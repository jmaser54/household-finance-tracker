#!/usr/bin/env bash
# CI-only (macOS). Runs the `smoke-test` build of the packaged, sandboxed app.
# Inside the real app window it checks, and reports with fixed SMOKE lines
# (never data), that:
#  - the bundled page loads inside the App Sandbox and renders (no error banner),
#  - creating (first run) or unlocking (second run) the household through the
#    real UI works, with a synthetic passphrase,
#  - encrypted saving works; saving while locked and a wrong passphrase are
#    refused; the saved data reopens intact,
#  - a backup can be made; a wrong passphrase cannot open it; restoring it
#    (in this CI-only build, from a fixed file instead of the panels) works,
#  - the data files are in the app's sandbox container, are age-encrypted, and
#    contain no plaintext marker,
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
  expect '^SMOKE probe render-ok$' "the app did not render (or showed its error banner)"
  expect '^SMOKE probe screen-(setup|unlock)$' "neither the passphrase setup nor the unlock screen was shown"
  expect '^SMOKE probe ui-opened$' "creating or unlocking the household through the UI did not reach the welcome screen"
  expect '^SMOKE probe reopen-ok$' "the household did not reopen after locking"
  expect '^SMOKE probe save-ok$' "saving failed"
  expect '^SMOKE probe save-locked-err-locked$' "saving while locked was not refused"
  expect '^SMOKE probe wrong-err-wrong_passphrase$' "a wrong passphrase was not refused"
  expect '^SMOKE probe unlock-ok$' "the saved change did not reopen intact"
  expect '^SMOKE probe backup-ok$' "making a backup failed"
  expect '^SMOKE probe restore-wrong-err-wrong_passphrase$' "a backup opened with a wrong passphrase"
  expect '^SMOKE probe restore-commit-without-open-err-no_pending_restore$' "a restore could be committed without opening a backup"
  expect '^SMOKE probe restore-open-ok$' "the backup did not open with the household passphrase, or its contents differed"
  expect '^SMOKE probe restore-commit-ok$' "the restore did not complete"
  expect '^SMOKE probe restored-ok$' "the restored data did not reopen intact"
  expect '^SMOKE file smoke-backup.hmbackup encrypted-ok$' "the backup file is missing, not age-encrypted, or shows plaintext"
  expect '^SMOKE file ledger.before-restore.age encrypted-ok$' "the pre-restore copy is missing, not age-encrypted, or shows plaintext"
  expect '^SMOKE data-in-container yes$' "the data folder is not inside the sandbox container"
  expect '^SMOKE file ledger.age encrypted-ok$' "ledger.age is missing, not age-encrypted, or shows plaintext"
  expect '^SMOKE file ledger.previous.age encrypted-ok$' "ledger.previous.age is missing, not age-encrypted, or shows plaintext"
  expect '^SMOKE probe fetch-blocked$' "the page was able to send a request to an outside site"
  expect '^SMOKE navigation refused https://example.com$' "navigation to an outside site was not refused"
  expect '^SMOKE probe done$' "the in-window checks did not finish"
done
test -d "$CONTAINER" || { echo "FAIL: no sandbox container was created" >&2; ok=false; }
[ "$ok" = true ] || exit 1
echo "Smoke test passed (arm64 and x86_64): renders in the sandbox; encrypted storage, backup and restore work; outside fetch and navigation are blocked."
