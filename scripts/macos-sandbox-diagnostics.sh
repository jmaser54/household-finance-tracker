#!/usr/bin/env bash
# CI-only diagnostics (macOS), run only when the smoke test fails. Re-signs
# COPIES of the smoke-test app with different entitlements to isolate why the
# page does not load under the sandbox. Nothing here is shipped or uploaded,
# and the real entitlements file is not modified.
set -uo pipefail

SRC="src-tauri/target/release/bundle/macos/Household Money.app"
WORK="$(mktemp -d)"
echo "Signing flags of the Tauri-built bundle:"
codesign -dv "$SRC" 2>&1 | grep -E '^(CodeDirectory|Signature)' || true

variant() { # variant <name> <entitlement keys...>
  local name="$1"; shift
  local app="$WORK/$name/Household Money.app" plist="$WORK/$name.plist"
  mkdir -p "$WORK/$name" && ditto "$SRC" "$app"
  {
    echo '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict>'
    for key in "$@"; do echo "<key>$key</key><true/>"; done
    echo '</dict></plist>'
  } >"$plist"
  codesign --force --deep -s - --options runtime --entitlements "$plist" "$app" >/dev/null 2>&1
  local bin out pid
  bin="$(find "$app/Contents/MacOS" -type f -perm -u+x | head -n 1)"
  out="$(mktemp)"
  "$bin" >"$out" 2>&1 & pid=$!
  for _ in $(seq 1 60); do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
  kill "$pid" 2>/dev/null || true
  echo "== Variant: $name  [entitlements: ${*:-none}]"
  grep '^SMOKE ' "$out" | grep -v '^SMOKE setup$' || echo "(no SMOKE output)"
}

variant "bundle-no-sandbox"
variant "sandbox-only" com.apple.security.app-sandbox
variant "sandbox-plus-network-client" com.apple.security.app-sandbox com.apple.security.network.client
exit 0
