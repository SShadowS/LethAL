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

It is not yet proven on any server (see [servers.md](servers.md)).

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
    "LEND_FIGURES.resumeSnapshot.carried": 9,
    "LEND_FIGURES.resumeSnapshot.nonCarryableRows": 1,
    "LEND_FIGURES.resumeSnapshot.groupedCalls": 8,
    "LEND_FIGURES.resumeRefusedSnapshot.carryable": 18,
    "LEND_FIGURES.resumeRefusedSnapshot.carried": 18,
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
- R2 carries the 9 KEPT mutants and re-runs the other 10, one of them from an `error` row.
  `nonCarryableRows` is 1. `groupedCalls` is 8.
- R3 carries 18 mutants and scores M0019 as no-coverage. `carried` is 18.
- The sentinel row's `durationMs` is 987654.

## The legs

The legs run in this order on one store. A is L0's run, H its proven test-app hash, D its
dependency fingerprint. A "clone" is `seedRunFrom` (`packages/runner/itest/lend-seed.ts`): a copy of
A's run row and rows, with only the named field changed.

| leg | seed | session | expected |
|---|---|---|---|
| L0 | none | no flag | frozen; H contains `\|closed-world:public` (refused by name otherwise); one unsuffixed snapshot |
| L1 | none | `--skip-known-survivors` | the 12 survivors known, by key; no lend warning |
| R1 | F: unfinished full clone | `--resume-run F` | `resume-reusing-run` (19), `resume-batch-carried`; all carried; no deploy |
| R2 | SP1 to SP4 (snapshot owners), then K | `--resume` | resolves to K; `resume-baseline-reused` names L1's run B; KEPT carried by key; the sentinel's `priorDurationMs`; no baseline test ran here |
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
  pinned offline in `tests/r618-lend-order.test.ts` (the N1o and RC4a cases), not live.
- **Another `runner_build`.** Only v3 compares builds.
- **`runMayLend` itself.** It has no production caller; each site copies its steps inline. That
  is filed as its own roadmap item.

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

Offline red checks and the live ones still to run are in R618's handoff
(`/coord/handoff/R-618/redcheck-live.md`). Per site:

- RC1a: delete the history site's `backendBuildRefusal` call: N1 goes red (live), and
  `r618-lend-order.test.ts` (offline).
- RC1b: delete the snapshot site's `backendBuildRefusal` call: R3 goes red (live).
- RC4a: delete the history site's R557 mark check: `r618-lend-order.test.ts` goes red (offline).
- RC7: make `assertSameTestApp` return early: RN1 and RN2 still throw, later, from the R496 recheck
  under the lease (`TestAppRepublishedError`), after a run row exists, so the no-new-row check goes
  red. RC7b breaks both checks: only then is a pending or revoked run carried.

## History

- 2026-10-22: built offline (R618). Not yet run on any server.
