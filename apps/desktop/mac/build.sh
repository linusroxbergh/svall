#!/bin/sh
# Builds the shell with SwiftPM and assembles build/Archipelago.app.
set -eu
MAC="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$MAC/../../.." && pwd)"
CONFIG="${1:-debug}"
XC="$ROOT/vendor/ghostty/macos/GhosttyKit.xcframework"
SHARE="$ROOT/vendor/ghostty/zig-out/share"
[ -d "$XC" ] || { echo "GhosttyKit missing: pnpm ghostty:build" >&2; exit 1; }
ln -sfn "$XC" "$MAC/GhosttyKit.xcframework"

cd "$MAC"
# GhosttyKit ships headers its umbrella header does not import; the warning is upstream noise
swift build -c "$CONFIG" -Xcc -Wno-incomplete-umbrella
BIN="$(swift build -c "$CONFIG" --show-bin-path)/Archipelago"

APP="$MAC/build/Archipelago.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/Archipelago"
cp "$MAC/Info.plist" "$APP/Contents/Info.plist"
cp "$MAC/Archipelago.icns" "$APP/Contents/Resources/Archipelago.icns"
cp "$MAC/Resources/ghostty-theme" "$APP/Contents/Resources/ghostty-theme"
rsync -a --delete "$SHARE/ghostty" "$SHARE/terminfo" "$APP/Contents/Resources/"
if [ -d "$ROOT/apps/desktop/web/dist" ]; then
  rsync -a --delete "$ROOT/apps/desktop/web/dist/" "$APP/Contents/Resources/web/"
fi
# the build the bundle came from, for a bug report to name
BUILD="$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || date +%Y%m%d%H%M%S)"
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion $BUILD" "$APP/Contents/Info.plist"
codesign --force --sign - "$APP"
echo "$APP"
