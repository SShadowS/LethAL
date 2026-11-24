# PR-403 pre-commitment: leg C's `batch-lane-strict-reruns` accepts upstream's sequential walk (ADR-070 step 3)

Coord PR-403 (lethal-bugs, 2026-11-24), on the orchestrator's word. Written and committed before the build and before the
re-gate. Evidence: today's update log `/coord/handoff/al-runner-v3-update/2026-11-24.log`, and the kept gate log
`/work/tools/al-runner-v3/failed/edge-e5176a9fd@5b3f271020093fb81b03d7a83202a9e31da373ab/gate.log`.

## Why
- Today's daily update gated edge e5176a9fd: gate-fail on leg C only (every other leg passed). The one moved fact is
  `batch-lane-strict-reruns`, one of the eight PR-114a capability facts.
  - Its judge (`al-runner-v3-contract.ts`) expects, with `strictOrder: true`, the reader `Codeunit50773.NeedsFive` to be
    re-run: a first row failing "store is 0", then a passing one.
  - The passing builds (main-bf3a3e863, 3.0.0-alpha.15) read exactly that.
  - Edge reads `Codeunit50772.StoresFive=pass Codeunit50773.NeedsFive=pass`: two rows, with the reader once, after the
    writer.
- **The cause is deliberate upstream work, ADR-070 step 3:** 6a31851380 "switch --strict-order to the sequential walk,
  delete the lane re-runs", then f479ec6c13 and d328ade49f. Under `strictOrder`, al-runner now runs the codeunits in order,
  so the reader runs once, after the writer, and sees its state.
- **Not a verdict away from BC.** In one BC session a reader that runs after its writer sees the writer's state, which is
  the new reading.
  - The fact's own text says the body is "NOT LethAL's".
  - LethAL sends `strictOrder` only in PR-340's carry walk, under `AL_STRICT_SEQUENTIAL=1`, judged by its own fact
    `batch-sequential-carry` ("the reader runs after it ONCE"). That fact passed on edge, and nothing in LethAL relies on
    the lane re-run.

## The change (one judge)
`batch-lane-strict-reruns` reads `matches` on EITHER shape, and `diverged` on anything else:
- **the re-run (until ADR-070 step 3):** the reader's rows are exactly two, the first `fail` "store is 0" and the second
  `pass` (the judge as today, unchanged);
- **the sequential walk (from ADR-070 step 3):** the batch holds exactly two rows: the writer `Codeunit50772.StoresFive`
  `pass`, then the reader `Codeunit50773.NeedsFive` `pass`, in that order.
- Everything else stays `diverged`, e.g. the reader failing once ("store is 0") with no re-run, the reader failing again,
  the reader before the writer, or a third row.
- The `expected` text names both shapes and the three commits.

## What does not change
- `baselineBatchingFor` still needs all eight facts at `matches`, from the build's record AND this session's probe. The
  set of shapes that read `matches` widens by exactly one, and only for this fact. No other fact's judge, no pin, no
  default and no leg's figure moves.
- The receipts of main-bf3a3e863 and alpha.15 still read `matches` (the re-run shape), so their records stay valid. Their
  `readingsDigest` covers pins, not this judge, and `r814-gated-builds.test.ts` is unaffected.

## Tests (red before the build), in `packages/runner/tests/al-runner-v3-contract.test.ts`
1. The sequential walk reads `matches` (writer pass, then reader pass, two rows).
2. The re-run reads `matches`, as today.
3. **Neither shape (the orchestrator's third test):** the reader failing "store is 0" once, with no re-run, reads
   `diverged`; so do the reader before the writer, and the reader failing again.
- Each direction red-checked: drop the new shape and test 1 goes red; accept "any final pass" and test 3 goes red.

## Predictions
- **VERIFY:** green.
- **The full v3 gate on `current` (main-bf3a3e863):** PASS, with leg C's `batch-lane-strict-reruns` still `matches`
  (the re-run shape).
- **The re-gate of edge e5176a9fd from master, after the merge:** leg C reads `batch-lane-strict-reruns = matches`, and
  every leg passes. `serve-keep-reasons` stays the known `diverged` warn fact.
  - If it passes, `current` moves to edge-e5176a9fd by the script, as usual.
  - Edge carries upstream's login replay. LethAL's PR-360 pin keeps it off, and lethal-code is told (PR-402 step 2).
  - Any other leg moving is a STOP, read and named before anything else.
- **Timing:** the re-gate waits for lethal-code's PR-402 gate on `current` to end.
