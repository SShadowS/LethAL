# PR-196 (R1131): record bcdev's start WorkDate per call and refuse a change from the baseline's — design, r1

Coord task PR-196, lethal-preproc, 2026-11-19. Spec before code; spec-adversary next. Related: [[R1131]], [[R1127]], PR-180
(control 1.0.0.27).

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
