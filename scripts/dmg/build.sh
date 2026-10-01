#!/bin/sh
# Packs an app into a compressed disk image whose Finder window shows it beside a link to Applications, over a
# background (gen.mjs) with an arrow between them. Finder lays the window out, so the first run asks to control it.
# Usage: scripts/dmg/build.sh <app> <dmg>
set -eu
APP="$1"
DMG="$2"
DIR="$(cd "$(dirname "$0")" && pwd)"
NAME=Svall
MNT="/Volumes/$NAME"
fail() { echo "dmg: $*" >&2; exit 1; }
# Finder finds the volume by its name, so a second one called that would take the layout instead
[ ! -e "$MNT" ] || fail "a volume named $NAME is mounted; eject it first"

WORK="$(mktemp -d)"
trap 'hdiutil detach "$MNT" -force -quiet 2>/dev/null || true; rm -rf "$WORK"' EXIT
mkdir -p "$WORK/stage/.background"
ditto "$APP" "$WORK/stage/$NAME.app"
ln -s /Applications "$WORK/stage/Applications"
tiffutil -cathidpicheck "$DIR/background.png" "$DIR/background@2x.png" -out "$WORK/stage/.background/background.tiff" 2>/dev/null
# room for the .DS_Store Finder writes
SIZE="$(($(du -sm "$WORK/stage" | cut -f1) + 20))m"
# hdiutil create fails now and then on a stage it builds fine a moment later
for try in 1 2 3; do
  hdiutil create -volname "$NAME" -srcfolder "$WORK/stage" -fs HFS+ -format UDRW -size "$SIZE" -ov "$WORK/rw.dmg" && break
  [ "$try" -lt 3 ] || fail "hdiutil could not create the image"
  sleep 10
done
hdiutil attach -readwrite -noverify -noautoopen "$WORK/rw.dmg" >/dev/null

osascript <<EOF || fail "Finder could not lay out the window; if macOS refused, let your terminal control Finder in System Settings > Privacy & Security > Automation"
tell application "Finder"
  -- Finder sees a just-attached volume a moment later
  repeat 20 times
    if exists disk "$NAME" then exit repeat
    delay 0.5
  end repeat
  tell disk "$NAME"
    open
    tell container window
      set current view to icon view
      set toolbar visible to false
      set statusbar visible to false
      set pathbar visible to false
      -- the bounds take in macOS 26's 32pt title bar, leaving 640x400 for the background
      set bounds to {200, 120, 840, 552}
      -- a Finder that shows hidden files would lay .background and .fseventsd over the window
      set position of every item to {940, 100}
    end tell
    set opts to icon view options of container window
    set arrangement of opts to not arranged
    set icon size of opts to 128
    set text size of opts to 13
    set background picture of opts to file ".background:background.tiff"
    set position of item "$NAME.app" of container window to {176, 180}
    set position of item "Applications" of container window to {464, 180}
    update without registering applications
    delay 2
    close
  end tell
end tell
EOF
# Finder writes the layout a moment after the window closes
for i in 1 2 3 4 5 6 7 8 9 10; do [ -f "$MNT/.DS_Store" ] && break; sleep 1; done
[ -f "$MNT/.DS_Store" ] || fail "Finder wrote no layout to the image"
sync
hdiutil detach "$MNT" -quiet || { sleep 3; hdiutil detach "$MNT" -force -quiet; }
hdiutil convert "$WORK/rw.dmg" -format UDZO -imagekey zlib-level=9 -ov -o "$DMG" >/dev/null
