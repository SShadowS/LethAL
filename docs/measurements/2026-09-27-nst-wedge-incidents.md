# Business Central server tier (NST) wedges and hangs caused by LethAL work: incident record

Compiled 2026-09-27 from the repository, the coordination notes and the scratch evidence named per
section. Written so the owner can report the platform side (for example to Microsoft). It holds no
customer source code. Object names, test names, byte counts and error text are quoted as recorded.

## Terms used here

- **NST**: the Business Central server tier (Windows service `MicrosoftDynamicsNavServer$BC` inside
  the container).
- **Fenced call**: LethAL runs every test through an OData V4 unbound action on its own control
  extension (`LethAL Control`), for example
  `POST http://<container>:7048/BC/ODataV4/LethALControl_RunMutantWithCoverage?...`. The test runs in
  that OData session (`GuiAllowed = No`, `ClientType = ODataV4`).
- **Wedge**: after the incident the container stopped answering OData (the control app's
  `HarnessInfo` read or the company list timed out), or the NST service itself hung, and only a
  restart brought it back. A restart done only because LethAL's recovery procedure demands one (to be
  sure stranded AL is dead) is NOT counted as a wedge; it is listed separately.
- **In-flight-unknown**: LethAL's own label when a call ended without a readable answer, so it cannot
  know whether BC is still running it. It quarantines the whole run, which is why these incidents
  show up as "0 killed / 0 survived / 0 no-coverage".

Containers: Cronus28, Cronus281, Cronus283, Cronus284, Cronus285 are local Windows Docker BC
containers. Recorded builds: Cronus28 and Cronus284 run application 28.4.53241.53758 (DK)
(`r236b/before-284.txt` for Cronus284; the GH-24 plan and `docs/measurements/README.md` for
Cronus28). The R236 smoke log records "BC version: 28.0.53667.0" for Cronus28 on 2026-09-26
(`r236/before-state.txt`); that it is the platform build beside the 28.4 application is a guess, not
checked. Builds for Cronus281/283/285 at the time of their incidents are not recorded in the sources
read.

Scratch evidence paths are under `C:/Users/SShadowS/AppData/Local/Temp/` and are not committed.

## Summary

| # | Mechanism | Occurrences | Wedges needing a restart | Dates |
| --- | --- | --- | --- | --- |
| 1 | TestPage test through the fenced OData call: reply headers arrive, the tail of the chunked body never does | 26 lost replies recorded (list below) | 4 | 2026-09-18 to 2026-09-27 |
| 2 | TestPage test over a page with real triggers: the call never returns | 4 runs (3 measured hangs, 1 run lost to tooling) | 1 (NST stuck `StopPending`) | 2026-07-31, 2026-08-01 |
| 3 | Non-terminating AL loop inside a fenced call (deliberate, a mutant) | every `itest:hang` OFF leg by design; 1 stop failure | 1 (2026-09-26, stop did not take) | 2026-07-31 onward |
| 4 | Client-aborted OData calls, then the whole OData endpoint stops answering | 1 | 1 | 2026-07-18 |
| 5 | Related, not wedges: stranded operations and a stalled body with a healthy server | 4 | 0 proven | 2026-07-25 to 2026-09-02 |

---

## 1. TestPage baseline call: truncated reply, sometimes followed by an OData wedge

### What we sent

The baseline run of `fixtures/sandbox-data-tests` (68 tests). The 22nd is
`Data Tests.PageActionComputesNonZero`, which does `TestPage "Data Value Card"`: `OpenView()`,
invoke action `Compute`, read a field, `Close()`. It goes through
`LethALControl_RunMutantWithCoverage` (a single call, one test, code coverage on). In this fenced
session the platform refuses TestPage, so the correct answer is a `fail` whose message carries
`System.NotSupportedException: Specified method is not supported. at
Microsoft.Dynamics.Nav.Runtime.NavSession.CreateNavTestService()` and its CLR callstack. A clean
answer is 6616 to 6618 bytes, the only answer above 2.9 KB in the suite.

### What the server did (MEASURED)

From `docs/superpowers/specs/2026-09-26-r236-rate-precommitment.md` (D3, OUTCOME O4 to O8):

- HTTP 200, `Transfer-Encoding: chunked`, no `Content-Length`. Headers arrive, most of the body
  arrives, then the body stops.
- Two endings: the client's 120 s timer fires while the body read stalls (body stops 73 to 116 bytes
  short), or the socket is closed about 27 to 31 s after dispatch (body lacks only the final `}` of
  the OData envelope, 1 byte).
- Bytes received on the 8 Cronus284 hits: 6528, 6536, 6530, 6544, 6616, 6642, 6533, 6533. On the 4
  traced Cronus28 hits: 6534, 6641, 6528, 6534. No cut is on a 4096 or 8192 boundary, none falls
  inside the callstack text.
- Headers are late on every hit: 606 ms or more on Cronus284 (clean answers: 543 ms at most, median
  320 ms).
- In 7 of 8 Cronus284 hits the control app's own operation record says the test finished (`done`):
  the AL completed and built its whole answer; only delivery failed. The 8th could not be read: both
  status reads timed out while the Application event log showed Id 705 warnings, "Request was
  throttled. It either timed-out or was cancelled.The OData operation was canceled by the user.",
  `"Max Active Request Count": "100","Requests running": "5","Requests waiting": "8"`.
- Only this call breaks: 0 of the other tests' calls failed (3894 `RunMutant*` calls in the arm
  files).
- Afterwards the container sometimes stops answering OData (`HarnessInfo unreachable`), which needs
  a restart.

### Occurrences

| Date | Container | Control app | Run | Lost replies | Ending | Wedge? | Recovery | Evidence |
| --- | --- | --- | --- | --: | --- | --- | --- | --- |
| 2026-09-18 | Cronus285 (fresh) | 1.0.0.18 | first `itest:tables` | 1 | not recorded | no | none; next run passed | `docs/roadmap/R225.md` |
| 2026-09-26 | Cronus28 | not recorded | first `itest:tables` on `da35dd8` | 1 | not recorded | no | none; next runs passed | `docs/roadmap/R236.md` |
| 2026-09-26 afternoon | Cronus28 | 1.0.0.19 | `itest:chunked` control leg, again after a restart, then `itest:tables` | 3 | not recorded | no | none (each passed on retry) | `R236.md` |
| 2026-09-26 | Cronus28 | 1.0.0.19 | GH-24 lane gate runs | 2 | not recorded | no | none (passed on retry) | `R236.md` |
| 2026-09-26 18:39 to 19:06 | Cronus28 | 1.0.0.19 | R236 smokes (probe) | 6 of 7 sessions | 4 timer (120 s), 2 socket close (27.1 s, 27.8 s) | **2** of 5 followed by a preflight | `Restart-BcContainer` 18:43 to 18:49 and 19:00 to 19:06, then force-reset-lease and clear-quarantine | spec D3; `r236/log.txt` |
| 2026-09-26 19:31 to 20:29 | Cronus284 | 1.0.0.19 | R236 rate arms (probe) | 8 (6 of 60 counted, 2 of 3 warm-up) | 6 timer, 2 socket close (30.8 s, 27.8 s) | **1** of 8 (after B'1 #10) | `Restart-BcContainer` 19:58, healthy 20:03:59 | spec OUTCOME O1, O5, O8 |
| 2026-09-27 ~11:40 | Cronus28 | 1.0.0.19 | orchestrator `itest:tables` x2 | 2 | socket close: "RunMutant 2xx body could not be read: Error: The socket connection was closed unexpectedly" | not tested | none recorded | orchestrator scratch `gh24-run1.log`, `gh24-run1b.log`; `H:/lethal-coord/handoff/lethal-orchestrator.md` |
| 2026-09-27 ~11:48 | Cronus284 | 1.0.0.19 | orchestrator `itest:tables` | 1 | "RunMutant timed out after headers: AbortError" | no (used cleanly at 13:47) | none | `gh24-c284-run1.log` |
| 2026-09-27 ~12:13 | Cronus28 | 1.0.0.19 | orchestrator `itest:tables` | 1 | "RunMutant timed out after headers: AbortError" | **no**: `itest:bcdev` passed 3/12/4 right after | none | `gh24-run1c.log`, `r236-bcdev-check.log` |
| 2026-09-27 ~13:50 | Cronus284 | 1.0.0.19 | R236b prep session (probe) | 1 | headers 772 ms, 6616 bytes, socket close ~26.6 s | **yes** | owner recovery (method not recorded); afterwards an orphaned LethAL lease remained | `U:/Git/LethAL-wt/lane-bugs/.superpowers/sdd/2026-09-27-R-236b-testpage-reply-fix/task-3-report.md`; `H:/lethal-coord/questions/q-20260927T120229-ef48a407*.md` |

Totals: 26 lost replies over 10 days on 3 containers. Wedges: 4 (Cronus28 2 of 5 hits checked,
Cronus284 1 of 8 on 2026-09-26 and 1 of 1 on 2026-09-27). The 2026-09-27 Cronus284 wedge: both
`GetOperationStatus` reads timed out, `LethALControl_RegisteredArtifact` failed after about
5 minutes, `HarnessInfo unreachable: AbortError: The operation was aborted.`, and RenewLease got
HTTP 503 twice.

Rate by container differs sharply and is not explained: Cronus28 smokes 6 of 7 sessions, Cronus284
6 of 60 counted sessions (`docs/roadmap/R263.md`). On 2026-09-27 it was 4 of 4 `itest:tables` runs
across both containers.

### Hypotheses (NOT measured)

- The platform loses the last bytes of a large chunked OData response when the action's answer
  carries a CLR exception from `CreateNavTestService`. Answer size, "opens a TestPage" and "carries a
  CLR exception" always vary together here, so none is isolated.
- Which side drops the bytes (server send or client read) is not known; the pre-committed test for it
  (D6) did not decide.
- The wedge might be the OData request pool filling (the Id 705 throttling warnings), but that was
  seen on only one hit.
- Container age, resident apps, uptime and keep-alive socket reuse are open candidates for the rate
  difference (R263).

### Reproduction for a bug report

1. BC 28.4 container (DK), an extension exposing a codeunit as an OData V4 web service with an
   action that runs one test method through a test runner codeunit (`Codeunit.Run`) and returns a JSON
   `Text` of about 6.6 KB. Our case: `LethAL Control` 1.0.0.19 and the `LethAL Sandbox Data` /
   `LethAL Sandbox Data Tests` 1.0.0.18 fixture apps.
2. The test method opens a `TestPage` on a card page, invokes one page action and closes it. In the
   OData session this raises `NotSupportedException` at `NavSession.CreateNavTestService()`; the
   action catches it and returns it (with the CLR callstack) in its answer.
3. Call the action with basic auth over HTTP (`POST .../ODataV4/<Service>_<Action>?...`), keep-alive
   on, 120 s client timeout, after running ~21 short tests through the same action.
4. Repeat for 10 to 60 sessions. Expected: always a complete 200 body. Observed: on some calls,
   headers after 600+ ms, then the body stops 1 to 116 bytes short of the end; the client times out
   or the socket closes at ~27 to 31 s. Afterwards, check `$metadata` or any action: on some
   containers the OData endpoint no longer answers until the container is restarted.
5. Scripted probe: `scripts/r236-baseline-probe/probe.ts` (records headers time, bytes received and
   the partial body per call).

---

## 2. TestPage over a page with real triggers: the call never returns, NST stuck `StopPending`

### What we sent

A baseline test `PageExtCountsMatchingRelated` in `fixtures/sandbox-data-tests` that opens
`TestPage "Data Main List"`. The page's source table has triggers and a FlowField, and a
`pageextension "Data Main List Ext"` writes a row from `OnOpenPage`. Same fenced single call as in
section 1. Control app 1.0.0.13 on Cronus283 (2026-08-01).

A control on a code-free list page (`fixtures/sandbox-probes`) did NOT hang: the fenced session
refused it in 87 ms with the `CreateNavTestService` error (Cronus281, 2026-07-31, `docs/roadmap/R069.md`).

### What the server did (MEASURED)

| Date | Container | Result | NST state after | Recovery | Evidence |
| --- | --- | --- | --- | --- | --- |
| 2026-07-31 | Cronus283 | a TestPage test (`OpenView(); Close();` on `Data Main List`) never returned; run quarantined | not recorded | force-reset-lease (no restart recorded) | `docs/roadmap/R069.md` |
| 2026-08-01 run 1 | Cronus283 | never returned; whole 84-mutant run quarantined | `MicrosoftDynamicsNavServer$BC` stuck **`StopPending`**; `Restart-BcContainerServiceTier` itself timed out ("Time out has expired and the operation has not been completed") | `docker restart Cronus283` (healthy in 30 s), then force-reset-lease | `.superpowers/sdd/2026-08-01-r69-phase2-batch-runner/task-7-report.md` |
| 2026-08-01 run 2 | Cronus283 | identical, same test | `Running` | force-reset-lease only | same |
| 2026-08-01, with `--stop-hung-sessions` | Cronus283 | one run lost to a tooling fault (not an observation); one clean run: still quarantined, resolved in ~34 s instead of never | `Running` | force-reset-lease and clear-quarantine, no restart | `.superpowers/sdd/2026-08-01-r69-phase2-batch-runner/r76-containment-report.md` |

The test was then removed from the fixture; it survives only as a comment.

### Hypotheses (NOT measured)

Why this page hangs when a code-free page is refused in 87 ms is not known: the difference is the
page's triggers, FlowField and the writing `OnOpenPage` in a page extension. Whether the hang and the
`StopPending` state are one bug is not known (n = 1 for `StopPending`).

### Reproduction for a bug report

1. BC 28 container, an OData V4 web-service action that runs a test method in its own session.
2. Test method: open a `TestPage` on a list page whose source table has `OnModify`/`OnValidate`
   triggers and a FlowField, with a page extension whose `OnOpenPage` inserts a row in another table.
3. Call the action. Observed: no response; the NST can end up `StopPending` and
   `Restart-BcContainerServiceTier` times out; only a Docker restart recovers. The same call on a
   code-free page returns in under 100 ms with `NotSupportedException` at
   `NavSession.CreateNavTestService()`.

---

## 3. A non-terminating AL loop inside a fenced call

### What we sent

`fixtures/sandbox-hang` (`HangLogic` codeunit): `repeat Advance(); until Counter >= Limit;` and
similar loops. A mutant deletes `Advance();` or empties the body, so the loop never ends. It runs
inside a fenced `RunMutant` call. With `--stop-hung-sessions`, LethAL holds the request open at the
budget and calls `LethALControl_StopHungRun` on a second connection, which uses AL `StopSession` on
the stuck session; BC then answers the held request with HTTP 408 naming the `StopSession` call.
Without the flag, the client aborts and LethAL quarantines.

### What the server did (MEASURED)

- 2026-07-31, Cronus281, `itest:hang` first proof (`docs/roadmap/R053.md`): ON leg, both hangs
  stopped, 408 received ("stopped the session (ID: 33) ... by an AL StopSession call", 20098 ms on a
  20000 ms budget). OFF leg: client abort, operation marker stranded; recovery was the §8 procedure
  (NST restart, force-reset-lease, clear-quarantine). The AL session did NOT survive the client abort
  (container idle at 0.05% CPU afterwards). This restart was procedural, not a wedge.
- Every `itest:hang` OFF leg strands a marker by design; the gate's teardown force-resets it. The
  orchestrator handoff says "its OFF leg leaves a live loop" and runs the gate last. That claim is
  NOT measured in any source read, and it disagrees with the 2026-07-31 CPU observation above.
- **2026-09-26, Cronus28, control app 1.0.0.19, merged GH-24 tree `5b9e12a`: wedge.** The ON leg
  failed to stop mutant M0004 (`void-method-call`, `HangLogic` line 37). Afterwards `HarnessInfo`
  and the company list timed out (`lethal doctor` FAIL) and one BC session had been open since
  12:31:48Z. The owner ran `/recover-tier`: `Restart-BcContainer Cronus28`, force-reset-lease
  (generation c85a799e to 7f2f59b6, epoch 707), clear-quarantine; doctor all ok. The same source
  passed the gate three times in the lane before and after; it did not recur.
  Evidence: `H:/lethal-coord/questions/q-20260926T123719-78196b89.md` and `.answer.md`.
- Hosted relative (not an NST we control): on a Continia hosted BC 28 DK sandbox, a
  non-terminating Document Output mutant (M0013) outlived 180 s and 330 s budgets; the hosting proxy
  ends requests at about 360 s (R53, R44). Stranded operations followed (2026-07-27, 2026-08-04),
  recovered with force-reset-lease; see section 5.

### Hypotheses (NOT measured)

Why `StopSession` did not end the looping session on 2026-09-26, and whether the stuck session is
what blocked OData, is not known (one occurrence, not reproduced).

### Reproduction for a bug report

1. OData V4 action A runs a test that loops forever (`repeat until false`-style, no database I/O).
2. After 20 s, from a second connection, action B calls `StopSession(<A's session id>)`.
3. Expected: A's request ends with 408 (this is what we normally see). Observed once: A was not
   stopped, the session stayed open, and OData stopped answering until a container restart.
4. Gate: `LETHAL_ITEST_HANG=1 bun run itest:hang` (fixture `fixtures/sandbox-hang`).

---

## 4. OData endpoint stops answering after client-aborted calls (2026-07-18)

### What we sent

Early development (`.superpowers/sdd/bcdev-integration-fixes-report.md`, 2026-07-18). While testing
parameter names on the then control codeunit's `MutationControl_SetActive` action on Cronus28 (then
a separate host), one call was aborted by the client after about 90 s while it apparently still ran
on the server. Further calls followed.

### What the server did (MEASURED)

From then on every OData call hung, including `GET /ODataV4/$metadata`, which touches no table.
`SetActive` hung 25 s, `ClearActive` 15 s, `$metadata` 15 s, each with no response. The dev
endpoint (port 7049) stayed healthy throughout; waited 40+ minutes, no recovery. Recovery needed an
NST restart.

### Hypothesis (NOT measured)

Each client-aborted call left a server-side web-service session running, and the finite pool of
OData sessions filled, so new requests queued forever.

### Reproduction for a bug report

Call an OData V4 action that runs for longer than the client's timeout, abort client-side, repeat a
few times, then call `$metadata`. Observed: `$metadata` hangs while the dev endpoint answers.

---

## 5. Related incidents that are not proven server wedges

| Date | Container | What happened | Recovery | Evidence |
| --- | --- | --- | --- | --- |
| ~2026-07-25 | Cronus281 | a `RunMutant` call hit LethAL's client timeout (AbortError) mid-gate; the operation could not be confirmed complete; next session refused `operation-orphaned` | `Restart-BcContainerServiceTier` (procedural), force-reset-lease (first attempt HTTP 503 while the NST started) | `.superpowers/sdd/progress-6a-archived.md` |
| 2026-07-27 | Continia hosted sandbox | Document Output mutant outlived its budget, BC kept running it, operation stranded | force-reset-lease after a LethAL URL fix | `docs/roadmap/R051.md` |
| 2026-08-04 | Continia hosted sandbox | two `void-method-call` mutants deleting a `SetCurrentKey` (slow scan, not a hang) stranded despite `--stop-hung-sessions` | recover-tier, `--resume` | `docs/roadmap/R089.md`, `.superpowers/sdd/2026-08-03-do-live-campaign/progress.md` |
| 2026-09-02 | Cronus28 | Document Output baseline test `CDO Aut Stat Bal Check Tests.LegacySystem_CustomerWithBalance_ShouldCreateJournalLine`: headers at ~2.8 s, then the body read stalled ~272 s ("RunMutant 2xx body could not be read: TimeoutError") | none needed: no lingering session, no event-log error | `docs/roadmap/R191.md` |

The 2026-09-02 case has the same outward shape as section 1 (headers, then a stalled body) on a
different test. R191 guesses an outbound HTTP call from Continia Core waiting on a network the
container lacks; not measured.

## What is not in this record

- LethAL's own defects that left lease state stuck without any server fault (for example the
  truncated-id marker bug in `.superpowers/sdd/progress-5cb1-archived.md`) are excluded.
- For section 1 the first 2026-09-18 and 2026-09-26 occurrences left no byte counts; they are counted
  as lost replies by their quarantine reason only.
