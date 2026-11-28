#!/usr/bin/env bash
# Per-worktree setup inside a kraken-lethal container (.kraken/project.yaml `setup`).
# Idempotent: safe to re-run. Sibling repos are shared by all worktrees under /work/src, on the
# work volume so they survive a container recreation (the image links /home/dev/src to it for
# the .mcp.json paths). Setup runs once per worktree, so anything off the volume would be lost.
# KRAKEN_SETUP_SRC overrides the sibling-repo folder (the unit test uses it).
set -euo pipefail
src="${KRAKEN_SETUP_SRC:-/work/src}"
mkdir -p "$src"
clone() { # <name> <url>
  if [ ! -d "$src/$1/.git" ]; then git clone --quiet "$2" "$src/$1"; else git -C "$src/$1" pull --quiet --ff-only || true; fi
}
# PR-484: install a sibling's dependencies (run in its folder) whenever its TRACKED dependency files (package.json,
# package-lock.json, bun.lock, as git tracks them) differ from the stamp the last install left in node_modules, so a
# pull that bumps a dependency is installed (2026-11-27: business-central-mcp kept bc-toolbox-envelope 0.1 and failed
# tsc). `npm ci` when package-lock.json is tracked; else `npm install` (bc-dev-mcp and pi-mcp track bun.lock, and their
# package-lock.json is an untracked npm leftover). Every failure fails setup by name and writes no stamp.
# NOTE: deps runs inside an && list, where `set -e` does not stop on a failure, so every step checks its own status.
deps() {
  local files want have
  files=$(git ls-files package.json package-lock.json bun.lock) || { echo "kraken-setup: git ls-files failed in $PWD" >&2; return 1; }
  if [ -z "$files" ]; then
    [ -d node_modules ] || npm install --loglevel=error || { echo "kraken-setup: npm install failed in $PWD" >&2; return 1; }
    return 0
  fi
  want=$(git ls-files -z package.json package-lock.json bun.lock | xargs -0 cat | sha256sum | cut -c1-64) || { echo "kraken-setup: hashing the dependency files failed in $PWD" >&2; return 1; }
  [[ $want =~ ^[0-9a-f]{64}$ ]] || { echo "kraken-setup: the dependency hash in $PWD is not a sha256" >&2; return 1; }
  have=$(cat node_modules/.kraken-deps.sha256 2>/dev/null || true)
  [ "$want" = "$have" ] && return 0
  if git ls-files --error-unmatch package-lock.json >/dev/null 2>&1; then
    npm ci --loglevel=error || { echo "kraken-setup: npm ci failed in $PWD" >&2; return 1; }
  else
    npm install --loglevel=error || { echo "kraken-setup: npm install failed in $PWD" >&2; return 1; }
  fi
  echo "$want" > node_modules/.kraken-deps.sha256
}
# four worktrees run setup at once and share $src: one at a time through the siblings
(
  flock 9
  clone bc-dev-mcp https://github.com/SShadowS/bc-dev-mcp.git
  clone business-central-mcp https://github.com/SShadowS/business-central-mcp.git
  clone pi-mcp https://github.com/SShadowS/pi-mcp.git
  for r in bc-dev-mcp business-central-mcp pi-mcp; do
    (cd "$src/$r" && deps && npm run --silent --if-present build)
  done
) 9>"$src/.lock"
# fixture symbol folders (.alpackages, gitignored) arrive as one tar through secret_files; kraken
# re-runs setup when its bytes change. Files extracted last time and absent now are removed.
man=.kraken-local/fixture-symbols.manifest
top="$(git rev-parse --show-toplevel 2>/dev/null || true)"
# R670: with an R614 marker (.fixture-symbols.sha256) the two gate folders belong to
# prepareFixtureSymbols, which trusts the marker. Writing another tar's files under it would make a
# stale marker read "verified", so they are neither removed nor extracted here.
gated() {
  [ -f .fixture-symbols.sha256 ] || return 1
  case "$1" in fixtures/sandbox-tests/.alpackages/* | fixtures/sandbox-data-tests/.alpackages/*) return 0 ;; esac
  return 1
}
if [ -f .kraken-local/fixture-symbols.tar ]; then
  tar -tf .kraken-local/fixture-symbols.tar | { grep -v '/$' || true; } | sort > "$man.new"
  # never remove an absolute path or one with a .. segment, whatever an old manifest says
  if [ -f "$man" ]; then
    comm -23 "$man" "$man.new" | while IFS= read -r f; do
      case "/$f/" in */../*) continue ;; esac
      case "$f" in /* | [A-Za-z]:*) continue ;; esac
      gated "$f" && continue
      rm -f -- "$f"
    done
  fi
  if [ -f .fixture-symbols.sha256 ]; then
    tar -xf .kraken-local/fixture-symbols.tar --anchored \
      --exclude=fixtures/sandbox-tests/.alpackages --exclude=fixtures/sandbox-data-tests/.alpackages
  else
    tar -xf .kraken-local/fixture-symbols.tar
  fi
  mv "$man.new" "$man"
  # R670: the code reads the pinned tar as fixture-symbols-<first 12 hex of its sha256>.tar, so a
  # re-pin never overwrites a tar older worktrees still pin. Keep a copy under that name, once per
  # tar, in the main checkout only (FIXTURE_SYMBOLS_TAR is under /work/lethal).
  if [ "$top" = "${KRAKEN_MAIN_TOP:-/work/lethal}" ]; then
    named=.kraken-local/fixture-symbols-$(sha256sum .kraken-local/fixture-symbols.tar | cut -c1-12).tar
    if [ ! -f "$named" ]; then
      cp .kraken-local/fixture-symbols.tar "$named.part"
      chmod 600 "$named.part"
      mv "$named.part" "$named"
    fi
  fi
fi
# The main checkout (/work/lethal) holds the control app every worktree's config points at
# (controlSymbolPath). Build it, as the control-app skill does, when missing or older than its
# source; its symbols came in the tar. KRAKEN_MAIN_TOP overrides the path (the unit test uses it).
if [ "$top" = "${KRAKEN_MAIN_TOP:-/work/lethal}" ]; then
  ctl="$PWD/extensions/lethal-control"
  app="$ctl/lethal-control.app"
  if [ ! -f "$app" ] || [ -n "$(find "$ctl/src" "$ctl/app.json" -newer "$app" -print -quit)" ]; then
    # compile to a temp name and rename, so a failed compile never leaves a fresh-looking partial app
    rm -f "$app.tmp"
    "${LETHAL_ALC_DIR:?LETHAL_ALC_DIR unset}/alc" "/project:$ctl" "/packagecachepath:$ctl/.alpackages" "/out:$app.tmp"
    mv -f "$app.tmp" "$app"
  fi
fi
bun install
bun scripts/build-native-parser.ts
