#!/bin/sh
# Builds GhosttyKit.xcframework and Ghostty's resources from the pinned submodule into vendor/ghostty-kit;
# --check only lists what the build is missing.
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
GHOSTTY="$ROOT/vendor/ghostty"
[ -f "$GHOSTTY/build.zig" ] || git -C "$ROOT" submodule update --init vendor/ghostty
WANT="$(sed -nE 's/^[[:space:]]*\.minimum_zig_version[[:space:]]*=[[:space:]]*"([^"]+)".*/\1/p' "$GHOSTTY/build.zig.zon")"

ZIG="${ZIG:-}"
if [ -z "$ZIG" ] && command -v brew >/dev/null 2>&1 && [ -x "$(brew --prefix zig@0.15 2>/dev/null)/bin/zig" ]; then
  ZIG="$(brew --prefix zig@0.15)/bin/zig"
fi
[ -n "$ZIG" ] || ZIG="$(command -v zig || true)"
MISSING=
if [ -z "$ZIG" ]; then
  MISSING="✗ zig  $WANT not found: brew install zig@0.15"
else
  HAVE="$("$ZIG" version)"
  [ "$HAVE" = "$WANT" ] || MISSING="✗ zig  $HAVE found, Ghostty needs $WANT (brew install zig@0.15, or ZIG=/path/to/zig)"
fi
xcodebuild -license check >/dev/null 2>&1 || MISSING="$MISSING${MISSING:+
}✗ xcode  building Ghostty needs Xcode 26 or newer, selected with xcode-select and its license accepted"
xcrun -sdk macosx metal --version >/dev/null 2>&1 || MISSING="$MISSING${MISSING:+
}✗ metal  Metal Toolchain missing: xcodebuild -downloadComponent MetalToolchain"
[ -z "$MISSING" ] || { echo "$MISSING" >&2; exit 1; }
[ "${1:-}" != --check ] || exit 0

# Apple libtool drops archive members that aren't 8-byte aligned; shim it out.
PATH="$ROOT/scripts/ghostty-libtool-shim:$PATH"
export PATH

cd "$GHOSTTY"
# Ghostty 1.3.1 always builds libghostty-vt, which the app doesn't use and which fails on the macOS 27 SDK,
# so the checks below judge the build; removing earlier outputs keeps them from passing those checks
rm -rf macos/GhosttyKit.xcframework zig-out
# changing what this builds needs REV bumped in ghostty-kit.sh, so checkouts replace their kit
"$ZIG" build \
  -Demit-xcframework=true \
  -Dxcframework-target=native \
  -Demit-macos-app=false \
  -Dsentry=false \
  -Di18n=false \
  -Doptimize=ReleaseFast || echo "zig build failed; checking whether it still built GhosttyKit" >&2

[ -d "$GHOSTTY/macos/GhosttyKit.xcframework" ] || { echo "xcframework missing after build" >&2; exit 1; }
[ -f "$GHOSTTY/zig-out/share/terminfo/78/xterm-ghostty" ] || { echo "terminfo missing after build" >&2; exit 1; }
[ -d "$GHOSTTY/zig-out/share/ghostty/shell-integration" ] || { echo "shell integration missing after build" >&2; exit 1; }

# build.sh links for the Mac's own architecture; zig builds for its own, whatever the shell's
ARCH="$([ "$(sysctl -n hw.optional.arm64 2>/dev/null)" = 1 ] && echo arm64 || echo x86_64)"
FAT_LIB="$GHOSTTY/macos/GhosttyKit.xcframework/macos-$ARCH/libghostty-fat.a"
[ -f "$FAT_LIB" ] || { echo "GhosttyKit has no macos-$ARCH library: build with a zig for this Mac's architecture" >&2; exit 1; }
nm -gU "$FAT_LIB" 2>/dev/null | grep -q ' T _ghostty_app_new' || {
  echo "libghostty-fat.a is missing ghostty symbols" >&2; exit 1; }

# the app builds against vendor/ghostty-kit, which this build or a downloaded kit fills
KIT="$ROOT/vendor/ghostty-kit"
# the stamp goes first and is written last, so an interrupted copy leaves a kit that ghostty-kit.sh current refuses
rm -f "$KIT/version"
rm -rf "$KIT"
mkdir -p "$KIT/share"
cp -R "$GHOSTTY/macos/GhosttyKit.xcframework" "$KIT/"
cp -R "$GHOSTTY/zig-out/share/ghostty" "$GHOSTTY/zig-out/share/terminfo" "$KIT/share/"
REV="$(sed -n 's/^REV=//p' "$ROOT/scripts/ghostty-kit.sh")"
BUILT="$(git -C "$GHOSTTY" rev-parse HEAD)"
echo "$BUILT-r$REV" > "$KIT/version"
echo "GhosttyKit: $KIT"
