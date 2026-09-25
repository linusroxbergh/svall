#!/bin/sh
# Installs dependencies, downloads or builds GhosttyKit, builds Archipelago.app, installs it to /Applications and restarts
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
# the app builds with the Command Line Tools; only building Ghostty from source needs Xcode
SDK="$(xcrun --show-sdk-version 2>/dev/null || true)"
if [ -z "$SDK" ]; then
  case "$(xcode-select -p 2>/dev/null)" in
    *.app/*) missing "✗ xcode  license not accepted: open Xcode once, or sudo xcodebuild -license accept" ;;
    *) missing "✗ command line tools  missing: xcode-select --install" ;;
  esac
elif [ "${SDK%%.*}" -lt 26 ]; then
  case "$(xcode-select -p 2>/dev/null)" in
    *.app/*) missing "✗ xcode  the selected Xcode has the macOS $SDK SDK, older than 26: update it, or sudo xcode-select -s /Library/Developer/CommandLineTools" ;;
    *) missing "✗ command line tools  the macOS $SDK SDK is older than 26: update them in System Settings → General → Software Update" ;;
  esac
fi
[ -w "$DEST" ] || missing "✗ app folder  $DEST is not writable: mkdir -p ~/Applications, then ARCHI_APP_DEST=\$HOME/Applications pnpm desktop:install"

# GhosttyKit is downloaded for the Ghostty commit this checkout records, or built from source when none can be
BUILD_GHOSTTY=
if scripts/ghostty-kit.sh ahead; then
  echo "==> keeping GhosttyKit built from vendor/ghostty, a Ghostty bump not yet committed"
elif ! scripts/ghostty-kit.sh current; then
  echo "==> downloading GhosttyKit"
  if ! scripts/ghostty-kit.sh fetch; then
    BUILD_GHOSTTY=1
    NO_KIT="✗ ghostty  no GhosttyKit could be downloaded (the reason is above; gh auth login fixes a signed-out gh)"
    if xcodebuild -license check >/dev/null 2>&1; then
      echo "    building it from source instead (if gh is signed out, gh auth login and a rerun skip that)"
      echo "==> fetching Ghostty"
      git submodule update --init vendor/ghostty
      GHOSTTY_CHECK="$(scripts/ghostty-build.sh --check 2>&1)" || missing "$NO_KIT, and building it needs:
$GHOSTTY_CHECK"
    else
      missing "$NO_KIT, and building it needs Xcode 26 or newer, the Metal toolchain and zig: see Building Ghostty from source in the README"
    fi
  fi
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

if [ -n "$BUILD_GHOSTTY" ]; then
  echo "==> building GhosttyKit (several minutes)"
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
