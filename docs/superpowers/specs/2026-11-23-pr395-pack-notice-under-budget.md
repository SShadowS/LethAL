# PR-395 pre-commitment (R1200): the "pack-entries N" notice says when a time budget has switched packing off

Written 2026-11-23, during c4's quiet window (read and write only), before the build. R1200 (lethal-bugs) records the
measurement and its cause; this PR is the product fix it names.

## What was found (read-only)
- **The cause of R1200:** PR-391's A/B arms all passed `--time-budget` as a safety cap. `runMutantsParallel`
  (orchestrator.ts) switches packing off under any finite time budget:
  `budgeted = args.timeBudget !== undefined && Number.isFinite(args.timeBudget.seconds)`, then
  `packCap = split && !budgeted ? owner.packEntryCap?.() : undefined`. That is PR-241's own rule (cd660eb34, 2026-11-19,
  from R912: a budget clamps each prefetch request's deadline, so a stop must lose at most one window, never a packed
  request). PR-241's own A/B ran with no budget for that reason. So every PR-391 arm ran unpacked, which is why P1 and offP
  match.
- **The defect:** the backend prints `[lethal] al-runner-v3 pack-entries 64 (PR-241 A/B; experimental)` from `lanes()`
  whenever the cap is set, before and regardless of the orchestrator's decision. Under a budget the run says packing is on
  while it is off. That line is what misled the A/B.

## The change
- The notice moves to where the decision is made (`runMutantsParallel`, beside `packCap`/`packOn`), printed once per
  batch where packing could apply (the split):
  - packing on: `[lethal] al-runner-v3 pack-entries N (PR-241 A/B; experimental)` (today's text);
  - the cap is set but a time budget turns it off: `[lethal] al-runner-v3 pack-entries N: off under --time-budget (PR-241:
    a budget clamps each prefetch deadline, so packed requests are not sent; run without --time-budget to pack)`;
  - no cap: nothing (as today).
- The backend's unconditional line in `lanes()` is removed.
- **Not changed:** when packing applies, any request, any verdict. It is a stderr notice, not a warning event, so no
  warning code and no gate warning set moves. No gate, test or script reads the line (checked by grep on
  packages/runner/itest, tests and scripts).

## Tests (red-checked each way)
1. A split run with the cap and no budget prints the "on" line, not the "off" one.
2. The same run with a finite `--time-budget` prints the "off under --time-budget" line, not the "on" one.
3. No cap: neither line.
4. The backend's `lanes()` no longer prints a pack line (the old unconditional line is gone).

## Checks
VERIFY (one at a time, after c4's window), Opus review, selectLegs' gates (the v3 gate, since the backend file changes),
CI. The no-budget DO re-check is bugs' PR-391 re-run (offP vs P vs M), not this PR's.
