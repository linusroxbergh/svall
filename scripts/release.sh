#!/bin/sh
# Builds, signs, notarizes and packages Svall into dist/, writes its appcast and latest.json, and uploads them to svall.dev.
# --adhoc does the same unsigned and stops before notarizing and uploading.
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
ADHOC=
for a in "$@"; do
  case "$a" in
    --) ;;
    --adhoc) ADHOC=1 ;;
    *) echo "release: usage: pnpm release [--adhoc]" >&2; exit 1 ;;
  esac
done
VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' apps/desktop/mac/Info.plist)"
BUILD="$(git rev-list --count HEAD)"
ID="${SVALL_SIGN_ID:-Developer ID Application}"
NOTARY="${SVALL_NOTARY_PROFILE:-svall-notary}"
fail() { echo "release: $*" >&2; exit 1; }
notarize() { xcrun notarytool submit "$1" --keychain-profile "$NOTARY" --wait | tee /dev/stderr | grep -q 'status: Accepted' || fail "notarization of $1 was not accepted"; }

if [ -z "$ADHOC" ]; then
  [ -z "$(git status --porcelain)" ] || fail "the tree has changes"
  [ "$(git rev-parse --abbrev-ref HEAD)" = main ] || fail "release from main"
  git rev-parse -q --verify "refs/tags/v$VERSION" >/dev/null && fail "v$VERSION is tagged already; bump CFBundleShortVersionString"
  : "${SVALL_HOST:?set SVALL_HOST to the ssh host of the server}" "${SVALL_SITE_DIR:?set SVALL_SITE_DIR to the site folder on it}"
  # Sparkle offers only a higher CFBundleVersion, and a commit count falls if history is ever rewritten
  PUBLISHED="$(curl -fsS https://svall.dev/latest.json 2>/dev/null | sed -n 's/.*.build.: *\([0-9]*\).*/\1/p')"
  [ -z "$PUBLISHED" ] || [ "$BUILD" -gt "$PUBLISHED" ] || fail "build $BUILD is not above the published $PUBLISHED, so no installed copy would update"
  rm -rf dist/releases && mkdir -p dist/releases
  rsync -a "$SVALL_HOST:$SVALL_SITE_DIR/releases/" dist/releases/
else
  ID=-
fi

pnpm app:build
APP=apps/desktop/mac/build/Svall.app
scripts/sign.sh "$APP" "$ID"
if [ -z "$ADHOC" ]; then
  ditto -c -k --keepParent "$APP" dist/Svall.zip
  notarize dist/Svall.zip
  xcrun stapler staple "$APP"
fi

DMG="dist/releases/Svall-$VERSION.dmg"
rm -rf dist/stage && mkdir -p dist/stage dist/releases
ditto "$APP" dist/stage/Svall.app
ln -s /Applications dist/stage/Applications
hdiutil create -quiet -volname Svall -srcfolder dist/stage -fs HFS+ -format UDZO -ov "$DMG"
if [ -z "$ADHOC" ]; then
  codesign --timestamp --sign "$ID" "$DMG"
  notarize "$DMG"
  xcrun stapler staple "$DMG"
  spctl -a -t open --context context:primary-signature -v "$DMG"
  # a copy marked as downloaded by a browser must still open under Gatekeeper
  cp "$DMG" dist/quarantined.dmg
  xattr -w com.apple.quarantine "0081;$(printf %x "$(date +%s)");Safari;" dist/quarantined.dmg
  MNT="$(mktemp -d)"
  hdiutil attach -quiet -nobrowse -readonly -mountpoint "$MNT" dist/quarantined.dmg
  spctl -a -vv "$MNT/Svall.app" || { hdiutil detach -quiet "$MNT"; fail "Gatekeeper refused the app in the DMG"; }
  hdiutil detach -quiet "$MNT"
  rm dist/quarantined.dmg
fi

SHA="$(shasum -a 256 "$DMG" | cut -d' ' -f1)"
printf '{"version":"%s","build":%s,"url":"https://svall.dev/releases/Svall-%s.dmg","sha256":"%s"}\n' "$VERSION" "$BUILD" "$VERSION" "$SHA" > dist/latest.json

if [ -z "$ADHOC" ]; then
  # the Svall.dmg link stays out while the appcast is made, so the latest release is listed once
  rm -f dist/releases/Svall.dmg
  "$(scripts/sparkle-tools.sh)/generate_appcast" --download-url-prefix https://svall.dev/releases/ dist/releases
  mv dist/releases/appcast.xml dist/appcast.xml
fi
ln -sf "Svall-$VERSION.dmg" dist/releases/Svall.dmg
if [ -n "$ADHOC" ]; then
  echo "dry run done: $DMG and dist/latest.json; no appcast, notarization or upload"
  exit 0
fi
# the DMG is in place before the feeds that name it
rsync -a "$DMG" "$SVALL_HOST:$SVALL_SITE_DIR/releases/"
rsync -a dist/releases "$SVALL_HOST:$SVALL_SITE_DIR/"
rsync -a dist/appcast.xml dist/latest.json scripts/install.sh "$SVALL_HOST:$SVALL_SITE_DIR/"
git tag "v$VERSION"
git push origin "v$VERSION"
echo "released Svall $VERSION ($BUILD)"
