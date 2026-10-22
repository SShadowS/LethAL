# R-646c plan r0: a whole-batch replay only when the snapshot on record confirms it

Closes R646's remaining path (measure.md: REACHABLE) and R643's deploy cost. Master c8c6e47d.
Fail closed: when in doubt, take the ordinary path (deploy, baseline or snapshot, step 5b).

## The rule, in one place

Step 1b' (orchestrator.ts, before the deploy) today asks only `batchCarriesEntirely`. After this change
a batch is a **replay candidate** when every mutant is a stranded skip (R53, unchanged) or has a stored
row that would carry, where a stored `no-coverage` row now also counts as a candidate row.
For a candidate:

1. **Resolve the snapshot once.** Compute `hashAlTree(batchDir)` and the test-app read, and run the
   SAME resolution `scoreBatch` runs today: `findBaselineSnapshot` (newest eligible, R389/R492/R495/
   R496/R512/R513 in its SQL), `snapshotApplies`, R619's `runMayLend` on the snapshot's run, R-236c's
   scope drop, and the TestPage replacement. This code moves out of `scoreBatch` into one function,
   `resolveBaselineSnapshot`, unchanged. Its result is handed to `scoreBatch` if the batch takes the
   ordinary path, so a batch never looks up twice and the two paths cannot see two snapshots
   (r1 requirement 1). `scoreBatch` keeps calling it itself for non-candidate batches.
2. **Split the snapshot's coverage.** Run the same `select` logic on the snapshot's baseline, but as a
   pure function that records nothing: green tests, the coverage index, `coverageFilter`, and the
   unsupported-only index (R69). Extract that part of `select` into `planCoverage(baseline, mutants,
   refusals)`, used by `select` too, so it cannot drift.
3. **Confirm, per row.**
   - A carried kill (`killed`, `timeout-killed`): passes, as in 5b (a kill stands).
   - A carried survivor (`survived`, `known-survivor`): passes only if
     `facedEveryCoveringTest(stored covering_tests, covering-in-the-snapshot)`. NULL, `[]`, or covered
     by nothing in the snapshot: fails.
   - A stored `no-coverage`: passes only if the snapshot leaves it uncovered by green tests AND it is
     not an R69 unsupported-only candidate there. Then the ordinary path would record plain
     `no-coverage` too.
   - The snapshot has no green test: fails (the ordinary path records `error` for that).
4. **All pass:** replay whole, NO deploy, NO baseline. Kills and survivors are carried from the
   resumed run's rows exactly as today (stored lists, attribution). Each `no-coverage` row is recorded
   **re-derived, not carried** (`carried` false), with the snapshot split's `unplaceable` flag, as
   the ordinary path records it (R621's "never carried" holds). Its refusal note is the stored row's,
   because 1b' cannot read the backend's post-deploy refusals (see Risks); the batch hash is equal,
   so the refusal is the same one. The
   `coverage-split` event is the snapshot split's (what the ordinary path would emit). The
   `resume-batch-carried` message gains one clause naming the confirming snapshot: "confirmed against
   run N's batch K baseline snapshot". No baseline rows are written for the batch, as today.
5. **Any fails:** emit the new warning `resume-batch-not-confirmed` (below), then the ordinary path
   with the resolved snapshot. 5b then re-runs exactly the failing survivors and re-derives the
   no-coverage rows against the same snapshot.

### No eligible snapshot (deliberate, r1 requirement 2)

`resolveBaselineSnapshot` returns nothing only when `findBaselineSnapshot` finds no eligible row (or
`allowReuse` is false, R318). Then nothing newer than the resumed run's own baseline is on record that
LethAL trusts, so the stored rows are the newest evidence there is. **Decision: replay whole as today**
when every row is a kill or a survivor with a non-empty list. This is no worse than R192's accepted
risk (the environment's data is not re-checked; a test that changed colour with nothing on record is
invisible to every path, the ordinary path included, which would reuse the same rows' snapshot if it
had one). A stored `no-coverage` row with no snapshot cannot be confirmed, so that batch takes the
ordinary path, as R-585 does today.

A snapshot that IS found but refused by a site check (R619 backend build, R557, R-236c scope) is NOT
"no snapshot": that batch takes the ordinary path (fresh baseline), exactly as `scoreBatch` does
today. Reason: a refused newer snapshot is evidence on record the replay cannot weigh.

### Which snapshot

The newest eligible one, from any run, because that is what the ordinary path reuses.
- It is the resumed run's own: the check passes for every current-build row (measure.md's
  invariant) and catches the R-644..R-646b legacy rows.
- It is a LATER run's (the reproduced hole): survivors that never faced a test green there fail, and
  the batch takes the ordinary path, which re-runs exactly them.
- It is OLDER than the resumed run's rows (the run's own was pending, suspect or lost, so the SQL
  skipped it): it is still what the ordinary path would reuse, so it is the right comparison. A
  mismatch falls back to the ordinary path with that same snapshot. Consistent either way.

## Warning

New code **`resume-batch-not-confirmed`** (nothing renamed): "[lethal] --resume: batch K is not
recorded from run P without a deploy: run N's batch J baseline snapshot, the one this batch would
reuse, does not confirm it: S survivor(s) are covered there by a test they were not run against,
C stored no-coverage mutant(s) are covered there (R646, R643). The batch is deployed; the snapshot is
reused." Listed in `docs/using-lethal-from-an-agent.md`. Warnings are free strings: no schema change.
**SessionReport shape: unchanged.** No new field, so no ripple.

## R643

Closed by this build: a fully scored batch whose no-coverage rows the snapshot confirms uncovered (and
whose survivors it confirms) replays with no deploy. What remains is deliberate and fail closed: a
no-coverage row with no eligible snapshot, or one the snapshot covers, still deploys. Mark R643
`done (<commit>)` with that sentence. R646 `done (<commit>)`.

## Tests (test-first; each red-checked by reverting its own piece)

New file `packages/runner/tests/r646c-confirmed-replay.test.ts` (grows from the measurement file):
1. The hole (measure.md test 4): later run C's snapshot has the killer green -> `--resume-run A`
   emits `resume-batch-not-confirmed`, deploys once, re-runs every survivor, all killed. Red today.
2. Witness (measure.md test 3) stays green unchanged.
3. **Consistency (r1 req 1):** one store, two file copies. Copy 1: resume normally (the 1b' check
   decides). Copy 2: the same, but one carried KILL's `covering_tests` set to NULL, which forces the
   ordinary path while that kill still carries in 5b (its verdict is unaffected). Assert per mutant:
   verdict and `carried` equal. Run it for both a confirming store (no C) and the hole store (with C).
4. **R643 case:** a fully scored batch with stored no-coverage rows that A's own snapshot leaves
   uncovered: replays, `deploys === 0`, no-coverage rows `carried` false, `coverage-split` equal to
   the ordinary path's. Red today (it deploys).
5. Unconfirmed no-coverage: the snapshot covers one stored no-coverage mutant -> not confirmed,
   deploys once, that mutant killed.
6. **No snapshot (r1 req 2):** snapshots deleted; survivors with lists, no no-coverage row ->
   replays whole, 0 deploys, survivors carried (today's behaviour, pinned as a decision). With a
   no-coverage row -> deploys (unchanged).
7. A refused snapshot (R619 backend-build seeded) -> ordinary path with a fresh baseline, not a replay.
8. Stranded (R53): a candidate batch holding a stranded row still skips it in both outcomes.
9. R318 (`allowReuse` false): behaves as "no snapshot"; `resume.test.ts`'s R318 test unchanged.
10. Pinned by direct calls: `planCoverage` gives `select` and 1b' the same split (one test per output:
    covered, uncovered, unplaceable, unsupported-only).

Existing tests that must stay green unchanged: `r644-source-baseline-lend.test.ts` (R646 block),
`r621-no-coverage-carry.test.ts` (its "snapshot on record" whole case now replays; its assertions,
no-coverage and not carried, still hold), `resume.test.ts` R192 (snapshot of run 1 confirms; stored
lists kept). If any of these needs an edit, that is a finding to report, not to absorb.

## itest:lend prediction (r1 requirement 3; pre-committed on master before any live run)

Only **R1** moves. R1 = `--resume-run` of the full clone F of A; the newest eligible snapshot is run
B's (L1); today R1 deploys once, reuses B's snapshot, carries 15 and re-derives 4 no-coverage.
R-646b's live pass shows B's coverage keeps all 12 survivors inside their lists and the 4 no-coverage
uncovered, so B's snapshot confirms the batch.
- `artifacts` length: 1 -> **0** (deploy count back to 0).
- codes: `["resume-reusing-run", "resume-baseline-reused"]` -> **`["resume-reusing-run",
  "resume-batch-carried"]`**; the `resume-batch-carried` message names run B's batch 0 (replaces the
  `resume-baseline-reused` "same as run B's batch 0" assertion).
- Unchanged: carried 15 (`carriedInPartBatch(ALL)`), carryable 19, `resumedFrom` {F, 15, 0},
  `groupedCalls` 0, `ranHere` 0, the frozen per-mutant table (3/12/4), identity.
- R2, R3, RP, L0, L1, N0, N1, N5, RN*: unchanged (no candidate batch: each holds an error row or a row
  to run; RN* refuse before the batch loop). No leg gains `resume-batch-not-confirmed`.
Any other movement, or R1 emitting `resume-batch-not-confirmed`, is a BLOCK.
The gate file's R1 block and header comment are edited in the same commit as the code, after the
pre-commitment lands.

Gates on the final head: itest:lend and itest:bcdev (orchestrator change on the resume path; bcdev
must be unchanged since it never resumes).

## Size

- `orchestrator.ts`: about 120 lines moved (snapshot resolution, coverage planning, out of
  `scoreBatch`/`select`, unchanged), about 90 new (candidate test, confirmation, replay of
  no-coverage as re-derived, the warning). `resume.ts`: about 15 (a candidate predicate that admits a
  stored no-coverage row; `carriedVerdictFor` unchanged).
- Tests: about 300 lines, one new file. `lend.itest.ts`: about 15 lines in R1 plus the header.
- Docs: the agent guide's warning list, `docs/gates/lend.md`, the pre-commitment spec, R646/R643.
- Medium: one build, one deep plan review, one build review.

## Risks for the review

- The test-app read moves before the deploy for candidate batches. It reads the published TEST app,
  which our deploy does not touch; check that `assertNoTestAppDrift` gives the same answer there.
- `hashAlTree(batchDir)` at 1b' must equal the hash `scoreBatch` computes after deploy (the deploy
  must not write `.al` into `batchDir`). One test pins it by computing both on a deployed batch.
- Backend coverage refusals (`withBackendRefusals`) are read after the deploy, so 1b' has only the
  session's `coverageRefused`. A refused object's mutant is stored `no-coverage` with a note; without
  the backend's refusal the snapshot split can only call it covered (fails: deploy, safe) or
  uncovered (confirmed: recorded no-coverage, the same verdict; the note comes from the resumed run's
  row, since the batch hash is equal). Neither direction scores a false survive. The review should
  check this argument. (Withdrawn in r2: the review's I2 breaks it.)

## r2 (overrides everything above where they differ)

Answers `review-opus-plan.md`. The shape stays: one snapshot resolution at 1b', a pure coverage
split, per-row confirmation, otherwise the ordinary path with the same snapshot.

### B1: a carried kill needs 5b's precondition
A carried `killed` / `timeout-killed` passes only if the 1b' split COVERS it (some green test in the
snapshot covers it) and does NOT refuse it. Otherwise the batch takes the ordinary path, which
records it as the split says (R69 `error`, or `no-coverage` before 5b). This is exactly what 5b
already demands: 5b only reaches a mutant that step 5 did not record as uncovered.
- Test B1: A has killer X green, so M is killed. Later run C (same batch hash) has X red, and X is
  the only test covering M. `--resume-run A`: `resume-batch-not-confirmed`, one deploy, M recorded as
  the ordinary path records it. Added as a third store to the consistency test (test 3): per mutant,
  the replay decision and the forced ordinary path give the same verdict and `carried`.

### I2: backend refusals: stored WITH the snapshot
Computing them at 1b' is not possible without a compile: bcdev's refusals need the compiled `.app`'s
declared objects (`indexArtifact`: `AppMethodIndex.fromAppFile`, then `buildLineMap` or
`indexHubRefusals`). And "fall back when a stored note differs from the split" does not catch the
review's case (a row stored `killed` has no note, and the 1b' split without the index refusal calls
it covered).
**Choice:** persist the backend's refusal map with each snapshot. New nullable column
`baseline_snapshots.coverage_refusals` (JSON of `withBackendRefusals`' backend part, the map the
deployed index gave for that batch), written by `recordBaselineSnapshot`. At 1b' the split uses the
session's `coverageRefused` merged with the snapshot's stored map. That is the refusal set the
deployed index gives for these exact instrumented bytes (the key is the batch hash, coverage mode
and test app). A snapshot whose column is NULL (recorded before this change) cannot confirm: the
batch takes the ordinary path. Fail closed, and old stores pay today's cost, never less safety.
- When the ordinary path reuses such a snapshot after a deploy, it compares the stored map with the
  live `withBackendRefusals` result and throws by name if they differ (a caller-contract check: the
  key promised equal bytes). One unit test per direction.
- Ripple: the migration (`ALTER TABLE ... ADD COLUMN`), `BaselineSnapshot` gains the field,
  `itest/lend-seed.ts` copies it (its offline test pins clone fidelity), `recordBaselineSnapshot`'s
  callers pass it.
- Test I2: snapshot C stores a refusal of M's object; M stored `killed` in A -> not confirmed, one
  deploy, M `no-coverage` with the refusal note. And: a snapshot with NULL refusals -> ordinary path.
- Known limit for the review: the snapshot key holds no build symbols. A resume refuses a symbols
  change, but a snapshot from a run with other symbols and the same instrumented bytes could carry
  another refusal set. Today's snapshot reuse has the same exposure. Not widened here; flag only.

### I3: no usable snapshot (for the orchestrator to rule)
The review is right: with no eligible snapshot the ordinary path runs a FRESH baseline, and 5b would
catch a test newly green. And no snapshot is common: on a closed-world server (`bc1`-`bc3` are) a
crashed run's own snapshots stay `|pending` and are never reused (R601, store.ts
`confirmClosedWorld`).

Options:
- **(a) Confirm against the resumed run's OWN pending snapshot**, only when the resume was accepted
  under R601 (same test app, same closed answer asked now), matched by run id, batch hash, the pending
  identity and coverage mode, and not suspect or lost.
  - Safe: a run records at most one snapshot per batch, and only from a full baseline it ran itself
    (`scoreBatch`: none when it reused one or replayed). So A's own snapshot for this batch hash IS the
    baseline A scored that batch against. It trusts nothing that carrying A's rows does not already
    trust under R601, and B's own post-execution check confirms or revokes both.
  - What it buys: R643's saving on crashed closed-world resumes (A's no-coverage rows confirm against
    A's own coverage, same batch hash, so R621's staleness cannot apply), and it catches legacy rows.
  - What it does not buy: it passes by construction for current rows, so it detects NOTHING newly
    green. It equals "replay as today" for R646.
- **(b) No usable snapshot -> ordinary path** (deploy plus fresh baseline). Closes R646 fully.
  Cost: R192's own measurement: 40 s deploy + 215 s baseline (407 tests) per fully scored batch per
  resume, twelve resumes in one hosted session. On closed-world servers that is every crashed resume,
  so R192's saving is gone there.
- **(c) Keep the replay; leave R646 open** for that case.

Frequency (measure.md, R643 census): resumes are rare in the stores on record (1 in 82 local runs;
2 of 12 committed campaign reports, both single-batch, so 0 whole-replay candidates). Where resumes
do happen they repeat (R192: 12 in one session), so the cost of (b) lands on exactly the sessions
that already suffer.

**Recommendation: (a), and close R646's no-snapshot residual by ruling** as R192's accepted data
risk: "a test that changed colour since the run that scored the batch, with nothing on record, is not
re-checked". Reason: the ordinary path itself has that blind spot whenever A's snapshot is eligible
(open-world, or confirmed); that the pending case happens to run a fresh baseline is an accident of
R389, not a guarantee anyone relies on. (a) makes the two identity cases behave the same, and every
check that IS on record is applied. If the owner wants the drift checked, choose (b) and accept the
cost; then file R192's open-world reuse as the same gap.
Under (a): with neither an eligible nor an own-pending snapshot (open-world run whose snapshot is
suspect or lost, or `allowReuse` false), replay as today for kills and recorded survivors; a stored
no-coverage still deploys.
- Test I3a: a closed-world crash (pending snapshot, R601-accepted resume) with no-coverage rows ->
  confirmed against A's own snapshot, 0 deploys. Test I3b: the same with A's identity REVOKED ->
  not used (revoked runs do not resume anyway; pinned). Test: the no-snapshot decision (as r0 test 6).

### I4: both test-app reads
`scoreBatch` keeps its post-deploy read and `assertNoTestAppDrift`. When the batch came through the
1b' check, its result must equal the 1b' read, or the session throws by name (the test app changed
under the resume). Test: a backend whose published package changes between the two reads -> refused.

### Minors
- **Stranded row uncovered in the snapshot:** the ordinary path's step 5 records `no-coverage`
  (uncovered rows are recorded before 5b's stranded skip). The replay does the same: a stranded row
  the snapshot split leaves uncovered is recorded `no-coverage` (re-derived); a covered one is the
  stranded skip (R53, unchanged). With no snapshot: the stranded skip, as today. Test both, and
  include a stranded row in the consistency test.
- **Texts rewritten, not appended.**
  - `resume-batch-carried`: "batch K was neither deployed nor baselined: its N mutants were recorded
    from run P (C carried, S skipped as stranded, U re-derived as no-coverage), checked against run
    R's batch J baseline snapshot: each carried survivor was run there against every test that covers
    it, each carried kill is covered there, and each no-coverage is uncovered there. Carried rows keep
    the covering tests they were measured under; the coverage split reported is that snapshot's." With
    no snapshot: "... recorded from run P with no snapshot on record to check them against; the
    covering tests, attribution and coverage split reported are that run's, and a test that changed
    colour since is not detected (R192)."
  - `resume-reusing-run`: its no-coverage sentence becomes "A stored no-coverage is never carried: it
    is re-derived from the coverage this session uses (its own baseline's, a reused baseline's, or the
    snapshot that lets a fully scored batch skip its deploy), so a batch holding one is deployed unless
    that snapshot leaves it uncovered (R621, R643)." The substrings `itest:lend` asserts ("reusing run
    N — X mutant verdict(s) may be carried", the error-row count, R601's clause) are kept verbatim.
- **One lookup:** `resume.ts` gains `storedVerdictFor(index, m)`: today's `carriedVerdictFor` body
  (carry-disabled check, R391's `carryRule`, `carryRecord`) without the R621 drop.
  `carriedVerdictFor` becomes `storedVerdictFor` minus `no-coverage`, unchanged in behaviour. The
  candidate predicate uses `storedVerdictFor`; no parallel lookup.

### itest:lend prediction (r2): unchanged from r0
B1 does not move R1. Today R1 reuses B's snapshot on the ordinary path and carries 15 = the 12
survivors and the 3 kills. 5b reaches a mutant only when step 5 found it covered and unrefused, so
all 3 kills are covered and unrefused in B's split, and they pass the new precondition. B's snapshot
is recorded by L1 on the gate's own (new) head, so its refusal column is filled. Prediction:
- R1: `artifacts` 1 -> 0; codes `["resume-reusing-run", "resume-batch-carried"]`; the
  `resume-batch-carried` message names run B's batch 0. Everything else unchanged (15 carried, 19
  carryable, `resumedFrom`, `groupedCalls` 0, `ranHere` 0, the frozen 3/12/4 table).
- I3's choice does not move any leg: no leg resumes a pending run with a fully scored batch (RP's
  KP holds an error row).
- Every other leg unchanged; the rewritten `resume-reusing-run` keeps every asserted substring.
Any other movement is a BLOCK.

### Size (r2)
Medium-plus: r0's estimate plus about 40 lines for the refusal column (migration, write, read,
equality check), about 25 for (a)'s own-pending lookup (one store query), `lend-seed.ts` 2 lines,
and about 6 more tests (B1, I2 x2, I3a/b, I4, stranded). Roughly 300 product lines and 450 test
lines.

## r3 (orchestrator ruling; SUPERSEDES r0, r1 and r2)

Ruling: no snapshot-confirm path. A batch that carries a survivor takes the ORDINARY path: deploy,
then an eligible snapshot (`findBaselineSnapshot`) or a fresh baseline, then step 5b with R-646b's
`facedEveryCoveringTest`. That closes R646 with logic that already exists and is already gated.
Gone from the plan: `resolveBaselineSnapshot`, `planCoverage`, the refusal-map column, the B1/I2/I3/I4
special cases, `resume-batch-not-confirmed`.

### (1) What would still replay whole, and is it sound?

Under "no `survived` or `known-survivor` row": `batchCarriesEntirely` already refuses an `error` row
(not carryable: `carriedVerdictFor` returns nothing), a `no-coverage` row (R621 drop), a NULL list,
and a `carryBarred` mutant. So only a batch of **carried kills (`killed`, `timeout-killed`) plus R53
stranded skips** would replay.

**It is not consistent with the ordinary path (the review's B1, a gap that exists today).** Run A had
killer X green, so M is stored `killed`. A later run C (same batch hash) recorded a snapshot with X
red, or the deployed index now refuses M's object (R497). The ordinary path's step 5 records M from
the current split before 5b ever sees it: R69's unsupported-only `error`, or a refused `no-coverage`.
5b carries a kill only for a mutant step 5 found covered (`perMutantTests.get(m) !== undefined`). The
replay records `killed`.
- Is the replay's `killed` wrong? Not as a measurement: A confirmed it (unmutated rerun, R577
  reproduction), and a kill measured once is not undone by fewer covering tests. But it is a verdict
  the ordinary path would not give for the same batch on the same store, and for the refusal case
  the deployed index now says M's object cannot be attributed at all. So the two paths disagree,
  which breaks the earlier consistency requirement. It is not R646's false survive; it is the
  opposite direction (a possibly unattributable kill kept).

**Census (`allkill-census.ts`, `allkill.out`):** fully scored batches made only of kills:
- local stores: **1 of 73**;
- committed real-campaign reports: **0 of 11**.
So keeping the replay for all-kill batches saves almost nothing.

**Recommendation: (ii) drop the whole-batch replay entirely.** Every fully scored batch takes the
ordinary path. That closes B1 as well, deletes code instead of adding it, and makes the two paths one
path. Cost per all-kill batch per resume: 40 s (deploy, snapshot reused) or about 255 s (deploy plus
a fresh baseline at R192's measured scale, 407 tests). In the census that is 1 batch locally and 0 in
the real campaigns.
(i), keeping the all-kill replay and recording B1 as a stated limit under R646, is the alternative.
It saves the same ~0 batches and keeps two paths that disagree.

### (2) Cost, into R643 (R643 stays OPEN)

Rewrite R643's "What" to say: since R-646c, `--resume` deploys EVERY fully scored batch (since R-585
already those with a no-coverage row, 81% of real batches; since R-646c also those with a survivor;
under (ii) all of them). Per batch per resume: about 40 s with a reused snapshot. About 255 s with a
fresh baseline, which is the closed-world crash case (a crashed run's snapshots stay pending, R601).
That is R192's own measured figure: 12 resumes in one hosted session. The cheaper variant becomes a
general "snapshot-confirmed whole carry", and its design notes are r0-r2 of this plan plus the deep
review's findings (B1 kills, I2 refusal timing and build symbols, I3 pending snapshots). Status:
open; build only if resumes prove frequent (measured: 1 resume in 82 local runs; 2 of 12 committed
reports, both single-batch). Not claimed closed.

R646: `done (<commit>)`. The text says a survivor is never carried without a baseline this session
uses (fresh or reused), and that R192's data limit stays: a reused snapshot does not re-check the
environment, as before.

### The change (under (ii))

- `orchestrator.ts`: delete step 1b' (the `batchCarriesEntirely` branch) and `replayCarriedBatch`.
  Stranded skips (R53) and carries already happen in 5b. `resume.ts`: delete `batchCarriesEntirely`,
  and R646b's `[]` rule inside it goes with it (5b already handles `[]`).
- Texts that would become false, rewritten (not appended):
  - `resume-reusing-run`: drop "a batch whose every mutant carries is recorded from run N without
    either (R192)" and the "so a batch holding one is deployed" clause. It becomes: "Every batch is
    deployed, and baselined unless a prior run's completed baseline for the same instrumented source
    and test app is on record (then that baseline's verdicts, coverage and durations are reused).
    A stored no-coverage is never carried: it is re-derived from this session's coverage (R621). A
    survivor is carried only when it was run against every test that covers it now (R646)." The
    substrings `itest:lend` asserts are kept verbatim.
  - `report.ts` `CAVEAT_INTERPRETATIONS.resumed`: drop "A batch whose every mutant carried was not
    republished (R192)" and the `resume-batch-carried` mention. This text is in the report: check
    `interpretation.test.ts`, `report.test.ts` and the report-equality snapshot; regenerate a
    snapshot only on purpose, and say so.
  - `report.ts`'s artifacts doc comment (the R192 "no entry here" sentence), `docs/using-lethal-from-
    an-agent.md` (the `resume-batch-carried` paragraphs), `docs/gates/lend.md` if it names the
    replay. The warning code `resume-batch-carried` is no longer emitted; it is not renamed.
- SessionReport shape: unchanged.

### Tests (test-first; a red check per direction)

In `r646c-whole-replay-reach.test.ts`, made permanent:
1. The reach test (later run C's snapshot has the killer green) goes GREEN: one deploy, C's snapshot
   reused, `resume-tests-not-faced`, every survivor killed. Red check: restore step 1b' -> red.
2. The witness stays green.
3. A survivor batch is never replayed: A's own snapshot, all survivors faced -> deploys once, reuses
   the snapshot, carries every survivor, runs no mutant. Red check: restore 1b' -> red (deploys 0).
4. No snapshot: snapshots deleted, A's killer red, now green -> a fresh baseline runs, every survivor
   re-run and killed (`resume-tests-not-faced`). Red check: restore 1b' -> red.
5. All-kill batch (direction of (ii)): deploys once, nothing executed, kills carried. B1 store (C has
   the killer red): the kill is recorded as the ordinary path records it. Red check: restore 1b' ->
   red. (Under (i) this test inverts.)
6. R53: a batch of kills plus one stranded row: deploys, the stranded row is skipped (not run,
   `STRANDED_SKIP_NOTE`). R318: `resume.test.ts`'s R318 test keeps its verdicts; only its replay
   assertion changes.

Existing tests that pin the replay and must be rewritten on purpose (each listed in the commit):
`resume.test.ts`'s R192 block (the "neither deployed nor baselined" cases, `batchCarriesEntirely`'s
unit test, the attestation-gate case, the R318 replay comment), `identity-refusals.test.ts`'s "the
fully scored batch is neither deployed nor baselined", `r644-source-baseline-lend.test.ts`'s three
whole-batch replay tests (R646b's `[]` replay cases become plain 5b cases), `r621-no-coverage-carry
.test.ts` (assertions unchanged; `resume-batch-carried` stays absent). Each rewritten test asserts the
new behaviour (deploys once, snapshot reused, nothing executed), never just deletes the old one.

### itest:lend prediction (exact; pre-committed on master before any live run)

**No leg moves.** No leg replays a batch whole today: R1's batch holds 4 no-coverage rows (ordinary
path since R-585), R2/RP hold an error row, and R3 holds a row to run. Removing the replay therefore
changes no path.
- R1: 1 deploy (`artifacts` length 1); codes `["resume-reusing-run", "resume-baseline-reused"]`; the
  reused snapshot is run B's batch 0; carryable 19; carried 15 = `carriedInPartBatch(ALL)`;
  `resumedFrom` {F, 15, 0}; `groupedCalls` 0; `ranHere` 0; frozen table 3 killed / 12 survived /
  4 no-coverage per mutant.
- R2: codes `["resume-reusing-run", "resume-baseline-reused"]`, B's snapshot, carryable 9, 1 error
  row, carried 7, `groupedCalls` 8, sentinel carried from K.
- RP: as R2 with KP and N5's snapshot, plus R601's clause.
- R3: codes `["resume-reusing-run", "snapshot-backend-build-changed"]`, baseline re-run, carried 15.
- L0 fresh; L1 and N0 lend 12; N1 and N5 lend nothing; RN1d, RN2, RN3, RN4 refused before the lease
  with their texts unchanged.
- No leg emits `resume-batch-carried`, `resume-tests-not-faced` or `resume-survivor-no-record`.
The one text that changes, `resume-reusing-run`, keeps every substring the gate asserts.
Any movement is a BLOCK. Gates on the final head: itest:lend and itest:bcdev.

### Size (r3, under (ii))

Small product diff, net negative: about 150 lines deleted (`replayCarriedBatch`, step 1b',
`batchCarriesEntirely`), about 20 changed (two warning texts, one interpretation text, one doc
comment). Tests: about 200 lines for the 6 tests above, and about 10 existing tests rewritten.
Docs: R646, R643, the agent guide, `docs/gates/lend.md`, the pre-commitment spec.

### r3 amendment (delta review: ADOPT, no blocker; orchestrator: R53 and R192 checks)

1. **Cost, against master, not r2.** The "(1) Cost" sentence above is wrong. Against master, every fully scored
   batch with no no-coverage row and no error row now deploys: up to 3 of 16 real-report batches, up to 42 of 73
   local ones. Only the all-kill count is 1/73 and 0/11. R643's rewrite ("all of them") is the honest one, and it
   gets these counts.
2. **Pinned snapshot, rewritten on purpose:** `resume.test.ts.snap`, the entry "C02-04 characterization R192: the
   resumed run reuses batch 1's baseline snapshot" (it pins `resume-batch-carried`). Regenerate it only with
   `--update-snapshots` on that file, and say so in the commit.
3. **R53 stranded (orchestrator):** step 5b still skips a stranded mutant (`wasStranded`, then `STRANDED_SKIP_NOTE`).
   Existing tests cover it only for batches that still had work left. Test 6 above pins it for a fully scored
   batch on the ordinary path. **A gap that exists today, and that r3 widens:** a stranded mutant that is uncovered
   now gets `no-coverage` at step 5, before 5b, and loses its stranded note. A later resume that covers it again
   would re-run it, and it would hang. **Fix:** skip stranded mutants before step 5. **Test 7:** a stranded mutant
   that is uncovered in this session's coverage keeps `STRANDED_SKIP_NOTE` and is not recorded `no-coverage`.
   Red check: move the skip back after step 5, and the test goes red.
4. **Warning texts (R192, check B):**
   - `resume-reusing-run`: the R192 clause and "so a batch holding one is deployed" are dropped (as above).
   - `CAVEAT_INTERPRETATIONS.resumed`: changes (as above).
   - `resume-batch-carried`: no longer emitted.
   - `resume-baseline-reused`: text unchanged, but it is now emitted once per fully scored batch.
   - `snapshot-*`, `resume-tests-not-faced` and `resume-survivor-no-record` can newly appear for those batches.
   - Every substring the lend gate asserts survives: the "reusing run N — K mutant verdict(s) may be carried"
     opening, the error clause and the R601 clause.
5. **Deploy on resume:** a deploy that fails (the R90 ceiling, a compile bisect, a `DeploymentError`) fails loudly,
   as it does for any batch. A republished test app is still refused for the whole run (`assertSameTestApp`).
   This is accepted.
6. itest:lend: "no leg moves" is confirmed (R1 already asserts 1 artifact).
