#!/usr/bin/env bash
# Builds what a desktop release publishes into one folder, then scans it; the release workflow's build job runs this:
#
#   scripts/release-build.sh --out <dir> --version <id> --url-base <url>
#
# The folder ends up holding archipelago-companion-<id>-linux-x64.tar.gz and -linux-arm64.tar.gz, and
# archipelago-controller-<id>-darwin-<arch>.tar.gz, the tree the app carries, whose manifest names each companion at
# <url>/<archive> with its digest. ARCHI_RELEASE_KEY signs every manifest; without it the release is marked unsigned.
# macOS only, as the controller is. A secret, developer path or checkout dependency in any archive fails the build.
set -euo pipefail

repo=$(cd "$(dirname "$0")/.." && pwd)
out= version= base=
while [ $# -gt 0 ]; do
  case $1 in
    --out) out=$2; shift 2 ;;
    --version) version=$2; shift 2 ;;
    --url-base) base=$2; shift 2 ;;
    *) echo "release-build.sh: unknown argument $1" >&2; exit 2 ;;
  esac
done
if [ -z "$out" ] || [ -z "$version" ] || [ -z "$base" ]; then
  echo "usage: release-build.sh --out <dir> --version <id> --url-base <url>" >&2
  exit 2
fi
mkdir -p "$out"
out=$(cd "$out" && pwd -P)

pnpm --dir "$repo" --filter @archipelago/desktop-web build:mobile
node "$repo/scripts/build-companion.mjs" --out "$out/companion" --version "$version" >"$out/companion.json"
node "$repo/scripts/build-controller.mjs" --out "$out/controller" --version "$version" \
  --companion-url-base "$base" --companions "$out/companion" >"$out/controller.json"
mv "$out"/companion/archipelago-companion-"$version"-linux-*.tar.gz "$out/"
platform=$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).platform' "$out/controller.json")
# as build-companion.mjs packs its archives: no Apple provenance xattrs, no AppleDouble members
COPYFILE_DISABLE=1 tar --no-xattrs -czf "$out/archipelago-controller-$version-$platform.tar.gz" -C "$out/controller" "releases/$version"
node "$repo/scripts/release-scan.mjs" "$out"/*.tar.gz
