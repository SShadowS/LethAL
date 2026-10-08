# R-508 plan r2: invalidate a lease-lost batch in the STORE

[r2] Revised after `/coord/handoff/R-508/review-r1-opus-adversary.md`. Every change from r1 is
marked [r2]. Adopted: I1, I3, M1–M5, and the review's INTERIM crash-window step (I2). The
review's positive "batch completed" marker is NOT adopted (see "Crash window").

Read `/coord/handoff/R-508/repro.md` first. Four repro tests, all RED today, all in
`/work/lethal-wt/r508/packages/runner/tests/orchestrator.test.ts` (search "R508").

## The fix

### 1. [r2] At the moment of loss: `onLost(batchIndex)` (first chance)

- Add `readonly onLost: (batchIndex: number) => void` to `LeaseSessionDeps`.
- In `LeaseSession.noteLeaseLost`, AFTER `this.d.safety.latchUnsafe(...)`, call
  `this.d.onLost(this.#lostBatchIndex)` ONLY on the first loss (the same `undefined` check that
  sets `#lostBatchIndex`). Latch first, so no new work can start while the write runs.
- The helper that constructs `LeaseSession` (the one building `new LeaseSession({...})`, which
  already takes `a.runId`) wires `onLost` to a function that runs synchronously:
  ```ts
  (batchIndex) => {
    try {
      store.invalidateBatch(runId, batchIndex, lostBatchNote(safety));
      store.dropBaselineSnapshot(runId, batchIndex);
    } catch (err) {
      console.warn(`[lethal] could not correct run ${runId} batch ${batchIndex} at the lease loss (${messageOf(err)}); the session's teardown tries again`);
    }
  }
  ```
  Pass the store into that helper if it does not have it. bun:sqlite is synchronous, so the
  write is done before `noteLeaseLost` returns. It never throws out of `noteLeaseLost`: the
  heartbeat (`pulse`) and the dispatch paths call it, and they must keep failing closed.
- Why: there is no SIGINT/SIGTERM handler, so Ctrl-C or a kill skips every `finally` (review I2).
  This write closes most of that window.

### 2. In the `finally`: `invalidateLostBatch` (second chance)

The second chance catches a verdict recorded AFTER the loss note: the in-flight RunMutant whose
answer arrived after `noteLeaseLost`. It also covers an `onLost` write that failed.

Replace `emitLeaseLostInvalidation(leaseSession, safety, emit)` with
`invalidateLostBatch(store, runId, leaseSession, safety, emit, late)`. [r2] Its order: the event
FIRST, then the write (review I3):

```ts
function invalidateLostBatch(store, runId, leaseSession, safety, emit, late: Error | undefined): void {
  const lost = leaseSession?.lostBatchIndex;
  if (lost === undefined) return;
  const note = lostBatchNote(safety);          // today's text, unchanged
  emit({ type: "batch-invalidated", batchIndex: lost, reason: note });
  try {
    store.invalidateBatch(runId, lost, note);
    store.dropBaselineSnapshot(runId, lost);
  } catch (err) {
    if (late !== undefined) console.warn(`[lethal] ${late.message}`);
    throw new LostBatchNotStoredError(runId, lost, err);
  }
}
```

- [r2] `LostBatchNotStoredError` extends `Error` directly. Message:
  `run ${runId} batch ${lost}: the lease was lost, and the stored verdicts were NOT corrected (${messageOf(err)}); do not --resume run ${runId}`.
  Pass `{ cause: err }`.
- [r2] If the session was already failing (`failing === true`), also `console.warn` that earlier
  error's message before throwing, so neither error is lost. Keep it in a variable in the `catch`
  that sets `failing`.
- Call it in BOTH callers' `finally`, after `closeLeaseScope`, before `surfaceLateRefusal`:
  ```ts
  } finally {
    let late: Error | undefined;
    try {
      late = await closeLeaseScope({ ... });
    } finally {
      invalidateLostBatch(cfg.store, runId, leaseSession, safety, emit, late);
    }
    surfaceLateRefusal(late, failing, safety);
  }
  ```
  `runSession` (at the "Layer 5C-B1 (design §6, verbatim)" comment) and `runNamedMutants` (just
  before `applyBatchInvalidations`). Delete the old call after each `finally`.
- [r2] (M1) The reason for "after `closeLeaseScope`" is that teardown and the lease release must
  always run, even if the write throws. It is NOT that `finish()` can note a loss: it cannot, and
  `lostBatchIndex` is final before `closeLeaseScope`. Do not write the r1 reason into comments.
- This also closes R508's "Also" item: the event is emitted, and the write made, even when the
  teardown throws a late refusal, and when the session throws (`failing = true`). On the normal
  path the event order is unchanged: `phase-left teardown`, `batch-invalidated`, `quarantined`.
- Fix the comments that say `store.invalidateBatch` is called "just above". They are wrong today
  for the lease path. Also fix the `noteLeaseLostOrThrow` / `LeaseSession` doc lines that say
  verdicts are invalidated "at session end".

### 3. [r2] store.ts: a new `dropBaselineSnapshot`, lease path only (I1)

`dropBaselineSnapshot(runId: number, batchIndex: number): number` runs
`DELETE FROM baseline_snapshots WHERE run_id = ? AND batch_index = ?` and returns `changes()`.

- It is called ONLY from `onLost` and `invalidateLostBatch`.
- `invalidateBatch` is UNCHANGED, and so is the attestation gate's call to it.
- r1 put the delete inside `invalidateBatch`. The review measured that this turns 4 existing resume
  tests red and breaks R192's main case: a resume after a hang at the start of a batch.

## What "invalidated" means (reuse, no new semantics)

`invalidateBatch` is unchanged. Rows of `(run_id, batch_index)` whose verdict is not `error` or
`known-survivor` become `error`. Their `failure_note` becomes the note, and `killing_test`,
`killing_test_failure` and `kill_position` are cleared. The readers then refuse those rows with
no change of their own:

- `--resume`: only `CARRYABLE_VERDICTS` carry, and `error` is not one of them, so the lost batch
  is re-run.
- `--skip-known-survivors`: it reads only finished runs, and no lost row can now be carried into
  a later finished run.
- R192 snapshot: the row is gone.

Carried rows inside the lost batch are rewritten too. That costs one re-run. It is the safe
direction, and it is what the attestation gate already does.

**Schema / IDENTITY_SCHEME / migration: none.** `batch_index` already exists on `mutants` and on
`baseline_snapshots`. `IDENTITY_SCHEME` stays 30.

## [r2] Crash window

- **Closed by step 1:** a crash at any point after `noteLeaseLost` returns, with rows recorded
  BEFORE the loss note.
- **Residue:** a verdict recorded AFTER the loss note and BEFORE a crash. Example: the in-flight
  mutant's answer arrives, is recorded, then the process is killed before the `finally`.
- **Not adopted: a positive "batch completed" marker.** The store has no batch-completion
  transaction. Without `maxGuardsPerBatch` the whole project is ONE batch, so every crash would
  leave the batch unmarked, and `--resume` would carry nothing. That breaks R47 on every crash.
- **Builder files a new correctness-risk item** (next free id via `bun scripts/roadmap-next-id.ts`,
  checked right before writing). Title: "A verdict recorded after a lease-loss note and before a
  crash is still carried by --resume". It proposes the review's NEGATIVE record:
  - a `lost_batches (run_id, batch_index, note)` table, written by `onLost`;
  - the table is excluded by `buildResumeIndex`'s reader (`mutantVerdicts`), `findResumableRun`'s
    EXISTS and `findBaselineSnapshot`;
  - a new table, created if absent, so no migration of existing rows and no `IDENTITY_SCHEME`
    change.
  Cite R508 and this plan.

## [r2] Builder files: the attestation-path snapshot (I1)

A new correctness-risk item: "The attestation gate invalidates a batch's verdicts but its R192
baseline snapshot is still reused". It must contain:

- **The false-kill argument:** a snapshot measured against the wrong binary can record test T
  green when T is red on the real one. T is then sent as covering and scores a kill.
- **The cost:** deleting the snapshot there turns the review's 4 existing resume tests red. Name
  them by their test names (from the review's scratch measurement, or re-measure). It also loses
  R192's resume-after-a-hang-at-batch-start reuse.
- **Status:** open, not fixed by R508.

## Tests

### Flip the repro tests (they already assert the fixed behaviour; make them pass)

In `orchestrator.test.ts`:

1. `R508: … > the lost batch's stored rows are not carried; the completed batch's are`
   - Lost direction: every run 1 batch 1 row is `error`. Run 2 carries no batch 1 row and
     re-measures M0001 and M0002.
   - Control: every run 2 batch 0 row has `carried = 1` and run 1's verdict, compared per mutant.
   - Remove the `console.log` lines.
2. `… > --skip-known-survivors on a later run does not read the lost batch's survivor`
   - Assert the key SET: exactly batch 0's `UnderLimit … empty-block` key, and not batch 1's
     `IsOverBudget … return-value` key.
3. `… > the lost batch's baseline snapshot is not reused by the resume`
   - Lost: run 1's `baseline_snapshots` hold batch 0 only. No `resume-baseline-reused` warning
     names run 1's batch 1.
   - ADD a control: a resume whose batch 0 has work left reuses run 1's batch 0 snapshot.
     [r2] (M2) In run 1, make one batch 0 mutant end in a TRANSPORT-level error: a run that throws
     or answers `operation: "pre-dispatch-rejected"`-style, NOT `in-flight-unknown` and NOT a lease
     answer. Pick a shape that records `error` without latching; read `runMutantsOnBackend` to
     choose it. Assert run 1's stored row for that mutant really is `verdict = 'error'`. Then
     expect a `resume-baseline-reused` warning naming "run <run1>'s batch 0".
4. `R259 … > R508 repro: a lease lost during the reruns leaves no kill in the store`
   - Lost: every row of `fx.cfg.runId` is `error` with the lease-lost note.
   - ADD a control: the same fixture with no lease loss leaves M0001 `killed` in the store.

### New tests

5. Teardown throw. The session loses the lease mid-batch AND meets an R507 lease-path refusal.
   Reuse the `R507: …` block's `wired` / `leaseRouter` helpers, R12's shape. The session rejects
   with `UnfilteredExtensionsQueryError`, yet the lost batch's stored rows are `error` and the
   events contain `batch-invalidated`.
6. In `tests/resume.test.ts`, add `describe("ResultsStore.dropBaselineSnapshot (R508)")`. Seed
   snapshots for batches 0 and 1, then drop batch 0. `findBaselineSnapshot` then finds only batch
   1's, and the return value is 1. [r2] Also assert that `invalidateBatch` leaves snapshots alone,
   which pins I1's "attestation path unchanged".
7. [r2] (I3) Write failure. Wrap the store so `invalidateBatch` throws, with a fixed error, on
   EVERY call (`onLost`'s and the `finally`'s).
   - `runSession` rejects with `LostBatchNotStoredError`. Its message names the run and batch and
     contains "do not --resume run <id>", and `.cause` is the fixed error.
   - The events contain `batch-invalidated`, emitted before the throw.
   - `console.warn` (spy, as R507's `capturingWarn`) shows the `onLost` warning.
   - Variant with an R507 late refusal: `console.warn` shows the late refusal's message BEFORE the
     named error is thrown.
8. [r2] Crash stand-in. Wrap the store so `invalidateBatch` succeeds on its FIRST call (`onLost`)
   and throws on every later one (the `finally`'s). That stands in for a process that dies before
   its `finally` could correct anything.
   - Session 1 rejects with `LostBatchNotStoredError`.
   - The error message says "NOT corrected" even though `onLost` wrote. That is conservative and
     deliberate; state it in the test.
   - Resume with a normal store wrapper on the same database: run 2 carries no batch 1 row, and no
     `resume-baseline-reused` warning names run 1's batch 1. The batch 0 control still carries.
9. [r2] Ordering. The lease-lost backend gets a `close()` method. After the loss the session is
   unsafe, so `closeLeaseScope` calls only `closeIfSupported`. `close()` reads the store at that
   moment and records it. Assert that batch 1's rows were already `error` and its snapshot
   already gone when `close()` ran. That is before the `finally`'s write, so only `onLost` can
   have done it.

10. [r2] Verdict recorded after the loss note: the case only the `finally` can correct.
    - Inside one mutant's `run`, fire the heartbeat (`FakeTimers.fire()`, with
      `renewQueue = [{ renewed: false }]`), so `noteLeaseLost` runs and `onLost` writes.
    - That run then returns an ordinary `fail`, which is recorded AFTER the note.
    - Assert that its stored row is `error` after the session.
    - With `onLost` alone, the row would stay `killed`. Without this test, no test needs the
      `finally`'s write, since in tests 1–4 the lease-lost mutant itself is recorded as `error`.

### Snapshot changed on purpose

`C02-04 characterization 7: lease lost mid-batch` pins the bug. Update it deliberately with
`bun test --update-snapshots packages/runner/tests/orchestrator.test.ts -t "7: lease lost mid-batch"`.

- Expected diff: ONLY M0001's `verdict` (survived → error) and `failure_note` (null → the
  lease-lost note). The review measured exactly this.
- Any other change in the `.snap` is a BLOCK. If `onLost`'s warning or the event order shows up in
  the trace, stop and report rather than accept it.
- Afterwards `bun scripts/verify.ts` must show no `.snap` change.

### Red-checks, one per direction (revert with the Edit tool, never sed)

| Check | Revert | Must go RED | Must stay green |
|---|---|---|---|
| R-A | Delete the store write in `invalidateLostBatch` | Test 10 | Controls |
| R-B | Move the `invalidateLostBatch` call to after the `finally` | Test 5 (the event half) | Others |
| R-C | Remove `runNamedMutants`' `invalidateLostBatch` call AND make its `onLost` a no-op | Test 4 | Others |
| R-D | Remove both `dropBaselineSnapshot` calls | Test 3 (lost half), and test 6's drop half if you call it there | — |
| R-E | Invalidate every batch `0..lost` (over-invalidation) | Tests 1 and 3 (their controls) | — |
| R-F | Make `dropBaselineSnapshot` ignore `batch_index` | Test 6's "only batch 1 remains" | — |
| R-G [r2] | Swap to write-then-event in `invalidateLostBatch` | Test 7's "event present" | — |
| R-H [r2] | Drop the `late` warn | Test 7's variant | — |
| R-I [r2] | Make `onLost` a no-op | Tests 8 and 9 | Tests 1–4 (the `finally` still corrects) |
| R-J [r2] | Move the `onLost` call before `latchUnsafe` | Nothing may turn red. If nothing does, say so: the order is a design rule, not tested. Or add a check that the latch is set when `onLost` runs. | — |

Expected results that are worth knowing:

- [r2] Tests 1–4 stay GREEN under R-A, because `onLost` already corrected their rows. That is
  expected. Test 10 is R-A's red.
- Each half has its own red: R-I shows that `onLost` is needed, and R-A (test 10) shows that the
  `finally` is needed.
- R-C: in `runNamedMutants` the lease is lost on an unmutated rerun, after the mutant rows were
  written, so `onLost` alone corrects them. That is why R-C must disable both halves for that
  caller.

Report the red output and the restored green output for each check. The `mutation-red-checker`
subagent may run them, with Edit-tool edits only.

## itest:hang

No change is expected. The gate does no `--resume` and loses no lease. Its OFF leg quarantines by
`deadline-exceeded`, not by lease loss.

Pre-commitment: `/coord/handoff/R-508/hang-precommitment.md` (r2). Commit it under
`docs/superpowers/specs/2026-10-08-r508-lease-lost-store-precommitment.md` BEFORE any live run.

## Builder rules

- Use the Edit/Write tools for every file, including red-check reverts. Never `sed -i`, heredocs,
  `cat >>`, shell redirects into files, or `bun -e`/`python -c` edits.
- Never read `lethal.config*.json`. No live BC, except the gate run by its owner step.
- Typed errors extend `Error` directly (`LostBatchNotStoredError`). No `!` assertions. Use the
  `exactOptionalPropertyTypes` spreads.
- Verify loop, from the repo root:
  1. `bun run typecheck`
  2. `rm -rf packages/*/dist`
  3. `bunx biome check <touched files>`
  4. `bun scripts/verify.ts`
- Roadmap:
  1. `bun scripts/roadmap-set.ts R508 --status "fixed in <commit>, live gate pending"`.
  2. File the two new items above, re-checking the next free id right before each one, then
     regenerate the index.
  3. Run `bun test scripts/roadmap-index.test.ts scripts/line-citations.test.ts`, then the final
     `bun scripts/verify.ts`.
  4. Cite names, not file:line. Mark R508 `done (<commit>)` only after `itest:hang` passes.
- CHANGELOG `## [Unreleased]` → `### Fixed`:
  "A lease lost mid-batch now discards that batch's verdicts in the results store, at the moment
  of the loss and again at session end, not only in the report. `--resume` no longer carries them,
  a later `--skip-known-survivors` no longer reads them through a resumed run, and the batch's saved
  baseline is not reused (R508). [r2] Because such a run may now hold nothing carryable,
  `--resume last` can pick an OLDER unfinished run with the same configuration."
- Do not commit until verify is green. Chain the push with `&&` after the checks, and put
  `[skip ci]` on WIP pushes.

## Open questions

1. [r2] Resolved: the snapshot delete is lease-only (I1); the attestation path is a new item.
2. [r2] Resolved for now: the crash window is narrowed by `onLost`, and the residue is a new item.
3. [r2] (M5) Verify's run rows (`runNamedMutants`): verify's message on a lost batch is
   acceptable as it is. Test 4 keeps the store consistent. No reader uses those rows today.
