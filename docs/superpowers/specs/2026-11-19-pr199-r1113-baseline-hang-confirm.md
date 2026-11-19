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

## 3. Measurement M1 (bc4, BC 29, under lethal-code's lease; owner question q-20261119T043331-68d01347; nothing runs before a yes)
- **The probe pair** (`/coord/handoff/PR-199/probe/`, scratch ids 76150-76199, checked free first; invented code). One test
  codeunit, each test alone at baseline:
  - **S1 `LoopsForever`:** an AL loop bounded at 15 min. This is the control: the hang gate's shape.
  - **S2 `HttpBlackhole`:** `HttpClient.Get` to a non-routable address (`http://10.255.255.1/`) with
    `HttpClient.Timeout := 900000`, so only the network wait holds it.
  - **S3 `HttpDefaultTimeout`:** the same call with BC's default timeout.
- **The driver** (`/coord/handoff/PR-199/drive.ts`) calls LethAL's own transport (`run` with `timeoutMs` 10 s), so the stop is
  LethAL's real `StopHungRun`, with `stopGraceMs` raised to 900 s for this measurement only. For each shape it records:
  - when the stop was confirmed by our side;
  - when BC answered the held request, and with what status and text (or none by 900 s);
  - whether the hung session is still in `Active Session` at the answer and at 900 s. That is read through the bc-dev MCP's
    data tools, or a probe web-service read, by session id;
  - afterwards: a control-app lease acquire and release, and one trivial `RunMutant`. This tells whether the server is healthy
    or needs the owner's restart.
- **Predictions:**
  - **P1:** S1 is answered within 10 s with the 400 form, the session is gone, and the server is healthy.
  - **P2:** S3 is answered later than 30 s but within about 130 s (BC's default HTTP timeout, plus margin), with the session gone
    by then.
  - **P3:** S2 is either answered only after the 900 s client timeout, or not by 900 s.
- **Decision rule** (pre-committed; the design that follows is chosen by M1, not by preference):
  - **A: every non-answered shape is answered later, with the stop form, and the session is then gone.** The fix is
    client-side: at baseline only, hold the request longer for BC's answer, under a new `--baseline-stop-grace-ms`. Its default
    is chosen from the measured times and stated with them. A late answer then scores as today's confirmed stop
    (`baseline-test-stopped`), and the run goes on. The R658 rule is unchanged: no answer by the end of the grace still
    quarantines.
  - **B: a shape gets no answer, but its session is provably gone** (not in `Active Session`) and the server is healthy. The fix
    adds a second form of confirmation: the control app reports whether that session id is still alive (a new read-only action,
    so a control-app version, folded into PR-196's 1.0.0.28 only if both are ready together). "Gone" then confirms the stop. A
    session that is still alive keeps the quarantine.
  - **C: a session stays alive.** The quarantine stays (R658). Fix 3 then names the hung test and its shape in the quarantine
    message, which fix 1's recovery steps already partly do. The underlying cause goes to the owner as a BC limit, with the
    measurement.
  - If M1 shows something none of these covers, a new pre-commitment comes first.
- **What M1 cannot show:** the third DO hang (no network) may be a database wait or something else. M1 does not reproduce it.
  The DO test itself is not rerun, because it hung only intermittently. The chosen design is judged on S1-S3 only, and says so.

## 4. The change (filled in by an amendment after M1; nothing is built before it)
Common to A and B:
- **The test is left out by name,** as today's `baseline-test-stopped`.
- **The mutants that only it covered are not reported as plain `no-coverage`.** The report's `baselineStopped` block already
  names the test. The amendment says, with a test, whether those mutants carry a note.
- **Gates:** `itest:hang` on bc4 (the 400 form) and on bc2 (the 408 form), on the final head, with its existing legs unchanged
  and a new baseline leg for the measured late-answer shape, pre-committed in the amendment. Plus the unit suite, red checks
  in both directions, and VERIFY.
