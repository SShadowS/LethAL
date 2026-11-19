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

## Amendment 1 (2026-11-19): the first stage measured nothing; the second stage, pre-committed before it runs
**The owner's answers:**
- q-20261119T043331-68d01347 allowed the probe on bc4.
- q-20261119T044508-116185f0 ruled, for branch A on BC 29: a late 400 counts as a confirmed stop **only** when the independent
  lock witness shows the work ended. Each such stop records its delay per test and is labelled `late-confirmed` in the report.
  R833's 10 s window stays for everything without a witness.

**Stage 1 (bc4, lease attempt 075, probe v1.0.0.0; evidence `/coord/handoff/PR-199/m1a.log`, `S1/`):**
- **M0 is VOID.** `HttpWaitOnly` to `http://10.255.255.1/` returned "failed" with an empty error text after **181 ms**: BC does
  not wait on that address. The review predicted this (PR-176 saw BC refuse a loopback address at once). S3 was not run, as
  the rule says.
- **S1 measured nothing.** It failed in 274 ms with "Sorry, the current permissions prevented the action. (TableData 76150 P199
  Witness Insert ...)": the test runner's restrictive permissions. The loop never ran, and no stop was sent. Its witness read
  "free: no row", which shows nothing, because the row never existed.
- No conclusion is drawn from stage 1.

**Stage 2, probe v1.0.0.1** (`/coord/handoff/PR-199/probe/`, `alc` 0 errors):
- **Permissions:** the probe codeunits get explicit `Permissions` on the witness and setting tables.
- **Seeding:** each shape's witness row is seeded and committed (`SeedWitness`) before the shape runs, so the test locks an
  EXISTING row. The witness then reads `free: counter N`. If the lock is still held, it fails on BC's lock timeout.
- **S3's URL** comes from a setting (`SetUrl`), and M0 tries candidates **in this order**, each `HttpWaitOnly(url, 60000)`
  with no stop. The first that takes 55-75 s is used for S3:
  - C2: `http://192.0.2.1/` (TEST-NET-1, never routed);
  - C3: `http://1.1.1.1:81/` (a public host, a port that is not served);
  - C4: `http://example.com:81/`.

  Each candidate's time and text are recorded. If none waits, S3 is not measurable from bc4. That is recorded, and the stage
  ends with S1 alone.
- **S1:** after `SeedWitness('S1')`, under the stop, then the witness.
- **P1 is unchanged:** answered within 10 s with the 400 form, and the witness free.
- **S3** (if M0 found a URL): after `SeedWitness('S3')`, under the stop, then the witness.
  - **P2:** no answer within 30 s; an answer between 45 and 75 s after our stop; the witness free after it.
- **The decision rule is §3's,** with the owner's ruling above for BC 29.

## Amendment 2 (2026-11-19): stage 2's results, and where fix 3 goes from here
bc4 was restarted (q-20261119T083334-eb8233a8) and restored first: setup with LethAL Control 1.0.0.28, the Continia stack, DO and
DO Test, then doctor ok. The run used lease attempt 075 throughout. Evidence: `/coord/handoff/PR-199/m1b.log`, `m1c.log`,
`v2-S1/`, `v3-S1/`, `restore/`.

**M0: no candidate waits.** Each `HttpWaitOnly(url, 60000)` returned "failed" with an empty error text:

| candidate | time to fail |
|---|---|
| C2 `http://192.0.2.1/` | 204 ms |
| C3 `http://1.1.1.1:81/` | 55 ms |
| C4 `http://example.com:81/` | 48 ms |

- Stage 1 had already shown the same for `10.255.255.1` (181 ms).
- **From bc4, an outbound HTTP call does not wait: it fails at once.** S3 is not measurable there, as the amendment allowed.
- **A consequence for R1113:** on bc4, DO's Azure tests cannot have hung on a network wait either.

**S1 (the AL loop):**
- **Probe v1.0.0.1 was again refused by test permissions,** this time on an indirect read. The test runner's restrictive
  permissions ignore the probe codeunit's own `Permissions`.
- **v1.0.0.2** sets `TestPermissions = Disabled` on the probe's test codeunit. That is a probe defect, not a change to what is
  measured.
- **With it, P1 HELD:**
  1. our `StopHungRun` was sent at 10.0 s and answered `stopped: true` (session 539) in 167 ms;
  2. BC answered the held request **253 ms after the stop**, with the 400 "begin transaction world not called";
  3. the verdict was `timeout`, classified `baseline-test-stopped`, and the run went on;
  4. the witness then read **"free: counter 2"**: the lock was released, so the hung session's work ended.

**What the rule decides:**
- **A:** no evidence. No shape answered late, and no HTTP wait can be made on bc4.
- **B:** stays ruled out (§3).
- **C:** no session was seen alive.

**So no change to LethAL's stop or confirmation is justified by this measurement.**

**Where fix 3 goes instead.** PR-200's company-creation probe on bc4, on the same day, found the likelier cause of DO's baseline
quarantines (`/coord/handoff/PR-200/bc4/result.md`):
- a test that creates a company, commits, deletes it and commits (T3) got an unprompted BC 400 "begin transaction world not
  called", and the run was quarantined;
- from then on, every web-service call was 401, and bc4 needed a restart;
- DO's hung tests create companies, and two of them commit.

Fix 3 therefore continues in the company-writes work, preproc's PR-212, not here. PR-199 is submitted as this measurement,
with no code change.
