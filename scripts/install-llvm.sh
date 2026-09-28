#!/usr/bin/env bash
# RUST-03 S2.1: install the pinned LLVM 23.1.2 clang for one LethAL native target, check the
# download's sha256 and the installed clang's banner, and export LLVM_BIN (to $GITHUB_ENV when it
# is set). One place for release.yml and ci.yml. Never floats to a newer LLVM: every asset is pinned
# by URL and hash, and the banner must say exactly "clang version 23.1.2".
#
#   bash scripts/install-llvm.sh <win32-x64|linux-x64|linux-arm64|darwin-x64|darwin-arm64>
#
# Why not KyleMayes/install-llvm-action: its asset list stops at 21.1.x, so it refuses 23.1.2 on
# every platform (CI run 36443811955 on Windows). Why conda-forge for darwin-x64: LLVM 23.1.2 has
# no official macOS x64 build (the release ships macOS-ARM64 only), and Homebrew no longer bottles
# llvm for Intel macOS. conda-forge's clang 23.1.2 osx-64 build is the pinned 23.1.2 there.
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
    exe=clang-cl.exe
    ;;
  linux-x64 | linux-arm64 | darwin-arm64)
    case "$key" in
      linux-x64) asset=LLVM-$VERSION-Linux-X64.tar.xz sha=b5ed9675149cc837c282e9b6962c276c9fa62863d5b2f91537b60848552995b7 ;;
      linux-arm64) asset=LLVM-$VERSION-Linux-ARM64.tar.xz sha=075da47cb832273717d4c7bad4b6b4848d7c154262e9ba0dcc0025426d4073f0 ;;
      darwin-arm64) asset=LLVM-$VERSION-macOS-ARM64.tar.xz sha=d7c26fc6177e42842e2d1ffaad31aec057c56a924392b1a23d830abe2c5d53b1 ;;
    esac
    fetch "$REL/$asset" "$sha" "$dest.tar.xz"
    tar -xJf "$dest.tar.xz" -C "$dest" --strip-components=1
    exe=clang
    ;;
  darwin-x64)
    mm="$dest.micromamba"
    fetch https://github.com/mamba-org/micromamba-releases/releases/download/2.9.0-0/micromamba-osx-64 \
      1e71054bb3ac9a076e21f7ec48acfef536f9b3f1408f371a942784bf5ef83d8a "$mm"
    chmod +x "$mm"
    "$mm" create --yes --root-prefix "$dest.mamba" --prefix "$dest" \
      --channel conda-forge --override-channels "clang==$VERSION"
    exe=clang
    ;;
  *)
    echo "install-llvm: no LethAL target $key" >&2
    exit 1
    ;;
esac

bin="$(dirname "$(find "$dest" -type f -name "$exe" -path "*/bin/*" | head -n 1)")"
banner="$("$bin/$exe" --version | head -n 1)"
echo "install-llvm: $bin/$exe: $banner"
case "$banner" in
  "Apple clang"*) echo "install-llvm: got Apple clang, not LLVM $VERSION" >&2; exit 1 ;;
  "clang version $VERSION "* | "clang version $VERSION") ;;
  *) echo "install-llvm: expected clang version $VERSION" >&2; exit 1 ;;
esac
if [ -n "${GITHUB_ENV:-}" ]; then echo "LLVM_BIN=$bin" >>"$GITHUB_ENV"; fi
echo "LLVM_BIN=$bin"
