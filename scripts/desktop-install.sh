#!/bin/sh
# Installs dependencies, downloads or builds GhosttyKit, builds Archipelago.app, installs the controller release it
# carries, copies the app to /Applications and restarts the daemon. Checks first, so a failed check or build leaves the
# machine untouched.
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
DEST="${ARCHI_APP_DEST:-/Applications}"

# one column, like the archi output it runs; colour only on a terminal that wants it
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  C="$(printf '\033[36m')" D="$(printf '\033[2m')" R="$(printf '\033[31m')" N="$(printf '\033[0m')"
  export FORCE_COLOR=1
else
  C= D= R= N=
fi
step() { printf '%s◇%s  %s\n' "$C" "$N" "$*"; }
bar() { printf '%s│%s\n' "$D" "$N"; }
fail() { printf '%s■%s  %s\n' "$R" "$N" "$*" >&2; exit 1; }
LOG="$(mktemp -t archipelago-install)"
# a step's own output goes to the log, which is shown only when the step fails
quiet() { "$@" >>"$LOG" 2>&1 || { tail -n 40 "$LOG" >&2; fail "$* failed; the whole log is $LOG"; }; }
printf '%s┌%s  Archipelago\n' "$C" "$N"; bar

# every check runs before the script stops, so one run lists all that is missing
MISSING=
missing() { MISSING="$MISSING
$*"; }

step "Checking your Mac"
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
CHECK_OUT="$(mktemp -t archipelago-check)"
CHECK_OK=1
pnpm --silent archi -p private setup --check --release apps/desktop/mac/build/Archipelago.app/Contents/Resources/release >"$CHECK_OUT" 2>&1 || CHECK_OK=
cat "$CHECK_OUT"; bar
if [ -z "$CHECK_OK" ] || [ -n "$MISSING" ]; then
  [ -z "$MISSING" ] || printf '%s\n' "$MISSING" | sed '/^$/d' >&2
  fail "Nothing was changed. Fix the ✗ items above, then run pnpm desktop:install again."
fi

if [ -n "$BUILD_GHOSTTY" ]; then
  step "Building GhosttyKit (several minutes)"
  quiet scripts/ghostty-build.sh
fi

step "Building the app (a few minutes)"
quiet pnpm --filter @archipelago/desktop-web build
# the phone page ships with every install, so the desktop's mobile switch only has to serve it
quiet pnpm --filter @archipelago/desktop-web build:mobile
quiet apps/desktop/mac/build.sh release

# app.pid outlives a crash, after which its pid can be another process's
is_app() { case "$(ps -p "$1" -o comm= 2>/dev/null)" in Archipelago | */Archipelago) return 0 ;; esac; return 1; }

# an open window stays the old bundle (archi only brings it to the front), and one under the old app id would write
# back the sign-ins setup moves. Each is asked by its pid, as a quit sent to the bundle id can reach another window,
# and once: a second quit while it asks about unsaved edits would answer for the user
CLOSED=
for home in "$HOME"/.archipelago "$HOME"/.archipelago-*; do
  [ -f "$home/app.pid" ] || continue
  pid=$(cut -f1 "$home/app.pid")
  case "$pid" in '' | *[!0-9]*) continue ;; esac
  is_app "$pid" || continue
  [ -n "$CLOSED" ] || { step "Closing open windows"; CLOSED=1; }
  osascript -l JavaScript -e "ObjC.import('AppKit'); const a = \$.NSRunningApplication.runningApplicationWithProcessIdentifier($pid); if (!a.isNil() && !a.terminate) throw new Error('macOS did not pass the quit on')" >/dev/null \
    || fail "could not ask Archipelago to quit, so nothing was installed; quit it, then run pnpm desktop:install again"
  for _ in $(seq 60); do is_app "$pid" || break; sleep 1; done
  ! is_app "$pid" || fail "Archipelago did not quit within 60 s, so nothing was installed; quit it, then run pnpm desktop:install again"
done

step "Installing to $DEST"
rm -rf "$DEST/Archipelago.app"
cp -R apps/desktop/mac/build/Archipelago.app "$DEST/Archipelago.app"
# Finder caches icons per bundle path; touching the bundle makes it re-read this build's
touch "$DEST/Archipelago.app"

# setup moves an older install's sign-ins only once the app installed reads them under the new id. The installed layout
# is what a published release uses, so a developer install exercises it too: the release the build just made goes under
# ~/.local/share/archipelago, and launchd, the Claude hooks and the shims are pointed at `current`. A workspace build
# carries no release signature.
step "Setting up the release, hooks, the daemon and the archi command"
SETUP_OUT="$(mktemp -t archipelago-setup)"
pnpm --silent archi -p private setup --allow-unsigned \
  --release apps/desktop/mac/build/Archipelago.app/Contents/Resources/release >"$SETUP_OUT" 2>&1 || { cat "$SETUP_OUT" >&2; fail "archi setup failed"; }
cat "$SETUP_OUT" >>"$LOG"
# its ! lines are the user's to act on
grep '^! ' "$SETUP_OUT" | sed "s/^/${D}│${N}  /" || true

# setup moved every fleet's agent onto current and reloaded the ones it rewrote; a daemon already on
# current still runs the release it started from until it is restarted
step "Restarting archid"
launchctl list | awk '$3 ~ /^io\.github\.linusroxbergh\.archipelago\.archid/ { print $3 }' | while read -r label; do
  echo "    $label" >>"$LOG"
  launchctl kickstart -k "gui/$(id -u)/$label" >>"$LOG" 2>&1 || echo "    (kickstart failed for $label)" >>"$LOG"
done

step "$(pnpm --silent archi -p private agent)"
bar
printf '%s└%s  Installed. Open Archipelago from Spotlight, or run archi.\n' "$C" "$N"
command -v codex >/dev/null 2>&1 && printf '   If Codex asks to trust Archipelago'\''s hooks, choose "Trust all and continue".\n'
exit 0
