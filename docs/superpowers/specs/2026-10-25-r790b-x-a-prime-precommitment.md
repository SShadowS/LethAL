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
