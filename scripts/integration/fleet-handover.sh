#!/usr/bin/env bash
# The fleet handover integration run: two Ubuntu 24.04 containers, real sshd, rsync, tmux, Git and systemd, and a mocked
# Claude. It builds the Linux companion archive for the docker host's architecture from this checkout (unless
# --archive names one), builds the machine image, and runs fleet-handover.mjs, which says what it checks.
#
#   scripts/integration/fleet-handover.sh [--archive <companion.tar.gz>] [--out <dir>]
#                                         [--scenarios all|none|kill|drop|<fault>@<boundary>,...] [--keep]
#
# Needs docker (Docker Desktop, colima, or a Linux runner's engine) and the checkout's Node and pnpm install.
set -euo pipefail

repo=$(cd "$(dirname "$0")/../.." && pwd)
archive=
pass=()
while [ $# -gt 0 ]; do
  case $1 in
    --archive) archive=$2; shift 2 ;;
    *) pass+=("$1"); shift ;;
  esac
done

docker info >/dev/null 2>&1 || { echo "fleet-handover.sh: docker is not running" >&2; exit 2; }
# the machines run on the docker host's own architecture: under user-mode emulation every process reads as qemu
platform=$(docker info --format '{{.Architecture}}')
case $platform in
  aarch64 | arm64) arch=arm64 ;;
  x86_64 | amd64) arch=x64 ;;
  *) echo "fleet-handover.sh: no companion is built for $platform" >&2; exit 2 ;;
esac

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
if [ -z "$archive" ]; then
  [ -d "$repo/apps/desktop/web/dist-mobile" ] || pnpm --dir "$repo" --filter @svall/desktop-web build:mobile
  node "$repo/scripts/build-companion.mjs" --out "$work/companion" --arch "$arch" >"$work/companion.json"
  archive=$(ls "$work"/companion/svall-companion-*-linux-"$arch".tar.gz)
fi

docker build -q -t svall-it:latest "$repo/scripts/integration" >/dev/null
node "$repo/scripts/integration/fleet-handover.mjs" --archive "$archive" --image svall-it:latest ${pass[@]+"${pass[@]}"}
