#!/usr/bin/env bash
# The LethAL coord CLI: bash scripts/coord.sh <command> [args...]
# An inherited CG_COORD_ROOT is IGNORED: the machine-wide default can point at CentralGauge's
# root, and a wrapper that kept it would write LethAL claims there. Override with LETHAL_COORD_ROOT.
export CG_COORD_ROOT="${LETHAL_COORD_ROOT:-H:\\lethal-coord}"
exec deno run --allow-all U:/Git/agent-coord/coord.ts "$@"
