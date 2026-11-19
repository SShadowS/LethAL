# PR-196 (R1131): record bcdev's start WorkDate per call and refuse a change from the baseline's — design, r1

Coord task PR-196, lethal-preproc, 2026-11-19. Spec before code; spec-adversary next. Related: [[R1131]], [[R1127]], PR-180
(control 1.0.0.27).

## 0a. Amendment 1: the spec-adversary review of r1 (86e6a2ba)
The review found no false-kill path. It confirmed the reported date IS each method's start date: RunMany sets it before
each method, and the runner's Initialize stores and restores it. Five points change the spec; item 4 needs a ruling. Each
item overrides the section it names.
1. **Reused baselines and resume (overrides §2.2's baseline rule).**
   - `BaselineSnapshot` stores `workDate` (the baseline calls' date).
   - A snapshot is reused ONLY when its stored date equals the date of this session's first test-running answer;
     otherwise the batch's baseline is re-run. A snapshot stored before this change has no date, so it is never reused.
   - **Clarified at build (2026-11-19).** Batch 0's reuse decision comes before any test-running answer, so the session
     has no date to compare with yet.
     - Allowing the reuse there loops: a resume across midnight in a non-demo company reuses the old snapshot, every
       mutant row becomes `workdate-changed`, and each later `--resume` repeats it.
     - So a session NEVER reuses its first batch's snapshot: batch 0's baseline is always re-run, which gives the
       session its date. Later batches reuse only on an equal date.
     - The cost is one baseline per resume.
     - The `workdate-changed` note says to re-run (a resume re-runs batch 0's baseline and reads the new date), not
       "re-run with --resume" as a loop.
   - `baselineWorkDate` in the report is the first batch's date; each batch's own date travels on its
     `baseline-batch-finished`.
   - Carried rows keep their verdicts; the date they ran on is not recorded, as today.
   - `itest:lend` exercises this path. Its pre-committed figure: no verdict moves (one day, one date).
2. **When `workDate` is required (overrides §2.2's "missing refuses").**
   - It is required exactly when a method RAN: one per RunMany `methods` entry, and on a RunMethod answer whose
     `codeunitResults` is not an error. That is the same rule as `sessionId` (`AddSessionKeys`).
   - An answer where no test ran (R688 `test-discovery-failed`, RunMany's `ResolvePairs` exit, a caught phase-2 error)
     carries no date and keeps today's handling.
   - RunMethod's date goes through a getter into `BuildStatus`, because `TestResultsToJSON` is Base Application's own
     shape.
3. **The scoring site (overrides §2.2's "scores error").**
   - A date mismatch is returned by the backend as a step with `cause: "workdate-changed"`, and it takes the
     orchestrator's `step.cause` branch (as R198's causes do). It is never a plain error outcome, which would be a
     transport error and abort the session.
   - **Every test-running answer is compared:** mutant, kill-reproduce, kill-confirmation, warm-prefix and group (R198)
     answers.
4. **The unit of the date (overrides §2.2's "ONE date per session"; NEEDS A RULING).** Each batch has its own
   baseline, so the comparison is per batch. On the first mismatch inside a batch:
   - **(A)** the mismatching answer, and every later one in that batch, is `error` / `workdate-changed`. Simple; a date
     move costs that batch's remaining verdicts.
   - **(B)** the batch's baseline is re-run ONCE on the new date and becomes that batch's baseline for the rest. The
     mismatching mutant is re-run against it. A second move in the same batch falls back to (A).

   (B) keeps verdicts on a long run crossing a date (DO windows run for hours). It cannot make a false kill, because a
   kill is confirmed on the date it ran under. Recommendation was (B).
   **RULED (orchestrator, 2026-11-19): (A).** A posting during a run is rare. (A) is never wrong, only conservative: the
   affected rows read `error` / `workdate-changed` by name, and the user re-runs. (B) adds a mid-batch re-baseline path for
   a rare case, which is more code to trust. Two baseline calls disagreeing WITHIN one baseline
   still refuse the batch (`BaselineWorkDateUnstableError`).
5. **Hub mode** (`coverageMode: "procedure"`, which sends the baseline to bc-dev-mcp, bcdev-backend.ts): its answers
   carry no `workDate`, and its session follows its own date rule. The comparison does not apply there. The report says
   so: `baselineWorkDate` is absent, plus a one-line note. A refusal would break a supported mode.
6. **Report and plumbing (adds to §2.3):**
   - `workdate-changed` joins the closed `MutantErrorCause` set: `ERROR_CAUSE_INTERPRETATIONS`, the schema enum, and
     their pinned counts.
   - `baselineWorkDate` travels on an event (as `baseline-batch-finished`'s date), so a report rebuilt from events keeps
     it. It is REQUIRED on a bcdev report outside hub mode, so a silent drop fails a test.
   - `errorClassOf` passes the new cause through. No bcdev baseline holds an error row, so no frozen figure moves.
7. **Wording and proof:**
   - R1131's "also catches the midnight change of a non-demo company" is true only for fresh sessions. A reused session's
     `GetDefaultWorkDate` returns its own old WorkDate. Reworded in R1131 when this lands.
   - **The live proof** (lethal-code, under leases) is the full re-proof CLAUDE.md requires after a control-build change:
     every BC gate on every server listed for it (`docs/gates/servers.md`), plus bc4, with 1.0.0.28. Each passes per
     mutant on its frozen baseline, and each report carries a `baselineWorkDate` equal to that server's CRONUS last G/L
     date.

## 0b. Amendment 2 (2026-11-19, after the Opus review of the build; orchestrator ruling (2))
- **The review BLOCKED the batch-0 clarification of amendment 1 item 1** ("a session never reuses its first batch's
  snapshot"):
  - it breaks `itest:lend`, whose R1, R2 and RP assert batch-0 reuse;
  - it costs users: every bcdev `--resume` would re-run its first baseline, so R192's reuse is lost for single-batch
    projects.
- **The root cause:** at batch 0's reuse decision no test has run, so the session has no date.
- **The ruling (2):** the control app returns the date WITHOUT running a test, on a call the client already makes
  before each batch.
- **The change, replacing amendment 1 item 1's batch-0 clarification:**
  1. **Control 1.0.0.28** (the same bump) also returns `workDate` = `Format(LogInMgt.GetDefaultWorkDate(), 0, 9)` on
     the control call the client makes before each batch's baseline or reuse decision (the builder names which call:
     the status or lease answer the client already reads there). It is computed the same way a test-running call
     computes its start date, in a web-service session.
  2. **At EVERY batch's reuse decision, batch 0 included,** the client compares that FRESH date with the snapshot's
     stored date. It reuses only on equality, and re-runs the baseline otherwise. A dateless snapshot is never reused.
     If the fresh read is missing on a 1.0.0.28 answer, that is a protocol error, refused by name.
  3. **The batch's comparison date** is that batch's baseline date: from the live baseline's answers, or, on reuse, the
     snapshot's date (which equals the fresh read).
     - The guard's session-wide `sessionDate` is dropped. This fixes the review's M2: a later batch no longer compares
       against the first answer's date.
  4. **Pre-committed:**
     - `itest:lend` passes UNCHANGED (R1, R2 and RP still reuse batch 0 on one day, one date);
     - every other frozen gate is as amendment 1 item 7 says.
  5. **Tests, red-checked both ways:**
     - same date → reuses (batch 0 and a later batch);
     - moved date → re-runs;
     - a dateless snapshot is never reused;
     - a missing fresh date refuses.
- **The review's minor points, folded in:**
  - **M1:** the guard keeps the verdict's other fields (stop accounting, sessionId) when it marks `workdate-changed`.
  - **M3:** two baseline dates inside one batch's baseline abort the SESSION by name (`BaselineWorkDateUnstableError`),
    not just the batch. That is conservative and rare; it is stated here, matching the code, with an orchestrator-level
    test.
  - **M4:**
    - the CHANGELOG line states the reuse rule exactly;
    - R1131's status is set done in the branch;
    - servers.md's proof rows move only with code's re-proof.
  - **M5** is moot: R192's reuse is kept.

## 1. The problem (checked in the source before writing)
- Since PR-180 the control app sets each test's start WorkDate to Base Application's `LogInMgt.GetDefaultWorkDate()`:
  - `RunMethod.Codeunit.al` reads it on every call;
  - `RunMany.Codeunit.al` reads it once per call (`StartWorkDate`) and sets it before each method.
- In a demo company that is the last G/L entry's posting date; otherwise it is the session's WorkDate (today).
- **No answer carries it** (RunMany's per-method object has index, codeunitId, method, lineNo, sessionId, results,
  duration, observedActive), and **no client code reads it**.
- So a posting in the same company during a run, or midnight in a non-demo company, moves later calls' start date away
  from the baseline's, silently.

## 2. The change
1. **Control app 1.0.0.28.** Every answer that runs tests returns the start date it set, as `workDate`, an ISO text
   (`Format(d, 0, 9)`):
   - RunMany: in each per-method object, next to `sessionId`;
   - RunMethod: in its answer object.
   - Nothing else changes.
   - Its rules apply (the `control-app` skill): bump `app.json`, compile with alc, update the setup script's
     `CONTROL_APP`/`CONTROL_SHA256`, and raise `MIN_CONTROL_VERSION` to 1.0.0.28. Republishing to bc1-bc3 (setup
     script) and bc4 is a live step through lethal-code, under leases.
2. **The client** reads `workDate` from every answer that runs tests (baseline, mutant, confirmation and kill-reproduce
   calls).
   - **A missing `workDate`** on an answer from a control app at or above 1.0.0.28 is a protocol error and refuses, by
     name, as the other echo checks do (fail loudly).
   - **The baseline date:** all baseline calls of a session must report ONE date. If two baseline calls disagree, the
     session refuses at baseline: `BaselineWorkDateUnstableError`, naming both dates and the calls. No mutant runs on
     an unstable baseline.
   - **A mutant or confirmation answer** whose `workDate` differs from the baseline date is NOT scored. The mutant's
     verdict is `error`, cause `workdate-changed`, and the note names both dates.
     - It is never a kill or a survivor, so a date move can only cost a verdict, never invent one.
     - A kill confirmation under a different date is the same `error`, not `unstable`.
3. **The report** records the baseline's start date in an OPTIONAL field `baselineWorkDate` (present when the backend
   reports one: bcdev). A session with any `workdate-changed` errors raises a caveat `workdate-changed`, with the count.
   - That is a new Caveat, so `CAVEAT_INTERPRETATIONS` and the counts in interpretation.test.ts and report.test.ts
     follow (CLAUDE.md).
   - The field is optional, so committed sample reports still validate and are not regenerated.
4. **al-runner v3** is unchanged: its client-session date is set by v3 itself (R1127), and the field stays absent.

## 3. Pre-committed
- **Unit tests, each red-checked:**
  - a mutant answer with a different `workDate` scores `error` / `workdate-changed`;
  - an equal date scores normally;
  - two baseline calls with different dates refuse with `BaselineWorkDateUnstableError`;
  - an answer without `workDate` from a 1.0.0.28 app refuses;
  - the report carries `baselineWorkDate` and the caveat with its count;
  - a confirmation under a different date is `error`, not `unstable`.
- **Frozen bcdev gates:** NO verdict or row moves. The fixtures post nothing during a run, and a gate run within one day
  of a demo company keeps one date. Warning sets are unchanged. Each gate's report gains `baselineWorkDate` (not in
  any per-mutant row).
- **The live proof** (lethal-code, on a bc server under a lease, after republishing 1.0.0.28):
  - `itest:bcdev` passes per mutant on its frozen baseline;
  - its report's `baselineWorkDate` equals the server's last G/L date in CRONUS (read by a separate read-only check);
  - every call in the events reports that same date.
  - A live posting-mid-run probe is out of scope (it needs a write into the company during a run); the unit tests pin
    the path.
- **The orchestrator rules on the version floor:** raising `MIN_CONTROL_VERSION` makes every gate server need 1.0.0.28
  before its next gate.
