#!/bin/sh
# Turns an assembled app's Info.plist into the given variant's; the repo's plist is the release's.
set -eu
PLIST="$1"
[ "$2" = release ] && exit 0
P=/usr/libexec/PlistBuddy
$P -c "Set :CFBundleIdentifier io.github.linusroxbergh.svall.dev" -c "Set :CFBundleName Svall Dev" \
  -c "Set :CFBundleDisplayName Svall Dev" -c "Set :SvallHomeName .svall-dev" "$PLIST"
for key in SUFeedURL SUPublicEDKey SUEnableAutomaticChecks SUAutomaticallyUpdate; do $P -c "Delete :$key" "$PLIST" 2>/dev/null || true; done
