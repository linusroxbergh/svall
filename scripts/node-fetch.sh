#!/bin/sh
# Downloads the Node that Svall.app ships into vendor/node/<version>, once per version, checked against the pinned sha256.
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION=v24.21.0
SHA256=6239d4cf92d864487ec8cd3615038f7b67e7f58b77b21cd2f09ea9fbd68065fe
NAME="node-$VERSION-darwin-arm64"
OUT="$ROOT/vendor/node/$VERSION"
[ -x "$OUT/node" ] && { echo "$OUT/node"; exit 0; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
curl -fsSL -o "$TMP/$NAME.tar.xz" "https://nodejs.org/dist/$VERSION/$NAME.tar.xz"
echo "$SHA256  $TMP/$NAME.tar.xz" | shasum -a 256 -c - >/dev/null || { echo "$NAME.tar.xz does not match its pinned sha256" >&2; exit 1; }
tar -xJf "$TMP/$NAME.tar.xz" -C "$TMP" "$NAME/bin/node" "$NAME/LICENSE"
mkdir -p "$OUT"
mv "$TMP/$NAME/bin/node" "$TMP/$NAME/LICENSE" "$OUT/"
echo "$OUT/node"
