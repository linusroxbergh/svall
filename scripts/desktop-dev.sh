#!/bin/sh
# Vite dev server + a debug shell build pointed at it. SVALL_HOME selects the daemon, unless it names a release fleet.
set -eu
case "$(basename "${SVALL_HOME:-}")" in
  .svall-dev|.svall-dev-*) ;;
  .svall|.svall-[a-z]*) unset SVALL_HOME SVALL_CHAR_ID ;;
esac
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
curl -sf http://localhost:5173 >/dev/null && { echo "port 5173 is in use" >&2; exit 1; }
(cd "$ROOT/apps/desktop/web" && exec ./node_modules/.bin/vite) >/tmp/svall-vite.log 2>&1 &
VITE=$!
trap 'kill $VITE 2>/dev/null || true' EXIT INT TERM
READY=
for _ in $(seq 1 50); do curl -sf http://localhost:5173 >/dev/null && { READY=1; break; }; sleep 0.2; done
[ -n "$READY" ] || { echo "vite did not start:" >&2; tail -20 /tmp/svall-vite.log >&2; exit 1; }
apps/desktop/mac/build.sh debug
APP="$ROOT/apps/desktop/mac/build/Svall Dev.app"
SVALL_DEV_URL=http://localhost:5173 "$APP/Contents/MacOS/Svall"
