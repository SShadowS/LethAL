#!/usr/bin/env bash
# Corpus checkouts inside a kraken-lethal container (.kraken/project.yaml `setup`, second entry).
# Idempotent. The BaseApp corpus (host: U:/Git/BC.History) is the public MSDyn365BC.Code.History
# repo, branch w1-28, cloned at depth 1 into $src/BC.History on the work volume. Never pulled:
# lanes may keep local branches there. The clone goes to a temp folder and is moved into place only
# when it is complete, so a killed or failed clone never leaves a half checkout that blocks the next
# run. A failed clone exits non-zero (kraken retries setup). KRAKEN_SETUP_SRC overrides the folder
# (the unit test uses it).
set -euo pipefail
src="${KRAKEN_SETUP_SRC:-/work/src}"
mkdir -p "$src"
(
  flock 9
  if [ ! -d "$src/BC.History/.git" ]; then
    tmp="$src/.BC.History.partial"
    rm -rf "$tmp" "$src/BC.History" # either is a leftover of a clone that never finished
    if ! git clone --quiet --depth 1 --branch w1-28 --single-branch \
      https://github.com/StefanMaron/MSDyn365BC.Code.History.git "$tmp"; then
      echo "kraken-corpora: clone of the BaseApp corpus failed; setup will retry" >&2
      rm -rf "$tmp"
      exit 1
    fi
    mv "$tmp" "$src/BC.History"
  fi
) 9>"$src/.lock"
