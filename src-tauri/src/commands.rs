// The only native capabilities the window has: create, open, save and lock
// the encrypted household data, and make or restore an encrypted backup.
// See docs/ARCHITECTURE.md §4–7.
//
// The passphrase is held only here, in Rust memory, while unlocked (age's
// SecretString wipes it when dropped). It is never written to disk, logged,
// or sent back to the window. Every error is a fixed code (vault::VaultError).

use crate::vault::{self, Vault, VaultError};
use age::secrecy::{ExposeSecret, SecretString};
use std::fs::File;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Runtime, State};

pub struct AppState {
    vault: Vault,
    /// Held for the app's lifetime; None means another copy holds the lock.
    _writer_lock: Option<File>,
    can_write: bool,
    session: Mutex<Session>,
}

#[derive(Default)]
struct Session {
    passphrase: Option<SecretString>,
    /// False when the current file was unreadable and the previous version
    /// was opened instead; the next save must not rotate the damaged file
    /// over the good previous one.
    current_is_good: bool,
    /// A backup that has been opened and decrypted but not yet confirmed.
    /// Restoring uses exactly this data, not anything sent back by the window.
    pending_restore: Option<PendingRestore>,
}

struct PendingRestore {
    passphrase: SecretString,
    ledger: String,
}

impl AppState {
    pub fn new(dir: PathBuf) -> Self {
        let writer_lock = vault::acquire_single_writer_lock(&dir).ok().flatten();
        Self {
            can_write: writer_lock.is_some(),
            vault: Vault::new(dir),
            _writer_lock: writer_lock,
            session: Mutex::new(Session::default()),
        }
    }

    fn session(&self) -> std::sync::MutexGuard<'_, Session> {
        // A panic while holding the lock cannot leave partial data on disk
        // (saves are atomic), so recovering the guard is safe.
        self.session.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

fn code(error: VaultError) -> String {
    error.code().to_string()
}

/// "already_open" | "none" | "locked" | "unlocked"
#[tauri::command]
pub fn vault_status(state: State<'_, AppState>) -> &'static str {
    if !state.can_write {
        "already_open"
    } else if state.session().passphrase.is_some() {
        "unlocked"
    } else if state.vault.exists() {
        "locked"
    } else {
        "none"
    }
}

#[tauri::command(async)]
pub fn vault_create(state: State<'_, AppState>, passphrase: String, ledger: String) -> Result<(), String> {
    if !state.can_write {
        return Err("already_open".into());
    }
    let passphrase = SecretString::from(passphrase);
    let mut session = state.session();
    state.vault.create(&passphrase, &ledger, None).map_err(code)?;
    session.passphrase = Some(passphrase);
    session.current_is_good = true;
    Ok(())
}

/// Returns (ledger JSON, recovered_from_previous).
#[tauri::command(async)]
pub fn vault_unlock(state: State<'_, AppState>, passphrase: String) -> Result<(String, bool), String> {
    if !state.can_write {
        return Err("already_open".into());
    }
    let passphrase = SecretString::from(passphrase);
    let mut session = state.session();
    let opened = state.vault.open(&passphrase).map_err(code)?;
    session.passphrase = Some(passphrase);
    session.current_is_good = !opened.recovered_from_previous;
    Ok((opened.ledger, opened.recovered_from_previous))
}

#[tauri::command(async)]
pub fn vault_save(state: State<'_, AppState>, ledger: String) -> Result<(), String> {
    let mut session = state.session();
    let Some(passphrase) = session.passphrase.as_ref() else {
        return Err("locked".into());
    };
    let keep_previous = session.current_is_good;
    state.vault.save(passphrase, &ledger, keep_previous, None, &mut |_| Ok(())).map_err(code)?;
    session.current_is_good = true;
    Ok(())
}

#[tauri::command]
pub fn vault_lock(state: State<'_, AppState>) {
    let mut session = state.session();
    session.passphrase = None; // SecretString zeroizes on drop
    session.current_is_good = false;
    session.pending_restore = None;
}

// ---- Backups ---------------------------------------------------------------

const BACKUP_EXTENSION: &str = "hmbackup";

/// The save and open panels. In the CI-only smoke build, a fixed file in the
/// app's own container stands in for the panels, since nobody can click them.
#[cfg(not(feature = "smoke-test"))]
mod panels {
    use super::BACKUP_EXTENSION;
    use std::path::PathBuf;
    use tauri::{AppHandle, Runtime};
    use tauri_plugin_dialog::DialogExt;

    pub fn choose_backup_destination<R: Runtime>(app: &AppHandle<R>, file_name: &str) -> Option<PathBuf> {
        app.dialog()
            .file()
            .set_title("Save your Household Money backup")
            .set_file_name(file_name)
            .add_filter("Household Money backup", &[BACKUP_EXTENSION])
            .set_can_create_directories(true)
            .blocking_save_file()?
            .into_path()
            .ok()
    }

    pub fn choose_backup_to_restore<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
        app.dialog()
            .file()
            .set_title("Choose a Household Money backup to restore")
            .add_filter("Household Money backup", &[BACKUP_EXTENSION])
            .blocking_pick_file()?
            .into_path()
            .ok()
    }
}

#[cfg(feature = "smoke-test")]
mod panels {
    use std::path::PathBuf;
    use tauri::{AppHandle, Manager, Runtime};

    fn fixed<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
        Some(app.path().app_data_dir().ok()?.join("smoke-backup.hmbackup"))
    }
    pub fn choose_backup_destination<R: Runtime>(app: &AppHandle<R>, _file_name: &str) -> Option<PathBuf> {
        fixed(app)
    }
    pub fn choose_backup_to_restore<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
        fixed(app)
    }
}

/// `date` is "YYYY-MM-DD", used only for the suggested file name.
fn suggested_file_name(date: &str) -> String {
    let bytes = date.as_bytes();
    let valid = bytes.len() == 10
        && bytes.iter().enumerate().all(|(i, b)| if i == 4 || i == 7 { *b == b'-' } else { b.is_ascii_digit() });
    if valid {
        format!("Household Money Backup {date}.{BACKUP_EXTENSION}")
    } else {
        format!("Household Money Backup.{BACKUP_EXTENSION}")
    }
}

/// Saves an encrypted backup of `ledger` (protected by the household
/// passphrase) to a file the person chooses, then checks it by reading it back.
#[tauri::command(async)]
pub fn backup_create<R: Runtime>(app: AppHandle<R>, state: State<'_, AppState>, ledger: String, date: String) -> Result<(), String> {
    // Copy the passphrase out so the session is not held while the panel is open.
    let passphrase = state.session().passphrase.clone().ok_or_else(|| "locked".to_string())?;
    let path = panels::choose_backup_destination(&app, &suggested_file_name(&date)).ok_or_else(|| "cancelled".to_string())?;
    vault::write_backup(&path, &passphrase, &ledger, None).map_err(code)
}

/// Opens and decrypts a backup the person chooses, and returns its ledger so
/// the window can check it and show what it contains. Nothing is replaced
/// until `restore_commit`.
#[tauri::command(async)]
pub fn restore_open<R: Runtime>(app: AppHandle<R>, state: State<'_, AppState>, passphrase: String) -> Result<String, String> {
    if !state.can_write {
        return Err("already_open".into());
    }
    {
        // Existing data may only be replaced from an unlocked household.
        let session = state.session();
        if session.passphrase.is_none() && state.vault.exists() {
            return Err("locked".into());
        }
    }
    let passphrase = SecretString::from(passphrase);
    let path = panels::choose_backup_to_restore(&app).ok_or_else(|| "cancelled".to_string())?;
    let ledger = vault::read_backup(&path, &passphrase).map_err(code)?;
    state.session().pending_restore = Some(PendingRestore { passphrase, ledger: ledger.clone() });
    Ok(ledger)
}

/// Replaces the household data with the backup opened by `restore_open`.
/// Returns true if the household passphrase is now different (the backup's).
#[tauri::command(async)]
pub fn restore_commit(state: State<'_, AppState>) -> Result<bool, String> {
    let mut session = state.session();
    let pending = session.pending_restore.take().ok_or_else(|| "no_pending_restore".to_string())?;
    if session.passphrase.is_none() && state.vault.exists() {
        return Err("locked".into());
    }
    let changed = session
        .passphrase
        .as_ref()
        .is_some_and(|current| current.expose_secret() != pending.passphrase.expose_secret());
    let keep_previous = session.current_is_good;
    state.vault.restore(&pending.passphrase, &pending.ledger, keep_previous, None, &mut |_| Ok(())).map_err(code)?;
    session.passphrase = Some(pending.passphrase);
    session.current_is_good = true;
    Ok(changed)
}

#[tauri::command]
pub fn restore_cancel(state: State<'_, AppState>) {
    state.session().pending_restore = None;
}

#[cfg(test)]
mod tests {
    use super::suggested_file_name;

    #[test]
    fn suggested_file_name_only_uses_a_valid_date() {
        assert_eq!(suggested_file_name("2026-10-29"), "Household Money Backup 2026-10-29.hmbackup");
        for bad in ["", "2026-10-2", "../../etc", "2026/10/29", "2026-10-29x"] {
            assert_eq!(suggested_file_name(bad), "Household Money Backup.hmbackup", "{bad}");
        }
    }
}
