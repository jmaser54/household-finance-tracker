// Household Money: the desktop shell around the existing web UI.
//
// Privacy boundary (PROJECT_PRINCIPLES.md §3.1, docs/ARCHITECTURE.md §4):
// - the macOS App Sandbox, granted no network entitlement, stops this process
//   and its webview from opening connections;
// - the window may only show the app's own bundled pages; any navigation
//   elsewhere is refused, so page script cannot carry data off in a URL;
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
            let builder = WebviewWindowBuilder::from_config(app.handle(), &config)?.on_navigation(|url| {
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
/// scripts/check-desktop-config.mjs and the CI workflow).
#[cfg(feature = "smoke-test")]
mod smoke {
    use std::io::ErrorKind;
    use std::net::{SocketAddr, TcpStream};
    use std::time::Duration;
    use tauri::webview::PageLoadEvent;
    use tauri::{AppHandle, Manager, Runtime, WebviewWindowBuilder};

    /// Fixed progress markers (never data) on stderr, which is unbuffered.
    pub fn note(message: &str) {
        eprintln!("SMOKE {message}");
    }

    /// Marks startup and ends the run after 45 s if the page never finishes
    /// loading, so CI always gets output instead of a hang.
    pub fn start<R: Runtime>(app: AppHandle<R>) {
        note("setup");
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_secs(45));
            note("timeout waiting for page load");
            app.exit(2);
        });
    }

    pub fn attach<'a, R: Runtime, M: Manager<R>>(
        builder: WebviewWindowBuilder<'a, R, M>,
    ) -> WebviewWindowBuilder<'a, R, M> {
        builder.on_page_load(|window, payload| {
            if payload.event() != PageLoadEvent::Finished {
                note(&format!("page-load-started {}://{}", payload.url().scheme(), payload.url().host_str().unwrap_or("")));
                return;
            }
            note(&format!("page-loaded {}", payload.url()));
            note(&format!("network {}", network_probe()));
            let app = window.app_handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_secs(2));
                app.exit(0);
            });
        })
    }

    /// Attempts an outbound TCP connection. Under the App Sandbox without a
    /// network entitlement, macOS refuses it with "Operation not permitted".
    fn network_probe() -> String {
        let target: SocketAddr = "1.1.1.1:443".parse().expect("valid address");
        match TcpStream::connect_timeout(&target, Duration::from_secs(5)) {
            Ok(_) => "connected".to_string(),
            Err(error) if error.kind() == ErrorKind::PermissionDenied => "blocked-by-sandbox".to_string(),
            Err(error) => format!("failed-other:{:?}", error.kind()),
        }
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
