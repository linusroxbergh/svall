#!/bin/sh
# Signs Svall.app inside-out with hardened runtime: helpers, Sparkle's nested code, then the app.
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
sign --entitlements "$MAC/app.entitlements" "$APP"
codesign --verify --strict --deep "$APP"
