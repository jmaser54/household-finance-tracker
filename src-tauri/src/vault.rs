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
/// Copy of the household data as it was just before the last restore.
pub const BEFORE_RESTORE: &str = "ledger.before-restore.age";

/// Highest scrypt cost accepted when opening a backup (log2 N; 2^21 needs
/// about 2 GiB of memory). Fixed rather than relative to this Mac, so a
/// backup made on a faster Mac still opens on the 2017 MacBook Air, while a
/// malicious file cannot demand hours of work or tens of GiB of memory.
pub const BACKUP_MAX_WORK_FACTOR: u8 = 21;
/// A backup file larger than this is refused before it is read.
const MAX_BACKUP_FILE_BYTES: u64 = MAX_LEDGER_BYTES as u64 + 1024 * 1024;

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
    /// A backup was written but reading it back did not give the same data.
    BackupUnverified,
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
            Self::BackupUnverified => "backup_unverified",
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
    decrypt_with_ceiling(ciphertext, passphrase, None)
}

/// `max_work_factor`: None uses age's default ceiling (about 16× this Mac's
/// own ~1 s cost), which suits the data file this Mac wrote itself.
fn decrypt_with_ceiling(ciphertext: &[u8], passphrase: &SecretString, max_work_factor: Option<u8>) -> Result<String, VaultError> {
    let decryptor = age::Decryptor::new_buffered(ciphertext).map_err(classify)?;
    // A passphrase file must contain only a passphrase stanza.
    if !decryptor.is_scrypt() {
        return Err(VaultError::Damaged);
    }
    let mut identity = age::scrypt::Identity::new(passphrase.clone());
    if let Some(max) = max_work_factor {
        identity.set_max_work_factor(max);
    }
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

/// Writes an encrypted backup to a file the user chose, then reads it back and
/// decrypts it to prove it is complete and opens with the passphrase.
///
/// The sandbox only permits writing the exact file chosen in the save panel,
/// so this cannot use a temporary file plus rename. A failure part-way can
/// leave a damaged backup at that path; the read-back check catches it and
/// reports `BackupUnverified` or `WriteFailed`. The household data itself is
/// never touched.
pub fn write_backup(path: &Path, passphrase: &SecretString, ledger: &str, work_factor: Option<u8>) -> Result<(), VaultError> {
    let bytes = encrypt(ledger, passphrase, work_factor)?;
    let written = (|| -> io::Result<()> {
        let mut file = File::create(path)?;
        file.write_all(&bytes)?;
        file.sync_all()
    })();
    written.map_err(|_| VaultError::WriteFailed)?;
    match read_backup(path, passphrase) {
        Ok(read_back) if read_back == ledger => Ok(()),
        _ => Err(VaultError::BackupUnverified),
    }
}

/// Reads and decrypts a backup file the user chose.
pub fn read_backup(path: &Path, passphrase: &SecretString) -> Result<String, VaultError> {
    let size = fs::metadata(path).map_err(|_| VaultError::ReadFailed)?.len();
    if size > MAX_BACKUP_FILE_BYTES {
        return Err(VaultError::TooLarge);
    }
    let bytes = fs::read(path).map_err(|_| VaultError::ReadFailed)?;
    decrypt_with_ceiling(&bytes, passphrase, Some(BACKUP_MAX_WORK_FACTOR))
}

impl Vault {
    /// Replaces the household data with a restored ledger.
    ///
    /// First keeps a copy of the current data file, whatever its state, as
    /// `ledger.before-restore.age` (still encrypted with the old passphrase),
    /// then saves the restored ledger with the normal atomic save. If the
    /// restore is interrupted at any point, `ledger.age` is either the old
    /// data or the restored data, never a mixture or nothing.
    pub fn restore(
        &self,
        passphrase: &SecretString,
        ledger: &str,
        keep_previous: bool,
        work_factor: Option<u8>,
        interrupt: &mut dyn FnMut(SaveStep) -> io::Result<()>,
    ) -> Result<(), VaultError> {
        let current = self.path(CURRENT);
        if current.exists() {
            let copy = self.path(&format!("{BEFORE_RESTORE}.tmp"));
            (|| -> io::Result<()> {
                fs::copy(&current, &copy)?;
                File::open(&copy)?.sync_all()?;
                fs::rename(&copy, self.path(BEFORE_RESTORE))
            })()
            .map_err(|_| VaultError::WriteFailed)?;
        }
        self.save(passphrase, ledger, keep_previous, work_factor, interrupt)
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

    // ---- Backups and restore -------------------------------------------------

    #[test]
    fn backup_round_trip_with_the_household_passphrase() {
        let dir = TempDir::new();
        let file = dir.0.join("Household Money Backup.hmbackup");
        write_backup(&file, &good(), LEDGER_A, FAST).unwrap();
        assert!(fs::read(&file).unwrap().starts_with(b"age-encryption.org/v1\n-> scrypt "));
        assert!(!String::from_utf8_lossy(&fs::read(&file).unwrap()).contains("synthetic ledger"));
        assert_eq!(read_backup(&file, &good()).unwrap(), LEDGER_A);
    }

    #[test]
    fn backup_with_wrong_passphrase_is_refused() {
        let dir = TempDir::new();
        let file = dir.0.join("b.hmbackup");
        write_backup(&file, &good(), LEDGER_A, FAST).unwrap();
        assert_eq!(read_backup(&file, &pass("some other passphrase")).err(), Some(VaultError::WrongPassphrase));
    }

    #[test]
    fn damaged_truncated_or_foreign_backups_are_refused() {
        let dir = TempDir::new();
        let file = dir.0.join("b.hmbackup");
        write_backup(&file, &good(), LEDGER_A, FAST).unwrap();
        let bytes = fs::read(&file).unwrap();

        let mut flipped = bytes.clone();
        let last = flipped.len() - 3;
        flipped[last] ^= 0x40;
        fs::write(&file, flipped).unwrap();
        assert_eq!(read_backup(&file, &good()).err(), Some(VaultError::Damaged));

        fs::write(&file, &bytes[..bytes.len() / 2]).unwrap();
        assert_eq!(read_backup(&file, &good()).err(), Some(VaultError::Damaged));

        for foreign in [&b""[..], b"%PDF-1.7 not a backup", b"{\"schemaVersion\":1}"] {
            fs::write(&file, foreign).unwrap();
            assert_eq!(read_backup(&file, &good()).err(), Some(VaultError::Damaged));
        }
    }

    #[test]
    fn missing_backup_file_is_a_read_failure() {
        let dir = TempDir::new();
        assert_eq!(read_backup(&dir.0.join("nope.hmbackup"), &good()).err(), Some(VaultError::ReadFailed));
    }

    #[test]
    fn oversized_backup_is_refused_before_reading() {
        let dir = TempDir::new();
        let file = dir.0.join("big.hmbackup");
        File::create(&file).unwrap().set_len(MAX_BACKUP_FILE_BYTES + 1).unwrap();
        assert_eq!(read_backup(&file, &good()).err(), Some(VaultError::TooLarge));
    }

    /// Rewrites the scrypt cost declared in a file's header (the payload stays as is).
    fn with_declared_work_factor(bytes: &[u8], from: u8, to: u8) -> Vec<u8> {
        let needle = format!(" {from}\n").into_bytes();
        let at = bytes.windows(needle.len()).position(|w| w == needle.as_slice()).unwrap();
        [&bytes[..at], format!(" {to}\n").as_bytes(), &bytes[at + needle.len()..]].concat()
    }

    #[test]
    fn backup_from_a_faster_mac_opens_but_an_absurd_work_factor_does_not() {
        let dir = TempDir::new();
        // A real backup made at a higher cost than the tests' usual one (as a
        // faster Mac would choose) opens.
        let faster = dir.0.join("faster.hmbackup");
        write_backup(&faster, &good(), LEDGER_A, Some(16)).unwrap();
        assert_eq!(read_backup(&faster, &good()).unwrap(), LEDGER_A);
        // A file declaring more than the fixed ceiling is refused before any work.
        let absurd = dir.0.join("absurd.hmbackup");
        let bytes = encrypt(LEDGER_A, &good(), FAST).unwrap();
        fs::write(&absurd, with_declared_work_factor(&bytes, 10, BACKUP_MAX_WORK_FACTOR + 1)).unwrap();
        assert_eq!(read_backup(&absurd, &good()).err(), Some(VaultError::ExcessiveWork));
    }

    #[test]
    fn backup_write_failure_is_reported() {
        let dir = TempDir::new();
        // A directory in place of the chosen file makes the write fail.
        let file = dir.0.join("not-a-file.hmbackup");
        fs::create_dir(&file).unwrap();
        assert_eq!(write_backup(&file, &good(), LEDGER_A, FAST).err(), Some(VaultError::WriteFailed));
    }

    #[test]
    fn making_a_backup_never_changes_household_data() {
        let (dir, vault) = vault_with(&[LEDGER_A, LEDGER_B]);
        let before: Vec<Vec<u8>> = [CURRENT, PREVIOUS].iter().map(|f| fs::read(dir.0.join(f)).unwrap()).collect();
        write_backup(&dir.0.join("b.hmbackup"), &good(), LEDGER_B, FAST).unwrap();
        let after: Vec<Vec<u8>> = [CURRENT, PREVIOUS].iter().map(|f| fs::read(dir.0.join(f)).unwrap()).collect();
        assert_eq!(before, after);
        assert_eq!(vault.open(&good()).unwrap().ledger, LEDGER_B);
    }

    #[test]
    fn restore_replaces_data_and_keeps_a_copy_of_what_it_replaced() {
        let (dir, vault) = vault_with(&[LEDGER_A]);
        let old_pass = good();
        let backup_pass = pass("passphrase used for the backup");
        vault.restore(&backup_pass, LEDGER_B, true, FAST, &mut |_| Ok(())).unwrap();
        // The restored data opens with the backup's passphrase...
        assert_eq!(vault.open(&backup_pass).unwrap().ledger, LEDGER_B);
        // ...and the replaced data is kept, still encrypted with the old one.
        let kept = decrypt(&fs::read(dir.0.join(BEFORE_RESTORE)).unwrap(), &old_pass).unwrap();
        assert_eq!(kept, LEDGER_A);
        assert!(!dir.0.join(format!("{BEFORE_RESTORE}.tmp")).exists());
    }

    #[test]
    fn restore_onto_a_new_mac_needs_no_existing_data() {
        let dir = TempDir::new();
        let vault = Vault::new(&dir.0);
        vault.restore(&good(), LEDGER_A, false, FAST, &mut |_| Ok(())).unwrap();
        assert_eq!(vault.open(&good()).unwrap().ledger, LEDGER_A);
        assert!(!dir.0.join(BEFORE_RESTORE).exists());
    }

    #[test]
    fn interrupted_restore_at_every_step_leaves_old_or_restored_data_never_neither() {
        for step in [SaveStep::TempWritten, SaveStep::TempFlushed, SaveStep::PreviousKept, SaveStep::Replaced] {
            let (dir, vault) = vault_with(&[LEDGER_A]);
            let result = vault.restore(&good(), LEDGER_B, true, FAST, &mut stop_at(step));
            assert_eq!(result.err(), Some(VaultError::WriteFailed), "{step:?}");
            let expected = if step == SaveStep::Replaced { LEDGER_B } else { LEDGER_A };
            assert_eq!(vault.open(&good()).unwrap().ledger, expected, "{step:?}");
            // The pre-restore copy is complete regardless of where it stopped.
            assert_eq!(decrypt(&fs::read(dir.0.join(BEFORE_RESTORE)).unwrap(), &good()).unwrap(), LEDGER_A, "{step:?}");
        }
    }

    #[test]
    fn restore_keeps_a_copy_even_of_unreadable_current_data() {
        let (dir, vault) = vault_with(&[LEDGER_A]);
        fs::write(dir.0.join(CURRENT), b"damaged").unwrap();
        vault.restore(&good(), LEDGER_B, false, FAST, &mut |_| Ok(())).unwrap();
        assert_eq!(fs::read(dir.0.join(BEFORE_RESTORE)).unwrap(), b"damaged");
        assert_eq!(vault.open(&good()).unwrap().ledger, LEDGER_B);
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
