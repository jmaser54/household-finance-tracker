#!/usr/bin/env bash
# CI-only (macOS). Runs the `smoke-test` build of the packaged, sandboxed app.
# Inside the real app window it checks, and reports with fixed SMOKE lines
# (never data), that:
#  - the bundled page loads inside the App Sandbox,
#  - the welcome screen actually renders (heading, preview, no error banner),
#  - the page cannot fetch from an outside site (blocked by the CSP),
#  - the page cannot navigate to an outside site (refused by the app).
# Note: the sandbox grants network.client because WebKit needs it, so macOS
# itself would PERMIT a connection; these checks cover the app's own layers.
set -euo pipefail

APP="src-tauri/target/universal-apple-darwin/release/bundle/macos/Household Money.app"
BIN="$(find "$APP/Contents/MacOS" -type f -perm -u+x | head -n 1)"
CONTAINER="$HOME/Library/Containers/io.github.jmaser54.householdmoney"
# The app is universal (Intel + Apple Silicon). Run each half: arm64 natively,
# x86_64 under Rosetta, so the Intel code the household's 2017 MacBook Air
# runs is exercised too (on this runner's hardware, not a real Intel Mac).
ok=true
for ARCH in arm64 x86_64; do
  OUT="$(mktemp)"
  echo "== $ARCH"
  arch "-$ARCH" "$BIN" >"$OUT" 2>&1 &
  PID=$!
  for _ in $(seq 1 75); do
    kill -0 "$PID" 2>/dev/null || break
    sleep 1
  done
  if kill -0 "$PID" 2>/dev/null; then kill "$PID" || true; echo "(still running after 75 s; stopped)"; fi
  grep '^SMOKE ' "$OUT" || echo "(no SMOKE output)"
  expect() { grep -Eq "$1" "$OUT" || { echo "FAIL [$ARCH]: $2" >&2; ok=false; }; }
  expect '^SMOKE page-loaded tauri://localhost$' "the bundled page did not load inside the sandbox"
  expect '^SMOKE probe render-ok$' "the welcome screen did not render"
  expect '^SMOKE probe fetch-blocked$' "the page was able to send a request to an outside site"
  expect '^SMOKE navigation refused https://example.com$' "navigation to an outside site was not refused"
  expect '^SMOKE probe done$' "the in-window checks did not finish"
done
test -d "$CONTAINER" || { echo "FAIL: no sandbox container was created" >&2; ok=false; }
[ "$ok" = true ] || exit 1
echo "Smoke test passed (arm64 and x86_64): renders in the sandbox; outside fetch and navigation are blocked."
