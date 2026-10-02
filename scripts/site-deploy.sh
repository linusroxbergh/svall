#!/bin/sh
# Builds the demo map from the app's code and copies the landing page in site/ to svall.dev. Only the files named
# here are sent, so the releases, appcast, latest.json and install.sh that release.sh puts beside them are never touched.
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
: "${SVALL_HOST:?set SVALL_HOST to the ssh host of the server}" "${SVALL_SITE_DIR:?set SVALL_SITE_DIR to the site folder on it}"
pnpm --dir "$ROOT" site:build
cd "$ROOT/site"
rsync -a index.html icon.svg icon-180.png map-grain.png lighthouse.svg fonts animals map shots "$SVALL_HOST:$SVALL_SITE_DIR/"
echo "deployed site/ to $SVALL_HOST:$SVALL_SITE_DIR"
