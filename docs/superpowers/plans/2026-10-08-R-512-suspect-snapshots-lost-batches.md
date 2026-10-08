# R-512 plan r3: R512 (attestation-path snapshot) and R513 (crash residue), together

[r3] After the r2 re-review (REVISE, two items): the mark is owner-scoped (`markSnapshotSuspect`
returns whether it inserted, and the clear matches `marked_by_run`). Test 19b and red-checks O, O2,
P and P2 are new. The multi-service-tier edge case is named, and so is the fall-through to an older
snapshot in item (a).

[r2] Revised after `/coord/handoff/R-512/review-r1-opus-adversary.md`. Every change from r1 is
marked [r2]. Adopted: C1 and C2 (the SUSPECT MARK replaces r1's gate-time drop), I1 (lazy option:
no `identityMismatch` branch, no test for it), I2, I3, M1, M3, M4, and open questions (a), (b), (c).

Read `/coord/handoff/R-512/repro.md` first. Five repro/control tests exist, uncommitted, in
`packages/runner/tests/resume.test.ts` (describe "R512: ...") and
`packages/runner/tests/orchestrator.test.ts` (two "R513 repro" tests at the end of the R508
describe). Three are RED today. [r2] The R512 repro's shape is rewritten (I2, see Tests).

## Part 1 — R512: [r2] a durable SUSPECT MARK on the snapshot in use

### The distinction (what the session actually knows)

Today the gate knows one bit per batch: `attestation.clean` (did any covered run attest). It fires
when the batch contributed and `clean` is false. That covers two different states:

| State | What the covered runs did | Evidence about the binary |
|---|---|---|
| **Hang at batch start** (R192's main case; all 5 named tests) | The first covered run never answered (in-flight-unknown, stranded, deadline). No answer carried an attestation. | None either way. The binary is exactly as unproven as when ANY snapshot is recorded (a snapshot is always recorded before the mutant phase). |
| **Wrong / unproven binary** (R512) | At least one run ANSWERED with `attestation.observedAny === false`, and none attested clean. | Evidence that the binary may not be the instrumented one. |

[r2] (I1) `identityMismatch` is NOT used as evidence. The transport maps a mismatch to an `error`
outcome with NO attestation, and `RunMutantMany` hard-codes it false, so it never reaches the
orchestrator as an attestation. Say this in R512's closing paragraph. No branch and no test for it.

[r2] (C1, C2) **Why r1's gate-time drop was not enough.** It ran only at the gate and only on
(run, batch)'s own snapshot, so it missed three routes to the same false kill:
- **C1:** a batch that REUSED an earlier run's snapshot records none of its own. A records S_A and
  hangs; B reuses S_A and answers unattested; the gate drops 0 rows; C reuses S_A again.
- **C2:** a throw before the gate (for example a transport-error abort) skips the gate.
- A crash or Ctrl-C before the gate skips it too.

### [r2] The rule

- **Mark** the snapshot IN USE as suspect, durably and synchronously, on the FIRST answer in the
  batch with `observedAny === false`, while the batch has no clean attestation yet.
  - The snapshot in use is the reused one's `(reused.runId, reused.batchIndex)` when this batch
    reused a snapshot, else this run's own `(runId, batchIdx)`.
  - Writing the own key when no snapshot row exists (an incomplete baseline records none) is
    harmless: nothing matches it.
- **Clear** this batch's mark on the FIRST clean attestation in the batch. Once `clean` is true it is
  never reset, as today, and later unattested answers mark nothing.
- `findBaselineSnapshot` skips a snapshot with a mark.
- **The gate needs NO drop.** When the gate fires after an unattested answer, the mark is already
  written and nothing clears it. When the gate fires after a hang with no answer, there is no
  evidence, and the snapshot is kept (R192). `scoreBatch`'s gate is unchanged from master.

**When clearing is safe.** The mark mirrors the gate's own condition ("no clean attestation in this
batch"). A batch with some unattested and some clean answers passes the gate today: its verdicts
are accepted, on the reading that `observedAny: false` there came from coverage over-approximation
(the test called the procedure but never reached the guard), not from a wrong binary. Clearing the
mark applies the same reading to the snapshot.
- For the OWN snapshot the reading is sound. The baseline ran on the same deployed artifact
  moments earlier, and the clean attestation proves that artifact.
- For a REUSED snapshot the clean attestation proves this run's binary, not the binary the lending
  run measured on. The mark was set only on this run's evidence, though. Clearing it restores the
  state before that evidence: "no evidence", the same state as every reused snapshot today (the
  R192 warning already says a test that has gone red since is not detected). The residual risk is
  open question (a).
- Clearing only ever removes a mark THIS run's insert created. [r3] This is enforced in the store,
  not only by the reuse rule: `ledger.suspect` is set only when the insert created the row, and the
  delete also matches `marked_by_run`. The reuse rule alone is not enough. Two concurrent resumes can
  both have reused S_A before either marked it, so one of them could otherwise clear the other's
  mark.
- Edge cases, not handled. Name both in R512's closing text:
  - A container that changes mid-batch from wrong to right would clear the mark. Nothing in LethAL
    detects a mid-run republish today (see the comment in `runSession`).
  - [r3] A multi-service-tier environment, where calls are spread over several service tiers with
    different binaries. One tier answers clean and another unattested in the same batch, so the
    clean answer clears the mark (and passes the gate today), although some answers came from a
    wrong binary.

Cost: a batch whose first unattested answer was coverage over-approximation, followed by a hang
before any clean attestation, keeps its mark. Its resume re-runs one baseline. That is the safe
direction, and rare.

### [r2] Schema: a new `suspect_snapshots` table

```sql
-- R512: a baseline snapshot a run answered unattested against (observedAny false, no clean
-- attestation yet in that batch). findBaselineSnapshot never lends one. Keyed like
-- baseline_snapshots' (run_id, batch_index); the batch that set a mark clears it on its first
-- clean attestation. A whole new TABLE needs no migrate() step.
CREATE TABLE IF NOT EXISTS suspect_snapshots (
  run_id INTEGER NOT NULL,
  batch_index INTEGER NOT NULL,
  marked_by_run INTEGER NOT NULL,
  recorded_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (run_id, batch_index)
);
```
- A table, not a column: a `suspect` column on `baseline_snapshots` would need an ALTER in
  `migrate()`. A table needs nothing and follows the `lost_batches` and `batch_artifacts` precedent.
  If the builder finds a column simpler, say why in the submit note. I found no reason.
- Store methods [r3, owner-scoped]:
  - `markSnapshotSuspect(key, markedByRun): boolean` = `INSERT OR IGNORE`, returning
    `changes() > 0`.
  - `clearSnapshotSuspect(key, markedByRun)` = `DELETE ... WHERE run_id = ? AND batch_index = ?
    AND marked_by_run = ?`.
  - So `marked_by_run` is now READ, by the clear. It is not provenance only, as r2 said.
- `findBaselineSnapshot`: add `AND NOT EXISTS (SELECT 1 FROM suspect_snapshots s WHERE s.run_id =
  baseline_snapshots.run_id AND s.batch_index = baseline_snapshots.batch_index)`.

### [r2] Migration (the second new table)

Same as `lost_batches` below. The store has NO schema version number. `SCHEMA` (`CREATE TABLE IF NOT
EXISTS`) runs on every open, then `migrate()`, which only ALTERs columns of existing tables. An OLD
store opens, gains an empty `suspect_snapshots`, and lends exactly what it lent before. "No row"
means "no evidence recorded", which is the right reading for snapshots recorded before R512. (M3) An
older LethAL binary opening a newer store ignores the table, so it simply gets no protection; no
hazard. `IDENTITY_SCHEME` does NOT move (stays 30).

### [r2] Code

1. In `orchestrator.ts`, a named ledger type replaces the four inline `{ clean: boolean }` types
   (`ScoreBatchInput.executeCovering`, the parallel `executeCovering` closure in `runSession`,
   `confirmWarm`'s args, `runMutantsOnBackend`'s args):
   ```ts
   /** Design §G: one batch's attestation ledger. `clean`: some run attested; never reset.
    *  `suspect` (R512): a run answered `observedAny: false` before any clean attestation; the
    *  snapshot in use is then marked in the store, and the mark is cleared when `clean` turns true. */
   interface AttestationLedger {
     clean: boolean;
     /** [r3] A mark was attempted (at most once per batch). */
     markTried: boolean;
     /** [r3] THIS run's insert created the mark, so only then may it clear it. */
     suspect: boolean;
     /** [r3] Returns true only when the insert created the row (`changes() > 0`). */
     readonly markSuspect: () => boolean;
     readonly clearSuspect: () => void;
   }
   function feedAttestation(ledger: AttestationLedger, a: TestVerdict["attestation"]): void {
     if (a === undefined) return; // no answer is no evidence (a 408, in-flight, transport error)
     if (a.observedAny && a.identityMismatch !== true) {
       if (ledger.clean) return;
       ledger.clean = true;
       if (ledger.suspect) ledger.clearSuspect();
     } else if (!ledger.clean && !ledger.markTried) {
       ledger.markTried = true;
       ledger.suspect = ledger.markSuspect(); // [r3] false when another run's mark is already there
     }
   }
   ```
   The builder may simplify the shape; the behaviour is the contract: mark once, only before
   `clean`; clear once when `clean` turns true, and only a mark this run's own insert created.
   [r3] The hole this closes: two concurrent resumes B and D both reuse S_A. B marks it. D's insert
   is ignored, but under r2 D still set `suspect`, and D's clean attestation then deleted B's mark.
2. Replace the four feed sites with `feedAttestation(args.attestation, <verdict>.attestation)`. They
   are the covering run in `runMutantsOnBackend`, the kill-confirmation rerun, and the two sites in
   `confirmWarm` (`verdict` and `rv`). Keep each site's comment. Every site comes BEFORE the mutant's
   `record()`, so the mark is in the store before any verdict that answer produces.
3. `scoreBatch` builds the ledger once the snapshot decision is made:
   `{ clean: false, markTried: false, suspect: false, markSuspect: () =>
   store.markSnapshotSuspect(key, runId), clearSuspect: () => store.clearSnapshotSuspect(key, runId) }`
   [r3], where `key` is `reused` → `(reused.runId,
   reused.batchIndex)`, else `(runId, batchIdx)`. With no `input.snapshot` (C02-04's no-snapshot
   path), both closures are no-ops.
4. The probe path of `runNamedMutants` (`const attestation = { clean: false }`) gets the same shape
   with no-op closures: it records no snapshot.
5. A failing mark write: let the store error propagate (no catch, no new error class). It runs in
   the mutant loop, and the session fails as it does for a failed `record()`. Name this in the
   doc comment: a store that refuses the mark also refuses the verdict it would have guarded.
6. The gate in `scoreBatch` is UNCHANGED. [r2] r1's `dropBaselineSnapshot` at the gate is deleted
   from the plan.
7. Doc comments:
   - `findBaselineSnapshot`: add an R512 line (a suspect snapshot is never lent, and why).
   - `dropBaselineSnapshot`: unchanged, still lease path only.
   - `invalidateBatch`: say that a snapshot is refused through `suspect_snapshots`, not here.

### What R512 does NOT close: open question (a), filed by the builder

Any reused snapshot whose test has gone red or slow since can still give a false `timeout-killed`.
A position-1 `timeout` is scored with no unmutated confirm, and its budget comes from the
snapshot's duration. That includes the hang-at-start case this plan keeps on purpose.

## Part 2 — R513: a `lost_batches` negative record, read by every resume reader

### Schema

In `store.ts` `SCHEMA`, beside `baseline_snapshots`:
```sql
-- R513: a batch whose lease was lost. Written at the loss (`onLost`), before anything else, so a
-- verdict recorded after the loss note and never corrected (a crash skips the session's finally) is
-- still refused by every resume reader. A whole new TABLE needs no migrate() step.
CREATE TABLE IF NOT EXISTS lost_batches (
  run_id INTEGER NOT NULL REFERENCES runs(id),
  batch_index INTEGER NOT NULL,
  note TEXT NOT NULL,
  recorded_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (run_id, batch_index)
);
```

### Migration

- The store has NO schema version number. Every open runs `SCHEMA` (`CREATE TABLE IF NOT EXISTS`)
  and then `migrate()`, which only ALTERs columns of existing tables. A whole new table needs no
  `migrate()` step; `batch_artifacts` and `publish_outcomes` set that precedent.
- An OLD store opens, gains an empty `lost_batches`, and reads exactly as before. "No row" means
  "no lost batch recorded", which is the right reading. From R508 on, a lease-lost batch already has
  its rows rewritten to `error` (by `onLost` and the `finally`). One from before R508 was not
  corrected by anything, so this change neither helps nor hurts it (R508 made the same choice).
- [r2] (M3) An older binary opening a newer store ignores the table: no protection, no hazard.
- `IDENTITY_SCHEME` does NOT move (stays 30). No mutant identity, key or emitted AL changes.
- No `SessionReport` field, no event, no schema JSON change (for either new table).

### Writer

- New `ResultsStore.markBatchLost(runId, batchIndex, note): void` =
  `INSERT OR IGNORE INTO lost_batches (run_id, batch_index, note) VALUES (?, ?, ?)`. The first note
  wins, like `noteLeaseLost`'s first loss.
- `onLost` (in the helper that builds `LeaseSession`) calls it FIRST, then the existing
  `invalidateBatch` and `dropBaselineSnapshot`, all inside the existing try/catch. First, because each
  of the three writes is safe alone and the insert is the one that protects later rows.
- `invalidateLostBatch` (the `finally`) calls it first too, inside its try: a second chance if
  `onLost`'s insert failed. A failure still throws `LostBatchNotStoredError` (unchanged).
- No transaction: each statement autocommits and each moves only in the safe direction.

### Readers: apply `invalidateBatch`'s rewrite AT READ TIME, do not drop rows

[r2] (M1) One constant for the verdicts `invalidateBatch` leaves alone, used by both
`invalidateBatch`'s UPDATE and the read-time expression:
```ts
/** Verdicts `invalidateBatch` leaves as they are (and so does the R513 read-time rewrite). */
const INVALIDATION_KEEPS_SQL = "('error', 'known-survivor')";
/** R513: a row of a lost batch reads as `invalidateBatch` would have rewritten it. `m` is the
 *  mutants alias. */
const EFFECTIVE_VERDICT_SQL = `CASE WHEN m.verdict NOT IN ${INVALIDATION_KEEPS_SQL} AND EXISTS (SELECT 1 FROM lost_batches l WHERE l.run_id = m.run_id AND l.batch_index = m.batch_index) THEN 'error' ELSE m.verdict END`;
```
1. `mutantVerdicts` (alias `mutants m`): select `EFFECTIVE_VERDICT_SQL AS verdict`, plus the lost
   note (`(SELECT note FROM lost_batches l WHERE ...) AS lost_note`). When the effective verdict
   differs from the stored one, return the row as `invalidateBatch` would leave it: `failureNote` =
   the lost note, and no `killingTest`, `killingTestFailure` or `killPosition`. Everything else as
   stored.
   - **Why read-as-error and not exclude.** `buildResumeIndex` and its `strandedKeys` stay
     UNCHANGED, for two reasons.
     - A stranded row in a lost batch is already `error` with its `quarantined: ` note.
       `invalidateBatch` leaves it, and so does this, so R53 still skips that mutant instead of
       re-running a hang. Excluding the row would drop it from `strandedKeys`.
     - A colliding identity key with one row in the lost batch stays ambiguous, so it is not
       carried. Excluding that row would make the other row unique, and it would be carried.
2. `findResumableRun`, `unfinishedRunUnderOtherScheme`, `unfinishedRunUnderOtherSymbols` and
   `unfinishedRunUnderOtherCoverageMode` change the same way. In each EXISTS, use `FROM mutants m
   WHERE m.run_id = runs.id AND (${EFFECTIVE_VERDICT_SQL}) IN (${placeholders})`.
   - A run whose only carryable rows are in a lost batch is then not "resumable": by R52's rule it
     has nothing to carry.
   - `--resume last` then moves to an older run with the same configuration. That is R508's
     CHANGELOG note, now also true after a crash.
3. `findBaselineSnapshot`: add `AND NOT EXISTS (SELECT 1 FROM lost_batches l WHERE l.run_id =
   baseline_snapshots.run_id AND l.batch_index = baseline_snapshots.batch_index)`. Belt and braces:
   `onLost` already drops the snapshot, but a failed drop after a successful insert must not lend it.
4. NOT changed:
   - `priorSurvivorKeys`. It reads FINISHED runs only. A lease loss latches the session, so a run
     with a lost batch is never finished, and after this fix no lost row is carried into a later
     finished run.
   - `strandedKeys` (see 1).
   - `batchMutantRows` and `verify`. They read the run being verified, and R508's M5 ruling stands.
   - [r2] (M4) Say in R513's closing paragraph that `verify` can still list a lost batch's
     `survived` row as a gap target. That is acceptable because verify re-measures every target.

### Shared mechanism with R512? Considered, not adopted

[r2] R512 now has its own table, `suspect_snapshots`. Its key is a snapshot (possibly another run's),
not a batch of the current run, and it can be CLEARED, while a lost batch never is. One table would
need a "kind" column and two rules. Keep two small tables, each with one meaning.

## Tests

### Flip the repros (remove their `console.log` lines)

1. [r2] (I2) **Rewrite the R512 repro's run 2** in resume.test.ts. Real timeouts never carry an
   attestation. Replace `redEverywhere("timeout")` with a real-shape backend:
   - Every baseline run (no mutant active) answers `timeout`, with no attestation.
   - In batch 1, the FIRST covered run answers `timeout` with no attestation.
   - Every later covered run answers `pass`, attested clean (`observedAny: true`).

   Today that shape gives `M0001 timeout-killed` (killing test `OverBudgetDetected`). Keep the reuse
   assertions, and assert that M0001 is not `timeout-killed` after the fix. Run 1 stays
   `wrongBinaryInBatch1` (`observedAny: false` is the real shape of a wrong binary on the coverage
   "none" path). Re-measure the RED output before any source change and update `repro.md`. Rename
   the test "...is not reused, so a test red on the real binary scores no kill".
2. `R513 repro: a timeout-killed recorded after the loss note ...` and `R513 repro: a survived ...`
   (orchestrator.test.ts) go green as written. Rename them "...is not carried ...". Their
   precondition stays: the run-1 row still holds `timeout-killed` / `survived`. The fix is in the
   readers, and that precondition is what proves the test reaches the residue.
   - **Strengthen the crash stand-in for these two.** At `close()`, break `markBatchLost` and
     `dropBaselineSnapshot` as well as `invalidateBatch`: extend `breakableInvalidate`, or add a
     sibling `breakableStore`, to wrap all three. Otherwise the `finally`'s `markBatchLost` lands,
     and the tests cannot tell `onLost`'s insert from the `finally`'s.

### [r2] New R512 tests (resume.test.ts R512 describe unless noted)

3. **C1 sequence: a lent snapshot is marked by the run that reused it.**
   - Run A: `CountingBackend("pass", undefined, 2)` records S_A for batch 1 and hangs (no answer, no
     mark).
   - Run B: `--resume`. It reuses S_A (assert the `resume-baseline-reused` warning names A's batch
     1), and its batch-1 covered runs answer `observedAny: false`, so the gate fires.
   - Assert that `suspect_snapshots` holds `(A, 1)`.
   - Run C: `--resume`, using the real-shape backend from test 1. Assert there is no reuse warning
     naming A's batch 1, its baseline re-runs (`baselineRuns > 0`), and no batch-1 mutant is
     `timeout-killed` or `killed`.
   - RED today, and RED under r1's gate-time drop: that is C1.
4. **C2: a throw before the gate.** Run 1, batch 1: M0001's covered run answers `observedAny:
   false`, then M0002's run throws a transport error, so the session rejects before the gate. Reuse
   the R508 describe's `transport-error` answer in orchestrator.test.ts, where the session throws
   "backend transport error".
   - Assert no `batch-invalidated` event for batch 1 (the gate never ran) and a `suspect_snapshots`
     row for `(run1, 1)`.
   - The resume does not reuse run 1's batch-1 snapshot.
5. **Crash stand-in (the mark is durable before teardown).** Same shape as test 4, with a
   `before`-style hook on the run AFTER the unattested answer: it reads the store at that moment and
   records whether `(run1, 1)` is marked. Assert it was. That shows the mark landed before any
   `finally`, gate or teardown, as R508's test 9 showed for `onLost`.
6. **[r2] (I3) Warm replay is the first answer.** On the grouped path, batch 1's first covered call
   answers a 408 `timeout` at position k > 1 with no attestation. Its warm replay (`confirmWarm`)
   answers `observedAny: false`. Assert the snapshot in use is marked.
   - Use the R206 warm-kill fakes in orchestrator.test.ts (search `confirmWarm` / "warm").
   - The builder checks which `confirmWarm` site (`verdict` or `rv`) that replay feeds, and adds a
     second variant that reaches the other site.
7. **[r2] (I3) Kill confirmation is the first answer.** The covering run answers `fail` with no
   attestation, and the unmutated confirm rerun answers `observedAny: false`. Assert the mark.
8. **Clear direction (keep, and clearing is safe).** In batch 1, the first covered run answers
   `observedAny: false` and a later one attests clean.
   - Assert no `suspect_snapshots` row after the session.
   - Assert a later resume whose batch 1 has work left still reuses the snapshot.
9. **No re-mark after clean.** In batch 1, the first covered run attests clean and a later one
   answers `observedAny: false`. Assert no row.
10. **Clean batch keeps its snapshot.** All attested clean: no row, and it is reused.

### Controls for the kept direction

11. The 5 named R192 tests stay green UNCHANGED: a hang at batch start still reuses. Do not edit them.
12. Keep-at-the-store control: `CountingBackend("pass", undefined, 2)`. Assert the
    `batch-invalidated` "unattested artifact" event for batch 1, `baseline_snapshots` of run 1 holds
    batches `[0, 1]`, and `suspect_snapshots` is empty.
13. Keep `R512 control: without the snapshot ...` and `R512 measure: a test that FAILS ...` as they
    are. Both are green before and after the fix.
14. The R513 repros keep their batch-0 control: every batch-0 row is carried, with run 1's verdict.
15. A crash with NO lease loss stays resumable. Reuse the R508 control "control: a resume whose batch
    0 has work left reuses run 1's batch 0 snapshot". Add assertions that `lost_batches` and
    `suspect_snapshots` are empty and that run 1 is picked.
- [r2] (I1) r1's `identityMismatch` test is DELETED.

### Store-level tests (resume.test.ts)

16. R513: `mutantVerdicts` reads batch 1's `killed`, `survived` and `timeout-killed` rows as `error`,
    with the lost note and no killing fields. Batch 0 is unchanged. A batch-1 `known-survivor` stays.
    A batch-1 stranded `error` keeps its `quarantined: ` note, and `buildResumeIndex(...).strandedKeys`
    holds it.
17. R513: a run whose only carryable rows are in a lost batch. `findResumableRun` returns the OLDER
    unfinished run with the same fingerprint (seed both). One case each for the three siblings:
    other scheme, other symbols and other coverage mode each return null for the lost-only run.
18. `findBaselineSnapshot` skips a lost batch's snapshot and, [r2], a suspect one (one case each),
    and still finds the same run's batch-0 snapshot.
19. `markBatchLost` twice keeps the first note. `markSnapshotSuspect` twice is a no-op, and
    `clearSnapshotSuspect` removes exactly one key.
19b. [r3] **Owner-scoped mark.**
    - Run X calls `markSnapshotSuspect(S_A, X)`, which returns true.
    - Run Y calls `markSnapshotSuspect(S_A, Y)`, which returns false and leaves the row's
      `marked_by_run` as X.
    - Run Y then calls `clearSnapshotSuspect(S_A, Y)`.
    - Assert the row is still there and `findBaselineSnapshot` still skips S_A.
    - Then `clearSnapshotSuspect(S_A, X)` removes it.
    - Also, through `feedAttestation` with a fake ledger whose `markSuspect` returns false: a later
      clean answer does not call `clearSuspect`.
20. Old store (a smoke test only, per M3): open a file store, `DROP TABLE lost_batches` and
    `DROP TABLE suspect_snapshots`, close, reopen. Both tables exist again, and earlier rows read
    unchanged.
21. R513 end to end: a store whose `dropBaselineSnapshot` always throws. After the loss, the resume
    finds no reusable snapshot for run 1's batch 1.

### Red-checks, one per direction (revert with the Edit tool only, report red then restored green)

| Id | Revert | Must go RED | Must stay GREEN |
|---|---|---|---|
| A [r2] | `markSuspect` is a no-op | 1, 3, 4, 5 | 11, 12 |
| B [r2] | Mark on every batch at the gate, or on a no-attestation answer | 11 (the 5 R192 tests), 12 | 1 |
| C [r2] | Mark the OWN key even when a snapshot was reused | 3 | 1 |
| D [r2] | Covering-run site keeps the old clean-only check | 1, 3, 4 | 6, 7 |
| D2 [r2] | Kill-confirm site keeps the old check | 7 | others |
| D3/D4 [r2] | Each `confirmWarm` site keeps the old check | 6 (its variant) | others |
| E [r2] | `clearSuspect` is a no-op | 8 | 1 |
| F [r2] | Mark even after `clean` | 9 | 8 |
| G [r2] | `findBaselineSnapshot` without the suspect NOT EXISTS | 1, 3, 18 (suspect case) | 12 |
| O [r3] | `clearSnapshotSuspect` without the `marked_by_run` condition | 19b (row gone after Y's clear) | 8 |
| O2 [r3] | `ledger.suspect = true` whatever `markSuspect` returns | 19b (the `feedAttestation` half) | 8 |
| P [r3] | Defer the mark to the gate: write it beside `invalidateBatch` when `suspect`, not at the answer | 4 (the throw skips the gate), 5 | 1, 3 |
| P2 [r3] | Defer the mark to teardown (the session's `finally`) | 5 (the mark is absent when the next run starts) | 1, 3, 4 |
| H | `mutantVerdicts` ignores `lost_batches` | 2 (both), 16 | 14 |
| I | `onLost` skips `markBatchLost` (with the strengthened stand-in) | 2 (both) | 14 |
| J | Readers EXCLUDE lost rows instead of reading them as error | 16 (the stranded half) | 2 |
| K | `findResumableRun`'s EXISTS uses the stored verdict | 17 (findResumableRun case) | 16 |
| K2–K4 | Same, one sibling at a time | 17 (that sibling's case) | others |
| L | `findBaselineSnapshot` without the lost NOT EXISTS | 18 (lost case), 21 | — |
| M | Join `lost_batches` on `run_id` only (over-exclusion) | 14, 18 (batch-0 half) | — |
| N | `INSERT OR REPLACE` in `markBatchLost` | 19 | — |

If one does not go red, stop and report it; do not weaken the revert. No wall-clock asserts anywhere:
use `FakeTimers`, call counters and store reads, as R508's tests do.

## itest:hang

No effect expected. The gate runs no `--resume` and loses no lease. It reads neither
`baseline_snapshots`, `lost_batches` nor `suspect_snapshots`.
- [r2] The ON and SINGLE legs: a covered run on the healthy container can answer `observedAny:
  false` (over-approximated coverage) before the first clean attestation. That writes and then clears
  a mark in the gate's scratch store. No asserted figure depends on it.
- The OFF leg quarantines by `deadline-exceeded`. It may leave a mark if its only answers before the
  hang were unattested. Nothing reads it.

Pre-commitment: `/coord/handoff/R-512/hang-precommitment.md` (r2). Commit it as
`docs/superpowers/specs/2026-10-08-r512-r513-precommitment.md` BEFORE any live run.

## Builder rules

- Edit/Write tools for every file, including red-check reverts. Never `sed -i`, heredocs, `cat >>`,
  shell redirects into files, `bun -e` or `python -c` edits.
- Never read `lethal.config*.json`. No live BC except the gate run by its owner step.
- Typed errors extend `Error` directly (no new error class is planned). No `!`. Use the
  `exactOptionalPropertyTypes` spreads.
- Verify loop, from the repo root:
  1. `bun run typecheck`
  2. `rm -rf packages/*/dist`
  3. `bunx biome check <touched files>`
  4. `bun scripts/verify.ts`
- Snapshots: none should change. If one does, stop and report. Any intended update is whole-file
  (`bun test --update-snapshots <file>`), never with `-t`: that wipes the file's other snapshots, as
  R-508 found.
- Roadmap:
  1. `bun scripts/roadmap-set.ts R512 --status "fixed in <commit>, live gate pending"`, and the same
     for R513.
  2. Append a short "Fixed by R-512" paragraph to each item (names, not file:line).
     - R512's says that `identityMismatch` is not used as evidence, and why (I1).
     - [r3] R512's also names the two edge cases it does not handle: a container that changes
       mid-batch, and a multi-service-tier environment with mixed answers.
     - R513's carries M4's verify note.
  3. [r2] (a) **File a new correctness-risk item, with priority.** Check the next free id first
     (`bun scripts/roadmap-next-id.ts`, right before writing).
     - Title: "A reused baseline lets a position-1 timeout score a kill with no unmutated confirm".
     - [r3] Also: once S_A is marked, `findBaselineSnapshot` may fall through to the NEXT-newest
       snapshot with the same two hashes, possibly recorded in the same stale period with no
       evidence against it. The mark refuses one snapshot, not a period.
     - Evidence: the R512 repro (the reused-snapshot route) and the budget rule `max(2 x baseline
       duration, minMutantBudgetMs)`. The most likely live shape is a fast duration reused on a
       slower day.
     - Fix: when the batch's baseline was reused, confirm a position-1 timeout unmutated at the same
       budget before scoring it.
  4. Run `bun scripts/roadmap-index.ts`, then `bun test scripts/roadmap-index.test.ts
     scripts/line-citations.test.ts`, then the final `bun scripts/verify.ts`.
  5. Mark `done (<commit>)` only after `itest:hang` passes.
- CHANGELOG `## [Unreleased]` → `### Fixed`:
  "[r2] A baseline saved for `--resume` is no longer reused once a run measured against it answered
  without attesting the deployed binary (a stale or wrong container). The mark is written at that
  answer, so it also holds when the session throws or is killed before the batch ends, and when the
  baseline was itself reused from an earlier run. Before, such a baseline could make a test that
  hangs on the real binary score a timeout kill (R512). A batch whose lease was lost is now recorded
  in the results store at the moment of loss, and `--resume` reads every verdict of that batch as an
  error, so a verdict recorded after the loss and before a crash or kill is no longer carried (R513)."
- Do not commit until verify is green. Chain the push with `&&` after the checks; WIP pushes carry
  `[skip ci]`; both CI jobs green before submit.

## Open questions (r2: all resolved or filed)

1. [r2] (a) Filed by the builder with priority, as above. Not fixed here.
2. [r2] (b) **Closed by the suspect mark for its false-kill half.** A crash or throw before the
   gate no longer leaves a lendable snapshot: the mark is written at the first unattested answer.
   One residue stays, and it is not a false kill. The batch's recorded `survived` rows from
   unattested answers are still carried by `--resume` after such a crash, because the gate never
   rewrote them. That hides kills. Say it in R512's closing paragraph. File a separate item only if
   the owner wants it.
3. [r2] (c) Yes: `observedAny: false` is the evidence. It is the only shape that reaches the
   orchestrator (I1).
