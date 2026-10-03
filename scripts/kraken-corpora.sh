#!/usr/bin/env bash
# Corpus checkouts inside a kraken-lethal container (.kraken/project.yaml `setup`, second entry).
# Idempotent. The BaseApp corpus (host: U:/Git/BC.History) is the public MSDyn365BC.Code.History
# repo, branch w1-28, cloned at depth 1 into $src/BC.History on the work volume. Never pulled:
# lanes may keep local branches there. KRAKEN_SETUP_SRC overrides the folder (the unit test uses it).
set -euo pipefail
src="${KRAKEN_SETUP_SRC:-/work/src}"
mkdir -p "$src"
(
  flock 9
  if [ ! -d "$src/BC.History/.git" ]; then
    git clone --quiet --depth 1 --branch w1-28 --single-branch \
      https://github.com/StefanMaron/MSDyn365BC.Code.History.git "$src/BC.History"
  fi
) 9>"$src/.lock"
