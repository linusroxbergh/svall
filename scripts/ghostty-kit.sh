#!/bin/sh
# GhosttyKit, the terminal engine the app links, prebuilt per Ghostty commit on one GitHub release so installs
# need neither Xcode nor zig. The app builds against vendor/ghostty-kit, however the kit got there.
#   current   exit 0 when vendor/ghostty-kit was built from the Ghostty commit HEAD records, at REV
#   ahead     exit 0 when it was built from a vendor/ghostty checkout ahead of that commit, a bump not yet committed
#   fetch     download that commit's kit into vendor/ghostty-kit
#   publish   build that commit's kit, upload it and print the lines that pin it (maintainers)
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPO=linusroxbergh/svall
TAG=ghostty-kit
KIT="$ROOT/vendor/ghostty-kit"
# bump when ghostty-build.sh or its libtool shim changes what it builds, then pnpm ghostty:publish
REV=1
COMMIT="$(git -C "$ROOT" rev-parse HEAD:vendor/ghostty)"
VERSION="$COMMIT-r$REV"
ASSET="GhosttyKit-$VERSION-arm64.zip"
# xcodebuild names the slice after the library's architecture, which is zig's own, whatever the shell's
LIB=GhosttyKit.xcframework/macos-arm64/libghostty-fat.a
# the one kit fetch takes: the VERSION it was published as, and the sha256 publish printed for it
PINNED=332b2aefc6e72d363aa93ab6ecfc86eeeeb5ed28-r1
SHA256=c31cad36b47911a0e4a45a8d32e4699b1b2217598a58747a9c10da833b846c4b

current() {
  [ "$(cat "$KIT/version" 2>/dev/null)" = "$VERSION" ]
}

ahead() {
  [ -e "$ROOT/vendor/ghostty/.git" ] || return 1
  head="$(git -C "$ROOT/vendor/ghostty" rev-parse HEAD)"
  [ "$head" != "$COMMIT" ] && [ "$(cat "$KIT/version" 2>/dev/null)" = "$head-r$REV" ] &&
    git -C "$ROOT/vendor/ghostty" merge-base --is-ancestor "$COMMIT" "$head" 2>/dev/null
}

fetch() {
  if [ "$(sysctl -n hw.optional.arm64 2>/dev/null)" != 1 ]; then
    echo "prebuilt GhosttyKit is for Apple Silicon only" >&2
    return 1
  fi
  if [ "$VERSION" != "$PINNED" ]; then
    echo "no GhosttyKit is pinned for Ghostty $COMMIT at r$REV: publish it, then pin the sha256 publish prints" >&2
    return 1
  fi
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  if ! curl -fsSL --max-time 600 -o "$tmp/$ASSET" "https://github.com/$REPO/releases/download/$TAG/$ASSET"; then
    echo "no GhosttyKit could be downloaded for Ghostty $COMMIT" >&2
    return 1
  fi
  if ! echo "$SHA256  $tmp/$ASSET" | shasum -a 256 -c - >/dev/null 2>&1; then
    echo "the downloaded GhosttyKit for Ghostty $COMMIT does not match its pinned sha256" >&2
    return 1
  fi
  if ! ditto -x -k "$tmp/$ASSET" "$tmp/kit" 2>/dev/null || [ "$(cat "$tmp/kit/version" 2>/dev/null)" != "$VERSION" ] ||
    [ ! -f "$tmp/kit/share/terminfo/78/xterm-ghostty" ] || [ ! -d "$tmp/kit/share/ghostty/shell-integration" ] ||
    [ ! -f "$tmp/kit/$LIB" ]; then
    echo "the downloaded GhosttyKit for Ghostty $COMMIT is incomplete" >&2
    return 1
  fi
  # the stamp goes first and comes back last, so an interrupted replace leaves a kit that current refuses
  mv "$tmp/kit/version" "$tmp/version"
  rm -f "$KIT/version"
  rm -rf "$KIT"
  mkdir -p "$(dirname "$KIT")"
  mv "$tmp/kit" "$KIT"
  mv "$tmp/version" "$KIT/version"
}

publish() {
  cd "$ROOT"
  if gh release view "$TAG" -R "github.com/$REPO" --json assets --jq '.assets[].name' 2>/dev/null | grep -qx "$ASSET"; then
    echo "$ASSET is published already, and commits pin it; bump REV to publish a new kit" >&2
    return 1
  fi
  git submodule update --init vendor/ghostty
  if [ -n "$(git -C vendor/ghostty status --porcelain --untracked-files=no)" ]; then
    echo "vendor/ghostty has local changes" >&2
    return 1
  fi
  scripts/ghostty-build.sh
  # a staged Ghostty bump checks out a commit other than HEAD's, which no install would ask for
  current || { echo "vendor/ghostty-kit was not built from Ghostty $COMMIT, the commit HEAD records" >&2; return 1; }
  [ -f "$KIT/$LIB" ] || { echo "vendor/ghostty-kit has no arm64 library: publish on an Apple Silicon Mac with an arm64 zig" >&2; return 1; }
  out="$(mktemp -d)"
  trap 'rm -rf "$out"' EXIT
  ditto -c -k "$KIT" "$out/$ASSET"
  gh release view "$TAG" -R "github.com/$REPO" >/dev/null 2>&1 ||
    gh release create "$TAG" -R "github.com/$REPO" --prerelease --title "GhosttyKit" \
      --notes "GhosttyKit builds that pnpm desktop:install downloads, one per Ghostty commit and kit revision."
  gh release upload "$TAG" "$out/$ASSET" -R "github.com/$REPO"
  echo "published $ASSET; pin it in scripts/ghostty-kit.sh:"
  echo "PINNED=$VERSION"
  echo "SHA256=$(shasum -a 256 "$out/$ASSET" | cut -d' ' -f1)"
}

case "${1:-}" in
  current) current ;;
  ahead) ahead ;;
  fetch) fetch ;;
  publish) publish ;;
  *) echo "usage: ghostty-kit.sh current | ahead | fetch | publish" >&2; exit 2 ;;
esac
