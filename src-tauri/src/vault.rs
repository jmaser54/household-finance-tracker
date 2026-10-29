// Encrypted, crash-safe storage of the household ledger
// (PROJECT_PRINCIPLES.md §8, docs/ARCHITECTURE.md §5–6).
//
// - The ledger is one UTF-8 JSON document, opaque to this module, encrypted
//   with the standard age format in passphrase (scrypt) mode. No custom
//   cryptography: only age's own encrypt and decrypt calls.
// - Saving never damages what is already on disk: the new file is fully
//   written and flushed under a temporary name, the previous good version is
//   kept as `ledger.previous.age`, and an atomic rename puts the new file in
//   place. At every instant `ledger.age` is a complete file (old or new).
// - Opening falls back to the previous version if the current one cannot be
//   read, and never treats unreadable data as "no data".
// - Errors are fixed codes. They never contain data or the passphrase.

use age::secrecy::SecretString;
use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::iter;
use std::path::{Path, PathBuf};

pub const CURRENT: &str = "ledger.age";
pub const PREVIOUS: &str = "ledger.previous.age";
const TEMP: &str = "ledger.age.tmp";
const PREVIOUS_TEMP: &str = "ledger.previous.age.tmp";
pub const LOCK: &str = "household.lock";

pub const MIN_PASSPHRASE_CHARS: usize = 12;
const MAX_PASSPHRASE_CHARS: usize = 1024;
/// Far above any realistic household ledger; refuses absurd inputs.
const MAX_LEDGER_BYTES: usize = 64 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VaultError {
    /// No saved data exists yet.
    NoVault,
    /// Saved data already exists; creating a new household would replace it.
    VaultExists,
    /// The passphrase did not open the data (or the file's key section is damaged;
    /// the two cannot be told apart).
    WrongPassphrase,
    /// The data file is damaged, truncated or not an age file.
    Damaged,
    /// The file needs far more key-derivation work than this Mac expects.
    ExcessiveWork,
    WeakPassphrase,
    TooLarge,
    /// The ledger is not valid UTF-8 text.
    InvalidText,
    ReadFailed,
    WriteFailed,
}

impl VaultError {
    pub fn code(self) -> &'static str {
        match self {
            Self::NoVault => "no_vault",
            Self::VaultExists => "vault_exists",
            Self::WrongPassphrase => "wrong_passphrase",
            Self::Damaged => "data_damaged",
            Self::ExcessiveWork => "excessive_work",
            Self::WeakPassphrase => "weak_passphrase",
            Self::TooLarge => "too_large",
            Self::InvalidText => "invalid_text",
            Self::ReadFailed => "read_failed",
            Self::WriteFailed => "write_failed",
        }
    }
}

pub fn check_passphrase(passphrase: &str) -> Result<(), VaultError> {
    let chars = passphrase.chars().count();
    if !(MIN_PASSPHRASE_CHARS..=MAX_PASSPHRASE_CHARS).contains(&chars) || passphrase.trim().is_empty() {
        return Err(VaultError::WeakPassphrase);
    }
    Ok(())
}

/// Encrypts with age's passphrase recipient. `work_factor` (scrypt log2 N) is
/// only set by tests; the app uses age's own ~1 second calibration.
pub fn encrypt(plaintext: &str, passphrase: &SecretString, work_factor: Option<u8>) -> Result<Vec<u8>, VaultError> {
    if plaintext.len() > MAX_LEDGER_BYTES {
        return Err(VaultError::TooLarge);
    }
    let mut recipient = age::scrypt::Recipient::new(passphrase.clone());
    if let Some(log_n) = work_factor {
        recipient.set_work_factor(log_n);
    }
    let encryptor = age::Encryptor::with_recipients(iter::once(&recipient as &dyn age::Recipient))
        .map_err(|_| VaultError::WriteFailed)?;
    let mut out = Vec::with_capacity(plaintext.len() + 512);
    let mut writer = encryptor.wrap_output(&mut out).map_err(|_| VaultError::WriteFailed)?;
    writer.write_all(plaintext.as_bytes()).map_err(|_| VaultError::WriteFailed)?;
    writer.finish().map_err(|_| VaultError::WriteFailed)?;
    Ok(out)
}

pub fn decrypt(ciphertext: &[u8], passphrase: &SecretString) -> Result<String, VaultError> {
    let decryptor = age::Decryptor::new_buffered(ciphertext).map_err(classify)?;
    // A passphrase file must contain only a passphrase stanza.
    if !decryptor.is_scrypt() {
        return Err(VaultError::Damaged);
    }
    let identity = age::scrypt::Identity::new(passphrase.clone());
    let mut reader = decryptor
        .decrypt(iter::once(&identity as &dyn age::Identity))
        .map_err(classify)?;
    let mut plaintext = Vec::new();
    // Payload chunks are authenticated as they are read: tampering or
    // truncation surfaces here as an error, never as partial data.
    reader
        .by_ref()
        .take(MAX_LEDGER_BYTES as u64 + 1)
        .read_to_end(&mut plaintext)
        .map_err(|_| VaultError::Damaged)?;
    if plaintext.len() > MAX_LEDGER_BYTES {
        return Err(VaultError::TooLarge);
    }
    String::from_utf8(plaintext).map_err(|_| VaultError::InvalidText)
}

fn classify(error: age::DecryptError) -> VaultError {
    use age::DecryptError as E;
    match error {
        E::DecryptionFailed | E::KeyDecryptionFailed | E::NoMatchingKeys => VaultError::WrongPassphrase,
        E::ExcessiveWork { .. } => VaultError::ExcessiveWork,
        _ => VaultError::Damaged,
    }
}

/// Where a save can be interrupted. Tests stop the save at each point to
/// simulate a crash or power loss there.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SaveStep {
    TempWritten,
    TempFlushed,
    PreviousKept,
    Replaced,
}

pub struct Vault {
    dir: PathBuf,
}

/// Result of opening saved data.
pub struct Opened {
    pub ledger: String,
    /// True when `ledger.age` could not be read and `ledger.previous.age` was used.
    pub recovered_from_previous: bool,
}

impl Vault {
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self { dir: dir.into() }
    }

    fn path(&self, name: &str) -> PathBuf {
        self.dir.join(name)
    }

    /// True if any saved data exists, readable or not.
    pub fn exists(&self) -> bool {
        self.path(CURRENT).exists() || self.path(PREVIOUS).exists()
    }

    /// Starts a new household. Refuses if any saved data exists, so it can
    /// never overwrite an existing ledger.
    pub fn create(&self, passphrase: &SecretString, ledger: &str, work_factor: Option<u8>) -> Result<(), VaultError> {
        use age::secrecy::ExposeSecret;
        check_passphrase(passphrase.expose_secret())?;
        if self.exists() {
            return Err(VaultError::VaultExists);
        }
        self.save(passphrase, ledger, false, work_factor, &mut |_| Ok(()))
    }

    /// Opens saved data, falling back to the previous version if needed.
    pub fn open(&self, passphrase: &SecretString) -> Result<Opened, VaultError> {
        let current = self.read_and_decrypt(CURRENT, passphrase);
        if let Ok(ledger) = current {
            return Ok(Opened { ledger, recovered_from_previous: false });
        }
        match self.read_and_decrypt(PREVIOUS, passphrase) {
            Ok(ledger) => Ok(Opened { ledger, recovered_from_previous: true }),
            Err(previous_error) => Err(match current {
                Err(VaultError::NoVault) => previous_error,
                Err(current_error) => current_error,
                Ok(_) => unreachable!(),
            }),
        }
    }

    fn read_and_decrypt(&self, name: &str, passphrase: &SecretString) -> Result<String, VaultError> {
        let bytes = match fs::read(self.path(name)) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Err(VaultError::NoVault),
            Err(_) => return Err(VaultError::ReadFailed),
        };
        decrypt(&bytes, passphrase)
    }

    /// Encrypts and saves atomically.
    ///
    /// `keep_previous`: copy the current file to `ledger.previous.age` first.
    /// Callers pass false when the current file is known to be unreadable
    /// (opened via fallback), so a damaged file never replaces the good
    /// previous version.
    ///
    /// `interrupt` is called after each step; an `Err` stops the save there,
    /// exactly as a crash would. The app passes a no-op.
    pub fn save(
        &self,
        passphrase: &SecretString,
        ledger: &str,
        keep_previous: bool,
        work_factor: Option<u8>,
        interrupt: &mut dyn FnMut(SaveStep) -> io::Result<()>,
    ) -> Result<(), VaultError> {
        let bytes = encrypt(ledger, passphrase, work_factor)?;
        self.write_atomically(&bytes, keep_previous, interrupt).map_err(|_| VaultError::WriteFailed)
    }

    fn write_atomically(
        &self,
        bytes: &[u8],
        keep_previous: bool,
        interrupt: &mut dyn FnMut(SaveStep) -> io::Result<()>,
    ) -> io::Result<()> {
        fs::create_dir_all(&self.dir)?;
        let temp = self.path(TEMP);
        {
            let mut file = File::create(&temp)?;
            file.write_all(bytes)?;
            interrupt(SaveStep::TempWritten)?;
            // On macOS, Rust's sync_all uses F_FULLFSYNC (flushes the drive cache).
            file.sync_all()?;
        }
        interrupt(SaveStep::TempFlushed)?;

        let current = self.path(CURRENT);
        if keep_previous && current.exists() {
            // Hard-link (no copy, no window without a current file), then
            // atomically move the link over the old previous version.
            let previous_temp = self.path(PREVIOUS_TEMP);
            let _ = fs::remove_file(&previous_temp);
            fs::hard_link(&current, &previous_temp)?;
            fs::rename(&previous_temp, self.path(PREVIOUS))?;
        }
        interrupt(SaveStep::PreviousKept)?;

        fs::rename(&temp, &current)?;
        interrupt(SaveStep::Replaced)?;
        File::open(&self.dir)?.sync_all()?;
        Ok(())
    }
}

/// Holds an exclusive lock so only one copy of the app writes the data.
/// Returns None when another copy already holds it.
pub fn acquire_single_writer_lock(dir: &Path) -> io::Result<Option<File>> {
    fs::create_dir_all(dir)?;
    let file = fs::OpenOptions::new().create(true).truncate(false).write(true).open(dir.join(LOCK))?;
    match file.try_lock() {
        Ok(()) => Ok(Some(file)),
        Err(fs::TryLockError::WouldBlock) => Ok(None),
        Err(fs::TryLockError::Error(error)) => Err(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    /// Low scrypt cost so tests run fast. The app uses age's ~1 s calibration.
    const FAST: Option<u8> = Some(10);
    const LEDGER_A: &str = r#"{"schemaVersion":1,"note":"synthetic ledger A"}"#;
    const LEDGER_B: &str = r#"{"schemaVersion":1,"note":"synthetic ledger B"}"#;

    fn pass(text: &str) -> SecretString {
        SecretString::from(text.to_string())
    }
    fn good() -> SecretString {
        pass("correct horse battery")
    }

    struct TempDir(PathBuf);
    impl TempDir {
        fn new() -> Self {
            static N: AtomicU32 = AtomicU32::new(0);
            let dir = std::env::temp_dir()
                .join(format!("hm-vault-test-{}-{}", std::process::id(), N.fetch_add(1, Ordering::SeqCst)));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn vault_with(ledgers: &[&str]) -> (TempDir, Vault) {
        let dir = TempDir::new();
        let vault = Vault::new(&dir.0);
        vault.create(&good(), ledgers[0], FAST).unwrap();
        for ledger in &ledgers[1..] {
            vault.save(&good(), ledger, true, FAST, &mut |_| Ok(())).unwrap();
        }
        (dir, vault)
    }

    fn stop_at(step: SaveStep) -> impl FnMut(SaveStep) -> io::Result<()> {
        move |reached| if reached == step { Err(io::Error::other("simulated crash")) } else { Ok(()) }
    }

    #[test]
    fn round_trip() {
        let (_dir, vault) = vault_with(&[LEDGER_A]);
        let opened = vault.open(&good()).unwrap();
        assert_eq!(opened.ledger, LEDGER_A);
        assert!(!opened.recovered_from_previous);
    }

    #[test]
    fn file_on_disk_is_age_encrypted_not_plaintext() {
        let (dir, _vault) = vault_with(&[LEDGER_A]);
        let bytes = fs::read(dir.0.join(CURRENT)).unwrap();
        assert!(bytes.starts_with(b"age-encryption.org/v1\n-> scrypt "));
        let text = String::from_utf8_lossy(&bytes);
        assert!(!text.contains("synthetic ledger"));
        assert!(!text.contains("correct horse"));
    }

    #[test]
    fn wrong_passphrase_is_refused() {
        let (_dir, vault) = vault_with(&[LEDGER_A]);
        assert_eq!(vault.open(&pass("not the right one!")).err(), Some(VaultError::WrongPassphrase));
    }

    #[test]
    fn create_never_overwrites_existing_data() {
        let (_dir, vault) = vault_with(&[LEDGER_A]);
        assert_eq!(vault.create(&good(), LEDGER_B, FAST).err(), Some(VaultError::VaultExists));
        assert_eq!(vault.open(&good()).unwrap().ledger, LEDGER_A);
    }

    #[test]
    fn short_or_blank_passphrases_are_refused() {
        let dir = TempDir::new();
        let vault = Vault::new(&dir.0);
        for weak in ["", "short", "elevenchars", "            "] {
            assert_eq!(vault.create(&pass(weak), LEDGER_A, FAST).err(), Some(VaultError::WeakPassphrase));
        }
        assert!(!vault.exists());
    }

    #[test]
    fn opening_with_nothing_saved_reports_no_vault() {
        let dir = TempDir::new();
        assert_eq!(Vault::new(&dir.0).open(&good()).err(), Some(VaultError::NoVault));
    }

    #[test]
    fn tampered_payload_is_detected() {
        let (dir, vault) = vault_with(&[LEDGER_A]);
        fs::remove_file(dir.0.join(PREVIOUS)).ok();
        let path = dir.0.join(CURRENT);
        let mut bytes = fs::read(&path).unwrap();
        let last = bytes.len() - 5;
        bytes[last] ^= 0x01; // flip one bit in the encrypted body
        fs::write(&path, bytes).unwrap();
        assert_eq!(vault.open(&good()).err(), Some(VaultError::Damaged));
    }

    #[test]
    fn tampered_header_is_detected() {
        let (dir, vault) = vault_with(&[LEDGER_A]);
        let path = dir.0.join(CURRENT);
        let mut bytes = fs::read(&path).unwrap();
        let mac_line = bytes.windows(4).position(|w| w == b"--- ").unwrap();
        bytes[mac_line + 6] ^= 0x01; // flip a bit in the header MAC
        fs::write(&path, bytes).unwrap();
        assert!(matches!(vault.open(&good()).err(), Some(VaultError::Damaged | VaultError::WrongPassphrase)));
    }

    #[test]
    fn truncated_file_is_detected_not_partially_read() {
        let (dir, vault) = vault_with(&[LEDGER_A]);
        let path = dir.0.join(CURRENT);
        let bytes = fs::read(&path).unwrap();
        fs::write(&path, &bytes[..bytes.len() - 10]).unwrap();
        assert_eq!(vault.open(&good()).err(), Some(VaultError::Damaged));
    }

    #[test]
    fn garbage_and_empty_files_are_damaged_not_empty_data() {
        let dir = TempDir::new();
        let vault = Vault::new(&dir.0);
        for content in [&b""[..], b"not an age file at all", b"age-encryption.org/v1\n-> scrypt"] {
            fs::write(dir.0.join(CURRENT), content).unwrap();
            assert!(vault.exists());
            assert_eq!(vault.open(&good()).err(), Some(VaultError::Damaged));
            assert_eq!(vault.create(&good(), LEDGER_B, FAST).err(), Some(VaultError::VaultExists));
        }
    }

    #[test]
    fn non_passphrase_age_files_are_rejected() {
        let dir = TempDir::new();
        let key = age::x25519::Identity::generate();
        let encryptor = age::Encryptor::with_recipients(iter::once(&key.to_public() as &dyn age::Recipient)).unwrap();
        let mut out = Vec::new();
        let mut writer = encryptor.wrap_output(&mut out).unwrap();
        writer.write_all(LEDGER_A.as_bytes()).unwrap();
        writer.finish().unwrap();
        fs::write(dir.0.join(CURRENT), out).unwrap();
        assert_eq!(Vault::new(&dir.0).open(&good()).err(), Some(VaultError::Damaged));
    }

    #[test]
    fn excessive_work_factor_is_refused() {
        let dir = TempDir::new();
        // Header claims log2 N = 40, far above any ceiling; decrypt must refuse
        // before doing the work.
        let bytes = encrypt(LEDGER_A, &good(), FAST).unwrap();
        let text = String::from_utf8_lossy(&bytes).into_owned();
        let tampered = text.replacen(" 10\n", " 40\n", 1);
        assert_ne!(text, tampered);
        fs::write(dir.0.join(CURRENT), tampered.as_bytes()).unwrap();
        assert_eq!(Vault::new(&dir.0).open(&good()).err(), Some(VaultError::ExcessiveWork));
    }

    #[test]
    fn save_keeps_previous_version() {
        let (dir, vault) = vault_with(&[LEDGER_A, LEDGER_B]);
        assert_eq!(vault.open(&good()).unwrap().ledger, LEDGER_B);
        let previous = decrypt(&fs::read(dir.0.join(PREVIOUS)).unwrap(), &good()).unwrap();
        assert_eq!(previous, LEDGER_A);
        assert!(!dir.0.join(TEMP).exists());
    }

    #[test]
    fn damaged_current_falls_back_to_previous() {
        let (dir, vault) = vault_with(&[LEDGER_A, LEDGER_B]);
        fs::write(dir.0.join(CURRENT), b"damaged").unwrap();
        let opened = vault.open(&good()).unwrap();
        assert_eq!(opened.ledger, LEDGER_A);
        assert!(opened.recovered_from_previous);
    }

    #[test]
    fn saving_after_fallback_does_not_overwrite_the_good_previous_version() {
        let (dir, vault) = vault_with(&[LEDGER_A, LEDGER_B]);
        fs::write(dir.0.join(CURRENT), b"damaged").unwrap();
        assert!(vault.open(&good()).unwrap().recovered_from_previous);
        vault.save(&good(), LEDGER_B, false, FAST, &mut |_| Ok(())).unwrap();
        let previous = decrypt(&fs::read(dir.0.join(PREVIOUS)).unwrap(), &good()).unwrap();
        assert_eq!(previous, LEDGER_A);
        assert_eq!(vault.open(&good()).unwrap().ledger, LEDGER_B);
    }

    #[test]
    fn interrupted_save_at_every_step_leaves_readable_data() {
        for step in [SaveStep::TempWritten, SaveStep::TempFlushed, SaveStep::PreviousKept, SaveStep::Replaced] {
            let (_dir, vault) = vault_with(&[LEDGER_A]);
            let result = vault.save(&good(), LEDGER_B, true, FAST, &mut stop_at(step));
            assert_eq!(result.err(), Some(VaultError::WriteFailed), "{step:?}");
            let opened = vault.open(&good()).unwrap();
            let expected = if step == SaveStep::Replaced { LEDGER_B } else { LEDGER_A };
            assert_eq!(opened.ledger, expected, "{step:?}");
            assert!(!opened.recovered_from_previous, "{step:?}");
        }
    }

    #[test]
    fn torn_temporary_file_from_a_crash_is_ignored_and_replaced() {
        let (dir, vault) = vault_with(&[LEDGER_A]);
        fs::write(dir.0.join(TEMP), b"age-encryption.org/v1\n-> scr").unwrap();
        assert_eq!(vault.open(&good()).unwrap().ledger, LEDGER_A);
        vault.save(&good(), LEDGER_B, true, FAST, &mut |_| Ok(())).unwrap();
        assert_eq!(vault.open(&good()).unwrap().ledger, LEDGER_B);
    }

    #[test]
    fn interrupted_first_save_leaves_no_half_household() {
        let dir = TempDir::new();
        let vault = Vault::new(&dir.0);
        let result = vault.save(&good(), LEDGER_A, false, FAST, &mut stop_at(SaveStep::TempFlushed));
        assert!(result.is_err());
        assert!(!vault.exists());
        assert_eq!(vault.open(&good()).err(), Some(VaultError::NoVault));
    }

    #[test]
    fn write_failure_leaves_existing_data_intact() {
        let (dir, vault) = vault_with(&[LEDGER_A]);
        // A directory where the temporary file should go makes the write fail.
        fs::create_dir(dir.0.join(TEMP)).unwrap();
        assert_eq!(vault.save(&good(), LEDGER_B, true, FAST, &mut |_| Ok(())).err(), Some(VaultError::WriteFailed));
        assert_eq!(vault.open(&good()).unwrap().ledger, LEDGER_A);
    }

    #[test]
    fn unicode_ledger_round_trips() {
        let ledger = r#"{"note":"Café — 5 € ✓ 日本"}"#;
        let (_dir, vault) = vault_with(&[ledger]);
        assert_eq!(vault.open(&good()).unwrap().ledger, ledger);
    }

    #[test]
    fn errors_never_carry_data() {
        for error in [VaultError::WrongPassphrase, VaultError::Damaged, VaultError::WriteFailed] {
            assert!(error.code().chars().all(|c| c.is_ascii_lowercase() || c == '_'));
        }
    }

    #[test]
    fn only_one_writer_at_a_time() {
        let dir = TempDir::new();
        let first = acquire_single_writer_lock(&dir.0).unwrap();
        assert!(first.is_some());
        assert!(acquire_single_writer_lock(&dir.0).unwrap().is_none());
        drop(first);
        assert!(acquire_single_writer_lock(&dir.0).unwrap().is_some());
    }
}
