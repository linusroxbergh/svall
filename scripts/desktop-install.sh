#!/bin/sh
# Installs dependencies, downloads or builds GhosttyKit, builds Archipelago.app, installs it to /Applications and restarts
# the daemon. Checks first and runs `archi setup` after the build when setup is missing or its
# hooks, shims or launchd agent are out of date or run another checkout, so a failed check or build leaves the machine untouched.
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
# hooks, shims or a plist setup now writes differently are set up again, as nothing else rewrites them
SETUP=
if [ ! -f "$HOME_DIR/config.json" ] || [ ! -f "$HOME/Library/LaunchAgents/io.github.linusroxbergh.archipelago.archid.plist" ] || [ ! -f "$HOME/.local/bin/archi" ]; then
  SETUP=1
fi
case "$CHECK" in *"out of date: run archi setup"*) SETUP=1 ;; esac
# setup is what starts the private fleet's agent, so one a failed start left unloaded gets another
launchctl print "gui/$(id -u)/io.github.linusroxbergh.archipelago.archid" >/dev/null 2>&1 || SETUP=1

if [ -n "$BUILD_GHOSTTY" ]; then
  echo "==> building GhosttyKit (several minutes)"
  scripts/ghostty-build.sh
fi

echo "==> building"
pnpm --filter @archipelago/desktop-web build
# the phone page ships with every install, so the desktop's mobile switch only has to serve it
pnpm --filter @archipelago/desktop-web build:mobile
apps/desktop/mac/build.sh release >/dev/null

# app.pid outlives a crash, after which its pid can be another process's
is_app() { case "$(ps -p "$1" -o comm= 2>/dev/null)" in Archipelago | */Archipelago) return 0 ;; esac; return 1; }

# an open window stays the old bundle (archi only brings it to the front), and one under the old app id would write
# back the sign-ins setup moves. Each is asked by its pid, as a quit sent to the bundle id can reach another window,
# and once: a second quit while it asks about unsaved edits would answer for the user
echo "==> closing open windows"
for home in "$HOME"/.archipelago "$HOME"/.archipelago-*; do
  [ -f "$home/app.pid" ] || continue
  pid=$(cut -f1 "$home/app.pid")
  case "$pid" in '' | *[!0-9]*) continue ;; esac
  is_app "$pid" || continue
  osascript -l JavaScript -e "ObjC.import('AppKit'); const a = \$.NSRunningApplication.runningApplicationWithProcessIdentifier($pid); if (!a.isNil() && !a.terminate) throw new Error('macOS did not pass the quit on')" >/dev/null \
    || fail "could not ask Archipelago to quit, so nothing was installed; quit it, then run pnpm desktop:install again"
  for _ in $(seq 60); do is_app "$pid" || break; sleep 1; done
  ! is_app "$pid" || fail "Archipelago did not quit within 60 s, so nothing was installed; quit it, then run pnpm desktop:install again"
done

echo "==> installing to $DEST"
rm -rf "$DEST/Archipelago.app"
cp -R apps/desktop/mac/build/Archipelago.app "$DEST/Archipelago.app"
# Finder caches icons per bundle path; touching the bundle makes it re-read this build's
touch "$DEST/Archipelago.app"

# setup moves an older install's sign-ins only once the app installed reads them under the new id
if [ -n "$SETUP" ]; then
  echo "==> archi setup (Claude hooks, tmux.conf, launchd agent, ~/.local/bin/archi)"
  pnpm archi -p private setup
fi

echo "==> restarting archid"
launchctl list | awk '$3 ~ /^io\.github\.linusroxbergh\.archipelago\.archid/ { print $3 }' | while read -r label; do
  echo "    $label"
  launchctl kickstart -k "gui/$(id -u)/$label" || echo "    (kickstart failed for $label)"
done

echo "installed $DEST/Archipelago.app; run archi, or open it from Spotlight or Launchpad"
