#!/usr/bin/env bash
# R670: rebuild the fixture-symbols tar.
#   bash scripts/build-fixture-symbols-tar.sh <old.tar> <repo> <workdir> <out.tar>
# Keeps every non-LethAL member of <old.tar> byte for byte; replaces every LethAL app copy (LethAL_*.app,
# target.app) with an alc build of the dependency's CURRENT source from <repo>, named LethAL_<name>_<version>.app,
# in each project that declares it. A project's copy of its own app (never a dependency, R148) is dropped.
# <workdir> is scratch (its tree/ and built/ are replaced). Packs reproducibly: ustar (the R614 reader),
# sorted names, fixed mtime, owner and mode. alc is not byte-stable, so the sha256 pin is the identity.
# Then name the result fixture-symbols-<first 12 hex of its sha256>.tar and follow docs/gates/alrunner-v3.md.
set -euo pipefail
# the unit test points this at a path that does not exist, so the refusal is seen on its own
OLD_TAR=${FIXTURE_SYMBOLS_OLD_TAR:-/work/lethal/.kraken-local/fixture-symbols.tar}
if [ $# -ne 4 ]; then
  echo "usage: $0 <old.tar> <repo> <workdir> <out.tar>" >&2
  exit 2
fi
old=$1 repo=$2 work=$3 out=$4
if [ -e "$out" ]; then
  echo "refused: $out exists; a tar another worktree may pin is never overwritten" >&2
  exit 2
fi
if [ "$(realpath -m -- "$out")" = "$OLD_TAR" ]; then
  echo "refused: $out is the kraken secret_files tar ($OLD_TAR); write beside it under a new name" >&2
  exit 2
fi
alc="${LETHAL_ALC_DIR:?}/alc"
tree=$work/tree
rm -rf "$tree" "$work/built" && mkdir -p "$tree"
tar -xf "$old" -C "$tree"
find "$tree" -path '*/.alpackages/*' \( -name 'LethAL_*.app' -o -name 'target.app' \) -print -delete
# every project in the tree, and its LethAL dependencies by name
for proj in $(cd "$tree" && ls -d fixtures/*/ examples/*/ | sed 's#/$##'); do
  [ -f "$repo/$proj/app.json" ] || continue
  jq -r '.dependencies[]? | select(.publisher=="LethAL") | .name' "$repo/$proj/app.json" | while IFS= read -r dep; do
    target=$(for a in "$repo"/fixtures/*/app.json "$repo"/examples/*/app.json; do
      if [ "$(jq -r .name "$a")" = "$dep" ]; then dirname "$a"; fi; done)
    [ -n "$target" ] || { echo "no fixture for $dep (needed by $proj)" >&2; exit 1; }
    ver=$(jq -r .version "$target/app.json")
    built=$work/built/LethAL_${dep}_${ver}.app
    if [ ! -f "$built" ]; then
      mkdir -p "$work/built"
      rel=${target#"$repo"/}
      "$alc" "/project:$target" "/packagecachepath:$tree/$rel/.alpackages" "/out:$built" >"$work/built/$dep.log" 2>&1 ||
        { cat "$work/built/$dep.log" >&2; exit 1; }
    fi
    cp "$built" "$tree/$proj/.alpackages/"
    echo "$proj <- LethAL_${dep}_${ver}.app"
  done
done
(cd "$tree" && tar --format=ustar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner \
  --mode='a=rX,u+w' -cf "$(realpath -m -- "$out")" examples extensions fixtures)
sha256sum "$out"
stat -c %s "$out"
