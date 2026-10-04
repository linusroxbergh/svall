#!/bin/sh
# Installs Svall from svall.dev: curl -fsSL https://svall.dev/install.sh | sh
set -eu
BASE="${SVALL_BASE_URL:-https://svall.dev}"
TEAM=W76DRQ3JZN
TTY= C= D= R= N= SPINNER=
if [ -t 2 ] && [ "${TERM:-}" != dumb ]; then
  TTY=1
  if [ -z "${NO_COLOR:-}" ]; then
    C="$(printf '\033[36m')" D="$(printf '\033[2m')" R="$(printf '\033[31m')" N="$(printf '\033[0m')"
  fi
fi
stop_spinner() {
  if [ -n "$SPINNER" ]; then
    kill "$SPINNER" 2>/dev/null || true
    wait "$SPINNER" 2>/dev/null || true
    SPINNER=
    printf '\r\033[2K' >&2
  fi
}
fail() { stop_spinner; printf '%s■%s  %s\n' "$R" "$N" "$*" >&2; exit 1; }
step() { printf '%s◇%s  %s\n' "$C" "$N" "$*" >&2; }
bar() { printf '%s│%s\n' "$D" "$N" >&2; }
printf '\n%s┌%s  Svall\n' "$C" "$N" >&2; bar
[ "$(uname -s)" = Darwin ] || fail "Svall runs on macOS only"
[ "$(sysctl -n hw.optional.arm64 2>/dev/null)" = 1 ] || fail "Svall needs a Mac with Apple silicon"
[ "$(sw_vers -productVersion | cut -d. -f1)" -ge 15 ] || fail "Svall needs macOS 15 or newer"
DEST="${SVALL_INSTALL_DIR:-/Applications}"
[ -n "${SVALL_INSTALL_DIR:-}" ] || [ -w "$DEST" ] || DEST="$HOME/Applications"
mkdir -p "$DEST" || fail "could not create $DEST; choose a writable folder with SVALL_INSTALL_DIR"
pgrep -f "$DEST/Svall.app/Contents/MacOS/Svall" >/dev/null && fail "quit Svall first, then run this again"

TMP="$(mktemp -d)"
LOCK=
cleanup() {
  set +e
  stop_spinner
  hdiutil detach -quiet "$TMP/mnt" 2>/dev/null || true
  if [ -n "$LOCK" ]; then
    # A stopped rename must leave the previous app launchable, not only a hidden backup.
    if [ ! -e "$DEST/Svall.app" ] && [ -e "$DEST/.Svall.app.old" ]; then
      mv "$DEST/.Svall.app.old" "$DEST/Svall.app" || printf 'Restore %s/.Svall.app.old to Svall.app before trying again.\n' "$DEST" >&2
    fi
    rm -rf "$DEST/.Svall.app.new"
    rmdir "$DEST/.Svall.install-lock" 2>/dev/null || true
  fi
  rm -rf "$TMP"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP
trap 'exit 131' QUIT
mkdir "$DEST/.Svall.install-lock" 2>/dev/null || {
  [ -d "$DEST/.Svall.install-lock" ] && fail "another install is using $DEST; if it was interrupted, remove $DEST/.Svall.install-lock and try again"
  fail "could not write to $DEST; choose a writable folder with SVALL_INSTALL_DIR"
}
LOCK=1
LOG="$TMP/install.log"
task() {
  label="$1"; shift
  if [ -n "$TTY" ]; then
    (
      while :; do
        for frame in '◐' '◓' '◑' '◒'; do
          printf '\r%s%s%s  %s…' "$C" "$frame" "$N" "$label" >&2
          sleep 0.15
        done
      done
    ) &
    SPINNER=$!
  else
    step "$label"
  fi
  if "$@" >"$LOG" 2>&1; then
    stop_spinner
    [ -z "$TTY" ] || step "$label"
  else
    stop_spinner
    cat "$LOG" >&2
    fail "$label failed; see above and try again."
  fi
}
step "Mac ready"
task "Finding the latest release" curl -fsSL --retry 3 --connect-timeout 15 --max-time 60 "$BASE/latest.json" -o "$TMP/latest.json"
field() { sed -n "s/.*\"$1\": *\"\{0,1\}\([^\",}]*\).*/\1/p" "$TMP/latest.json"; }
URL="$(field url)"; SHA="$(field sha256)"; VERSION="$(field version)"
[ -n "$URL" ] && [ -n "$SHA" ] || fail "latest.json names no download"
step "Downloading Svall ${VERSION:-release}"
PROGRESS=--silent
[ -z "$TTY" ] || PROGRESS=--progress-bar
curl -fL "$PROGRESS" --show-error --retry 3 --connect-timeout 15 --speed-limit 1024 --speed-time 60 "$URL" -o "$TMP/Svall.dmg" || fail "could not download Svall; check your connection and try again"
checksum() { echo "$SHA  $TMP/Svall.dmg" | shasum -a 256 -c - >/dev/null 2>&1 || { printf 'The download does not match its sha256; try again to download a fresh copy.\n' >&2; return 1; }; }
task "Checking the download" checksum
mkdir "$TMP/mnt"
task "Opening the disk image" hdiutil attach -quiet -nobrowse -readonly -mountpoint "$TMP/mnt" "$TMP/Svall.dmg"
# curl sets no quarantine flag, so Gatekeeper never sees this download: check its signature and notarization here
APP="$TMP/mnt/Svall.app"
signature() { codesign --verify --deep --strict "$APP" 2>/dev/null \
  && codesign -dv "$APP" 2>&1 | grep -qx "TeamIdentifier=$TEAM" \
  && spctl --assess --type execute "$APP" 2>/dev/null \
  || { printf 'The download is not Svall as signed by its developer and notarized by Apple.\n' >&2; return 1; }; }
task "Verifying Apple's notarization and developer signature" signature
install_app() {
  if [ ! -e "$DEST/Svall.app" ] && [ -e "$DEST/.Svall.app.old" ]; then mv "$DEST/.Svall.app.old" "$DEST/Svall.app" || return 1; fi
  rm -rf "$DEST/.Svall.app.new" || return 1
  ditto "$APP" "$DEST/.Svall.app.new" || return 1
  rm -rf "$DEST/.Svall.app.old" || {
    printf 'Remove %s/.Svall.app.old, a copy of the previous app, then try again.\n' "$DEST" >&2
    return 1
  }
  [ ! -e "$DEST/Svall.app" ] || mv "$DEST/Svall.app" "$DEST/.Svall.app.old" || {
    printf 'macOS may ask to let your terminal manage apps; allow it, then try again.\n' >&2
    return 1
  }
  mv "$DEST/.Svall.app.new" "$DEST/Svall.app" || return 1
  rm -rf "$DEST/.Svall.app.old" || true
}
task "Installing to $DEST" install_app
bar
if open "$DEST/Svall.app"; then
  printf '%s└%s  Installed Svall %s. Opening the app.\n\n' "$C" "$N" "$VERSION" >&2
else
  printf '%s└%s  Installed Svall %s. Open it from %s.\n\n' "$C" "$N" "$VERSION" "$DEST" >&2
fi
