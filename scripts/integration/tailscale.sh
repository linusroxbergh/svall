#!/bin/sh
# The machines have no tailnet: this answers what `host add`, a home move's check and the phone's switch ask, and keeps what
# `serve` was told in a file, so a run can see which machine serves the phone.
state="$HOME/.tailscale-double.json"
host="$(hostname).tailnet.test"
case "$1" in
  version) echo 0.0.0-integration ;;
  status) printf '{"BackendState":"Running","Self":{"DNSName":"%s.","UserID":1},"User":{"1":{"ID":1,"LoginName":"svall@integration"}}}\n' "$host" ;;
  serve)
    shift
    case "$1" in
      status) [ -f "$state" ] && cat "$state" || echo '{}' ;;
      --bg)
        port=$(echo "$3" | sed 's/--https=//')
        printf '{"Web":{"%s:%s":{"Handlers":{"/":{"Proxy":"%s"}}}}}\n' "$host" "$port" "$4" > "$state" ;;
      *) rm -f "$state" ;;
    esac ;;
  *) echo "tailscale is a test double" >&2; exit 1 ;;
esac
