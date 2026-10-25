# Design A2: overlap the alc proof with the baseline and the mutant loop (PLAN ONLY)

Coord task R-793. Status: **planned, build after the talk (Tue 27 Oct)**. Nothing here is built. Related: R790 (A1,
lethal-preproc: the baseline only, speculated inside `deploy()`), R780 (test-app cache), R769 (why the alc proof
stays), R734 (clean redeploy), R461 (plain build), R125 (no pin-back).

Inputs:
- lethal-preproc's R790 notes (branch `lethal/r790`, `/coord/handoff/R-790/`), with constraints C1-C3;
- an inventory of every write, event and read-after-write between `deploy()` and the end of a batch (orchestrator.ts
  at 6f63e707; line numbers below are from that commit);
- one spec-adversary review (opus), folded in as review items R1-R7.

The ~6 s prize on D1 is arithmetic, not a measurement: alc batch 6.2 s, baseline 2.6 s, mutant loop 6.1 s, wall
20.8 s (`/coord/handoff/final-timing/6aa7700c/timing.md`, D1 #2). A1 takes the baseline's 2.6 s of it. A2 can save
at most the alc time, because it commits as soon as alc resolves (§2).

In code and comments this design is called the **"deferred proof"**. orchestrator.ts:7359 already uses "R734 (A2)"
for the clean redeploy, and the two must not be confused.

## 0. Scope and switch
- **v3 only, behind a backend capability.** The capability is `deferredProof` on the v3 backend; no other backend
  implements it. The deferred path runs only when all of these hold:
  - the backend has the capability;
  - `workers === 1`;
  - not `--resume` / `--resume-run`;
  - neither app.json, the batch's or the test app's, enables `features: ["TranslationFile"]` (C3, §3);
  - the batch is a FIRST attempt. The R734 redeploy and the R461 plain build always run today's sequential path.

  Anything else runs today's path.
- **Kill switch:** `LETHAL_V3_DEFERRED_PROOF=0`, plus a test seam.
- **The bcdev path, and what "unchanged" means (R4).**
  - The `{ alc }` continuation (orchestrator.ts:7444-7609) sits textually before the code the window runs
    (7610-8225), and the batch-local variables are declared after the deploy: `unsupportedOnlyCandidates`,
    `refusedThisBatch`, `testPageThisBatch`, `httpTextThisBatch`, `v3RefusedThisBatch`.
  - So the build MOVES 7610-8225 into one function, `scoreDeployedBatch(scope, store, emit, ...)`, which gets fresh
    locals on every call. It adds one swappable store reference to `BatchScope` (built once, ~6959) and to the ~15
    direct `cfg.store` uses in that range.
  - That is a move, not an edit: the moved text is reviewed as a move diff (`git diff --color-moved`), and the
    store references are the only textual change.
  - The session catch's `cfg.store.abandonRun` (8239) and every end-of-session write keep the REAL store.
  - bcdev runs the moved function with the real store and the real emitter; T9 pins that its store and event
    sequences equal master's.

## 1. The backend half (al-runner-v3-backend.ts)
- **The prefix is unchanged.** `deploy()` runs `closeAllDaemons`, `resetLayoutState`, `stage()`, `readEchoId` and
  `readManifestIds` as today, and their errors (`ArtifactPrepareError` among them) still throw from `deploy()` before
  alc starts.
- **The copies (R6).**
  - The target compiles in `alc-src/` (A1's `compileTargetCopy`).
  - The test app compiles in `alc-test/`, a copy of the test dir without `.alpackages`. The test-app compile stages
    its packages in `alc-test-pkgs/`, and the R780 cache applies as today.
  - Order: read `pre` (the R780 test-dir read) FIRST, then copy, then scan the copy. Assert the copy's scan equals
    `pre` (the `.al` hash, every non-`.al` file's sha256 and the app.json byte sha, as `sameTestDirRead`); on any
    difference, fall back to today's sequential deploy. The proof's test-dir fields come from `pre`. So the proof
    binds exactly the bytes alc compiles, and exactly the bytes v3 reads, as long as `assertBound` holds.
  - Both copies map alc's paths back with A1's `errorAsIfIn` (r790), both separator forms, the same error class. An
    `AlcCompileError` or `TestAppError` text names `active/` and `testDir` exactly as today.
- **A failure of A2's own steps falls back, never aborts (R3).** If a copy step (`cp`, `fileStates`) fails with a
  plain fs error, `deploy()` abandons the deferred path for this batch and runs today's sequential deploy. Today's
  path has no copy step that could fail.
- **Today's error order is kept (R3).** Today these all run AFTER the target alc, so an `AlcCompileError` always wins:
  - the binding hashes: `linkIsUnproven(hashAlTree(active))`, `activeAppJsonSha256`, `activeOther`, `listDeps`;
  - the coverage index: `buildAlRunnerCoverageIndex` and `assertManifestObjectsDeclared`;
  - `buildSleepIndex`, the `realpath`s, and the pre-read.

  Under A2 they run while alc is pending, so `deploy()` catches ANY throw from them. It then awaits the target
  compile, and rethrows in today's order:
  1. the target's `AlcCompileError`;
  2. then the R780 order of the test-dir read error vs `TestAppError`;
  3. then the step's own error.

  In practice: a mutant whose AL alc rejects and the coverage-index parser also chokes on still reaches bisection.
- **What `deploy()` returns.** If none of these steps throws, it returns `null` with the proof's byte fields set and
  `proof.alc = "pending"`, plus a stored `joinProof: Promise<void>`. `targetAppSha256` and `testAppSha256` stay empty
  until the join; neither has a reader (R780).
- **`joinProof()`**
  - Awaits both compiles.
  - Checks that alc wrote nothing into either copy (`fileStates` before and after). TranslationFile is excluded, so a
    write is unexpected. It raises `ProofCopyChangedError`, which means "discard and re-run sequentially", never an
    alc verdict.
  - Sets `proof.alc = "passed"` and the shas.
  - Rethrows alc's errors in today's order (as above).
  - Writes the proofStore marker only after a passing join, and only if a test-dir read taken at the join equals
    `pre`.
- **Pending outside a window refuses.** `activate()` and `assertBound` accept `alc: "pending"` only between the
  orchestrator's `beginDeferred()` and `endDeferred()`. Otherwise it is an `AlRunnerV3UnprovenBatchError`.
- **Taint (R2).**
  - Every v3 call STARTED while the join is open is tainted, and the backend records the taint at the time the answer
    is produced. Prefetched answers (`prefetchMutants`, R635 §4) produced in the window stay tainted when they are
    consumed later.
  - A tainted answer that is not a clean, untimed row discards the WHOLE window (§2.5). That includes a timeout, a
    stop-kill, `deadline-exceeded`, a transport failure, a budget refusal, `alrunner-stop-mismatch`, an `unstable`
    confirm, an R577 reproduction that is not reproduced, and any refused row. So does any THROW from a tainted call:
    `AlRunnerV3EntriesRefusedError` (`warmup-dirty`, `warmup-disagrees`), and the second transport failure that
    triggers `stopAfterRecord`.
  - There is no per-mutant re-run: re-running one mutant out of order changes the kill ledger (`recordKill`) for the
    mutants after it, and `measuredToday` budgets in one-shot.
- **Backend session state (R1).** Some backend state outlives a batch, and the next `deploy()` does NOT reset it:
  - `entriesRefused` (:1054, set in `liveFailure` :3276, never cleared) poisons every later live call;
  - `baselineRefused` (:1106, session-scoped on purpose, R677) feeds `survivorNote` for LATER batches;
  - `stats` (the serve counters);
  - the pair store, the speculative (A1) store, and the lane memory notes.

  The backend gets `checkpoint(): BackendCheckpoint` and `restore(c)`. They copy and restore every field that a
  `resetLayoutState` + `deploy()` does not reset. The build lists the fields by reading the class (each `private`
  field: reset per deploy, or checkpointed), and a test pins that list (§5, T4).

## 2. The orchestrator half: a short journaled window
1. **The window.** It opens when `deployStep` returns `{ deferred }` (a new arm) and closes when `joinProof()` settles.
   That is about the alc time, not the batch: commit happens as soon as alc passes (R5).
2. **Inside the window**, `scoreDeployedBatch` runs with a journaled store and a journaled emitter. At the window's
   start, the orchestrator checkpoints the orchestrator state and the backend (`backend.checkpoint()`). The
   orchestrator state is `outcomes` (length), the kill ledger (a copy), `baselineGreenOverall`, `measuredToday`, the
   `sessionReuse.*Warned` flags, and `select`'s state.
3. **The journal** (`BatchJournal`, next to `OrderedCommit`, whose buffer-and-replay shape it reuses).
   - **Allowed store methods**, recorded and replayed in call order:

     | method | call sites (6f63e707) | replay note |
     |---|---|---|
     | `recordTestResult` | 5204, 5222, 11860 | the `mutantRowId` argument is remapped |
     | `recordBaselineSnapshot` | 5550 | as is |
     | `recordMutant` (via `record()`) | 12757 | returns a provisional id `-(n)`; the real id is mapped at replay |
     | `keepFacedTests` | 8030 | remapped id; replay asserts `changes() === 1`, as the store does |
     | `setRunTestAppHash` | 5357, 5680 | as is |

     (5500 and the `findBaselineSnapshot` / `getRun` / `runMayLend` reads are on the resume-only reuse path, which §0
     excludes.)
   - **Any other store method is a refusal:** `JournalRefusedError`, then discard and re-run sequentially (§2.5).
   - **Reads:** no read may observe this batch's journaled writes. None exists in the window today; a new one must be
     added to the table on purpose.
   - **Events:** journaled upstream of `createEmitter`, so `seq` is stamped at replay and contiguous. Backend notices
     (`handNotify`) are journaled too. The live renderer and `--progress-out` lag by the window's length (about the
     alc time), then catch up.
4. **The join passes, with no taint so far.**
   - Replay the journal through the real store and emitter.
   - Switch the wrapper to pass-through (`endDeferred()`), so the rest of the batch autocommits as today.
   - Nothing about completeness is needed: the replayed prefix is exactly what today's run would have written by that
     point.
   - An empty journal (alc finished before the first write) is the same as today.
   - "A silently empty commit" cannot happen: the batch keeps running live after the switch.
5. **Discard** happens on: a failed join; taint (§1); `JournalRefusedError`; `ProofCopyChangedError`; or the window
   ending some other way.
   - The window ends because the loop finished, threw (`TestAppDriftedError`, `baselineFoundNoneRefusal`,
     `StaleTargetMemberError`, `StaleDependencyMemberError`, `stopAfterRecord`, `ParallelStopError`) or hit
     `nothing-to-run`: the orchestrator AWAITS the join first.
   - On every discard: drop the journal, restore the orchestrator checkpoint, and restore the backend.
   - Then route by what the join gave:
     - **`AlcCompileError`:** enter today's `{ alc }` continuation with that same error object: R461 `plainBuild`,
       `compile-isolation`, `isolateAndNote`, R734 `redeployClean` (sequential, through `deployStep`), the error
       rows, `continue`. The routing text is not edited.
     - **Any other join error** (`TestAppError`, the test-dir read error, a spawn failure): throw to the session catch
       (8226-8243), as today's `deployStep` does.
     - **The join passed, but the window was tainted, refused, or changed a copy:** re-run the batch from its scoring
       start, sequentially, on the SAME proved deploy. `proof.alc` is now `passed`, the store and emitter are the
       real ones, and nothing is redeployed.
     - **The join passed, and the window ended with a throw:** replay the journal, then rethrow, so the store holds
       what today's run held at that throw.
6. **Early-throw order (R3, at the orchestrator level).** A throw inside the window never surfaces before the join. If
   alc failed, the alc path wins, exactly as today, because those checks would only have run after a passing deploy.

## 3. The Translations .g.xlf copy (C3)
- **Today**, a project with `features: ["TranslationFile"]` gets `Translations/<App>.g.xlf` written by alc: the
  target compile writes into `active/`, and the test-app compile writes into the user's test dir. v3 reads both after
  alc.
- **A2 does not overlap such a project** (§0). The bytes v3 reads stay unchanged.
- **For every other project**, alc compiles copies whose bytes equal the proof's (§1, R6). `joinProof` proves alc wrote
  nothing into them. If it did, the batch re-runs sequentially, so a later alc that writes a new kind of file cannot
  make v3 read bytes the proof does not describe.
- #5841 ignores `*.g.xlf`, but that does not loosen this gate: the gate is about bytes, not about what v3 interprets.

## 4. Resume, snapshot, crashes (R5)
- `--resume` / `--resume-run` keep today's path (§0).
- **A crash in the window** loses at most the window's rows, about the alc time of work. A later `--resume` re-runs
  that part. Today's per-mutant autocommit is unchanged after the window.
- **A crash during replay** leaves a partial prefix, autocommitted per call, which is today's crash state.
- **Snapshots:** `recordBaselineSnapshot` is journaled, so a snapshot is never recorded from a deploy whose alc
  failed.
- **Contention in the recorded durations.** A baseline slowed by alc's CPU, without timing out, writes inflated
  durations into the snapshot and the `2 × duration` budgets. The 180 s floor (`MIN_MUTANT_BUDGET_MS`) hides this
  except for tests over 90 s. The build records that it is accepted, or taints a baseline whose duration exceeds its
  A2-off measurement by a margin. This is an open question in §7.

## 5. Tests (red-checked, one per direction)
- **T1, equal on pass.** A fake backend with a deferred proof that passes mid-loop. The same batch with A2 on and off.
  The store dump (every table, row ids included) and the event list (minus `seq` and wall times) are equal.
  - Red: replay out of order, or drop the `mutantRowId` remap.
- **T2, nothing from a rejected batch.** The fake alc rejects at three points: before the first write, mid-baseline,
  and after the loop. No row and no event of the window is committed. `isolateAndNote` receives the same
  `AlcCompileError` object. The stored error-note TEXT equals the A2-off run's, so `errorAsIfIn` must have mapped the
  copy's paths back.
  - Red: commit before the join, route through a new class, or drop the path mapping.
- **T3, non-alc join errors abort.** A `TestAppError`, the test-dir read error and a spawn failure each abort as today,
  with nothing of the window in the store.
  - Red: route them into the alc path.
- **T3b, step errors under a failing alc.** A coverage-index throw (or a `linkIsUnproven` one) together with a
  target `AlcCompileError` reaches bisection.
  - Red: let the step error out first.
- **T3c, copy failure falls back.** An fs error in the copy step runs the sequential deploy, and the verdicts equal
  A2-off.
  - Red: abort on it.
- **T4, checkpoint.** After a discard, the orchestrator state AND the backend state (`entriesRefused`,
  `baselineRefused`, `stats`, the pair store) equal a run that never speculated. A second test pins the list of the
  backend's private fields that are reset per deploy or checkpointed, so a new field must be classified.
  - Red: skip one restore.
- **T5, taint discards whole.** These each discard the whole window and lead to a sequential re-run with today's
  verdicts:
  - a tainted timeout;
  - a tainted `deadline-exceeded`;
  - a tainted warm-up `AlRunnerV3EntriesRefusedError`;
  - a tainted prefetched answer consumed after the join;
  - two tainted transport failures (no `stopAfterRecord` abort).
  - Red: keep any tainted non-clean answer.
- **T6, the window closes at the join.** Rows after the join autocommit live. A kill right after the join leaves the
  replayed prefix plus the live rows, as today.
  - Red: hold the journal to the loop's end.
- **T7, copies.** A fake alc that writes into `alc-test/` raises `ProofCopyChangedError` and leads to a sequential
  re-run. A user edit between `pre` and the copy makes the copy scan differ and leads to a sequential deploy. A
  TranslationFile app.json never enters the window.
  - Red: drop either check.
- **T8, pending outside a window refuses.**
  - Red: drop the `beginDeferred` flag.
- **T9, bcdev unchanged.** A bcdev-kind fake backend gets no deferred arm. Its store and event sequences equal master's
  on the existing orchestrator tests, after the move of 7610-8225.

## 6. Gates
- VERIFY FULL before every push, with the red tests.
- **The full v3 gate** (`itest:alrunner-v3`, TABLES=1, CDO) on the head. Every per-mutant table must be unchanged; a
  move is a BLOCK.
- **A new itest leg, "DP" (deferred proof).** No leg proves v3 results from an alc-rejected batch are discarded today
  (preproc).
  - It uses R769's measured shape: a mutant alc rejects (AL0139 on a called path) and al-runner would run.
  - Under A2 the batch must bisect, and the mutant must be recorded `error` with today's alc note text. The other
    mutants must equal an A2-off run per mutant.
  - It enters `V3_GATE_LEGS` (R777: regate `current` after the merge).
- **BC legs.** `selectLegs` will pick bcdev, lease, tables and chunked, because `orchestrator.ts` changes, and the move
  in §0 REACHES the bcdev path. So the BC legs run: on bc3 (docker1, after the 03:00 UTC flip), under a lease. T9 does
  not replace them.
- **Timing receipt.** `scripts/v3-timing.ts --repeat 5` on gc and d1, quiet machine, against master, comparing WALL time
  (R7: `phase-left deploy` and `batch-published` no longer include alc). Pre-commit the expected figure on master
  first: D1 down by up to the alc time; gc unchanged.
- CI green; one opus build review (fast track).

## 7. Open questions for the build
- **Lanes** (`workers > 1`): `OrderedCommit` would nest inside the journal. Out of scope for the first build.
- **A1 vs A2:** with A2 on, A1's in-`deploy()` speculation is redundant on first attempts. Keep A1 for the cases A2
  excludes (resume, TranslationFile), or remove it. Measure first.
- **Contended baseline durations** (§4): accept or taint. The build measures the inflation on D1 and decides.
- **How much A2 saves once the window is short:** a tainted run (CPU contention) costs a sequential re-run of the
  window. If D1's taint rate under alc is high, A2 saves little, and A1 may be the better trade. The build measures
  the taint rate first, on 20 D1 runs, before writing the orchestrator half.
