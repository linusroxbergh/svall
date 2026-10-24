#!/bin/sh
# Builds the tmux that Svall.app ships into vendor/tmux/<version>, once per version: libevent and utf8proc linked in
# statically, so the binary needs only the system's libraries. With --linux x64|arm64 it builds the Linux companion's
# into vendor/tmux/<version>-linux-<arch> instead, in an Ubuntu 22.04 container through docker, so it runs on the
# oldest glibc the companion supports.
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMUX=3.7c
TMUX_SHA256=7c60cae9a0e25288e2e24750aafc9e8800fc7fd4555e447e1b29ee4201cfb3bf
LIBEVENT=2.1.13-stable
LIBEVENT_SHA256=f7e9383b8c0baa81b687e5b5eecc01beefaf1b19b64151d95ed61647fe7a315c
UTF8PROC=2.11.3
UTF8PROC_SHA256=abfed50b6d4da51345713661370290f4f4747263ee73dc90356299dfc7990c78
OUT="$ROOT/vendor/tmux/$TMUX-libevent-$LIBEVENT-utf8proc-$UTF8PROC"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
fetch() { # url sha256 file
  curl -fsSL -o "$TMP/$3" "$1"
  sum="$(if command -v sha256sum >/dev/null; then sha256sum "$TMP/$3"; else shasum -a 256 "$TMP/$3"; fi)"
  [ "${sum%% *}" = "$2" ] || { echo "$3 does not match its pinned sha256" >&2; exit 1; }
  tar -xzf "$TMP/$3" -C "$TMP"
}

# leaves the binary and the licences of all three in $TMP/out
build() { # jobs, libevent's extra configure arguments
  fetch "https://github.com/tmux/tmux/releases/download/$TMUX/tmux-$TMUX.tar.gz" "$TMUX_SHA256" tmux.tar.gz
  fetch "https://github.com/libevent/libevent/releases/download/release-$LIBEVENT/libevent-$LIBEVENT.tar.gz" "$LIBEVENT_SHA256" libevent.tar.gz
  fetch "https://github.com/JuliaStrings/utf8proc/archive/refs/tags/v$UTF8PROC.tar.gz" "$UTF8PROC_SHA256" utf8proc.tar.gz
  JOBS=$1
  shift
  DEPS="$TMP/deps"
  export PKG_CONFIG_LIBDIR="$DEPS/lib/pkgconfig"
  (cd "$TMP/libevent-$LIBEVENT" &&
    ./configure --prefix="$DEPS" --disable-shared --enable-static --disable-openssl --disable-samples \
      --disable-libevent-regress --disable-debug-mode "$@" >/dev/null &&
    make -j"$JOBS" >/dev/null && make install >/dev/null)
  (cd "$TMP/utf8proc-$UTF8PROC" && make -j"$JOBS" libutf8proc.a >/dev/null &&
    mkdir -p "$DEPS/include" "$DEPS/lib" && cp utf8proc.h "$DEPS/include/" && cp libutf8proc.a "$DEPS/lib/")
  (cd "$TMP/tmux-$TMUX" &&
    ./configure --enable-utf8proc --disable-jemalloc \
      LIBEVENT_CORE_CFLAGS="-I$DEPS/include" LIBEVENT_CORE_LIBS="$DEPS/lib/libevent_core.a" \
      LIBUTF8PROC_CFLAGS="-I$DEPS/include" LIBUTF8PROC_LIBS="$DEPS/lib/libutf8proc.a" >/dev/null &&
    make -j"$JOBS" >/dev/null)
  mkdir "$TMP/out"
  cp "$TMP/tmux-$TMUX/tmux" "$TMP/out/tmux"
  cp "$TMP/tmux-$TMUX/COPYING" "$TMP/out/LICENSE.tmux"
  cp "$TMP/libevent-$LIBEVENT/LICENSE" "$TMP/out/LICENSE.libevent"
  cp "$TMP/utf8proc-$UTF8PROC/LICENSE.md" "$TMP/out/LICENSE.utf8proc"
}

# nothing from Homebrew or the caller's flags may reach the link
unset CPPFLAGS LDFLAGS LIBS PKG_CONFIG_PATH

# inside the container: the build goes to stdout as a tar, and everything else to stderr
if [ "${1:-}" = --in-container ]; then
  apt-get update -qq >&2
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends \
    ca-certificates curl gcc libc6-dev make pkg-config bison libncurses-dev >&2
  export CFLAGS=-O2
  build "$(nproc)" >&2
  strip "$TMP/out/tmux"
  FOREIGN="$(objdump -p "$TMP/out/tmux" | awk '/NEEDED/ { print $2 }' | grep -Ev '^(libc|libm|libresolv|libtinfo|ld-linux-[a-z0-9_-]+)\.so\.[0-9]+$' || true)"
  [ -z "$FOREIGN" ] || { echo "tmux links libraries outside the system: $FOREIGN" >&2; exit 1; }
  tar -cf - -C "$TMP/out" .
  exit 0
fi

if [ "${1:-}" = --linux ]; then
  case "${2:-}" in
    x64) PLATFORM=linux/amd64 ;;
    arm64) PLATFORM=linux/arm64 ;;
    *) echo "usage: tmux-build.sh [--linux x64|arm64]" >&2; exit 2 ;;
  esac
  OUT="$OUT-linux-$2"
  [ -x "$OUT/tmux" ] && { echo "$OUT/tmux"; exit 0; }
  docker run --rm --platform "$PLATFORM" ubuntu:22.04 sh -c "$(cat "$0")" tmux-build.sh --in-container >"$TMP/tmux.tar"
  mkdir "$TMP/out"
  tar -xf "$TMP/tmux.tar" -C "$TMP/out"
else
  [ -x "$OUT/tmux" ] && { echo "$OUT/tmux"; exit 0; }
  # a newer SDK offers calls macOS 15 lacks, which configure finds by linking; the error names any to turn off below
  export MACOSX_DEPLOYMENT_TARGET=15.0
  export CFLAGS="-arch arm64 -mmacosx-version-min=15.0 -O2 -Werror=unguarded-availability-new"
  build "$(sysctl -n hw.ncpu)" ac_cv_func_pipe2=no
  FOREIGN="$(otool -L "$TMP/out/tmux" | tail -n +2 | awk '{ print $1 }' | grep -Ev '^(/usr/lib|/System)/' || true)"
  [ -z "$FOREIGN" ] || { echo "tmux links libraries outside the system: $FOREIGN" >&2; exit 1; }
fi

# the folder lands whole, as the binary in it marks the build done; it is staged beside its place, so the rename that
# lands it never crosses a volume
mkdir -p "$(dirname "$OUT")"
STAGE="$OUT.$$"
trap 'rm -rf "$TMP" "$STAGE"' EXIT
cp -R "$TMP/out" "$STAGE"
rm -rf "$OUT"
mv "$STAGE" "$OUT"
echo "$OUT/tmux"
