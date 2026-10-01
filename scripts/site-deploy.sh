#!/bin/sh
# Copies the landing page in site/ to svall.dev. Only the files named here are sent, so the releases, appcast,
# latest.json and install.sh that release.sh puts beside them are never touched.
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/site"
: "${SVALL_HOST:?set SVALL_HOST to the ssh host of the server}" "${SVALL_SITE_DIR:?set SVALL_SITE_DIR to the site folder on it}"
rsync -a index.html icon.svg icon-180.png map-grain.png fonts animals "$SVALL_HOST:$SVALL_SITE_DIR/"
echo "deployed site/ to $SVALL_HOST:$SVALL_SITE_DIR"
