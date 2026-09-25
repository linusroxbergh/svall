#!/bin/sh
# Installs dependencies, builds Archipelago.app, installs it to /Applications and restarts
# the daemon. Checks first and runs `archi setup` after the build when setup is missing or its
# hooks or shims are out of date, so a failed check or build leaves the machine untouched.
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
DEST="${ARCHI_APP_DEST:-/Applications}"
HOME_DIR="$HOME/.archipelago"
fail() { echo "$*" >&2; exit 1; }
# every check runs before the script stops, so one run lists all that is missing
MISSING=
missing() { MISSING="$MISSING
$*"; }

MACOS="$(sw_vers -productVersion)"
[ "${MACOS%%.*}" -ge 15 ] || missing "✗ macos  Archipelago needs macOS 15 or newer (this is $MACOS)"
if ! xcodebuild -license check >/dev/null 2>&1; then
  case "$(xcode-select -p 2>/dev/null)" in
    *.app/*) missing "✗ xcode  license not accepted: open Xcode once, or sudo xcodebuild -license accept" ;;
    *) missing "✗ xcode  missing or not selected: install Xcode, then sudo xcode-select -s /Applications/Xcode.app" ;;
  esac
fi
[ -w "$DEST" ] || missing "✗ app folder  $DEST is not writable: mkdir -p ~/Applications, then ARCHI_APP_DEST=\$HOME/Applications pnpm desktop:install"

if [ ! -d vendor/ghostty/macos/GhosttyKit.xcframework ]; then
  [ -f vendor/ghostty/build.zig ] || { echo "==> fetching Ghostty (first time only)"; git submodule update --init vendor/ghostty; }
  GHOSTTY_CHECK="$(scripts/ghostty-build.sh --check 2>&1)" || missing "$GHOSTTY_CHECK"
fi

echo "==> pnpm install"
pnpm install --silent

# the setup checks need node_modules, so they come straight after the install and before any build
CHECK="$(pnpm --silent archi -p private setup --check 2>&1)" || missing "$(echo "$CHECK" | sed '/fix these first:$/d')"
[ -z "$MISSING" ] || fail "nothing was changed; fix these first:$MISSING"
echo "$CHECK"

# uninstall keeps the fleet homes, so config.json alone would call a stripped machine set up;
# hooks or shims setup now writes differently are set up again, as nothing else rewrites them
SETUP=
if [ ! -f "$HOME_DIR/config.json" ] || [ ! -f "$HOME/Library/LaunchAgents/com.archipelago.archid.plist" ] || [ ! -f "$HOME/.local/bin/archi" ]; then
  SETUP=1
fi
case "$CHECK" in *"out of date: run archi setup"*) SETUP=1 ;; esac

if [ ! -d vendor/ghostty/macos/GhosttyKit.xcframework ]; then
  echo "==> building GhosttyKit (first time only, several minutes)"
  scripts/ghostty-build.sh
fi

echo "==> building"
pnpm --filter @archipelago/desktop-web build
# the phone page ships with every install, so the desktop's mobile switch only has to serve it
pnpm --filter @archipelago/desktop-web build:mobile
apps/desktop/mac/build.sh release >/dev/null

if [ -n "$SETUP" ]; then
  echo "==> archi setup (Claude hooks, tmux.conf, launchd agent, ~/.local/bin/archi)"
  pnpm archi -p private setup
fi

echo "==> installing to $DEST"
rm -rf "$DEST/Archipelago.app"
cp -R apps/desktop/mac/build/Archipelago.app "$DEST/Archipelago.app"
# Finder caches icons per bundle path; touching the bundle makes it re-read this build's
touch "$DEST/Archipelago.app"

echo "==> restarting archid"
launchctl list | awk '$3 ~ /^com\.archipelago\.archid/ { print $3 }' | while read -r label; do
  echo "    $label"
  launchctl kickstart -k "gui/$(id -u)/$label" || echo "    (kickstart failed for $label)"
done

# a window left open is still the old bundle, and archi would only bring it to the front.
# each quit event reaches one instance, so this asks again until every fleet's window is gone.
echo "==> closing open windows"
for _ in 1 2 3 4 5 6 7 8 9 10; do
  live=
  for home in "$HOME"/.archipelago "$HOME"/.archipelago-*; do
    [ -f "$home/app.pid" ] || continue
    pid=$(cut -f1 "$home/app.pid")
    kill -0 "$pid" 2>/dev/null || continue
    live=1
    break
  done
  [ -n "$live" ] || break
  osascript -e 'tell application id "com.archipelago.desktop" to quit' >/dev/null 2>&1 || true
  sleep 1
done

echo "installed $DEST/Archipelago.app; run archi, or open it from Spotlight or Launchpad"
