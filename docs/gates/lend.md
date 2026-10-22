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
    "LEND_FIGURES.resumeWhole.carried": 15,
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
- R1's one batch holds 4 stored no-coverage rows, so since R621 it is not carried whole. It deploys once,
  reuses L1's run B snapshot (no baseline test runs here), re-derives the 4 as fresh no-coverage and carries
  the other 15 by key. `carryable` is 19, `carried` 15, `groupedCalls` 0.
- R2 has 9 KEPT rows. It carries 7 of them, every one this session covers; its two KEPT rows that this session
  leaves uncovered come back as fresh no-coverage (see "A stored no-coverage is always re-derived" below). It re-runs the other 10, one of them from an `error` row. `carried` is 7, `nonCarryableRows` 1,
  `groupedCalls` 8.
- R3's K2 has 18 rows (not asserted). It carries 15 of them, every one this session covers, re-derives the three uncovered
  ones, and scores M0019 as no-coverage. `carried` is 15.
- The sentinel row (M0004 in K) has `durationMs` 987654.

### A stored no-coverage is always re-derived

- **The rule (R621):** `carriedVerdictFor` never returns a stored no-coverage. `scoreBatch` records every mutant left
  uncovered by the coverage this session uses (its own baseline's, or a reused snapshot's) as fresh no-coverage; a
  mutant covered now is run. So carried = carryable rows minus the stored no-coverage rows, in every batch.
- **A side effect (review M2):** a batch that used to be carried whole now takes the partial path, so a stored kill or
  survive whose mutant is uncovered under the coverage now used becomes a fresh no-coverage instead of being carried.
  That is the safe direction (nothing is lent against coverage that disagrees); on this fixture no such mutant exists.
- **A batch holding a stored no-coverage is never carried whole** (`replayCarriedBatch` never sees one). It deploys,
  and its baseline is reused from a matching snapshot when one exists. That is R1. R643 files a cheaper variant.
- **On this fixture** "frozen no-coverage" and "uncovered now" are the same mutants (`assertFrozen` pins every
  verdict), so the gate's `carriedInPartBatch` filters on the frozen verdict.
- **Not reached live:** a stored no-coverage for a mutant covered NOW (the fixture has none). The unit tests in
  `tests/r621-no-coverage-carry.test.ts` cover it.
- **How it was found:** live run 1 on bc1 was BLOCKED at R2 (7 carried against 9 pre-committed;
  `/coord/handoff/R-618/live-run-1.md`); R621 was filed and closed by R-585.

## The legs

The legs run in this order on one store. A is L0's run, H its proven test-app hash, D its
dependency fingerprint. A "clone" is `seedRunFrom` (`packages/runner/itest/lend-seed.ts`): a copy of
A's run row and rows, with only the named field changed.

| leg | seed | session | expected |
|---|---|---|---|
| L0 | none | no flag | frozen; H contains `\|closed-world:public` (refused by name otherwise); one unsuffixed snapshot |
| L1 | none | `--skip-known-survivors` | the 12 survivors known, by key; no lend warning |
| R1 | F: unfinished full clone | `--resume-run F` | `resume-reusing-run` (19), `resume-baseline-reused` naming B; one deploy; no baseline test ran here; all but the 4 no-coverage carried by key (R621) |
| R2 | SP1 to SP4 (snapshot owners), then K | `--resume` | resolves to K; `resume-baseline-reused` names L1's run B; KEPT minus its two uncovered rows carried by key; the sentinel's `priorDurationMs`; no baseline test ran here |
| R3 | SV3 (a v3 snapshot owner), K2 | `--resume-run K2` | `snapshot-backend-build-changed`, exact; the baseline re-ran (as many tests as L0's) |
| N0 | finished clone | `--skip-known-survivors` | as L1: the clone lends |
| N1 | finished v3 clone | `--skip-known-survivors` | `history-backend-build-changed`, exact; nothing lent |
| N5 | finished clone, revoked | `--skip-known-survivors` | `history-test-app-changed` naming `H\|closed-world:revoked`; nothing lent |
| RN3 | KV: unfinished v3 clone | `--resume-run KV` | refused: another backend |
| RN1d | KPd: unfinished pending clone with the OTHER closed tag (`public` and `public+internal` swapped) | `--resume` | it picked KPd; refused at the test app before the lease, in R601's words ("... and this session's differ"), tail `(R247, R495, R601)` |
| RN2 | KR: unfinished clone, revoked | `--resume-run KR` | refused at the test app (`H\|closed-world:revoked`) |
| RN4 | none | `--resume-run A` | refused: A already finished (R618 ruling 2) |
| RP | KP: unfinished pending clone of K's shape (`H\|pending`, A's server), the newest unfinished run | `--resume` | it picked KP (R601): `resume-reusing-run` names KP, 9 carryable, 1 error row, and R601's clause; `resume-baseline-reused` names N5's run; no baseline test ran here; KEPT minus its two uncovered rows carried by key; the sentinel carried from KP; R2's figures; frozen; its own run row ends exactly H (its live re-ask confirmed it); KP still `H\|pending` |

The RN legs throw before the session creates a run row and before it takes the lease. Every leg
also checks that its own run row records H and D, so that a republish between legs cannot make a
negative leg pass for the wrong reason, and that it emitted exactly its expected lend warnings
(codes starting `history-`, `resume-`, `snapshot-`, and `carry-refused-renumbered`).

K is written with its `mutant_code` and `line` values rotated among its rows, keys intact, so a
carry that matched by code would go red (I2). Its M0003 row is an `error`, so `nonCarryableRows`
runs live (Q3).

## What this gate cannot reach

- **The resume sites' step 1 (`backendBuildRefusal`).** In a bcdev session `--resume` only finds
  runs of the same backend (its SQL), and `--resume-run` checks backend equality first. So
  breaking step 1 inside `ResultsStore.runMayLend` for either resume site reddens no leg here.
  `tests/r619-one-lend.test.ts` covers it through `--resume-run` (`--resume` cannot reach it: its
  SQL selects the backend and, on v3, the build).
- **The snapshot site's R557 check** (steps 2 and 3 of `runMayLend` on the snapshot's run). A
  bcdev session cannot hold an al-runner snapshot of the same coverage mode. The al-runner legs
  and `tests/r619-one-lend.test.ts` cover it.
- **The history site's R557 check and its order against coverage mode and test app.** These are
  pinned offline in `tests/r618-lend-order.test.ts` (the N1o unit test and the RC4a case), not live.
- **Another `runner_build`.** Only v3 compares builds.
- **Which site calls `runMayLend`.** Since [R619](../roadmap/R619.md) all four lend sites call
  `ResultsStore.runMayLend` once each, with no inline copy left. That each one calls it, and that
  the step it returns is the site's refusal, is pinned offline by `tests/r619-one-lend.test.ts`
  (one call log per site), not live.

## Clone fidelity

A seed is not a full copy of a real run (review M2). It copies every field a lend check reads
(`getRun`'s fields, `resource_key` included since R601) and the mutant rows through `recordMutant`,
but not `app_id`, `test_digests`, `batch_artifacts`, `installed_bundles` or `test_results`. An interrupted clone is
therefore not exactly what a real interruption leaves: a real one would also hold its own
snapshot and test results. `lend-seed.test.ts` (offline, in CI) pins that a clone with no
override reads back as its source in `getRun`, `mutantVerdicts`, `priorSurvivorKeys` and
`findResumableRun`, and that each override changes only its own field. N0 is the same check live.

A crashed closed-world run keeps `|pending`. Since [R601](../roadmap/R601.md) it is resumable on
the same server by a session whose guard gives the same closed answer now; that session's own
re-ask after execution confirms or revokes its run, and the pending run is never confirmed by it.
Any `lethal run` session whose re-ask flips, fresh or resumed, also revokes every run of the
project still pending under its package (either closed tag) on its server, and names them in its
`closed-world-changed` warning; a `lethal verify` flip revokes nothing (R601's stated limits). RP
pins the accepted case live and RN1d a pending run
whose closed answer differs. No live leg flips (the fixture's answer is stable), so the revoke on a
flip, and the other refusals (the guard open now, another server), are pinned offline in
`tests/resume.test.ts`. A quarantined run is confirmed and stays resumable (an offline orchestrator
test, Q1).

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
- RC7: make `assertSameTestApp` return early: RN1d still throws, later, from the R496 recheck
  under the lease (`TestAppRepublishedError`, after a run row exists), so the refusal-head check
  goes red. RC7b breaks both checks: only then is KPd carried, and RN1d goes red as not refused.
- R601 (pre-committed in the R601 lend addendum): LRC1 (planted: the pending rule ignores the
  closed flags) turns RN1d red; LRC2 (planted: the post-execution re-ask skipped for a session that
  resumed a pending run), LRC3 (revert: the rule back to equality, refused before the lease) and
  LRC4 (revert: the R496 recheck back to equality alone, `TestAppRepublishedError`) turn RP red.
- **No red check:** RN2 (the gate stops at RN1d under RC7 and RC7b, so RN2's own route is never
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
- 2026-10-22, R601 (built offline, not yet run live): RN1 (a pending clone, refused) becomes RN1d (a
  pending clone with the other closed tag, refused at the test app) and RP (a pending clone of K's
  shape, resumed, its own run confirmed live). No figure changes: RP reuses R2's. The live run waits
  for the R601 lend pre-commitment (orchestrator ruling Q5). Review fix round: RP also asserts that
  no baseline test ran here (M-E), and a flip by any session revokes the project's pending runs on
  its server (I-A ruling; offline only, since no leg flips).
- 2026-10-22, R-585: R1 changes per the pre-commitment 28e7ac7d (R621: a stored no-coverage is re-derived, never
  carried). **PASS on bc2** at 522c6335 (`/coord/handoff/R-585/lend-bc2.log`), every leg as pre-committed:
  - R1 carried 15 of 19, one deploy, B's snapshot reused, groupedCalls 0;
  - R2 and RP carried 7, R3 carried 15;
  - L1 and N0 lent 12 known survivors (the R585 test scope is recorded and equal);
  - N1 and N5 lent nothing;
  - every leg 3 / 12 / 4 per mutant.

  `itest:bcdev` PASS 3 / 12 / 4 on the same head (`bcdev-bc2.log`).
