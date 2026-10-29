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
// - no Tauri plugins and no app commands exist yet, so the page has no
//   native capabilities at all.

use tauri::{Url, WebviewWindowBuilder};

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
        .setup(|app| {
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
    /// 1. whether the welcome screen rendered (heading, preview, no error banner),
    /// 2. whether the CSP blocked a fetch to an outside site,
    /// 3. then tries to navigate to an outside site, which must be refused.
    const PROBE: &str = r#"(async () => {
      const pause = () => new Promise((resolve) => setTimeout(resolve, 400));
      const report = async (result) => { location.href = 'tauri://localhost/__smoke/' + result; await pause(); };
      // The load event can arrive before the app's module script has run, so
      // wait (up to 10 s) for the welcome screen before judging the render.
      for (let i = 0; i < 50 && !document.querySelector('h1'); i++) await new Promise((r) => setTimeout(r, 200));
      const heading = document.querySelector('h1');
      const rendered = heading && heading.textContent === 'Our Household Money'
        && document.querySelector('.preview') && document.querySelector('.upload-card')
        && !document.getElementById('fatal-banner');
      await report(rendered ? 'render-ok' : 'render-missing'
        + '-h1' + (heading ? 1 : 0)
        + '-app' + (document.getElementById('app')?.childElementCount ?? -1)
        + '-banner' + (document.getElementById('fatal-banner') ? 1 : 0)
        + '-scripts' + document.scripts.length);
      let fetchResult = 'fetch-sent';
      try { await fetch('https://example.com/', { mode: 'no-cors' }); } catch { fetchResult = 'fetch-blocked'; }
      await report(fetchResult);
      location.href = 'https://example.com/';
      await pause();
      await report('done');
    })();"#;

    static PROBED: AtomicBool = AtomicBool::new(false);

    /// Fixed progress markers on stderr, which is unbuffered.
    pub fn note(message: &str) {
        eprintln!("SMOKE {message}");
    }

    /// Marks startup and ends the run after 45 s if the checks never finish,
    /// so CI always gets output instead of a hang.
    pub fn start<R: Runtime>(app: AppHandle<R>) {
        note("setup");
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_secs(45));
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
            let app = app.clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_secs(1));
                app.exit(0);
            });
        }
        true
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
                if window.eval(PROBE).is_err() {
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
