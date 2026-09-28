#!/usr/bin/env bash
# RUST-03 S2.1: install the pinned LLVM 23.1.2 clang for one LethAL native target, check the
# download's sha256 and the installed clang's banner, and export LLVM_BIN (to $GITHUB_ENV when it
# is set). One place for release.yml and ci.yml. Never floats to a newer LLVM: every asset is pinned
# by URL and hash, and the banner must say exactly "clang version 23.1.2".
#
#   bash scripts/install-llvm.sh <win32-x64|linux-x64|linux-arm64|darwin-arm64>
#
# Why not KyleMayes/install-llvm-action: its asset list stops at 21.1.x, so it refuses 23.1.2 on
# every platform (CI run 36443811955 on Windows). darwin-x64 has no key here: LLVM 23.1.2 ships no
# macOS x64 build, so release CI cross-builds that addon on darwin-arm64 with this same clang
# (owner ruling, RUST-03 S2) and smoke-tests it on an Intel runner.
set -euo pipefail

VERSION=23.1.2
REL="https://github.com/llvm/llvm-project/releases/download/llvmorg-$VERSION"
key="${1:?usage: install-llvm.sh <platform-key>}"
dest="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/llvm-$VERSION"

sha256_of() {
  # From stdin: sha256sum escapes a filename holding a backslash and prefixes the line with "\".
  if command -v sha256sum >/dev/null; then sha256sum <"$1" | cut -d' ' -f1; else shasum -a 256 <"$1" | cut -d' ' -f1; fi
}

fetch() { # url sha256 file
  curl -fsSL --retry 3 -o "$3" "$1"
  local got
  got="$(sha256_of "$3")"
  if [ "$got" != "$2" ]; then
    echo "install-llvm: $1 hashes to $got, pinned $2" >&2
    exit 1
  fi
}

mkdir -p "$dest"
case "$key" in
  win32-x64)
    fetch "$REL/LLVM-$VERSION-win64.msi" \
      e9d9141524f2c9fe4bf9f37012efe34f0aa745617be9e21fface9104703c55e5 "$dest.msi"
    # An administrative install only unpacks the files, so it never touches the LLVM the runner
    # image already has in C:\Program Files\LLVM.
    MSYS_NO_PATHCONV=1 msiexec /a "$(cygpath -w "$dest.msi")" /qn TARGETDIR="$(cygpath -w "$dest")"
    # The msi's directory table puts everything under LLVM\ (measured on 23.1.2).
    bin="$dest/LLVM/bin"
    exe=clang-cl.exe
    ;;
  linux-x64 | linux-arm64 | darwin-arm64)
    case "$key" in
      linux-x64) asset=LLVM-$VERSION-Linux-X64.tar.xz sha=b5ed9675149cc837c282e9b6962c276c9fa62863d5b2f91537b60848552995b7 ;;
      linux-arm64) asset=LLVM-$VERSION-Linux-ARM64.tar.xz sha=075da47cb832273717d4c7bad4b6b4848d7c154262e9ba0dcc0025426d4073f0 ;;
      darwin-arm64) asset=LLVM-$VERSION-macOS-ARM64.tar.xz sha=d7c26fc6177e42842e2d1ffaad31aec057c56a924392b1a23d830abe2c5d53b1 ;;
    esac
    fetch "$REL/$asset" "$sha" "$dest.tar.xz"
    # Each tarball has one top-level dir, LLVM-23.1.2-<platform>/, stripped here. bin/clang is a
    # SYMLINK to clang-23 in all three (read from the 23.1.2 assets), so nothing below may look
    # for a regular file.
    tar -xJf "$dest.tar.xz" -C "$dest" --strip-components=1
    bin="$dest/bin"
    exe=clang
    ;;
  darwin-x64)
    echo "install-llvm: LLVM $VERSION ships no macOS x64 build. darwin-x64 is cross-built on darwin-arm64: bash scripts/install-llvm.sh darwin-arm64, then bun scripts/build-native-parser.ts --target darwin-x64" >&2
    exit 1
    ;;
  *)
    echo "install-llvm: no LethAL target $key" >&2
    exit 1
    ;;
esac

if [ ! -x "$bin/$exe" ]; then
  echo "install-llvm: no executable $bin/$exe after unpacking; the asset's layout is not the one this script expects" >&2
  exit 1
fi
banner="$("$bin/$exe" --version | head -n 1)"
echo "install-llvm: $bin/$exe: $banner"
case "$banner" in
  "Apple clang"*) echo "install-llvm: got Apple clang, not LLVM $VERSION" >&2; exit 1 ;;
  "clang version $VERSION "* | "clang version $VERSION") ;;
  *) echo "install-llvm: expected clang version $VERSION" >&2; exit 1 ;;
esac
if [ -n "${GITHUB_ENV:-}" ]; then echo "LLVM_BIN=$bin" >>"$GITHUB_ENV"; fi
echo "LLVM_BIN=$bin"
