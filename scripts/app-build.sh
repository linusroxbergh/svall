#!/bin/sh
# Builds apps/desktop/mac/build/Svall.app with its own Node, tmux, daemon and CLI inside, so it runs without a checkout.
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

scripts/ghostty-kit.sh current || scripts/ghostty-kit.sh ahead || scripts/ghostty-kit.sh fetch
pnpm --filter @svall/desktop-web build
pnpm --filter @svall/desktop-web build:mobile
node scripts/runtime-bundle.mjs
NODE="$(scripts/node-fetch.sh)"
TMUX="$(scripts/tmux-build.sh)"
apps/desktop/mac/build.sh release

APP="$ROOT/apps/desktop/mac/build/Svall.app"
mkdir -p "$APP/Contents/Helpers"
cp "$NODE" "$TMUX" "$APP/Contents/Helpers/"
rsync -a --delete apps/desktop/mac/build/runtime/ "$APP/Contents/Resources/runtime/"
# nested code is signed before the bundle that seals it
codesign --force --sign - "$APP/Contents/Helpers/node" "$APP/Contents/Helpers/tmux"
codesign --force --sign - "$APP"
echo "$APP"
