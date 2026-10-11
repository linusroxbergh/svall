#!/bin/sh
# Runs `pnpm compat --notify` from this checkout every day at 09:00 (or at the next wake) through a LaunchAgent, with
# the PATH of the shell that ran this, so the CLIs it checks are the ones you use. `--remove` takes it off
set -eu
LABEL=dev.svall.compat
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Caches/svall-compat/launchd.log"
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
DOMAIN="gui/$(id -u)"

launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
if [ "${1:-}" = --remove ]; then rm -f "$PLIST"; exit 0; fi

PNPM=$(command -v pnpm)
mkdir -p "$(dirname "$LOG")" "$(dirname "$PLIST")"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$PNPM</string><string>compat</string><string>--notify</string></array>
  <key>WorkingDirectory</key><string>$ROOT</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>$PATH</string></dict>
  <key>StartCalendarInterval</key><dict><key>Hour</key><integer>9</integer><key>Minute</key><integer>0</integer></dict>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
EOF
plutil -lint "$PLIST" >/dev/null
launchctl bootstrap "$DOMAIN" "$PLIST"
echo "scheduled: $PLIST (runs $ROOT at 09:00; log $LOG)"
