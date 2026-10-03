#!/usr/bin/env bash
# The LethAL coord CLI: bash scripts/coord.sh <command> [args...]
# In a kraken container (KRAKEN_PROJECT set, every process there) the inherited CG_COORD_ROOT is the
# project's own /coord, and the coord is `kraken coord`. On the Windows host an inherited
# CG_COORD_ROOT is IGNORED: the machine-wide default can point at CentralGauge's root.
if [ -n "${KRAKEN_PROJECT:-}" ]; then
  exec kraken coord "$@"
fi
export CG_COORD_ROOT="${LETHAL_COORD_ROOT:-H:\\lethal-coord}"
moved="${CG_COORD_ROOT//\\//}/MOVED-TO-KRAKEN"
if [ -e "$moved" ]; then
  cat "$moved" >&2
  exit 3
fi
exec deno run --allow-all U:/Git/agent-coord/coord.ts "$@"
