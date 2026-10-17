#!/bin/sh
# Builds apps/desktop/mac/build.noindex/Svall.app with its own Node, tmux, daemon and CLI inside, so it runs without a checkout.
set -eu
export SVALL_VARIANT=release
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

scripts/ghostty-kit.sh current || scripts/ghostty-kit.sh ahead || scripts/ghostty-kit.sh fetch
pnpm --filter @svall/desktop-web build
pnpm --filter @svall/desktop-web build:mobile
node scripts/runtime-bundle.mjs
NODE="$(scripts/node-fetch.sh)"
TMUX="$(scripts/tmux-build.sh)"
apps/desktop/mac/build.sh release

APP="$ROOT/apps/desktop/mac/build.noindex/Svall.app"
mkdir -p "$APP/Contents/Helpers"
cp "$NODE" "$TMUX" "$APP/Contents/Helpers/"
# the carried controller runs the app's own node, through a link release-scan never sees, so the app holds one copy
CARRIED="$APP/Contents/Resources/release/node/bin/node"
cmp -s "$NODE" "$CARRIED" ||
  { echo "the release carries another node than $NODE: pin one Node in scripts/node-fetch.sh and scripts/release/pins.json" >&2; exit 1; }
ln -sf ../../../../Helpers/node "$CARRIED"
rsync -a --delete apps/desktop/mac/build.noindex/runtime/ "$APP/Contents/Resources/runtime/"
SPARKLE="$(scripts/sparkle-tools.sh)"
node scripts/licenses.mjs "$(dirname "$NODE")" "$(dirname "$TMUX")" "$(dirname "$SPARKLE")" >/dev/null
# beside the NOTICE and licence texts build.sh put there
rsync -a apps/desktop/mac/build.noindex/licenses/ "$APP/Contents/Resources/Licenses/"
# nested code is signed before the bundle that seals it
codesign --force --sign - "$APP/Contents/Helpers/node" "$APP/Contents/Helpers/tmux"
codesign --force --sign - "$APP"
# a build LaunchServices knows can stand for the bundle id in place of the installed app, and take its Sparkle update;
# unregistering one it never saw fails, which is fine
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -u "$APP" 2>/dev/null || true
echo "$APP"
