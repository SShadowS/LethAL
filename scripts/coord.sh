#!/usr/bin/env bash
# The LethAL coord CLI: bash scripts/coord.sh <command> [args...]
# In a kraken container (KRAKEN_PROJECT set, every process there) the inherited CG_COORD_ROOT is the
# project's own /coord, and the coord is `kraken coord`. On the Windows host an inherited
# CG_COORD_ROOT is IGNORED: the machine-wide default can point at CentralGauge's root.
# There a LETHAL_COORD_ROOT that differs from CG_COORD_ROOT is REFUSED (scripts/coord-status.ts
# applies the same rule): kraken coord reads CG_COORD_ROOT, so honouring it would mix two roots.
if [ -n "${KRAKEN_PROJECT:-}" ]; then
  if [ -n "${LETHAL_COORD_ROOT:-}" ] && [ "$LETHAL_COORD_ROOT" != "${CG_COORD_ROOT:-}" ]; then
    echo "coord.sh: LETHAL_COORD_ROOT=$LETHAL_COORD_ROOT differs from CG_COORD_ROOT=${CG_COORD_ROOT:-(unset)}; inside kraken the coord root is CG_COORD_ROOT. Unset LETHAL_COORD_ROOT or make the two equal." >&2
    exit 2
  fi
  exec kraken coord "$@"
fi
export CG_COORD_ROOT="${LETHAL_COORD_ROOT:-H:\\lethal-coord}"
moved="${CG_COORD_ROOT//\\//}/MOVED-TO-KRAKEN"
if [ -e "$moved" ]; then
  cat "$moved" >&2
  exit 3
fi
exec deno run --allow-all U:/Git/agent-coord/coord.ts "$@"
