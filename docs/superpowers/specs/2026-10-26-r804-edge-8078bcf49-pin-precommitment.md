# R804 pre-commitment (R-804): pin edge-8078bcf49 (3.0.0-alpha.5+edge.20261026)

Written 2026-10-26 by lethal-bugs. Lethal-spare builds the pin (lethal/r8078-pin 454d1350) and runs the
merge, regate, rejudge, K and timing sequence. Basis: the update-gate receipt
`/work/tools/al-runner-v3/failed/edge-8078bcf49@4aa6ca6df8e3770713f3dc4b31b105b710ddff45/` (judged at .gated 4aa6ca6d:
GATE-FAIL, with C, N1E and X held and O1 and T failing for lack of a pin). The commit-isolation probe:
`/coord/handoff/R-804/commit-probe/result.md`.

Build: `al-runner 3.0.0-alpha.5+edge.20261026 (8078bcf49)`, sha256 `614dc78c8513c6d5899fb402a121c2c6f910cbe255f56ab66a59f1a8f8d852d7`.

## Rulings
- **(a) `V3_SERVE_SAFE_REFUSALS` stays sound on this build.** Its two moved entries now match nothing: a `Commit()` under
  per-test isolation PASSES, and a failing OnRun gives no row, which fails closed as a missing row. So the list can only
  close daemons more often.
  - The commit move needed one more proof: a committing test now RUNS, so its committed state must stay inside its own
    entry. The probe measured that on this build and found NO CARRY-OVER: 7 kinds after `Commit()`, on the own and CDO
    17-app sets, within a request and across requests of one daemon, and in one-shot runs.
  - A commit kind in leg O1 makes this permanent. It is built and pre-committed separately; it is not part of this pin.
- **(b)** Relaxing LethAL's own refusals for the defects this build fixed is R803, after the talk. This pin moves no
  LethAL refusal logic.

## The pin `edge-8078bcf49` (data)
- **legC, eight facts `gone`:**
  - with alpha.5's objects and texts identical to the receipt: `none-selected-exit` (exit 6, stdout 0 rows),
    `quoted-name-unselectable` (exit 0), `refusal-cascade` (LaterFails "later", exit 1), `sleep-is-noop` (cut pattern;
    no-flag call under 1000 ms), `upstream-compile-errors` (exit 3, null), `refusal-row-shape` (`BC_HTTP_HUB_TEXT`, exit 1);
  - new: `duplicate-key-insert-raises` gone, with exactly `BC_END_OF_TEST_TEXT` ("The record in table Probe Row already
    exists. Identification fields and values: Key='K1'"), fail, exit 1 (#5788; as BC);
  - new: `commit-under-test-isolation` gone (CommitCall pass, exit 0; #5607; as BC).
  - `codeunit-runs-whole` reads `defect-present` (the default; not pinned).
  - `serve-keep-reasons` (a WARN fact) reads `diverged` (commit MOVED to pass; onrun-failed MOVED to no row). It is
    accepted, and recorded in the receipt's warn facts; it never holds or fails a gate (R612).
- **legT: 48 rows**, each a `TABLES_KNOWN_DIFFERENCES` key moving from v3's old verdict to BC's
  (`/coord/handoff/lethal-spare-edge/t-rows-8078.ts.txt`):
  - 7 duplicate-key rows: survived -> killed by `DoubleInsertWithoutKeyTriggerRaises` (#5603);
  - 41 Commit rows: 21 no-coverage -> killed (by `CommittedWriteSurvivesFailure`, `CommitBeforeCodeunitRunSucceeds` or
    `CommitBeforeValueFormCodeunitRunSucceeds`), and 20 no-coverage -> survived (#5607).
  - Counts 318 / 70 / 18 over 406 (the committed 290 / 57 / 59 plus exactly these moves); `refusedTests` 0.
  - Pass line: `T: pinned 48 rows (pin edge-8078bcf49, #5603, #5607)`.
- **xb:** exit 3 / 0 / 0. **serveRowFields:** #5798 (R782). **o1.cdoWorkDate:** 2026-08-01 (#5743), as on a157b2d34.

## Code beyond the data (named so it is part of what is judged)
- A T row pin may carry `from` (the committed row it replaces; default survived / - / -), and legT may carry
  `refusedTests` (default 3).
- `applyTPin` resets `coverageFiltered` to follow the pinned verdict, so a row pinned out of no-coverage is not left held.
- The T pass line lists the rows' own issues; for the earlier pins it stays "#5788".

## Predicted figures: the update gate on 8078bcf49 at the pin's merge commit
- **C:** pass (eight pinned `gone` facts; `serve-keep-reasons` diverged as a warn line only).
- **N1E:** pass by completion, 36/0/0 per mutant equal to `bcdev.names.baseline.json`, 0 echo mismatches, empty warning
  set. This comes from R782's pre-commitment (ab5e0e5b, addendum 5587b588), not from the 08:05Z receipt, which was judged
  before R782.
- **O1:** pass on both sets, with the CDO WorkDate 2026-08-01.
- **X:** pass with xb exit 3 / 0 / 0.
- **T:** pass, with the 48 pinned rows and the counts above.
- **Every other leg** (S1, S1E, S3, N1, N1S, L1, Y-A, Y-B, MO, WR, K, D1, D1c): as on a157b2d34, per mutant. D1 and D1c
  have 0 differences against `bc3-A` and `bc3-B`.
- Update gate outcome: `pass`, so `current` moves to edge-8078bcf49.

## Judgement
Any other reading is a BLOCK until explained, in a dated addendum, never an edit of this file.
