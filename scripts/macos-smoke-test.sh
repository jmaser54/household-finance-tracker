#!/usr/bin/env bash
# CI-only (macOS). Runs the `smoke-test` build of the app, which reports two
# facts and quits: the bundled page finished loading, and an outbound TCP
# connection attempt from inside the app failed with "operation not
# permitted" (the App Sandbox denying network access). The output contains
# no data: only fixed SMOKE lines.
set -euo pipefail

APP="src-tauri/target/release/bundle/macos/Household Money.app"
BIN="$(find "$APP/Contents/MacOS" -type f -perm -u+x | head -n 1)"
CONTAINER="$HOME/Library/Containers/io.github.jmaser54.householdmoney"
OUT="$(mktemp)"

# Baseline: an ordinary (unsandboxed) process on this runner CAN connect, so a
# blocked result below is the sandbox, not a missing network.
if nc -z -G 5 1.1.1.1 443; then
  echo "Baseline: network reachable outside the sandbox."
else
  echo "Runner has no network; the sandbox network probe would be inconclusive." >&2
  exit 1
fi

"$BIN" >"$OUT" 2>&1 &
PID=$!
for _ in $(seq 1 90); do
  kill -0 "$PID" 2>/dev/null || break
  sleep 1
done
if kill -0 "$PID" 2>/dev/null; then
  kill "$PID"
  echo "The app did not finish its smoke run within 90 seconds. Output:" >&2
  cat "$OUT" >&2
  exit 1
fi

echo "--- app output ---"
cat "$OUT"
echo "------------------"
grep -Eq '^SMOKE page-loaded tauri://localhost/' "$OUT" || { echo "Bundled page did not load." >&2; exit 1; }
grep -Eq '^SMOKE network blocked-by-sandbox$' "$OUT" || { echo "Network was NOT blocked by the sandbox." >&2; exit 1; }
test -d "$CONTAINER" || { echo "No sandbox container was created; the sandbox may not be active." >&2; exit 1; }
echo "Smoke test passed: page loads inside the sandbox, and macOS blocks network access."
