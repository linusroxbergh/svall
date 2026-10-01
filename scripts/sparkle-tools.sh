#!/bin/sh
# Downloads Sparkle's command-line tools (generate_keys, generate_appcast, sign_update) once, and prints their folder.
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION=2.10.0
SHA256=c2bf58aa8387266ac179357b1415d6f2635f044da8be41042af32425dae6da0c
OUT="$ROOT/vendor/sparkle/$VERSION"
[ -x "$OUT/bin/generate_appcast" ] && { echo "$OUT/bin"; exit 0; }
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
curl -fsSL -o "$TMP/sparkle.tar.xz" "https://github.com/sparkle-project/Sparkle/releases/download/$VERSION/Sparkle-$VERSION.tar.xz"
echo "$SHA256  $TMP/sparkle.tar.xz" | shasum -a 256 -c - >/dev/null || { echo "Sparkle-$VERSION.tar.xz does not match its pinned sha256" >&2; exit 1; }
mkdir -p "$OUT"
tar -xJf "$TMP/sparkle.tar.xz" -C "$OUT" ./bin ./LICENSE
echo "$OUT/bin"
