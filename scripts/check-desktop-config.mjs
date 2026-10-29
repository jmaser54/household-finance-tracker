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
if (security.freezePrototype !== true) fail('app.security.freezePrototype must be true');
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

// --- macOS entitlements ------------------------------------------------------
const plist = readFileSync('src-tauri/Entitlements.plist', 'utf8').replace(/<!--[\s\S]*?-->/g, '');
const keys = [...plist.matchAll(/<key>([^<]+)<\/key>\s*<(true|false)\/>/g)].map((m) => [m[1], m[2]]);
// network.client is required by WebKit to render at all inside the sandbox
// (Phase A finding). Nothing else is allowed, in particular not network.server.
const EXPECTED_ENTITLEMENTS = [
  ['com.apple.security.app-sandbox', 'true'],
  ['com.apple.security.network.client', 'true'],
];
if (JSON.stringify(keys) !== JSON.stringify(EXPECTED_ENTITLEMENTS)) {
  fail(`Entitlements must be exactly app-sandbox and network.client; found ${JSON.stringify(keys)}`);
}
if ((plist.match(/<key>/g) ?? []).length !== keys.length) fail('Entitlements.plist has entries this check does not understand');

// --- Rust dependencies -------------------------------------------------------
const cargoToml = readFileSync('src-tauri/Cargo.toml', 'utf8');
const section = (name) => new RegExp(`^\\[${name}\\]\\s*\\n([\\s\\S]*?)(?=^\\[|$(?![\\s\\S]))`, 'm').exec(cargoToml)?.[1] ?? '';
const depNames = (body) => [...body.matchAll(/^([A-Za-z0-9_-]+)\s*=/gm)].map((m) => m[1]);
if (JSON.stringify(depNames(section('dependencies'))) !== '["tauri"]') fail('the only Rust dependency may be tauri in this phase');
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
  'tauri-plugin-shell', 'tauri-plugin-opener', 'tauri-plugin-fs', 'tauri-plugin-websocket', 'tauri-plugin-upload',
]);
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

// --- Retired infrastructure --------------------------------------------------
if (existsSync('.github/workflows/deploy-pages.yml')) fail('the GitHub Pages deploy workflow was retired and must not return');

if (failures.length) {
  console.error(`Desktop configuration check FAILED (${failures.length}):`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log('Desktop configuration check passed (CSP, sandbox entitlements, no plugins, no networking crates).');
