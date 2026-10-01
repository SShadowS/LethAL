#!/usr/bin/env bash
# The LethAL coord CLI: bash scripts/coord.sh <command> [args...]
# CG_COORD_ROOT may be set by the caller to point at another root (tests do).
export CG_COORD_ROOT="${CG_COORD_ROOT:-H:\\lethal-coord}"
exec deno run --allow-all U:/Git/agent-coord/coord.ts "$@"
