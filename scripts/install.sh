#!/bin/sh
# Installs Svall from svall.dev: curl -fsSL https://svall.dev/install.sh | sh
set -eu
BASE="${SVALL_BASE_URL:-https://svall.dev}"
fail() { echo "svall install: $*" >&2; exit 1; }
[ "$(uname -s)" = Darwin ] || fail "Svall runs on macOS only"
[ "$(sysctl -n hw.optional.arm64 2>/dev/null)" = 1 ] || fail "Svall needs a Mac with Apple silicon"
[ "$(sw_vers -productVersion | cut -d. -f1)" -ge 15 ] || fail "Svall needs macOS 15 or newer"
DEST="${SVALL_INSTALL_DIR:-/Applications}"
[ -n "${SVALL_INSTALL_DIR:-}" ] || [ -w "$DEST" ] || DEST="$HOME/Applications"
mkdir -p "$DEST"
pgrep -f "$DEST/Svall.app/Contents/MacOS/Svall" >/dev/null && fail "quit Svall first, then run this again"

TMP="$(mktemp -d)"
trap 'hdiutil detach -quiet "$TMP/mnt" 2>/dev/null || true; rm -rf "$TMP" "$DEST/.Svall.app.new"' EXIT
curl -fsSL "$BASE/latest.json" -o "$TMP/latest.json"
field() { sed -n "s/.*\"$1\": *\"\{0,1\}\([^\",}]*\).*/\1/p" "$TMP/latest.json"; }
URL="$(field url)"; SHA="$(field sha256)"; VERSION="$(field version)"
[ -n "$URL" ] && [ -n "$SHA" ] || fail "latest.json names no download"
curl -fL --progress-bar "$URL" -o "$TMP/Svall.dmg"
echo "$SHA  $TMP/Svall.dmg" | shasum -a 256 -c - >/dev/null 2>&1 || fail "the download does not match its sha256"
mkdir "$TMP/mnt"
hdiutil attach -quiet -nobrowse -readonly -mountpoint "$TMP/mnt" "$TMP/Svall.dmg"
# the new copy is whole before the old one goes, so a failed copy leaves a working Svall
ditto "$TMP/mnt/Svall.app" "$DEST/.Svall.app.new"
rm -rf "$DEST/Svall.app" || fail "could not replace $DEST/Svall.app (macOS may ask to let your terminal manage apps); move it to the Trash and run this again"
mv "$DEST/.Svall.app.new" "$DEST/Svall.app"
echo "Installed Svall $VERSION in $DEST"
open "$DEST/Svall.app"
