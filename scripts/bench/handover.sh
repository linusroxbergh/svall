#!/usr/bin/env bash
# The fleet handover benchmark: the integration run's two Ubuntu 24.04 containers, provisioned and handed over once by
# scripts/integration/fleet-handover.mjs with no fault scenarios, then a first and two incremental handovers of a
# small, a large-file and a many-file repository, each measured by handover.mjs.
#
#   scripts/bench/handover.sh [--archive <companion.tar.gz>] [--out <dir>] [--repos small,large,many]
#                             [--files <n>] [--large-mib <n>] [--reuse] [--keep] [--flood] [--prefix <name>]
#
# --reuse measures on containers a --keep run left; --flood also measures a terminal printing to a viewer that reads
# nothing. The containers are svall-bench-local and svall-bench-remote, or named by --prefix, so an integration run can
# share the docker host. Needs docker (Docker Desktop, colima, or a Linux runner's engine) and the checkout's Node and
# pnpm install.
set -euo pipefail

repo=$(cd "$(dirname "$0")/../.." && pwd)
archive='' out='' reuse='' prefix=svall-bench
pass=()
while [ $# -gt 0 ]; do
  case $1 in
    --archive) archive=$2; shift 2 ;;
    --out) out=$2; shift 2 ;;
    --reuse) reuse=1; shift ;;
    --prefix) prefix=$2; shift 2 ;;
    *) pass+=("$1"); shift ;;
  esac
done

docker info >/dev/null 2>&1 || { echo "handover.sh: docker is not running" >&2; exit 2; }
platform=$(docker info --format '{{.Architecture}}')
case $platform in
  aarch64 | arm64) arch=arm64 ;;
  x86_64 | amd64) arch=x64 ;;
  *) echo "handover.sh: no companion is built for $platform" >&2; exit 2 ;;
esac

out=${out:-$(mktemp -d "${TMPDIR:-/tmp}/handover-bench.XXXXXX")}
mkdir -p "$out"
if [ -z "$reuse" ]; then
  work=$(mktemp -d)
  trap 'rm -rf "$work"' EXIT
  if [ -z "$archive" ]; then
    [ -d "$repo/apps/desktop/web/dist-mobile" ] || pnpm --dir "$repo" --filter @svall/desktop-web build:mobile
    node "$repo/scripts/build-companion.mjs" --out "$work/companion" --arch "$arch" >"$work/companion.json"
    archive=$(ls "$work"/companion/svall-companion-*-linux-"$arch".tar.gz)
  fi
  docker build -q -t svall-it:latest "$repo/scripts/integration" >/dev/null
  node "$repo/scripts/integration/fleet-handover.mjs" --archive "$archive" --image svall-it:latest --scenarios none --keep --out "$out/setup" --prefix "$prefix"
fi
node "$repo/scripts/bench/handover.mjs" --out "$out" --prefix "$prefix" ${pass[@]+"${pass[@]}"}
