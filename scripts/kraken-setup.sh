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
# four worktrees run setup at once and share $src: one at a time through the siblings
(
  flock 9
  clone bc-dev-mcp https://github.com/SShadowS/bc-dev-mcp.git
  clone business-central-mcp https://github.com/SShadowS/business-central-mcp.git
  clone pi-mcp https://github.com/SShadowS/pi-mcp.git
  for r in bc-dev-mcp business-central-mcp pi-mcp; do
    (cd "$src/$r" && { [ -d node_modules ] || npm install --silent; } && npm run --silent --if-present build)
  done
) 9>"$src/.lock"
# fixture symbol folders (.alpackages, gitignored) arrive as one tar through secret_files; kraken
# re-runs setup when its bytes change. Files extracted last time and absent now are removed.
man=.kraken-local/fixture-symbols.manifest
if [ -f .kraken-local/fixture-symbols.tar ]; then
  tar -tf .kraken-local/fixture-symbols.tar | { grep -v '/$' || true; } | sort > "$man.new"
  # never remove an absolute path or one with a .. segment, whatever an old manifest says
  if [ -f "$man" ]; then
    comm -23 "$man" "$man.new" | while IFS= read -r f; do
      case "/$f/" in */../*) continue ;; esac
      case "$f" in /* | [A-Za-z]:*) continue ;; esac
      rm -f -- "$f"
    done
  fi
  tar -xf .kraken-local/fixture-symbols.tar
  mv "$man.new" "$man"
fi
# The main checkout (/work/lethal) holds the control app every worktree's config points at
# (controlSymbolPath). Build it, as the control-app skill does, when missing or older than its
# source; its symbols came in the tar. KRAKEN_MAIN_TOP overrides the path (the unit test uses it).
if [ "$(git rev-parse --show-toplevel 2>/dev/null || true)" = "${KRAKEN_MAIN_TOP:-/work/lethal}" ]; then
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
