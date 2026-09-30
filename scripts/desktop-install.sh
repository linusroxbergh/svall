#!/bin/sh
# Installs dependencies, downloads or builds GhosttyKit, builds Svall Dev.app, installs it to /Applications and restarts
# the daemon. Checks first and runs `svall setup` after the build when setup is missing or its
# hooks, shims or launchd agent are out of date or run another checkout, so a failed check or build leaves the machine untouched.
set -eu
# a character's shell names its own fleet, which may be the release's
unset SVALL_HOME SVALL_CHAR_ID
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
DEST="${SVALL_APP_DEST:-/Applications}"
HOME_DIR="$HOME/.svall-dev"

# one column, like the svall output it runs; colour only on a terminal that wants it
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  C="$(printf '\033[36m')" D="$(printf '\033[2m')" R="$(printf '\033[31m')" N="$(printf '\033[0m')"
  export FORCE_COLOR=1
else
  C= D= R= N=
fi
step() { printf '%s◇%s  %s\n' "$C" "$N" "$*"; }
bar() { printf '%s│%s\n' "$D" "$N"; }
fail() { printf '%s■%s  %s\n' "$R" "$N" "$*" >&2; exit 1; }
LOG="$(mktemp -t svall-install)"
# a step's own output goes to the log, which is shown only when the step fails
quiet() { "$@" >>"$LOG" 2>&1 || { tail -n 40 "$LOG" >&2; fail "$* failed; the whole log is $LOG"; }; }
printf '%s┌%s  Svall\n' "$C" "$N"; bar

# every check runs before the script stops, so one run lists all that is missing
MISSING=
missing() { MISSING="$MISSING
$*"; }

step "Checking your Mac"
MACOS="$(sw_vers -productVersion)"
[ "${MACOS%%.*}" -ge 15 ] || missing "✗ macos  Svall needs macOS 15 or newer (this is $MACOS)"
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
[ -w "$DEST" ] || missing "✗ app folder  $DEST is not writable: mkdir -p ~/Applications, then SVALL_APP_DEST=\$HOME/Applications pnpm desktop:install"

# GhosttyKit is downloaded for the Ghostty commit this checkout records, or built from source when none can be
BUILD_GHOSTTY=
if scripts/ghostty-kit.sh ahead; then
  step "Terminal engine: keeping GhosttyKit built from vendor/ghostty, a Ghostty bump not yet committed"
elif ! scripts/ghostty-kit.sh current; then
  step "Terminal engine: downloading GhosttyKit"
  if ! scripts/ghostty-kit.sh fetch >>"$LOG" 2>&1; then
    tail -n 20 "$LOG" >&2
    BUILD_GHOSTTY=1
    NO_KIT="✗ ghostty  no GhosttyKit could be downloaded (the reason is above; gh auth login fixes a signed-out gh)"
    if xcodebuild -license check >/dev/null 2>&1; then
      step "Terminal engine: building it from source instead (if gh is signed out, gh auth login and a rerun skip that)"
      step "Terminal engine: fetching Ghostty"
      git submodule update --init vendor/ghostty
      GHOSTTY_CHECK="$(scripts/ghostty-build.sh --check 2>&1)" || missing "$NO_KIT, and building it needs:
$GHOSTTY_CHECK"
    else
      missing "$NO_KIT, and building it needs Xcode 26 or newer, the Metal toolchain and zig: see Building Ghostty from source in the README"
    fi
  fi
fi

step "Installing packages"
quiet pnpm install --silent

# the setup checks need node_modules, so they come straight after the install and before any build
CHECK_OUT="$(mktemp -t svall-check)"
CHECK_OK=1
pnpm --silent svall -p private setup --check >"$CHECK_OUT" 2>&1 || CHECK_OK=
# this script runs setup after the build for each line that asks for it, so those lines say that instead
AFTER="out of date, will be updated after the build"
NEW="$AFTER"; [ -f "$HOME_DIR/config.json" ] || NEW="will be set up after the build"
sed -e "/: run svall-dev setup\$/{
s/$(printf '\033')\[33m!/$C!/
s/!/→/
s/missing or out of date: run svall-dev setup\$/$NEW/
s/out of date: run svall-dev setup\$/$AFTER/
}" "$CHECK_OUT"; bar
if [ -z "$CHECK_OK" ] || [ -n "$MISSING" ]; then
  [ -z "$MISSING" ] || printf '%s\n' "$MISSING" | sed '/^$/d' >&2
  fail "Nothing was changed. Fix the ✗ items above, then run pnpm desktop:install again."
fi

# uninstall keeps the fleet homes, so config.json alone would call a stripped machine set up;
# hooks, shims or a plist setup now writes differently are set up again, as nothing else rewrites them
SETUP=
if [ ! -f "$HOME_DIR/config.json" ] || [ ! -f "$HOME/Library/LaunchAgents/io.github.linusroxbergh.svall.dev.svalld.plist" ] || [ ! -f "$HOME/.local/bin/svall-dev" ]; then
  SETUP=1
fi
grep -q 'run svall-dev setup' "$CHECK_OUT" && SETUP=1
# setup is what starts the private fleet's agent, so one a failed start left unloaded gets another
launchctl print "gui/$(id -u)/io.github.linusroxbergh.svall.dev.svalld" >/dev/null 2>&1 || SETUP=1

if [ -n "$BUILD_GHOSTTY" ]; then
  step "Building GhosttyKit (several minutes)"
  quiet scripts/ghostty-build.sh
fi

step "Building the app (a few minutes)"
quiet pnpm --filter @svall/desktop-web build
# the phone page ships with every install, so the desktop's mobile switch only has to serve it
quiet pnpm --filter @svall/desktop-web build:mobile
quiet apps/desktop/mac/build.sh release

# app.pid outlives a crash, after which its pid can be another process's
is_app() { case "$(ps -p "$1" -o comm= 2>/dev/null)" in Svall | */Svall) return 0 ;; esac; return 1; }

# an open window stays the old bundle (svall only brings it to the front). Each is asked by its pid, as a quit sent
# to the bundle id can reach another window, and once: a second quit while it asks about unsaved edits would answer for the user
CLOSED=
for home in "$HOME"/.svall-dev "$HOME"/.svall-dev-*; do
  [ -f "$home/app.pid" ] || continue
  pid=$(cut -f1 "$home/app.pid")
  case "$pid" in '' | *[!0-9]*) continue ;; esac
  is_app "$pid" || continue
  [ -n "$CLOSED" ] || { step "Closing open windows"; CLOSED=1; }
  osascript -l JavaScript -e "ObjC.import('AppKit'); const a = \$.NSRunningApplication.runningApplicationWithProcessIdentifier($pid); if (!a.isNil() && !a.terminate) throw new Error('macOS did not pass the quit on')" >/dev/null \
    || fail "could not ask Svall to quit, so nothing was installed; quit it, then run pnpm desktop:install again"
  for _ in $(seq 60); do is_app "$pid" || break; sleep 1; done
  ! is_app "$pid" || fail "Svall did not quit within 60 s, so nothing was installed; quit it, then run pnpm desktop:install again"
done

step "Installing to $DEST"
rm -rf "$DEST/Svall Dev.app"
cp -R "apps/desktop/mac/build/Svall Dev.app" "$DEST/Svall Dev.app"
# Finder caches icons per bundle path; touching the bundle makes it re-read this build's
touch "$DEST/Svall Dev.app"

if [ -n "$SETUP" ]; then
  step "Setting up hooks, the daemon and the svall command"
  SETUP_OUT="$(mktemp -t svall-setup)"
  pnpm --silent svall -p private setup >"$SETUP_OUT" 2>&1 || { cat "$SETUP_OUT" >&2; fail "svall setup failed"; }
  cat "$SETUP_OUT" >>"$LOG"
  # its ! lines are the user's to act on
  grep '^! ' "$SETUP_OUT" | sed "s/^/${D}│${N}  /" || true
fi

step "Restarting svalld"
launchctl list | awk '$3 ~ /^io\.github\.linusroxbergh\.svall\.dev\.svalld/ { print $3 }' | while read -r label; do
  echo "    $label" >>"$LOG"
  launchctl kickstart -k "gui/$(id -u)/$label" >>"$LOG" 2>&1 || echo "    (kickstart failed for $label)" >>"$LOG"
done

step "$(pnpm --silent svall -p private agent)"
bar
printf '%s└%s  Installed. Open Svall Dev from Spotlight, or run svall-dev.\n' "$C" "$N"
command -v codex >/dev/null 2>&1 && printf '   If Codex asks to trust Svall'\''s hooks, choose "Trust all and continue".\n'
exit 0
