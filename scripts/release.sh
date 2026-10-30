#!/bin/sh
# Builds, signs, notarizes and packages Svall into dist/, publishes the DMG as a GitHub release, and uploads the appcast and
# latest.json that name it to svall.dev.
# SVALL_RELEASE_KEY, which only --adhoc goes without, signs the controller and companions the app carries.
# --adhoc does the same unsigned and stops before notarizing and uploading. SVALL_NOTES names a Markdown file the update
# dialog shows as this version's notes, above those of every release since the installed one.
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
REPO=linusroxbergh/svall
DOWNLOADS="https://github.com/$REPO/releases/download/v$VERSION"
fail() { echo "release: $*" >&2; exit 1; }
notarize() { xcrun notarytool submit "$1" --keychain-profile "$NOTARY" --wait | tee /dev/stderr | grep -q 'status: Accepted' || fail "notarization of $1 was not accepted"; }
NOTES="${SVALL_NOTES:-}"
[ -z "$NOTES" ] || [ -f "$NOTES" ] || fail "SVALL_NOTES names no file: $NOTES"
# the DMG's window is laid out by Finder, so a terminal Finder will not answer stops here rather than after notarizing
osascript -e 'tell application "Finder" to get name of startup disk' >/dev/null ||
  fail "this terminal may not control Finder; allow it in System Settings > Privacy & Security > Automation"

if [ -z "$ADHOC" ]; then
  [ -z "$(git status --porcelain)" ] || fail "the tree has changes"
  [ "$(git rev-parse --abbrev-ref HEAD)" = main ] || fail "release from main"
  git fetch -q origin main || fail "could not fetch main from origin"
  [ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] || fail "main is not at origin/main; pull, or push what origin lacks"
  git rev-parse -q --verify "refs/tags/v$VERSION" >/dev/null && fail "v$VERSION is tagged already; bump CFBundleShortVersionString"
  # ls-remote exits 2 when origin has no such tag, and 128 when origin cannot be reached
  TAGGED=0
  git ls-remote --exit-code --tags origin "refs/tags/v$VERSION" >/dev/null || TAGGED=$?
  [ "$TAGGED" -ne 0 ] || fail "v$VERSION is tagged on origin already; bump CFBundleShortVersionString"
  [ "$TAGGED" -eq 2 ] || fail "could not read the tags on origin"
  for k in SUFeedURL SUPublicEDKey SUEnableAutomaticChecks SUAutomaticallyUpdate; do
    [ -n "$(/usr/libexec/PlistBuddy -c "Print :$k" apps/desktop/mac/Info.plist 2>/dev/null)" ] ||
      fail "apps/desktop/mac/Info.plist has no $k; make the key with generate_keys, in the folder scripts/sparkle-tools.sh prints, then add SUFeedURL, SUPublicEDKey, SUEnableAutomaticChecks and SUAutomaticallyUpdate"
  done
  # installed copies take only updates signed by this key, and generate_appcast signs with the one in the keychain
  [ "$("$(scripts/sparkle-tools.sh)/generate_keys" -p)" = "$(/usr/libexec/PlistBuddy -c 'Print :SUPublicEDKey' apps/desktop/mac/Info.plist)" ] ||
    fail "SUPublicEDKey in apps/desktop/mac/Info.plist is not the key generate_keys -p prints, so this release could never update itself"
  # the controller and companions the app carries are signed with a key scripts/release/allowed_signers lists
  : "${SVALL_RELEASE_KEY:?set SVALL_RELEASE_KEY to the release signing key; see docs/integration.md}"
  node -e 'import(process.argv[1]).then((m) => m.releaseKey())' "$ROOT/scripts/release-stage.mjs" ||
    fail "SVALL_RELEASE_KEY cannot sign this release"
  : "${SVALL_HOST:?set SVALL_HOST to the ssh host of the server}" "${SVALL_SITE_DIR:?set SVALL_SITE_DIR to the site folder on it}"
  gh auth status >/dev/null 2>&1 || fail "gh is not signed in, and the DMG is published as a GitHub release; run gh auth login"
  # the server is first used after notarizing, so one that does not answer stops the release here
  ssh "$SVALL_HOST" "test -d '$SVALL_SITE_DIR/releases'" || fail "$SVALL_HOST did not answer, or has no $SVALL_SITE_DIR/releases"
  # Sparkle offers only a higher CFBundleVersion, and a commit count falls if history is ever rewritten
  LATEST="$(curl -sS -w '\n%{http_code}' https://svall.dev/latest.json)" || fail "could not read https://svall.dev/latest.json"
  case "$(printf '%s\n' "$LATEST" | tail -n 1)" in
    200) PUBLISHED="$(printf '%s\n' "$LATEST" | sed -n 's/.*.build.: *\([0-9]*\).*/\1/p')" ;;
    404) PUBLISHED= ;;
    *) fail "could not read https://svall.dev/latest.json" ;;
  esac
  [ -z "$PUBLISHED" ] || [ "$BUILD" -gt "$PUBLISHED" ] || fail "build $BUILD is not above the published $PUBLISHED, so no installed copy would update"
  # the appcast is made from this build alone, so nothing from the server or a dry run is signed with the Sparkle key
  rm -rf dist/releases && mkdir -p dist/releases
else
  ID=-
fi

# the runtime bundles node_modules, which must be what the lockfile names
pnpm install --frozen-lockfile
# the controller the app carries is named the tag its companions are published under
SVALL_RELEASE_NAME="v$VERSION" pnpm app:build
APP=apps/desktop/mac/build.noindex/Svall.app
scripts/sign.sh "$APP" "$ID"
# the app, hardened and entitled as it ships, sets itself up, refreshes and uninstalls in a throwaway home
scripts/app-smoke.sh "$APP"
if [ -z "$ADHOC" ]; then
  ditto -c -k --keepParent "$APP" dist/Svall.zip
  notarize dist/Svall.zip
  xcrun stapler staple "$APP"
fi
# signing and the smoke test touch the bundle again, so it is unregistered as app-build.sh leaves it
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -u "$APP" 2>/dev/null || true

DMG="dist/releases/Svall-$VERSION.dmg"
mkdir -p dist/releases
scripts/dmg/build.sh "$APP" "$DMG"
if [ -z "$ADHOC" ]; then
  codesign --timestamp --sign "$ID" "$DMG"
  notarize "$DMG"
  xcrun stapler staple "$DMG"
  spctl -a -t open --context context:primary-signature -v "$DMG"
  # a copy marked as downloaded by a browser must still open under Gatekeeper
  MNT="$(mktemp -d)"
  trap 'hdiutil detach -quiet "$MNT" 2>/dev/null || true; rmdir "$MNT" 2>/dev/null || true; rm -f dist/quarantined.dmg' EXIT
  cp "$DMG" dist/quarantined.dmg
  xattr -w com.apple.quarantine "0081;$(printf %x "$(date +%s)");Safari;" dist/quarantined.dmg
  hdiutil attach -quiet -nobrowse -readonly -mountpoint "$MNT" dist/quarantined.dmg
  spctl -a -vv "$MNT/Svall.app" || fail "Gatekeeper refused the app in the DMG"
  hdiutil detach -quiet "$MNT"
  rmdir "$MNT"
  rm dist/quarantined.dmg
  trap - EXIT
fi

SHA="$(shasum -a 256 "$DMG" | cut -d' ' -f1)"
printf '{"version":"%s","build":%s,"url":"%s/Svall-%s.dmg","sha256":"%s"}\n' "$VERSION" "$BUILD" "$DOWNLOADS" "$VERSION" "$SHA" > dist/latest.json

if [ -z "$ADHOC" ]; then
  # the Svall.dmg link stays out while the appcast is made, so the latest release is listed once
  rm -f dist/releases/Svall.dmg
  # the appcast carries every release's notes under its version, newest first, and the app shows those above its own
  rm -rf dist/notes && mkdir dist/notes
  rsync -a --include='Svall-*.md' --exclude='*' "$SVALL_HOST:$SVALL_SITE_DIR/releases/" dist/notes/
  if [ -n "$NOTES" ]; then cp "$NOTES" "dist/notes/Svall-$VERSION.md"; else echo '- Small fixes and improvements.' > "dist/notes/Svall-$VERSION.md"; fi
  for f in $(ls dist/notes | sort -rV); do v="${f#Svall-}"; printf '## %s\n\n' "${v%.md}"; cat "dist/notes/$f"; echo; done > "dist/releases/Svall-$VERSION.md"
  "$(scripts/sparkle-tools.sh)/generate_appcast" --embed-release-notes --download-url-prefix "$DOWNLOADS/" dist/releases
  mv dist/releases/appcast.xml dist/appcast.xml
  # installed copies download what the enclosure names, and a prefix without its slash would name a missing file
  grep -qF "url=\"$DOWNLOADS/Svall-$VERSION.dmg\"" dist/appcast.xml || fail "the appcast does not name $DOWNLOADS/Svall-$VERSION.dmg"
  cp "dist/notes/Svall-$VERSION.md" dist/releases/
fi
ln -sf "Svall-$VERSION.dmg" dist/releases/Svall.dmg
if [ -n "$ADHOC" ]; then
  echo "dry run done: $DMG and dist/latest.json; no appcast, notarization or upload"
  exit 0
fi
# the release, with the DMG the feeds name, is public before the feeds; past the tag a second run refuses, so a failed or
# stopped step prints what finishes it, from the DMG the appcast signed. Svall.dmg is the copy svall.dev/download reaches
# through the latest release.
FEEDS="rsync -a dist/releases/Svall-$VERSION.md '$SVALL_HOST:$SVALL_SITE_DIR/releases/' && rsync -a dist/appcast.xml dist/latest.json scripts/install.sh '$SVALL_HOST:$SVALL_SITE_DIR/'"
FINISH="echo '$SHA  $DMG' | shasum -a 256 -c - && gh release upload v$VERSION --repo $REPO --clobber -- $DMG dist/releases/Svall.dmg && gh release edit v$VERSION --repo $REPO --draft=false --latest --notes-file dist/notes/Svall-$VERSION.md && curl -fsIL -o /dev/null $DOWNLOADS/Svall-$VERSION.dmg && $FEEDS"
REDO="gh release create v$VERSION --repo $REPO --verify-tag --title v$VERSION --notes-file dist/notes/Svall-$VERSION.md unless it exists, then $FINISH"
git tag "v$VERSION"
trap 'fail "the release stopped past the v$VERSION tag: run git push origin v$VERSION, then $REDO"' INT TERM HUP
git push origin "v$VERSION" || fail "nothing is published, but v$VERSION did not reach origin: run git tag -d v$VERSION and release again"
gh release create "v$VERSION" --repo "$REPO" --verify-tag --title "v$VERSION" --notes-file "dist/notes/Svall-$VERSION.md" -- "$DMG" dist/releases/Svall.dmg ||
  fail "v$VERSION is tagged, but its release lacks the DMG: run $REDO"
# a draft, or a DMG that did not upload, would leave the feeds naming a download nobody can reach
curl -fsIL -o /dev/null "$DOWNLOADS/Svall-$VERSION.dmg" || fail "Svall-$VERSION.dmg does not download from GitHub: run $FINISH"
sh -c "$FEEDS" || fail "the v$VERSION release is on GitHub, but the feeds did not reach svall.dev: run $FEEDS"
echo "released Svall $VERSION ($BUILD)"
