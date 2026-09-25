#!/bin/sh
# Builds GhosttyKit.xcframework and Ghostty's resources from the pinned submodule;
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
xcrun -sdk macosx metal --version >/dev/null 2>&1 || MISSING="$MISSING${MISSING:+
}✗ metal  Metal Toolchain missing: xcodebuild -downloadComponent MetalToolchain"
[ -z "$MISSING" ] || { echo "$MISSING" >&2; exit 1; }
[ "${1:-}" != --check ] || exit 0

# Apple libtool drops archive members that aren't 8-byte aligned; shim it out.
PATH="$ROOT/scripts/ghostty-libtool-shim:$PATH"
export PATH

cd "$GHOSTTY"
"$ZIG" build \
  -Demit-xcframework=true \
  -Dxcframework-target=native \
  -Demit-macos-app=false \
  -Dsentry=false \
  -Di18n=false \
  -Doptimize=ReleaseFast

[ -d "$GHOSTTY/macos/GhosttyKit.xcframework" ] || { echo "xcframework missing after build" >&2; exit 1; }
[ -f "$GHOSTTY/zig-out/share/terminfo/78/xterm-ghostty" ] || { echo "terminfo missing after build" >&2; exit 1; }

FAT_LIB="$(ls "$GHOSTTY"/macos/GhosttyKit.xcframework/*/libghostty-fat.a)"
nm -gU "$FAT_LIB" 2>/dev/null | grep -q ' T _ghostty_app_new' || {
  echo "libghostty-fat.a is missing ghostty symbols" >&2; exit 1; }

echo "GhosttyKit: $GHOSTTY/macos/GhosttyKit.xcframework"
