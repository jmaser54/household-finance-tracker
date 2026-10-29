#!/usr/bin/env bash
# CI-only (macOS). Runs the `smoke-test` build of the app, which prints fixed
# SMOKE progress lines (never data) and quits. It must show that:
#  - the bundled page finishes loading inside the App Sandbox, and
#  - an outbound TCP connection from inside the app is refused by macOS.
# A control run of the same binary WITHOUT the sandbox comes first, so a
# failure can be attributed to the sandbox or not.
set -euo pipefail

APP="src-tauri/target/release/bundle/macos/Household Money.app"
SANDBOXED_BIN="$(find "$APP/Contents/MacOS" -type f -perm -u+x | head -n 1)"
UNSANDBOXED_BIN="src-tauri/target/release/household-money" # linker-signed, no entitlements
CONTAINER="$HOME/Library/Containers/io.github.jmaser54.householdmoney"

run() { # run <label> <binary> <outfile>
  local label="$1" bin="$2" out="$3" pid
  echo "== $label"
  "$bin" >"$out" 2>&1 &
  pid=$!
  for _ in $(seq 1 75); do
    kill -0 "$pid" 2>/dev/null || break
    sleep 1
  done
  if kill -0 "$pid" 2>/dev/null; then
    kill "$pid" || true
    echo "(still running after 75 s; stopped)"
  fi
  grep '^SMOKE ' "$out" || echo "(no SMOKE output)"
}

# Baseline: an ordinary process on this runner CAN connect, so a blocked
# result below is the sandbox, not a missing network.
nc -z -G 5 1.1.1.1 443 || { echo "Runner has no network; the probe would be inconclusive." >&2; exit 1; }
echo "Baseline: network reachable outside the sandbox."

echo "Entitlements of the control binary (expected: none):"
codesign -d --entitlements - "$UNSANDBOXED_BIN" 2>&1 | tail -n +2 || true

CONTROL_OUT="$(mktemp)"
SANDBOX_OUT="$(mktemp)"
START="$(date '+%Y-%m-%d %H:%M:%S')"
run "Control: same app without the sandbox" "$UNSANDBOXED_BIN" "$CONTROL_OUT"
run "Sandboxed app bundle" "$SANDBOXED_BIN" "$SANDBOX_OUT"

ok=true
grep -Eq '^SMOKE page-loaded tauri://localhost/?$' "$SANDBOX_OUT" || { echo "FAIL: bundled page did not load in the sandbox." >&2; ok=false; }
grep -Eq '^SMOKE network blocked-by-sandbox$' "$SANDBOX_OUT" || { echo "FAIL: network was not blocked by the sandbox." >&2; ok=false; }
test -d "$CONTAINER" || { echo "FAIL: no sandbox container was created." >&2; ok=false; }

if [ "$ok" != true ]; then
  echo "== Sandbox denials logged for this app since $START (diagnostics)"
  log show --start "$START" --style compact \
    --predicate '(sender == "Sandbox" OR eventMessage CONTAINS "Sandbox") AND eventMessage CONTAINS "household-money"' 2>/dev/null \
    | tail -n 40 || true
  exit 1
fi
echo "Smoke test passed: the page loads inside the sandbox, and macOS blocks network access."
