#!/bin/sh
# Sets up, starts the daemon of and uninstalls a copy of the built Svall.app in a throwaway home with no Homebrew and a fake launchctl.
set -u
SRC="$1"
# node names its own paths with symlinks resolved, and mktemp's /var is a link to /private/var
D="$(mktemp -d)" || exit 1
T="$(cd "$D" && pwd -P)" || exit 1
trap 'rm -rf "$T"' EXIT
mkdir -p "$T/home/.local/bin" "$T/home/.claude" "$T/bin" "$T/Apps" "$T/Other"
cp -R "$SRC" "$T/Apps/Svall.app"
cp -R "$SRC" "$T/Other/Svall.app"
A="$T/Apps/Svall.app/Contents"
# records every call; `print` answers that nothing is loaded, as no daemon runs here
printf '#!/bin/sh\necho "$@" >> %s/launchctl.log\n[ "$1" != print ]\n' "$T" > "$T/bin/launchctl"
printf '#!/bin/sh\necho 2.1.0\n' > "$T/home/.local/bin/claude"
# answers the daemon's version probe and nothing else, so the real tailscale is never asked
printf '#!/bin/sh\n[ "$1" = version ]\n' > "$T/bin/tailscale"
chmod +x "$T/bin/launchctl" "$T/bin/tailscale" "$T/home/.local/bin/claude"
unset SVALL_HOME SVALL_CHAR_ID TMUX CLAUDE_CONFIG_DIR CODEX_HOME
export HOME="$T/home" PATH="$T/bin:$T/home/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin" SHELL=/bin/sh SVALL_APP_DEST="$T/Apps"
cli() { "$A/Helpers/node" "$A/Resources/runtime/svall.mjs" "$@"; }
FAILED=0
check() { if eval "$2"; then echo "ok   $1"; else echo "FAIL $1"; FAILED=1; fi; }
# the fake launchctl runs no daemon, so this starts one on a fleet of its own; the port file is the last thing a start writes
daemon() {
  F="$T/fleet"
  mkdir -p "$F" && echo '{"port":0}' > "$F/config.json" || return 1
  SVALL_HOME="$F" "$A/Helpers/node" "$A/Resources/runtime/svalld.mjs" 2>"$T/svalld.err" &
  P=$! i=0
  while [ ! -s "$F/port" ] && kill -0 "$P" 2>/dev/null && [ "$i" -lt 150 ]; do sleep 0.1; i=$((i + 1)); done
  [ -s "$F/port" ]; UP=$?
  kill "$P" 2>/dev/null; wait "$P" 2>/dev/null
  "$A/Helpers/tmux" -S "$F/tmux.sock" kill-server 2>/dev/null
  [ "$UP" = 0 ] || { cat "$F/svalld.log" "$T/svalld.err" >&2 2>/dev/null; return 1; }
}
# the signed helper setup put in the fleet runs a wrapped statusline and reports, to a home named like the release's
reports() {
  H="$T/.svall-smoke"
  mkdir -p "$H" || return 1
  "$A/Helpers/node" -e 'setTimeout(() => process.exit(1), 5000); require("net").createServer((c) => c.on("data", (d) => { process.stdout.write(d); process.exit(0); })).listen(process.argv[1])' "$H/hooks.sock" >"$T/report" &
  P=$! i=0
  while [ ! -S "$H/hooks.sock" ] && [ "$i" -lt 50 ]; do sleep 0.1; i=$((i + 1)); done
  OUT="$(printf '{"context_window":{"used_percentage":7}}' | SVALL_HOME="$H" SVALL_CHAR_ID=c_smoke "$HOME/.svall/hooks/svall-hook" status 'echo ok')"
  wait "$P"
  [ "$OUT" = ok ] && grep -q '"contextPct":7' "$T/report"
}
PLIST="$HOME/Library/LaunchAgents/io.github.linusroxbergh.svall.svalld.plist"

PLAN="$(cli setup --plan)"
check "plan lists claude" 'printf %s "$PLAN" | grep -q "\"agents\": *\[{\"kind\": *\"claude\""'
check "setup runs" 'cli setup --json --agents claude >/dev/null'
check "plist runs the app's node" 'grep -q "<string>$A/Helpers/node</string>" "$PLIST" && grep -q "runtime/svalld.mjs" "$PLIST"'
check "plist PATH leaves Helpers out" '! grep "<key>PATH</key>" "$PLIST" | grep -q Helpers'
check "shim execs the app's CLI" 'grep -q "$A/Resources/runtime/svall.mjs" "$HOME/.local/bin/svall"'
check "hooks run the app's node" 'grep "$A/Helpers/node" "$HOME/.claude/settings.json" | grep -q agent-hook'
check "the hook helper sits beside the scripts" '[ -x "$HOME/.svall/hooks/svall-hook" ] && grep -q "hooks/svall-hook" "$HOME/.claude/settings.json"'
check "the hook helper runs and reports" reports
check "refresh finds nothing to do" 'R="$(cli setup --if-needed --json)"; printf %s "$R" | grep -q "\"done\": *\[\]" && printf %s "$R" | grep -q "\"warnings\": *\[\]"'
check "a second copy leaves the fleets alone" 'O="$T/Other/Svall.app/Contents"; "$O/Helpers/node" "$O/Resources/runtime/svall.mjs" setup --if-needed --json | grep -q "runs these fleets" && grep -q "<string>$A/Helpers/node</string>" "$PLIST"'
check "the bundled daemon starts" daemon
check "uninstall runs" 'cli uninstall --json --from-app >/dev/null'
check "uninstall took the plist" '[ ! -f "$PLIST" ]'
check "uninstall took the shim" '[ ! -f "$HOME/.local/bin/svall" ]'
check "uninstall took the hooks" '[ -f "$HOME/.claude/settings.json" ] && ! grep -q agent-hook "$HOME/.claude/settings.json"'
check "uninstall left the app" '[ -d "$T/Apps/Svall.app" ]'
exit "$FAILED"
