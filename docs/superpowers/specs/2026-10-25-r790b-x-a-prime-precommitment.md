# R-790b pre-commitment (2026-10-25): leg X (a′), speculative rows from an alc-rejected batch are discarded

Committed before any live run of the leg. It closes R790's open point: leg X (a) cannot see the speculative
baseline, because its backend has no budget floor and no suite, so it never speculates.

## What X (a′) runs

Inside leg X of `itest:alrunner-v3` (`legX`, after X (a)), on X (a)'s broken batch (`SandboxLogic.Codeunit.al`
with `NoSuchVar := 1;`, which alc rejects with AL0118 and v3 runs anyway, X (b)):
- a backend with the speculative baseline ON: `transport: "serve-entries"`, the session's tests (`Sandbox Tests`,
  codeunit 79100: `OverBudgetDetected`, `ClampPercentRuns`), a budget floor (`useMutantBudgetFloor(180000, 120000)`);
- `deploy(broken)`.

## Pinned (the leg fails on any other reading)
- deploy() throws `AlcCompileError`, and its text equals X (a)'s once the scratch folder (`xa2` for `xa`) is mapped:
  today's error, byte for byte;
- v3 spawned exactly **1** time (the one test codeunit's speculative call), beside the failing alc;
- nothing is kept (`speculative` is unset);
- a baseline after it is refused (`activate(null)` throws "before a successful deploy"), so no baseline row can
  reach the store or the report.

## Not a new leg
X (a′) is a sub-check of leg X, which is already in `V3_GATE_LEGS`. No leg is added, so R777 (a new leg means a
`--regate` of `current`) does not apply. No other leg or sub-check moves.

## The red check (before the submit)
With the discard disabled (the alc-failure path keeps the speculative calls), leg X must read gate-fail.

## Amendment 1 (2026-10-25, 23:05 UTC): the first live run failed on the error-text pin
The first live run of leg X at fc8bc677 (`/coord/handoff/R-790b/legX-r790b.log`, `legX-r790b-diag.log`) read: an
`AlcCompileError`, 1 spawn, nothing kept, a baseline refused. That matches every pin except the text. The text
differed from X (a)'s in alc's banner line, `Compilation started for project ... containing '3' files at
'<time>'` (X (a)) against `'4' files` (X (a′)), for two reasons that have nothing to do with the speculation:
- alc prints its start time, so no two compiles' texts are equal byte for byte. The pin above was wrong.
- X (a) uses the default transport, and X (a′) uses `serve-entries`, which stages one more file.

The amended pin replaces the first bullet above:
- X (a′) also runs a REFERENCE backend, identical to X (a′)'s (serve-entries, the same suite and floor) except that
  speculation is off (today the `noSpeculativeBaseline` seam; once R-798 lands, `speculateBaseline: false`). The
  reference spawns v3 **0** times, and its error names AL0118.
- X (a′)'s deploy() throws `AlcCompileError`, and its text equals the reference's once both scratch folders read
  `<scratch>` and alc's ` at 'hh:mm:ss.fff'` start time reads ` at '<time>'`. Nothing else is masked.

The other pins (1 spawn, nothing kept, a baseline refused) and the red check do not change. When R-798 makes
speculation opt-in, X (a′) passes `speculateBaseline: true`, with the same pins.
