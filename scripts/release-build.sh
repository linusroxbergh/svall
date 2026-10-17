#!/usr/bin/env bash
# Builds what a desktop release publishes into one folder, then scans it; the release workflow's build job runs this:
#
#   scripts/release-build.sh --out <dir> --version <id> --url-base <url>
#   scripts/release-build.sh --sign <key> --out <dir>
#
# The folder ends up holding svall-companion-<id>-linux-x64.tar.gz and -linux-arm64.tar.gz, and
# svall-controller-<id>-darwin-<arch>.tar.gz, the tree the app carries, whose manifest names each companion at
# <url>/<archive> with its digest. SVALL_RELEASE_KEY signs every manifest; without it the release is marked unsigned.
# macOS only, as the controller is. A secret, developer path or checkout dependency in any archive fails the build.
# The second form signs, in place, the archives a build without the key left in <dir>; the release workflow runs it in
# a job of its own, so the key never reaches the build.
set -euo pipefail

repo=$(cd "$(dirname "$0")/.." && pwd)
out='' version='' base='' key=''
while [ $# -gt 0 ]; do
  case $1 in
    --out) out=$2; shift 2 ;;
    --version) version=$2; shift 2 ;;
    --url-base) base=$2; shift 2 ;;
    --sign) key=$2; shift 2 ;;
    *) echo "release-build.sh: unknown argument $1" >&2; exit 2 ;;
  esac
done
usage() {
  printf '%s\n' "usage: release-build.sh --out <dir> --version <id> --url-base <url>" \
    "       release-build.sh --sign <key> --out <dir>" >&2
  exit 2
}
if [ -n "$key" ]; then
  if [ -z "$out" ] || [ -n "$version" ] || [ -n "$base" ]; then usage; fi
  # the companions first, as the controller's manifest pins their archives' digests
  for archive in "$out"/svall-companion-*.tar.gz "$out"/svall-controller-*.tar.gz; do
    node --input-type=module -e 'const [m, a, k] = process.argv.slice(1); (await import(m)).signArchive(a, k);' \
      "$repo/scripts/release-manifest.mjs" "$archive" "$key"
  done
  exit 0
fi
if [ -z "$out" ] || [ -z "$version" ] || [ -z "$base" ]; then usage; fi
mkdir -p "$out"
out=$(cd "$out" && pwd -P)

pnpm --dir "$repo" --filter @svall/desktop-web build:mobile
node "$repo/scripts/build-companion.mjs" --out "$out/companion" --version "$version" >"$out/companion.json"
node "$repo/scripts/build-controller.mjs" --out "$out/controller" --version "$version" \
  --companion-url-base "$base" --companions "$out/companion" >"$out/controller.json"
mv "$out"/companion/svall-companion-"$version"-linux-*.tar.gz "$out/"
platform=$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).platform' "$out/controller.json")
# as build-companion.mjs packs its archives: no Apple provenance xattrs, no AppleDouble members
COPYFILE_DISABLE=1 tar --no-xattrs -czf "$out/svall-controller-$version-$platform.tar.gz" -C "$out/controller" "releases/$version"
node "$repo/scripts/release-scan.mjs" "$out"/*.tar.gz
