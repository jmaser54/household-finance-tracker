#!/usr/bin/env bash
# CI (macOS). Verifies the release build you will install:
#  1. it is validly (ad-hoc) signed, contains Intel and Apple Silicon code,
#     and every part of it is compiled to run on macOS 12 Monterey,
#  2. its entitlements are exactly App Sandbox + network.client (which WebKit
#     needs to render; macOS therefore permits outgoing connections),
#  3. it contains no smoke-test code,
#  4. when launched normally and left running, neither it nor WebKit's
#     helper processes open any network connection,
#  5. a downloaded (quarantined) copy is assessed by Gatekeeper as expected
#     for an unsigned household build, i.e. it needs "Open Anyway" once.
set -euo pipefail

APP="src-tauri/target/universal-apple-darwin/release/bundle/macos/Household Money.app"
BIN="$(find "$APP/Contents/MacOS" -type f -perm -u+x | head -n 1)"

echo "== 1. Signature"
codesign --verify --deep --strict --verbose=2 "$APP"
codesign -dv "$APP" 2>&1 | grep -E '^(Identifier|Format|Signature)=' || true
codesign -dv "$APP" 2>&1 | grep -q '^Signature=adhoc' || { echo "Expected an ad-hoc signature." >&2; exit 1; }

echo "== 1b. Intel + Apple Silicon, and runs on macOS 12 Monterey"
ARCHS="$(lipo -archs "$BIN")"
echo "Architectures: $ARCHS"
for want in x86_64 arm64; do
  case " $ARCHS " in *" $want "*) ;; *) echo "Missing $want code." >&2; exit 1 ;; esac
done
PLIST_MIN="$(/usr/libexec/PlistBuddy -c 'Print :LSMinimumSystemVersion' "$APP/Contents/Info.plist")"
echo "Info.plist LSMinimumSystemVersion: $PLIST_MIN"
[ "$PLIST_MIN" = "12.0" ] || { echo "Expected LSMinimumSystemVersion 12.0." >&2; exit 1; }
for want in x86_64 arm64; do
  # The OS version each half was compiled for (LC_BUILD_VERSION minos).
  MINOS="$(otool -arch "$want" -l "$BIN" | awk '/LC_BUILD_VERSION/{f=1} f&&$1=="minos"{print $2; exit}')"
  echo "$want compiled for macOS $MINOS or later"
  [ -n "$MINOS" ] || { echo "Could not read the minimum OS of the $want code." >&2; exit 1; }
  python3 -c "import sys; v=tuple(map(int,'$MINOS'.split('.'))); sys.exit(0 if v <= (12,0) else 1)" \
    || { echo "The $want code requires macOS $MINOS, newer than Monterey 12." >&2; exit 1; }
done

echo "== 2. Entitlements"
codesign -d --entitlements - --xml "$APP" 2>/dev/null > /tmp/entitlements.plist
python3 - /tmp/entitlements.plist <<'PY'
import plistlib, sys
ents = plistlib.load(open(sys.argv[1], "rb"))
print(ents)
assert ents == {"com.apple.security.app-sandbox": True, "com.apple.security.network.client": True}, \
    "entitlements must be exactly App Sandbox + network.client"
PY

echo "== 3. No smoke-test code in the release binary"
if strings "$BIN" | grep -q 'SMOKE '; then echo "Release binary contains smoke-test code." >&2; exit 1; fi

echo "== 4. No network sockets while running"
open -n "$APP"
sleep 20
PID="$(pgrep -f "$BIN" | head -n 1 || true)"
test -n "$PID" || { echo "The app is not running after launch." >&2; exit 1; }
if lsof -nP -a -p "$PID" -i; then echo "The app holds network sockets." >&2; exit 1; fi
for helper in $(pgrep -f 'com.apple.WebKit' || true); do
  if lsof -nP -a -p "$helper" -i; then echo "A WebKit helper holds network sockets." >&2; exit 1; fi
done
kill "$PID"
echo "No sockets held by the app or WebKit helpers."

echo "== 5. Gatekeeper assessment of a downloaded copy"
GK="$(mktemp -d)"
ditto "$APP" "$GK/Household Money.app"
xattr -w com.apple.quarantine "0083;$(printf '%x' "$(date +%s)");Safari;" "$GK/Household Money.app"
if spctl --assess --type execute -vv "$GK/Household Money.app" 2>&1; then
  echo "Gatekeeper accepts the downloaded copy."
else
  echo "Gatekeeper rejects the downloaded copy on first open, as expected for an unsigned household build."
  echo "Install step: open it once, then System Settings > Privacy & Security > Open Anyway."
fi
echo "Release app verification passed."
