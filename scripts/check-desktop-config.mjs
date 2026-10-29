// Verifies the Mac app keeps its least-privilege, no-network configuration
// (PROJECT_PRINCIPLES.md §3.1, docs/ARCHITECTURE.md §4):
//  - the Tauri window CSP matches the strict CSP in index.html
//  - no Tauri plugins, capabilities, updater, or devtools
//  - App Sandbox is on, with network.client (needed by WebKit) as the only other entitlement
//  - no networking crates are compiled into the macOS app
//  - the old GitHub Pages deployment stays removed
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const failures = [];
const fail = (message) => failures.push(message);

// --- Tauri configuration -----------------------------------------------------
const conf = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8'));
const htmlCsp = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(readFileSync('index.html', 'utf8'))?.[1];
const security = conf.app?.security ?? {};

if (!htmlCsp) fail('index.html has no Content-Security-Policy');
if (security.csp !== htmlCsp) fail('tauri.conf.json CSP must match index.html exactly');
for (const directive of ["default-src 'none'", "script-src 'self'", "connect-src 'none'", "form-action 'none'", "base-uri 'none'", "object-src 'none'"]) {
  if (!String(security.csp).includes(directive)) fail(`Tauri CSP is missing \`${directive}\``);
}
if (/unsafe-inline|unsafe-eval|\*/.test(String(security.csp))) fail('Tauri CSP contains unsafe-inline, unsafe-eval or a wildcard');
// freezePrototype stays off: Preact copies its virtual-DOM nodes (which carry
// an own "constructor" property) when re-rendering, and with Object.prototype
// frozen that assignment throws, so the app cannot update the screen
// (found in Phase B). The page loads no untrusted script, which is what this
// option defends against; the CSP and navigation lock remain the boundary.
if (security.freezePrototype !== false) fail('app.security.freezePrototype must be false (Preact cannot re-render with it; see comment)');
if (security.dangerousDisableAssetCspModification) fail('dangerousDisableAssetCspModification must not be set');
if (security.assetProtocol?.enable) fail('the asset protocol (file access from the page) must stay disabled');
if (conf.app?.withGlobalTauri !== false) fail('app.withGlobalTauri must be false');
if (JSON.stringify(security.capabilities ?? []) !== '[]') fail('no capabilities are granted in this phase');
if (existsSync('src-tauri/capabilities')) fail('src-tauri/capabilities must not exist in this phase (no native permissions)');
if (conf.plugins && Object.keys(conf.plugins).length > 0) fail('no Tauri plugins may be configured');
if (conf.bundle?.createUpdaterArtifacts) fail('updater artifacts must not be created');
if (JSON.stringify(conf.bundle?.targets) !== '["app"]') fail('bundle.targets must be exactly ["app"]');
if (conf.bundle?.macOS?.entitlements !== 'Entitlements.plist') fail('bundle.macOS.entitlements must be Entitlements.plist');
if (conf.bundle?.macOS?.signingIdentity !== '-') fail('macOS signing must stay ad-hoc ("-") for household builds');
if (conf.bundle?.macOS?.minimumSystemVersion !== '12.0') fail('bundle.macOS.minimumSystemVersion must be 12.0 (the household Mac runs Monterey)');

// --- macOS entitlements ------------------------------------------------------
const plist = readFileSync('src-tauri/Entitlements.plist', 'utf8').replace(/<!--[\s\S]*?-->/g, '');
const keys = [...plist.matchAll(/<key>([^<]+)<\/key>\s*<(true|false)\/>/g)].map((m) => [m[1], m[2]]);
// network.client is required by WebKit to render at all inside the sandbox
// (Phase A finding). Nothing else is allowed, in particular not network.server.
// files.user-selected.read-write: only files the person picks in a panel.
const EXPECTED_ENTITLEMENTS = [
  ['com.apple.security.app-sandbox', 'true'],
  ['com.apple.security.network.client', 'true'],
  ['com.apple.security.files.user-selected.read-write', 'true'],
];
if (JSON.stringify(keys) !== JSON.stringify(EXPECTED_ENTITLEMENTS)) {
  fail(`Entitlements must be exactly app-sandbox, network.client and files.user-selected.read-write; found ${JSON.stringify(keys)}`);
}
if ((plist.match(/<key>/g) ?? []).length !== keys.length) fail('Entitlements.plist has entries this check does not understand');

// --- Rust dependencies -------------------------------------------------------
const cargoToml = readFileSync('src-tauri/Cargo.toml', 'utf8');
const section = (name) => new RegExp(`^\\[${name}\\]\\s*\\n([\\s\\S]*?)(?=^\\[|$(?![\\s\\S]))`, 'm').exec(cargoToml)?.[1] ?? '';
const depNames = (body) => [...body.matchAll(/^([A-Za-z0-9_-]+)\s*=/gm)].map((m) => m[1]);
// tauri (the app shell), age (encryption) and tauri-plugin-dialog (backup
// save/open panels, used from Rust only). Anything else needs a review entry
// in docs/ARCHITECTURE.md §13 and an update here.
if (JSON.stringify(depNames(section('dependencies'))) !== '["tauri","age","tauri-plugin-dialog"]') {
  fail('the only Rust dependencies may be tauri, age and tauri-plugin-dialog');
}
const dialogLine = /^tauri-plugin-dialog\s*=\s*\{([^}]*)\}/m.exec(section('dependencies'))?.[1] ?? '';
if (!/version\s*=\s*"=2\.8\.2"/.test(dialogLine) || !/default-features\s*=\s*false/.test(dialogLine) || !/(^|[\s,{])features\s*=\s*\["gtk3"\]/.test(dialogLine)) {
  fail('tauri-plugin-dialog must be pinned to =2.8.2 with only the gtk3 (Linux-only) feature');
}
const ageLine = /^age\s*=\s*\{([^}]*)\}/m.exec(section('dependencies'))?.[1] ?? '';
if (!/version\s*=\s*"=0\.12\.1"/.test(ageLine) || !/default-features\s*=\s*false/.test(ageLine) || /(^|[\s,{])features\s*=/.test(ageLine)) {
  fail('age must be pinned to =0.12.1 with no features');
}
if (JSON.stringify(depNames(section('build-dependencies'))) !== '["tauri-build"]') fail('the only build dependency may be tauri-build');
if (/^\[target\./m.test(cargoToml)) fail('platform-specific dependency sections are not allowed');
const tauriLine = /^tauri\s*=\s*\{([^}]*)\}/m.exec(section('dependencies'))?.[1] ?? '';
if (!/default-features\s*=\s*false/.test(tauriLine)) fail('tauri must use default-features = false');
const tauriFeatures = [.../features\s*=\s*\[([^\]]*)\]/.exec(tauriLine)?.[1].matchAll(/"([^"]+)"/g) ?? []].map((m) => m[1]);
for (const feature of tauriFeatures) {
  if (!['wry', 'compression'].includes(feature)) fail(`tauri feature "${feature}" is not allowed`);
}
if (/^default\s*=/m.test(section('features'))) fail('the crate must not enable features by default (smoke-test is CI-only)');

// Crates that make or accept network connections. Checked against what is
// actually compiled for macOS: Cargo.lock also lists iOS/Android-only crates
// (Tauri uses reqwest only on those platforms), which never ship here.
const NETWORK_CRATES = new Set([
  'reqwest', 'ureq', 'isahc', 'curl', 'curl-sys', 'attohttpc', 'surf', 'hyper', 'hyper-util', 'h2', 'h3',
  'quinn', 'tungstenite', 'tokio-tungstenite', 'native-tls', 'rustls', 'openssl', 'openssl-sys', 'mio',
  'socket2', 'tiny_http', 'axum', 'actix-web', 'warp', 'tauri-plugin-http', 'tauri-plugin-updater',
  'tauri-plugin-shell', 'tauri-plugin-opener', 'tauri-plugin-websocket', 'tauri-plugin-upload',
]);
// tauri-plugin-fs is compiled in as a library the dialog plugin uses
// internally. It must never be registered as a plugin (which would offer file
// commands); checked below together with the registered plugin list.
for (const target of ['aarch64-apple-darwin', 'x86_64-apple-darwin']) {
  let tree;
  try {
    tree = execFileSync(
      'cargo',
      ['tree', '--manifest-path', 'src-tauri/Cargo.toml', '--locked', '--target', target, '-e', 'normal', '--prefix', 'none', '-q'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch (error) {
    fail(`could not list Rust dependencies for ${target}: ${String(error.stderr ?? error.message).trim().split('\n').pop()}`);
    continue;
  }
  const crates = new Set(tree.split('\n').map((line) => line.split(' ')[0]).filter(Boolean));
  for (const crate of crates) if (NETWORK_CRATES.has(crate)) fail(`networking crate "${crate}" is compiled into the ${target} app`);
  if (crates.size < 10) fail(`suspiciously few crates listed for ${target}; is the dependency check working?`);
}

// --- Native commands ---------------------------------------------------------
// The window's only native capabilities. Adding one needs a review entry in
// docs/ARCHITECTURE.md §4 and an update here.
const ALLOWED_COMMANDS = [
  'vault_status', 'vault_create', 'vault_unlock', 'vault_save', 'vault_lock',
  'backup_create', 'restore_open', 'restore_commit', 'restore_cancel',
];
const mainRs = readFileSync('src-tauri/src/main.rs', 'utf8');
const plugins = [...mainRs.matchAll(/\.plugin\(([^)]*\))\)/g)].map((m) => m[1].replace(/\s+/g, ''));
if (JSON.stringify(plugins) !== JSON.stringify(['tauri_plugin_dialog::init()'])) {
  fail(`the only registered plugin may be tauri_plugin_dialog::init(); found ${plugins.join(', ') || 'none'}`);
}
if (/tauri_plugin_fs/.test(mainRs + readFileSync('src-tauri/src/commands.rs', 'utf8'))) fail('tauri_plugin_fs must not be used or registered');
const handlers = [...mainRs.matchAll(/generate_handler!\[([\s\S]*?)\]/g)];
const registered = handlers.flatMap((m) => m[1].split(',').map((c) => c.trim().replace(/^commands::/, '')).filter(Boolean));
if (handlers.length !== 1 || JSON.stringify(registered) !== JSON.stringify(ALLOWED_COMMANDS)) {
  fail(`native commands must be exactly ${ALLOWED_COMMANDS.join(', ')}; found ${registered.join(', ') || 'none'}`);
}

// --- Retired infrastructure --------------------------------------------------
if (existsSync('.github/workflows/deploy-pages.yml')) fail('the GitHub Pages deploy workflow was retired and must not return');

if (failures.length) {
  console.error(`Desktop configuration check FAILED (${failures.length}):`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log('Desktop configuration check passed (CSP, entitlements, only the dialog plugin, allowed commands, no networking crates).');
