// Household Money: the desktop shell around the existing web UI.
//
// Privacy boundary (PROJECT_PRINCIPLES.md §3.1, docs/ARCHITECTURE.md §4):
// - the app contains no networking code (no network crates or plugins);
// - the window's CSP forbids the page from fetching or connecting anywhere;
// - the window may only show the app's own bundled pages; any navigation
//   elsewhere is refused, so page script cannot carry data off in a URL;
// - the macOS App Sandbox limits files and hardware. It must grant
//   network.client because WebKit will not render in the sandbox without it,
//   so macOS itself PERMITS outgoing connections; the layers above are what
//   keep the app from making any;
// - one Tauri plugin (dialog), used only from Rust for the backup save/open
//   panels; the page's only native capabilities are the commands in
//   commands.rs, which read and write encrypted files in the app's own
//   sandbox container and the backup file the person picks.

mod commands;
mod vault;

use tauri::{Manager, Url, WebviewWindowBuilder};

/// True for the app's own bundled pages. In debug builds the local Vite dev
/// server is allowed too, so `tauri dev` works; release builds never allow it.
fn is_app_url(url: &Url) -> bool {
    match (url.scheme(), url.host_str()) {
        // macOS serves bundled assets from tauri://localhost.
        ("tauri", Some("localhost")) => true,
        // Windows/Android form; harmless to accept, it never leaves the device.
        ("http" | "https", Some("tauri.localhost")) => true,
        ("http", Some("localhost")) if cfg!(debug_assertions) => url.port() == Some(5173),
        _ => false,
    }
}

fn main() {
    tauri::Builder::default()
        // Native save/open panels, used only from Rust (commands.rs). No
        // capability grants the window any dialog permission.
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            commands::vault_status,
            commands::vault_create,
            commands::vault_unlock,
            commands::vault_save,
            commands::vault_lock,
            commands::backup_create,
            commands::restore_open,
            commands::restore_commit,
            commands::restore_cancel,
        ])
        .setup(|app| {
            // Inside the App Sandbox this is the app's private container:
            // ~/Library/Containers/<id>/Data/Library/Application Support/<id>
            let data_dir = app.path().app_data_dir()?;
            app.manage(commands::AppState::new(data_dir));
            let config = app
                .config()
                .app
                .windows
                .first()
                .ok_or("main window is not configured")?
                .clone();
            #[cfg(feature = "smoke-test")]
            smoke::start(app.handle().clone());
            #[cfg(feature = "smoke-test")]
            let handle = app.handle().clone();
            let builder = WebviewWindowBuilder::from_config(app.handle(), &config)?.on_navigation(move |url| {
                #[cfg(feature = "smoke-test")]
                if smoke::handle_report(&handle, url) {
                    return false;
                }
                let allowed = is_app_url(url);
                #[cfg(feature = "smoke-test")]
                smoke::note(&format!("navigation {} {}://{}", if allowed { "allowed" } else { "refused" }, url.scheme(), url.host_str().unwrap_or("")));
                allowed
            });
            #[cfg(feature = "smoke-test")]
            let builder = smoke::attach(builder);
            builder.build()?;
            #[cfg(feature = "smoke-test")]
            smoke::note("window-created");
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Household Money could not start");
}

/// CI-only checks, compiled in only with `--features smoke-test`. The app you
/// install is built without this feature (enforced by
/// scripts/check-desktop-config.mjs and the CI workflow). Everything printed is
/// a fixed marker; no data exists in this phase and none is ever printed.
#[cfg(feature = "smoke-test")]
mod smoke {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::time::Duration;
    use tauri::webview::PageLoadEvent;
    use tauri::{AppHandle, Manager, Runtime, Url, WebviewWindowBuilder};

    /// Path prefix the in-page probe navigates to in order to report results.
    /// Such navigations are intercepted here and never actually happen.
    const REPORT_PREFIX: &str = "/__smoke/";

    /// Runs inside the real app window once the page has loaded. Reports, by
    /// attempting in-app navigations to fixed report URLs:
    /// 1. whether the app rendered (heading, a known screen, no error banner),
    /// 2. creating or unlocking the household through the real UI, then the
    ///    encrypted save / lock / wrong-passphrase / unlock round trip through
    ///    the same commands, with a synthetic passphrase,
    /// 3. backup, a refused wrong-passphrase restore, and a full restore,
    /// 3. whether the CSP blocked a fetch to an outside site,
    /// 4. then tries to navigate to an outside site, which must be refused.
    const PROBE: &str = r#"(async () => {
      const pause = () => new Promise((resolve) => setTimeout(resolve, 400));
      const report = async (result) => { location.href = 'tauri://localhost/__smoke/' + result; await pause(); };
      // The load event can arrive before the app's module script has run, so
      // wait (up to 10 s) for the welcome screen before judging the render.
      for (let i = 0; i < 50 && !document.querySelector('h1'); i++) await new Promise((r) => setTimeout(r, 200));
      const heading = document.querySelector('h1');
      for (let i = 0; i < 50 && !document.querySelector('[data-screen], .preview'); i++) await new Promise((r) => setTimeout(r, 200));
      const shown = document.querySelector('[data-screen]')?.getAttribute('data-screen') ?? (document.querySelector('.preview') ? 'landing' : 'none');
      const rendered = heading && heading.textContent === 'Our Household Money'
        && shown !== 'none' && !document.getElementById('fatal-banner');
      await report(rendered ? 'render-ok' : 'render-missing'
        + '-h1' + (heading ? 1 : 0)
        + '-app' + (document.getElementById('app')?.childElementCount ?? -1)
        + '-banner' + (document.getElementById('fatal-banner') ? 1 : 0)
        + '-scripts' + document.scripts.length);
      await report('screen-' + shown);

      const invoke = window.__TAURI_INTERNALS__.invoke;
      const outcome = async (fn) => { try { return await fn(); } catch (e) { return 'err-' + encodeURIComponent(String(e)).slice(0, 60); } };
      const PASS = 'smoke synthetic passphrase';
      const CANARY = 'SMOKE-CANARY-HOUSEHOLD';

      // 1. Through the real UI: create the household (first run) or unlock it.
      const type = async (input, value) => { input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })); await pause(); };
      const fields = [...document.querySelectorAll('input[type=password]')];
      for (const field of fields) await type(field, PASS);
      document.querySelector('button[type=submit]')?.click();
      for (let i = 0; i < 75 && !document.querySelector('.preview') && !document.querySelector('[role=alert]'); i++) await new Promise((r) => setTimeout(r, 200));
      await report('ui-' + (document.querySelector('.preview') ? 'opened' : document.querySelector('[role=alert]') ? 'alert' : 'stuck'));
      await report('secure-context-' + window.isSecureContext + '-subtle-' + (typeof crypto.subtle));

      // 1b. Import a SYNTHETIC statement through the real UI: file input ->
      //     pdf.js (worker, CSP) -> review screen -> Add -> encrypted save.
      const pdf = new File([new Uint8Array(__SMOKE_PDF__)], 'smoke-checking.pdf', { type: 'application/pdf' });
      const picked = new DataTransfer();
      picked.items.add(pdf);
      const input = document.querySelector('[data-testid=statement-input]');
      input.files = picked.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      const reviewing = () => document.querySelector('[data-screen=import]') && !document.querySelector('[aria-busy=true]');
      for (let i = 0; i < 150 && !reviewing(); i++) await new Promise((r) => setTimeout(r, 200));
      const addButton = [...document.querySelectorAll('button')].find((b) => /^Add \d+ transaction/.test(b.textContent));
      if (!reviewing() || !addButton) {
        await report('import-' + (document.querySelector('[data-file-status]')?.getAttribute('data-file-status') ?? 'no-review-screen'));
      } else if (document.body.textContent.includes('This statement was already added')) {
        await report('import-already');
        [...document.querySelectorAll('button')].find((b) => b.textContent === 'Cancel').click();
        await pause();
      } else {
        addButton.click();
        let added = null;
        for (let i = 0; i < 150 && !added; i++) { added = /Added (\d+) transactions?/.exec(document.body.textContent); if (!added) await new Promise((r) => setTimeout(r, 200)); }
        await report('import-' + (added ? 'added-' + added[1] : 'not-saved'));
      }

      // 2. The same commands directly: save, lock, refuse, unlock.
      await report('status-' + await outcome(() => invoke('vault_status')));
      await outcome(() => invoke('vault_lock'));
      const reopened = await outcome(() => invoke('vault_unlock', { passphrase: PASS }));
      await report('reopen-' + (Array.isArray(reopened) && reopened[1] === false ? 'ok' : 'failed'));
      const ledger = JSON.parse(reopened[0]);
      ledger.settings.householdName = CANARY;
      await report('save-' + await outcome(() => invoke('vault_save', { ledger: JSON.stringify(ledger) }).then(() => 'ok')));
      await outcome(() => invoke('vault_lock'));
      await report('save-locked-' + await outcome(() => invoke('vault_save', { ledger: '{}' }).then(() => 'saved')));
      await report('wrong-' + await outcome(() => invoke('vault_unlock', { passphrase: 'not the smoke passphrase' }).then(() => 'opened')));
      let saved = null;
      await report('unlock-' + await outcome(() => invoke('vault_unlock', { passphrase: PASS })
        .then(([ledgerJson, recovered]) => { saved = ledgerJson; return JSON.parse(ledgerJson).settings.householdName === CANARY && !recovered ? 'ok' : 'mismatch'; })));

      // 3. Backup and restore through the same commands. In this CI-only build
      //    a fixed file in the container stands in for the save/open panels.
      const backupLedger = JSON.stringify({ ...JSON.parse(saved), settings: { ...JSON.parse(saved).settings, householdName: 'SMOKE-CANARY-BACKUP' } });
      await report('backup-' + await outcome(() => invoke('backup_create', { ledger: backupLedger, date: '2026-10-29' }).then(() => 'ok')));
      await report('restore-wrong-' + await outcome(() => invoke('restore_open', { passphrase: 'not the smoke passphrase' }).then(() => 'opened')));
      await report('restore-commit-without-open-' + await outcome(() => invoke('restore_commit').then(() => 'committed')));
      await report('restore-open-' + await outcome(() => invoke('restore_open', { passphrase: PASS }).then((json) => (json === backupLedger ? 'ok' : 'mismatch'))));
      await report('restore-commit-' + await outcome(() => invoke('restore_commit').then((changed) => (changed === false ? 'ok' : 'unexpected'))));
      await outcome(() => invoke('vault_lock'));
      await report('restored-' + await outcome(() => invoke('vault_unlock', { passphrase: PASS })
        .then(([ledgerJson]) => (JSON.parse(ledgerJson).settings.householdName === 'SMOKE-CANARY-BACKUP' ? 'ok' : 'mismatch'))));
      // Leave a valid household for the next run's UI unlock.
      await outcome(() => invoke('vault_save', { ledger: saved }));
      await outcome(() => invoke('vault_lock'));

      let fetchResult = 'fetch-sent';
      try { await fetch('https://example.com/', { mode: 'no-cors' }); } catch { fetchResult = 'fetch-blocked'; }
      await report(fetchResult);
      location.href = 'https://example.com/';
      await pause();
      await report('done');
    })();"#;

    static PROBED: AtomicBool = AtomicBool::new(false);

    /// A SYNTHETIC statement, embedded in the CI-only smoke build only.
    const SMOKE_PDF: &[u8] = include_bytes!("../../tests/fixtures/synthetic/checking-2026-03.pdf");

    /// Fixed progress markers on stderr, which is unbuffered.
    pub fn note(message: &str) {
        eprintln!("SMOKE {message}");
    }

    /// Marks startup and ends the run after 150 s if the checks never finish,
    /// so CI always gets output instead of a hang. The probe performs about a
    /// dozen scrypt operations; under Rosetta, opening files whose cost was
    /// calibrated on the native Apple Silicon run takes several seconds each.
    pub fn start<R: Runtime>(app: AppHandle<R>) {
        note("setup");
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_secs(150));
            note("timeout");
            app.exit(2);
        });
    }

    /// Handles a probe report. Returns true when the URL was a report (and so
    /// must not be navigated to).
    pub fn handle_report<R: Runtime>(app: &AppHandle<R>, url: &Url) -> bool {
        if url.scheme() != "tauri" || !url.path().starts_with(REPORT_PREFIX) {
            return false;
        }
        let result = &url.path()[REPORT_PREFIX.len()..];
        note(&format!("probe {result}"));
        if result == "done" {
            inspect_files(app);
            let app = app.clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_secs(1));
                app.exit(0);
            });
        }
        true
    }

    /// Checks the saved files from inside the sandbox: they must be age
    /// files and must not contain the synthetic plaintext markers.
    fn inspect_files<R: Runtime>(app: &AppHandle<R>) {
        let Ok(dir) = app.path().app_data_dir() else {
            return note("files no-data-dir");
        };
        let in_container = dir.to_string_lossy().contains("/Library/Containers/");
        note(&format!("data-in-container {}", if in_container { "yes" } else { "no" }));
        for name in [crate::vault::CURRENT, crate::vault::PREVIOUS, crate::vault::BEFORE_RESTORE, "smoke-backup.hmbackup"] {
            let verdict = match std::fs::read(dir.join(name)) {
                Err(_) => "missing",
                Ok(bytes) if !bytes.starts_with(b"age-encryption.org/v1\n-> scrypt ") => "not-age",
                Ok(bytes) if bytes.windows(12).any(|w| w == b"SMOKE-CANARY") || bytes.windows(14).any(|w| w == b"EXAMPLE GROCER") => {
                    "plaintext-visible"
                }
                Ok(_) => "encrypted-ok",
            };
            note(&format!("file {name} {verdict}"));
        }
    }

    pub fn attach<'a, R: Runtime, M: Manager<R>>(
        builder: WebviewWindowBuilder<'a, R, M>,
    ) -> WebviewWindowBuilder<'a, R, M> {
        builder.on_page_load(|window, payload| {
            if payload.event() != PageLoadEvent::Finished {
                note(&format!("page-load-started {}://{}", payload.url().scheme(), payload.url().host_str().unwrap_or("")));
                return;
            }
            note(&format!("page-loaded {}://{}", payload.url().scheme(), payload.url().host_str().unwrap_or("")));
            if !PROBED.swap(true, Ordering::SeqCst) {
                let bytes: Vec<String> = SMOKE_PDF.iter().map(|b| b.to_string()).collect();
                let probe = PROBE.replace("__SMOKE_PDF__", &format!("[{}]", bytes.join(",")));
                if window.eval(&probe).is_err() {
                    note("probe-not-started");
                }
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::is_app_url;
    use tauri::Url;

    fn allowed(url: &str) -> bool {
        is_app_url(&Url::parse(url).expect("valid test URL"))
    }

    #[test]
    fn allows_only_bundled_app_pages() {
        assert!(allowed("tauri://localhost/"));
        assert!(allowed("tauri://localhost/index.html"));
        assert!(allowed("https://tauri.localhost/index.html"));
    }

    #[test]
    fn refuses_everything_else() {
        for url in [
            "https://example.com/",
            "http://example.com/?data=1",
            "https://localhost/",
            "tauri://example.com/",
            "file:///etc/passwd",
            "data:text/html,hello",
            "javascript:alert(1)",
            "about:blank",
            "mailto:someone@example.com",
            "https://tauri.localhost.example.com/",
        ] {
            assert!(!allowed(url), "{url} must be refused");
        }
    }

    #[test]
    fn dev_server_only_in_debug_builds() {
        assert_eq!(allowed("http://localhost:5173/"), cfg!(debug_assertions));
        assert!(!allowed("http://localhost:8080/"));
    }
}
