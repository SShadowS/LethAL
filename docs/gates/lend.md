# itest:lend

`LETHAL_ITEST_LEND=1 bun run itest:lend` is R618's gate. It runs the store's lend order on a BC
server with real lends. To "lend" here means that a session reuses something an earlier run
recorded: a survivor under `--skip-known-survivors` (history), a verdict under `--resume` or
`--resume-run`, or a batch's baseline (a baseline snapshot, R192). Every other BC gate starts from
an empty results store and sets none of those flags, so none of them ever lends.

It runs `fixtures/sandbox-app` with `fixtures/sandbox-tests` through the bcdev backend, on
`itest:bcdev`'s connection (the config in `fixtures/sandbox-app/` that `LETHAL_ITEST_CONFIG` names,
see [servers.md](servers.md)). It uses a SCRATCH results store, never the fixture's
`lethal.sqlite`, and publishes nothing beyond what `itest:bcdev` publishes. It compares every leg
with `bcdev.baseline.json` by identity key and records no baseline of its own. The plan is
`docs/superpowers/plans/2026-10-22-r618-bc-lend-gate.md` (r2).

It passed on bc1, bc2 and bc3 at 7084eece (see [servers.md](servers.md) and History below).

## Frozen figures

```json gate-figures
{
  "gate": "itest:lend",
  "baselines": {},
  "noBaseline": "Expectations are pre-committed constants (LEND_FIGURES, LEND_MUTANTS in gate-expected.ts); every leg reads bcdev.baseline.json read-only and compares with it by identity key.",
  "constants": {
    "LEND_FIGURES.totalMutantSites": 19,
    "LEND_FIGURES.fresh.killed": 3,
    "LEND_FIGURES.fresh.survived": 12,
    "LEND_FIGURES.fresh.noCoverage": 4,
    "LEND_FIGURES.fresh.groupedCalls": 15,
    "LEND_FIGURES.history.killed": 3,
    "LEND_FIGURES.history.survived": 0,
    "LEND_FIGURES.history.noCoverage": 4,
    "LEND_FIGURES.history.knownSurvivors": 12,
    "LEND_FIGURES.history.groupedCalls": 3,
    "LEND_FIGURES.resumeWhole.carryable": 19,
    "LEND_FIGURES.resumeWhole.carried": 19,
    "LEND_FIGURES.resumeWhole.groupedCalls": 0,
    "LEND_FIGURES.resumeSnapshot.carryable": 9,
    "LEND_FIGURES.resumeSnapshot.carried": 7,
    "LEND_FIGURES.resumeSnapshot.nonCarryableRows": 1,
    "LEND_FIGURES.resumeSnapshot.groupedCalls": 8,
    "LEND_FIGURES.resumeRefusedSnapshot.carried": 15,
    "LEND_FIGURES.resumeRefusedSnapshot.groupedCalls": 0,
    "LEND_FIGURES.sentinel.code": "M0004",
    "LEND_FIGURES.sentinel.durationMs": 987654,
    "LEND_FIGURES.kept": ["M0001", "M0002", "M0004", "M0005", "M0006", "M0007", "M0008", "M0016", "M0017"],
    "LEND_FIGURES.keptAsError": ["M0003"],
    "LEND_FIGURES.r3Rerun": ["M0019"]
  },
  "notPinned": {
    "warningMessages": "the exact texts of history-backend-build-changed (N1), snapshot-backend-build-changed (R3) and the RN refusals are built in the itest from run ids",
    "ranHere": "R3's count of baseline tests that ran here equals L0's, and R2's is 0"
  }
}
```

- L0, N1 and N5 score 3 / 12 / 4 over 19, per mutant equal to `bcdev.baseline.json`. Nothing is
  lent. `groupedCalls` is 15.
- L1 and N0 score 3 / 0 / 4, with the 12 survivors recorded as known survivors and not run.
  `knownSurvivors` is 12. `groupedCalls` is 3.
- R1 carries all 19 mutants of the one batch whole. `carried` is 19, and nothing is deployed.
- R2 has 9 KEPT rows. It carries 7 of them, every one this session covers; its two KEPT rows that this session
  leaves uncovered come back as fresh no-coverage (see "In a partly carried batch, uncovered mutants are re-derived"
  below). It re-runs the other 10, one of them from an `error` row. `carried` is 7, `nonCarryableRows` 1,
  `groupedCalls` 8.
- R3's K2 has 18 rows (not asserted). It carries 15 of them, every one this session covers, re-derives the three uncovered
  ones, and scores M0019 as no-coverage. `carried` is 15.
- The sentinel row (M0004 in K) has `durationMs` 987654.

### In a partly carried batch, uncovered mutants are re-derived

- **Partly carried batch:** `scoreBatch` records the mutants this session's own coverage selection leaves uncovered
  as fresh no-coverage, before any carry lookup. Every other mutant is looked up, and a stored no-coverage for a
  mutant covered now IS carried. So carried = carryable rows minus rows uncovered in this session.
- **Wholly carried batch:** `replayCarriedBatch` (R1) carries every verdict, no-coverage included.
- **On this fixture** the two rules give the same sets: `assertFrozen` pins every verdict, so "frozen no-coverage" and
  "uncovered now" are the same mutants, and the gate's `carriedInPartBatch` filters on the frozen verdict.
- **Status:** the case where a stored no-coverage is carried against this session's coverage is filed as
  [R621](../roadmap/R621.md). No gate exercises it.
- **How it was found:** live run 1 on bc1 was BLOCKED at R2 (7 carried against 9 pre-committed;
  `/coord/handoff/R-618/live-run-1.md`), and the pre-commitment got an addendum before the re-run.

## The legs

The legs run in this order on one store. A is L0's run, H its proven test-app hash, D its
dependency fingerprint. A "clone" is `seedRunFrom` (`packages/runner/itest/lend-seed.ts`): a copy of
A's run row and rows, with only the named field changed.

| leg | seed | session | expected |
|---|---|---|---|
| L0 | none | no flag | frozen; H contains `\|closed-world:public` (refused by name otherwise); one unsuffixed snapshot |
| L1 | none | `--skip-known-survivors` | the 12 survivors known, by key; no lend warning |
| R1 | F: unfinished full clone | `--resume-run F` | `resume-reusing-run` (19), `resume-batch-carried`; all carried; no deploy |
| R2 | SP1 to SP4 (snapshot owners), then K | `--resume` | resolves to K; `resume-baseline-reused` names L1's run B; KEPT minus its two uncovered rows carried by key; the sentinel's `priorDurationMs`; no baseline test ran here |
| R3 | SV3 (a v3 snapshot owner), K2 | `--resume-run K2` | `snapshot-backend-build-changed`, exact; the baseline re-ran (as many tests as L0's) |
| N0 | finished clone | `--skip-known-survivors` | as L1: the clone lends |
| N1 | finished v3 clone | `--skip-known-survivors` | `history-backend-build-changed`, exact; nothing lent |
| N5 | finished clone, revoked | `--skip-known-survivors` | `history-test-app-changed` naming `H\|closed-world:revoked`; nothing lent |
| RN3 | KV: unfinished v3 clone | `--resume-run KV` | refused: another backend |
| RN1 | KP: unfinished pending clone | `--resume` | refused at the test app (`H\|pending`), and it picked KP |
| RN2 | KR: unfinished clone, revoked | `--resume-run KR` | refused at the test app (`H\|closed-world:revoked`) |
| RN4 | none | `--resume-run A` | refused: A already finished (R618 ruling 2) |

The RN legs throw before the session creates a run row and before it takes the lease. Every leg
also checks that its own run row records H and D, so that a republish between legs cannot make a
negative leg pass for the wrong reason, and that it emitted exactly its expected lend warnings
(codes starting `history-`, `resume-`, `snapshot-`, and `carry-refused-renumbered`).

K is written with its `mutant_code` and `line` values rotated among its rows, keys intact, so a
carry that matched by code would go red (I2). Its M0003 row is an `error`, so `nonCarryableRows`
runs live (Q3).

## What this gate cannot reach

- **The resume sites' `backendBuildRefusal`.** In a bcdev session `--resume` only finds runs of the
  same backend (its SQL), and `--resume-run` checks backend equality first. So deleting the
  `assertLends` call at either site reddens no leg here. The al-runner-v3 legs and the unit tests
  in `tests/r586-run-may-lend.test.ts` cover them.
- **The snapshot site's R557 check** (`runLendsAlRunnerNames` on the snapshot's run). A bcdev
  session cannot hold an al-runner snapshot of the same coverage mode. The al-runner legs and unit
  tests cover it.
- **The history site's R557 check and its order against coverage mode and test app.** These are
  pinned offline in `tests/r618-lend-order.test.ts` (the N1o unit test and the RC4a case), not live.
- **Another `runner_build`.** Only v3 compares builds.
- **`runMayLend` itself.** It has no production caller; each site copies its steps inline. That
  is filed as [R619](../roadmap/R619.md).

## Clone fidelity

A seed is not a full copy of a real run (review M2). It copies every field a lend check reads
(`getRun`'s fields) and the mutant rows through `recordMutant`, but not `resource_key`, `app_id`,
`test_digests`, `batch_artifacts`, `installed_bundles` or `test_results`. An interrupted clone is
therefore not exactly what a real interruption leaves: a real one would also hold its own
snapshot and test results. `lend-seed.test.ts` (offline, in CI) pins that a clone with no
override reads back as its source in `getRun`, `mutantVerdicts`, `priorSurvivorKeys` and
`findResumableRun`, and that each override changes only its own field. N0 is the same check live.

A crashed closed-world run keeps `|pending` and is never resumable; RN1 pins that refusal. A
quarantined one is confirmed and stays resumable (an offline orchestrator test, Q1).

## Out of scope

`carry-refused-renumbered` (a recorded key whose verdict is not carried because the source changed
and the mutant is a twin) is not exercised: the fixture has no twins and its source does not change
between legs.

## Red checks

The live results are in `/coord/handoff/R-618/redcheck-live-results.md`, the offline ones in
`/coord/handoff/R-618/redcheck.md`. Per site:

- RC1a: delete the history site's `backendBuildRefusal` call: N1 goes red (live), and
  `r618-lend-order.test.ts` and `lend-seed.test.ts` (offline).
- RC1b: delete the snapshot site's `backendBuildRefusal` call: R3 goes red (live).
- RC4a: delete the history site's R557 mark check: `r618-lend-order.test.ts` goes red (offline).
- N5: delete the history site's test-app hash comparison: `r618-lend-order.test.ts`'s N5 test goes
  red (offline only; RC6 and RC7 break other sites).
- RC7: make `assertSameTestApp` return early: RN1 still throws, later, from the R496 recheck under
  the lease (`TestAppRepublishedError`), so the refusal-head check goes red. RC7b breaks both
  checks: only then is a pending run carried.
- **No red check:** RN2 (the gate stops at RN1 under RC7 and RC7b, so RN2's own route is never
  shown red) and RN3 (old code, not broken here).

## History

- 2026-10-22: built offline (R618).
- 2026-10-22, live run 1 on bc1: BLOCKED at R2. L0, L1 and R1 were as pre-committed. R2 carried 7, not 9 (the
  no-coverage KEPT rows were re-derived). Ruling (a): an addendum, then a re-run of the whole gate.
- 2026-10-22, at 7084eece, under LethAL Control 1.0.0.23:
  - **PASS on bc1** (`/coord/handoff/R-618/lend-bc1-run2.log`), **bc2** (`lend-bc2.log`) and **bc3**
    (`lend-bc3.log`). Every leg and the refusals RN1-RN4 were as pre-committed with the addendum.
  - **The 10 live red checks went red at their predicted leg**, plus an N0-only form of RC10
    (`/coord/handoff/R-618/redcheck-live-results.md`). The clean confirm afterwards passed.
- 2026-10-22, at 03547bf6 (R-618 merged with master after R582, which re-runs every kill on bcdev): **PASS on
  bc1** (`/coord/handoff/R-618/lend-bc1-merged.log`), every leg's figures unchanged.
