#!/bin/sh
# Builds the shell with SwiftPM and assembles build/Svall.app.
set -eu
MAC="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$MAC/../../.." && pwd)"
CONFIG="${1:-debug}"
XC="$ROOT/vendor/ghostty-kit/GhosttyKit.xcframework"
SHARE="$ROOT/vendor/ghostty-kit/share"
[ -d "$XC" ] || { echo "GhosttyKit missing: scripts/ghostty-kit.sh fetch, or pnpm ghostty:build" >&2; exit 1; }
"$ROOT/scripts/ghostty-kit.sh" current 2>/dev/null || "$ROOT/scripts/ghostty-kit.sh" ahead 2>/dev/null ||
  echo "warning: vendor/ghostty-kit is not for the Ghostty commit HEAD records: scripts/ghostty-kit.sh fetch, or pnpm ghostty:build" >&2
ln -sfn "$XC" "$MAC/GhosttyKit.xcframework"

cd "$MAC"
# the Mac's own architecture, since swift in a Rosetta shell would build x86_64 against an arm64 GhosttyKit
ARCH="$([ "$(sysctl -n hw.optional.arm64 2>/dev/null)" = 1 ] && echo arm64 || echo x86_64)"
# GhosttyKit ships headers its umbrella header does not import; the warning is upstream noise
swift build -c "$CONFIG" --arch "$ARCH" -Xcc -Wno-incomplete-umbrella
BIN="$(swift build -c "$CONFIG" --arch "$ARCH" --show-bin-path)/Svall"

APP="$MAC/build/Svall.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/Svall"
cp "$MAC/Info.plist" "$APP/Contents/Info.plist"
cp "$MAC/Svall.icns" "$APP/Contents/Resources/Svall.icns"
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
