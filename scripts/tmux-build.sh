#!/bin/sh
# Builds the tmux that Svall.app ships into vendor/tmux/<version>, once per version: libevent and utf8proc linked in
# statically, so the binary needs only the system's libraries.
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMUX=3.7c
TMUX_SHA256=7c60cae9a0e25288e2e24750aafc9e8800fc7fd4555e447e1b29ee4201cfb3bf
LIBEVENT=2.1.13-stable
LIBEVENT_SHA256=f7e9383b8c0baa81b687e5b5eecc01beefaf1b19b64151d95ed61647fe7a315c
UTF8PROC=2.11.3
UTF8PROC_SHA256=abfed50b6d4da51345713661370290f4f4747263ee73dc90356299dfc7990c78
OUT="$ROOT/vendor/tmux/$TMUX-libevent-$LIBEVENT-utf8proc-$UTF8PROC"
[ -x "$OUT/tmux" ] && { echo "$OUT/tmux"; exit 0; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
fetch() { # url sha256 file
  curl -fsSL -o "$TMP/$3" "$1"
  echo "$2  $TMP/$3" | shasum -a 256 -c - >/dev/null || { echo "$3 does not match its pinned sha256" >&2; exit 1; }
  tar -xzf "$TMP/$3" -C "$TMP"
}
fetch "https://github.com/tmux/tmux/releases/download/$TMUX/tmux-$TMUX.tar.gz" "$TMUX_SHA256" tmux.tar.gz
fetch "https://github.com/libevent/libevent/releases/download/release-$LIBEVENT/libevent-$LIBEVENT.tar.gz" "$LIBEVENT_SHA256" libevent.tar.gz
fetch "https://github.com/JuliaStrings/utf8proc/archive/refs/tags/v$UTF8PROC.tar.gz" "$UTF8PROC_SHA256" utf8proc.tar.gz

# nothing from Homebrew or the caller's flags may reach the link
unset CPPFLAGS LDFLAGS LIBS PKG_CONFIG_PATH
DEPS="$TMP/deps"
# a newer SDK offers calls macOS 15 lacks, which configure finds by linking; the error names any to turn off below
export PKG_CONFIG_LIBDIR="$DEPS/lib/pkgconfig" MACOSX_DEPLOYMENT_TARGET=15.0
export CFLAGS="-arch arm64 -mmacosx-version-min=15.0 -O2 -Werror=unguarded-availability-new"
JOBS="$(sysctl -n hw.ncpu)"

(cd "$TMP/libevent-$LIBEVENT" &&
  ./configure --prefix="$DEPS" --disable-shared --enable-static --disable-openssl --disable-samples \
    --disable-libevent-regress --disable-debug-mode ac_cv_func_pipe2=no >/dev/null &&
  make -j"$JOBS" >/dev/null && make install >/dev/null)
(cd "$TMP/utf8proc-$UTF8PROC" && make -j"$JOBS" libutf8proc.a >/dev/null &&
  mkdir -p "$DEPS/include" "$DEPS/lib" && cp utf8proc.h "$DEPS/include/" && cp libutf8proc.a "$DEPS/lib/")
(cd "$TMP/tmux-$TMUX" &&
  ./configure --enable-utf8proc --disable-jemalloc \
    LIBEVENT_CORE_CFLAGS="-I$DEPS/include" LIBEVENT_CORE_LIBS="$DEPS/lib/libevent_core.a" \
    LIBUTF8PROC_CFLAGS="-I$DEPS/include" LIBUTF8PROC_LIBS="$DEPS/lib/libutf8proc.a" >/dev/null &&
  make -j"$JOBS" >/dev/null)

BIN="$TMP/tmux-$TMUX/tmux"
FOREIGN="$(otool -L "$BIN" | tail -n +2 | awk '{ print $1 }' | grep -Ev '^(/usr/lib|/System)/' || true)"
[ -z "$FOREIGN" ] || { echo "tmux links libraries outside the system: $FOREIGN" >&2; exit 1; }
mkdir -p "$OUT"
cp "$BIN" "$OUT/tmux"
cp "$TMP/tmux-$TMUX/COPYING" "$OUT/LICENSE.tmux"
cp "$TMP/libevent-$LIBEVENT/LICENSE" "$OUT/LICENSE.libevent"
cp "$TMP/utf8proc-$UTF8PROC/LICENSE.md" "$OUT/LICENSE.utf8proc"
echo "$OUT/tmux"
