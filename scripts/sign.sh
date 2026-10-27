#!/bin/sh
# Signs Svall.app inside-out with hardened runtime: helpers, Sparkle's nested code, the carried controller's, then the app.
set -eu
APP="$1"; ID="$2"; MAC="$(cd "$(dirname "$0")/../apps/desktop/mac" && pwd)"
TS="--timestamp"; [ "$ID" = - ] && TS="--timestamp=none"
sign() { codesign --force --options runtime $TS --sign "$ID" "$@"; }
sign --entitlements "$MAC/node.entitlements" "$APP/Contents/Helpers/node"
sign "$APP/Contents/Helpers/tmux" "$APP/Contents/Helpers/svall-hook"
S="$APP/Contents/Frameworks/Sparkle.framework/Versions/B"
sign "$S/XPCServices/Installer.xpc"
sign --preserve-metadata=entitlements "$S/XPCServices/Downloader.xpc"
sign "$S/Autoupdate" "$S/Updater.app"
sign "$APP/Contents/Frameworks/Sparkle.framework"
# signing rewrites the carried node, so the carried SHA256SUMS keeps its unsigned digest; nothing on the Mac reads it
R="$APP/Contents/Resources/release"
# a carried node that links to Helpers/node is signed there, and codesign would sign it again through the link
[ -L "$R/node/bin/node" ] || [ ! -e "$R/node/bin/node" ] || sign --entitlements "$MAC/node.entitlements" "$R/node/bin/node"
sign --entitlements "$MAC/app.entitlements" "$APP"
codesign --verify --strict --deep "$APP"
