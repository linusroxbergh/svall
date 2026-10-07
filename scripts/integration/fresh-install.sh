#!/usr/bin/env bash
# The fresh-install run: a clean Ubuntu 24.04 machine of the docker host's architecture, added by the controller the app
# carries (`svall host add`), then `svall host upgrade` to a second release and `svall setup --rollback` back. It builds
# both releases from this checkout with scripts/release-build.sh (macOS only) unless --release and --upgrade name
# folders that build wrote, and runs fresh-install.mjs, which says what it checks. A release built with a --url-base on
# http://127.0.0.1:<port>/ is served by the run and downloaded, as the app does; any other is installed by path.
#
#   scripts/integration/fresh-install.sh [--release <dir> --upgrade <dir>] [--out <dir>] [--keep]
#
# Needs docker (Docker Desktop, colima, or a Linux runner's engine) and Node 24.
set -euo pipefail

repo=$(cd "$(dirname "$0")/../.." && pwd)
release='' upgrade=''
pass=()
while [ $# -gt 0 ]; do
  case $1 in
    --release) release=$2; shift 2 ;;
    --upgrade) upgrade=$2; shift 2 ;;
    *) pass+=("$1"); shift ;;
  esac
done

docker info >/dev/null 2>&1 || { echo "fresh-install.sh: docker is not running" >&2; exit 2; }
platform=$(docker info --format '{{.Architecture}}')
case $platform in
  aarch64 | arm64) arch=arm64 ;;
  x86_64 | amd64) arch=x64 ;;
  *) echo "fresh-install.sh: no companion is built for $platform" >&2; exit 2 ;;
esac

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
if [ -z "$release" ] || [ -z "$upgrade" ]; then
  [ "$(uname -s)" = Darwin ] || { echo "fresh-install.sh: only macOS builds the controller; pass --release and --upgrade" >&2; exit 2; }
  version=$(git -C "$repo" describe --tags --match 'v[0-9]*' --always --dirty)
  port=$(node -e 'const s = require("net").createServer().listen(0, "127.0.0.1", () => { console.log(s.address().port); s.close(); })')
  "$repo/scripts/release-build.sh" --out "$work/release" --version "$version" --url-base "http://127.0.0.1:$port/release" >/dev/null
  "$repo/scripts/release-build.sh" --out "$work/upgrade" --version "$version-next" --url-base "http://127.0.0.1:$port/upgrade" >/dev/null
  release=$work/release upgrade=$work/upgrade
fi

docker build -q --target machine -t svall-it:machine "$repo/scripts/integration" >/dev/null
node "$repo/scripts/integration/fresh-install.mjs" --release "$release" --upgrade "$upgrade" --arch "$arch" --image svall-it:machine ${pass[@]+"${pass[@]}"}
