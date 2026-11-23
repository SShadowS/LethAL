# PR-377 pre-commitment: refusal-family.ts runs every family on one exact BC build

Coord PR-377 (lethal-bugs, 2026-11-23), on the orchestrator's word. Written and committed before any re-run.

## The change
- `scripts/refusal-family.ts` calls al-runner with `--bc-version 28`. `28` resolves to build 28.4.53241.53758, whose service-tier
  runtime al-runner tries to download (PR-375, R1194).
- The fix is one exported constant, `REFUSAL_FAMILY_BC_VERSION = "28.4.53241.56646"`. It is the build LethAL's DO configs and its
  live serve runs name (R1194), and the build al-runner resolved offline in PR-375. Every family run passes it.
- zip-blob's own `--bc-version` is dropped; its `--dotnet-sidecar` and `--dotnet-assembly-dir` stay.
- **A test pins it:** the constant is four numbers, and the spawned arguments carry exactly one `--bc-version`, the constant. A
  bare major version (`28`) turns it red.

## The re-run (al-runner main-bf3a3e863, `current`)
- **Before:** every family in FAMILIES (26) on master's script (`--bc-version 28`). **After:** the same, on the fixed script.
- One process at a time, nice 19, CPUs 0-11, through heavy-slot.
- Joined per cell on the cell id: outcome (pass / fail / refused / timeout / missing) and message.

## Prediction
- **0 moves in every family** (outcome and message per cell). The families' .NET types, except zip-blob's, need no service tier, and
  no stored family run contains `dotnet-unavailable` (R1194).
- zip-blob is unchanged too: it already passed the exact build.
- **Any move is reported by name, by family and cell.** It would mean an earlier family result was measured on the wrong runtime,
  and its BC differential would need a second look.
