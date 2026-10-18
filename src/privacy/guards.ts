/**
 * Page-level safety nets. These complement, not replace, the Content Security
 * Policy in index.html.
 */
export function installGlobalGuards(): void {
  // A PDF dropped outside the import area would otherwise make the browser
  // navigate away and open the statement, discarding unsaved review state.
  for (const type of ['dragover', 'drop'] as const) {
    window.addEventListener(type, (event) => {
      if (!(event.target instanceof Element) || !event.target.closest('[data-dropzone]')) {
        event.preventDefault();
      }
    });
  }

  // Unexpected errors are shown to the user generically. They are never sent
  // anywhere, and the message is not echoed because it could contain data.
  window.addEventListener('error', (event) => {
    event.preventDefault();
    showFatal();
  });
  window.addEventListener('unhandledrejection', (event) => {
    event.preventDefault();
    showFatal();
  });
}

function showFatal(): void {
  const banner = document.getElementById('fatal-banner') ?? document.createElement('div');
  banner.id = 'fatal-banner';
  banner.setAttribute('role', 'alert');
  banner.className = 'fatal-banner';
  banner.textContent =
    'Something went wrong on this page. Your saved data has not been changed. Reload the page to try again.';
  document.body.prepend(banner);
}
