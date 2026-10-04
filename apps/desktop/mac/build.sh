#!/bin/sh
# Builds the shell with SwiftPM and assembles build.noindex/Svall Dev.app, or build.noindex/Svall.app with SVALL_VARIANT=release.
set -eu
MAC="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$MAC/../../.." && pwd)"
CONFIG="${1:-debug}"
VARIANT="${SVALL_VARIANT:-dev}"
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
# every hook and statusline refresh runs the helper, so a debug app still gets an optimised one
swift build -c release --arch "$ARCH" -Xcc -Wno-incomplete-umbrella --product svall-hook
HOOK="$(swift build -c release --arch "$ARCH" --show-bin-path)/svall-hook"

NAME="$([ "$VARIANT" = release ] && echo Svall || echo 'Svall Dev')"
# Spotlight skips a .noindex folder, so it never registers a build with LaunchServices, which lists it in Launchpad and Open With
APP="$MAC/build.noindex/$NAME.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources" "$APP/Contents/Helpers"
cp "$BIN" "$APP/Contents/MacOS/Svall"
# the binary links Sparkle, so every build carries it; only a build with a feed starts it
FRAMEWORK="$(dirname "$BIN")/Sparkle.framework"
mkdir -p "$APP/Contents/Frameworks"
rsync -a --delete "$FRAMEWORK" "$APP/Contents/Frameworks/"
otool -l "$APP/Contents/MacOS/Svall" | grep -q '@executable_path/../Frameworks' ||
  install_name_tool -add_rpath @executable_path/../Frameworks "$APP/Contents/MacOS/Svall"
cp "$MAC/Info.plist" "$APP/Contents/Info.plist"
"$MAC/variant-plist.sh" "$APP/Contents/Info.plist" "$VARIANT"
cp "$MAC/Svall.icns" "$APP/Contents/Resources/Svall.icns"
cp "$MAC/Resources/ghostty-theme" "$APP/Contents/Resources/ghostty-theme"
rsync -a --delete "$SHARE/ghostty" "$SHARE/terminfo" "$APP/Contents/Resources/"
if [ -d "$ROOT/apps/desktop/web/dist" ]; then
  rsync -a --delete "$ROOT/apps/desktop/web/dist/" "$APP/Contents/Resources/web/"
fi
# the commit count orders builds for the updater
BUILD="$(git -C "$ROOT" rev-list --count HEAD 2>/dev/null || echo 1)"
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion $BUILD" "$APP/Contents/Info.plist"
# a checkout's svalld copies the helper from here into its fleets, so it lands whole and signed
cp "$HOOK" "$APP/Contents/Helpers/svall-hook.tmp"
codesign --force --sign - "$APP/Contents/Helpers/svall-hook.tmp"
mv "$APP/Contents/Helpers/svall-hook.tmp" "$APP/Contents/Helpers/svall-hook"
codesign --force --sign - "$APP"
echo "$APP"
