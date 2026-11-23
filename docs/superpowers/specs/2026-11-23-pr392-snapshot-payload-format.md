# PR-392 pre-commitment (R1199): an R192 baseline snapshot from before PR-387 is not reused

Written 2026-11-23, before the build. The open NIT of PR-387's Opus build review.

## The gap (measured from the code)
- PR-387 marks a bcdev baseline row whose test body never ran (`TestVerdict.bodyNeverRan`, set on the hub's tool-error and
  no-result rows; `notRun: true` on the event), and counts it in `notRunAtBaseline`.
- An R192 snapshot (`baseline_snapshots`, store.ts) stores the baseline rows as JSON and is recorded whenever every test
  reached a verdict (`baseline.length === tests.length`, orchestrator.ts): a hub tool-error row is an `error` verdict, so a
  baseline holding one IS stored.
- A snapshot written before PR-387 has no `bodyNeverRan` on such a row. Reused on `--resume`, the row does not reach
  `notRunAtBaseline`: the caveat can under-count. No verdict moves (the caveat changes none).

## The change
- `baseline_snapshots` gains `payload_format INTEGER` (an `ALTER TABLE ... ADD COLUMN`, as `backend_state` was added); every
  existing row reads NULL.
- `recordBaselineSnapshot` writes `payload_format = 2` (`SNAPSHOT_PAYLOAD_FORMAT`, one exported constant; 2 = "rows carry
  `bodyNeverRan` where the body never ran").
- `findBaselineSnapshot` requires `payload_format = 2` beside its existing filters. `=` never matches NULL (the R354/R496
  rule), so a snapshot recorded before this PR lends none, and its batch re-runs its baseline once.
- Nothing else: the payload's shape, the key, the other filters and every verdict are unchanged.

## Predictions
- Gates run on fresh stores, so no gate figure moves.
- `itest:lend` (real `--resume` and snapshot reuse on sandbox-app, the orchestrator's ask) passes unchanged: within one run
  the snapshot it reuses was written by this code (format 2).
- A store opened by this code adds the column once; reopening it adds nothing (the migration is idempotent).

## Tests (red-checked each way)
1. A snapshot recorded now is found by `findBaselineSnapshot` (its other filters satisfied).
2. A row with `payload_format` NULL (written by hand as an older store would hold it) with the same hashes is NOT found;
   setting it to 2 makes it found (the positive control).
3. Opening an existing store that lacks the column adds it, and a second open is a no-op.

## Checks
VERIFY (one at a time), an Opus review of the diff, selectLegs' gates plus `itest:lend`, CI. Gates on CPUs 12-21 (PR-391's
A/B holds 0-11).
