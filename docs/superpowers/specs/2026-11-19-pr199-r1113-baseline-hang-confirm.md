# PR-199 design and pre-commitment: a hung BASELINE test should cost one test, not the run (R1113 fix 3)

Coord PR-199 (lethal-code, 2026-11-19). Roadmap: R1113, fix 3. Evidence: `/coord/handoff/PR-199/`, `/coord/handoff/PR-67/before/`,
`/coord/handoff/PR-68/full-quarantined/` and `changed-quarantined2/`, and `/coord/handoff/PR-68/friction.md`.

## 1. What happens today (read from the code, master 100a3990)
- **The baseline sends one test per call** (`dispatchUnmutated`), with a per-test budget of `--baseline-timeout-ms`, default
  120 s (`BASELINE_TIMEOUT_DEFAULT`). This is the per-test budget the task asks for, and it already exists.
- **When the budget passes,** the client always stops an unmutated run (R658):
  - `StopHungRun` on a second connection runs the control app's `StopSession(<the run's session>)`, clears the op, and writes
    the tombstone;
  - the client then holds the original request for `STOP_GRACE_MS` (30 s) and waits for BC's answer on it.
- **A confirmed stop already leaves the test out:**
  - BC's answer counts as confirmation when it is a 408 naming the stop (BC 28), or, on BC 29, a 400 within
    `STOP_400_WINDOW_MS` (10 s) of a stop LethAL confirmed;
  - the test is scored `timeout` and classified `baseline-test-stopped`, and the report's `baselineStopped` block names it;
  - it drops out of coverage, and the run goes on. `itest:hang`'s baseline leg proves exactly this (A1-A20) on a test that
    `Sleep`s past its budget.
- **The quarantine happens only when BC sends no answer within the grace.** The verdict is `deadline-exceeded` /
  `in-flight-unknown`, the session is latched unsafe, and a quarantine is recorded. R658's message follows: "LethAL's stop was
  confirmed and tombstoned the op, but BC never sent its 408; the control-app lease will read clean and must not be trusted
  until an NST restart".
- **All three DO hangs on bc4 (BC 29) were this case:** LethAL's own stop `confirmed`, and no answer from BC within 30 s.
  - two were Azure tests, which reach `CTS-SYS Http`;
  - one, `CDO Data Upgrade Tests.StaleExpiryUpgrade_ClearsOnlyTheCurrentCompany`, has no network call.
- **So the question is not the budget.** It is why BC does not answer the held request after `StopSession`, and what can
  safely count as a stop when it does not.

## 2. The hypothesis to measure
- **H:** `StopSession` ends a session that is running AL (a loop, `Sleep`) at once, but a session waiting in native code (an
  outbound `HttpClient` call, perhaps a database wait) ends only when that wait returns.
  - If the wait returns (an HTTP timeout, BC's default being about 100 s), BC then answers the held request: too late for the
    30 s grace.
  - If it never returns, BC never answers, and the session may still be alive. R658's distrust is then right.

## 3. Measurement, in bounded stages (bc4, BC 29, under lethal-code's lease; owner question q-20261119T043331-68d01347; nothing runs before a yes)
**Revised before any run** after the spec-adversary review (2026-11-19). The first version (master 461e8378) could pick a
design with no evidence:
- an HTTP shape that fails at once reaches no stop;
- its measuring client is cut by Bun's own fetch limit, about 272-300 s (R191);
- its health check is the one R658 calls untrustworthy;
- branch B's evidence was unchecked against the work actually ending.

This version measures only shapes whose wait ends by itself first. Every shape is checked for validity before the rule.

- **The probe pair** (`/coord/handoff/PR-199/probe/`, scratch ids 76150-76199, checked free first; invented code). A test
  codeunit, each test sent alone exactly as the bcdev baseline sends it (`RunMutantWithCoverage`, empty mutant id), and a probe
  web service:
  - **S1 `LoopsForever`:** writes and locks one scratch row (`P199 Witness`, key = the shape), then runs an AL loop bounded at
    10 min. This is the control: the hang gate's shape.
  - **S3 `HttpSlow60`:** writes and locks its scratch row, then makes `HttpClient.Get` to a non-routable address with
    `HttpClient.Timeout := 60000`.
  - **S2 (an unbounded network wait) and S4 (a database wait) are NOT run in this stage.** They need their own pre-commitment,
    and an owner restart booked beforehand.
- **The witness, which is the health check:** after each shape, a probe web-service call in a NEW session tries to lock and
  modify that shape's scratch row, with `LockTimeout` on.
  - If the row is free, the hung session's transaction is gone: its work ended.
  - If it is still locked, the session's work goes on, whatever any session list says.
  - Lease reads and a trivial run are not health evidence (R658).
- **The driver** (`/coord/handoff/PR-199/drive.ts`) sends the held request through LethAL's own transport, with a
  `fetchFn` wrapper that turns off Bun's idle timeout and logs these timings:
  - request sent, headers received, body received, status, and the first 300 characters of the body;
  - the error type, if the request fails;
  - our `StopHungRun` sent and answered, with `stopped`.

  The budget is 10 s. The held request is kept for at most 240 s, which is below Bun's limit about 272 s, bc4's OData
  operation timeout (to be read and stated), and Linux's connect give-up at about 127 s. S3's own wait is 60 s, well under all
  of these.
- **M0, validity, before any stop:**
  - S3 is run once with a 240 s budget and no stop: it must take 55-75 s and fail with an HTTP timeout error. A shape that
    fails fast (BC refusing the address, a gateway "unreachable", or a refused `Timeout`) is void, and needs a new
    pre-commitment.
  - Each stop measurement must reproduce the DO symptom: our stop `confirmed`, and no BC answer within 30 s. A shape that is
    answered within 30 s shows nothing about late answers; that is recorded, not counted for A.
- **M1a, under the stop:** S1 and then S3, each once, with the witness after each.
  - **P1:** S1 is answered within 10 s with the 400 form, and its witness row is free.
  - **P2:** S3 is NOT answered within 30 s. It is answered between 45 and 75 s after our stop, after its own HTTP wait has
    ended, and its witness row is free after the answer.
  - The exact text of every answer is recorded.
- **Decision rule** (pre-committed):
  - **A** (P2 holds, with the stop form): the fix is client-side.
    - At baseline only, the request is held longer under a new `--baseline-stop-grace-ms`.
    - Its default is based on the longest native wait it should cover, not on S3's measured time. It goes into R821's
      budget-plus-grace check, which refuses a total above the smaller of `REQUEST_CEILING_MS` and the client's own limit.
    - A late answer on BC 28 (the 408, which names the stop) scores as today's confirmed stop.
    - **On BC 29**, a late 400 is outside today's 10 s `STOP_400_WINDOW_MS`, and its text does not name the stop (R833, R53
      §4.2). Widening that window needs an owner ruling. Even with the ruling, a late 400 scores only if the witness also shows
      the work ended. That witness is a new client-side check, so it gets its own design and tests in the amendment.
    - With no answer by the end of the grace, the run still quarantines (R658).
  - **B** (session gone, no answer) is **not available** from this stage. A session missing from `Active Session` was not shown
    to mean its work ended, and no database-wait shape is measured. It needs S4 and the witness, in its own pre-commitment.
  - **C** (S3's answer never comes, or its witness row stays locked): the quarantine stays. The measurement goes to the owner as
    a BC limit, and the quarantine message names the hung test.
  - Anything else: a new pre-commitment first.
- **Releasing bc4:** only if every shape was answered and every witness row is free. Otherwise the lease is kept, the
  out-of-use marker is written, and the owner is asked through kraken.
- **bc2, for BC 28's 408 form:** after M1a, S3 once on bc2 under its own lease, with the same witness. This is a measurement
  before any bc2 gate leg is pre-committed.
- **What this cannot show:**
  - the third DO hang (no network);
  - an unbounded network wait.

  The chosen design states both gaps. The DO test itself is not rerun, because it hung only intermittently.

## 4. The change (filled in by an amendment after M1; nothing is built before it)
Common to A and B:
- **The test is left out by name,** as today's `baseline-test-stopped`.
- **The mutants that only it covered are not reported as plain `no-coverage`.** The report's `baselineStopped` block already
  names the test. The amendment says, with a test, whether those mutants carry a note.
- **Gates:** `itest:hang` on bc4 (the 400 form) and on bc2 (the 408 form), on the final head, with its existing legs unchanged.
  - **A new baseline leg for the late-answer shape,** pre-committed in the amendment:
    - its duration is at least the budget plus 30 s (so it cannot pass on the old path or on a fast failure; below that is a
      BLOCK);
    - `stopEvidence` is checked for each server form;
    - the witness row is free afterwards.
  - Plus the unit suite, red checks in both directions, and VERIFY.
