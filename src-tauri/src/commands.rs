// The only native capabilities the window has: create, open, save and lock
// the encrypted household data. See docs/ARCHITECTURE.md §4–6.
//
// The passphrase is held only here, in Rust memory, while unlocked (age's
// SecretString wipes it when dropped). It is never written to disk, logged,
// or sent back to the window. Every error is a fixed code (vault::VaultError).

use crate::vault::{self, Vault, VaultError};
use age::secrecy::SecretString;
use std::fs::File;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::State;

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
}
