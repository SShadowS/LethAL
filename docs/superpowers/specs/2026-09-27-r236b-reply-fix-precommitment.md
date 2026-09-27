# R236b: TestPage reply-fix, non-TestPage arm and acceptance pre-commitment

Task: R236 / R236b (the lost RunMutant reply on the TestPage baseline test, `PageActionComputesNonZero`).
Plan: `docs/superpowers/plans/2026-09-27-R-236b-testpage-reply-fix.md`.

Committed before any live run. Nothing above the `## §OUTCOME` line changes after that.

## §A1 Facts before any run

Source for all seven facts: `docs/superpowers/plans/2026-09-27-R-236b-testpage-reply-fix.md`, section
`## The mechanism, from evidence already in hand`. That section states its own source: every fact is from
the committed OUTCOME or from the scratch NDJSON it was tabulated from,
`C:/Users/SShadowS/AppData/Local/Temp/r236/{A1,A2,Bp1,Bp2,restore-check}.ndjson`, re-read on 2026-09-27.

1. **Only the end of the answer is lost, after the AL had built all of it.** All 8 broken calls got `200`
   headers, `Transfer-Encoding: chunked`, then most of the body. The six timer cases lack 73 to 116 bytes;
   the two socket-close cases lack ONLY the envelope's final `}`, and their partial bodies already carry
   `coverageRunMs` and `coverageSerializeMs`, which `RunMutantWithCoverage` computes after `RunMutant`,
   `StopApplicationCoverage` and `CoverageArray` (O6). AL returns the answer as one `Text`; the platform
   writes it out afterwards.
2. **The fence completed in 7 of 8; the 8th could not be read** (both status reads timed out under BC
   OData throttling, event 705) (O4).
3. **Always this one call.** 7 broken calls in 3 894 `RunMutant*` calls in those files (8 with the warm-up
   session), all on `PageActionComputesNonZero`; no other call broke (O4 and the re-read).
4. **Confounded with answer size, and more.** Re-read 2026-09-27: the TestPage call's clean answer is
   6 616 to 6 618 bytes; the largest clean answer of the other 67 tests is 2 872 to 2 874 bytes
   (`ExtCountRelatedIgnoresDecoys`). The TestPage answer is the only one above 2.9 KB (it carries the
   platform's CLR callstack). Every observation so far varies "opens a TestPage", "answer above ~3 KB" and
   "carries a CLR exception" together.
5. **Hits start late.** Every hit's headers arrived at 606 ms or later; every clean answer's by 543 ms (O5).
6. **Who drops the bytes is not known** (D6, O6).
7. **Hits can wedge the server.** 1 of 8 hits on Cronus284 and 2 of 5 on Cronus28 were followed by a failed
   `HarnessInfo` preflight (O8, D3).

These seven facts were re-read on 2026-09-27, as the plan section states.

## §A2 The non-TestPage arm (Cronus284, control app 1.0.0.19, client at HEAD)

Arms alternating in one loop under one probe lease: **T** = `Data Tests.PageActionComputesNonZero` with
coverage filter `79300..79399`; **S** = `Data Tests.ExtCountRelatedIgnoresDecoys` (passes; clean answer
2.9 KB) with a widened coverage filter chosen by calibration.

Calibration (not counted): try, in order, `79300..79399|130000..130499`, `79300..79399|130000..139999`,
`79300..79399|1..99999`; take the FIRST whose S answer is at least 6 617 bytes and whose call finishes
within 10 s. None qualifies: S is "not runnable".

Planned: 60 pairs (T then S). A **break** is a call that failed after dispatch: trace `errorPhase` `"body"`
or `"fetch"`.

After every break: one `GetOperationStatus` read and one `HarnessInfo` preflight. A failed preflight is a
wedge: the loop stops, `coord ask` the owner. No restart.

**Reading, first match wins:**

1. **grouped fix required**: S has at least ONE break, OR S was not runnable, OR fewer than 60 pairs
   completed with zero S breaks (an incomplete arm cannot clear the grouped path).
2. **grouped fix not required by this task**: all 60 pairs completed and S has zero breaks.

Neither reading is a root-cause statement, and neither closes or narrows R236. Stated limits: a direct loop
is not a session; S differs from T in more than size.

## §C Acceptance (Phase C)

- **C1, lost-body case, probe on Cronus284, control app 1.0.0.20, client at the fix commit.**
  `scripts/r236-baseline-probe/probe.ts --only src/DataValueSource.Codeunit.al` (as in the rate spec), 30
  counted sessions under the rate spec's D2 warm-up rule. A **recovered lost body** is a session whose
  TestPage call trace has `errorPhase` `"body"` AND a `lost-reply-recovered` warning names
  `PageActionComputesNonZero`.
  - P1: zero sessions quarantined with a reason containing `baseline test in-flight-unknown running
    PageActionComputesNonZero`, EXCEPT where the quarantine detail carries an `answer readback` reason
    that this plan's rule requires to fail closed; each such case is listed and FAILS P1 unless the owner
    rules it expected.
  - P2: for every recovered lost body, the trace shows headers then an INCOMPLETE body: `errorPhase`
    `"body"` and no `bodyEndAt` (no fixed byte threshold: measured broken replies ran to 6 616 and 6 642
    bytes, O6); where the probe captured the partial bytes, they are recorded beside that call's read-back
    answer for the OUTCOME. The recorded TestPage baseline row is `fail`, its text matches
    `describeTestPageUnsupported` (`CreateNavTestService`), and the session then records all 68 baseline
    rows.
  - P3: at least 3 recovered lost bodies among counted sessions. Fewer: 30 more counted sessions; still
    fewer than 3: the lost-body case is not exercised, acceptance FAILS.
  - Every other quarantine and every wedge is listed with its reason. A wedge ends the run (`coord ask`).
- **C1b, clean failing-TestPage write/read, Cronus284.** `size-arm.ts --kept-check 10` (Task 8): 10 direct
  TestPage calls. For every call whose body arrived whole, `GetOpAnswer` returns `found: true` and its
  `answer` is byte-equal to the body's inner `value`, and the transport verdict is `fail` with
  `CreateNavTestService`. Any mismatch FAILS acceptance. A lost body during C1b is recorded and counted
  with C1's recovered lost bodies.
- **C2, gates on Cronus28, control app 1.0.0.20.** `itest:hang`, `itest:bcdev` (including Task 8's pins),
  `itest:chunked`, each once and as frozen. `itest:tables`: GH-24's two-run procedure (its OUTCOME "Run
  order"), repeated until 3 consecutive rounds pass, at most 6 rounds. The 3-in-a-row is an operational
  hurdle, NOT a reliability claim: EVERY round, passing or failing, is reported with its reason. Per round,
  run 1 (committed baseline kept) is the authority for the 377 existing mutants: it must stop in
  `assertMatchesBaseline` with exactly ten "present in after but missing from before" differences, all
  `Data Reach Ops`, and zero field differences. Run 2 (scratch baseline) must pass end to end, and Task
  11's check of the ten reach mutants must print `GH-24 section 3 OK`.
- **If §A2 read "grouped fix required":** acceptance also requires Task 6b landed, its unit tests and
  red-checks green, and C2 run with it.
- **Write cost (reported, no threshold):** C1's median baseline `durationMs` over the 67 non-TestPage
  tests against the same statistic from the rate spec's arms A1 and A2 (same probe, same container); each
  gate's wall time against its last pre-fix run where one is recorded.

## §OUTCOME

### §A2 read-out (2026-09-27, Cronus284)

**Reading: grouped fix required.** This is the pre-committed DEFAULT from rule 1 (an incomplete arm
cannot clear the grouped path), reached because a wedge stopped the run before the arm started. It is not
a measurement of the grouped path, and it is not a root-cause statement. R236 is neither closed nor
narrowed.

- Lease: `coord lease Cronus284 bugs`, attempt `005`, heartbeated, released after the wedge.
- Before: `LethAL Control` 1.0.0.19 installed on Cronus284. The control app was not published.
- Prep session (`probe.ts --arm a2-prep --sessions 1`, client `81b5add`): record `container` `Cronus284`.
  It was a hit. The `PageActionComputesNonZero` call (attempt `a22`, opSeq 8761) got `200` headers at
  772 ms, chunked, then the body broke at 6 616 bytes on a socket close (`errorPhase` `"body"`, about
  26.6 s after dispatch). Both op status reads timed out (at 0 ms and 45 032 ms); `actionEnd` `unproven`;
  the session was quarantined. RenewLease returned HTTP 503 twice.
- Wedge: afterwards `HarnessInfo` was unreachable (`AbortError`) and `LethALControl_RegisteredArtifact`
  timed out. Cronus284 did not answer OData. No restart was done; the owner was asked
  (`q-20260927T120229-ef48a407`).
- The arm: calibration never ran and the loop never ran. T: 0 breaks over n = 0. S: 0 breaks over n = 0.
  pairsDone 0 of 60. No break bytes, headers times or op statuses to report.
- Orchestrator ruling: §A2 is NOT re-run.
- Size-arm defect found: a wedge before calibration (its first read, `odataReadRegisteredArtifact`,
  timing out with a `DOMException`) exits 2 ("harness fault") with an empty message, instead of 3 (wedge).

### Task 9 Step 1 and an INVALID C1b attempt (2026-09-27, Cronus284)

- Lease: `coord lease Cronus284 bugs`, attempt `007`, heartbeated, released after the attempt.
- Orphaned LethAL lease (holder `SShadowS-PC:18460:1`, expired 11:48:57Z): Windows process 18460 did not
  exist. The lane client's `force-reset-lease` refused, because its `MIN_CONTROL_VERSION` 1.0.0.20 check
  rejected the installed 1.0.0.19. The reset was done with the main checkout's client (`bde825c`,
  minimum 1.0.0.19), same flags, the lane config: serverGeneration `0305a098...` -> `c78d51e7...`,
  epoch -> 371. The epoch before is not exposed by any non-mutating read.
- Publish: `LethAL_LethAL Control_1.0.0.20.app` from the lane worktree, `-sync -upgrade`, succeeded;
  1.0.0.20 installed, 1.0.0.19 not installed. Doctor then exit 0 (control-version and lease ok).
- **INVALID C1b attempt.** `size-arm.ts --kept-check 10` was run WITHOUT the prescribed prep session, on
  the artifact already registered. It is not a C1b result either way. Facts:
  - Call 1: `whole` false, `deadline-exceeded`, `in-flight-unknown`, `replyRecovered` null. Orchestrator
    reading: a before-headers deadline on the R225 cold path (the first TestPage call after a fresh
    publish), which the fix correctly leaves alone.
  - Call 2: no record. About 15.5 s after call 1's record the script died with exit 2,
    `harness fault: abort@[native code]`: the kept-answer read's 15 s abort escaped the script
    uncaught. Fixed in `8706a34` and `3f83605` (a failed readback now counts as bad, exit 1, and every
    call is traced from its original action).
  - Doctor right after: all ok, no lease held. No wedge.

### Second C1b run, after owner recovery (2026-09-27, Cronus284, control app 1.0.0.20)

- Lease: `coord lease Cronus284 bugs`, attempt `008`, token `e70f6ade-7eab-400a-a0bc-fea2f5c4e682`,
  heartbeated, released; `coord holder Cronus284` returned `null` afterward.
- Precheck (13:35Z): doctor all ok, `HarnessInfo` semver `1.0.0.20`, no lease held, generation
  `c78d51e7...`. `Get-NAVServerSession` showed one session only (the check's own, 13:35:35): no leftover
  from the invalid attempt.
- c1-prep session (`probe.ts --arm c1-prep --sessions 1`): exit 0, no hit, 0 broken call(s).
- C1b (`size-arm.ts --kept-check 10`), exit 0, summary `{"calls":10,"bad":0,"lostBodies":1,"notWhole":10}`:
  - Call 1: `whole` false, `deadline-exceeded`, `in-flight-unknown`, `replyRecovered` null,
    `recoveryReadback` true, `headersMs` 681, `bytesReceived` 6539, `errorPhase` `body`. A REAL lost body:
    200 headers at 681 ms, 6 539 bytes, then the body broke. The client's readback of the kept answer was
    attempted and did NOT recover it (`replyRecovered` null).
  - Calls 2 to 10: `whole` false, `deadline-exceeded`, `in-flight-unknown`, `replyRecovered` null,
    `recoveryReadback` true, `errorPhase` `fetch` (no headers).
  - Exit 0 was VACUOUS under the pre-fix rule: zero calls arrived whole, so the byte-equality check never
    ran once. Under the rule added for Task 9 Step 2 (`keptCheckVerdict`, `scripts/r236-baseline-probe/size-arm.ts`,
    commit `d635c3f`), this run reads NOT MEASURED, not a pass.
- Wedge: Cronus284 wedged after C1b. Doctor right after (16:00 local) exit 1, `HarnessInfo unreachable:
  AbortError` on environment, company, control-version and lease; a direct `HarnessInfo` read also
  aborted. `Get-NAVServerSession` then listed one session (Windows, 13:38:36Z). No restart was done.
- C1 (the 32-session probe): NOT run. Stopped on the wedge.
- Counts: recovered lost bodies 0; unrecovered lost bodies 1 (call 1); quarantines 0 (no probe session
  after c1-prep); wedges 1. C1, P1/P2/P3 and the write cost: not measured.
- Lease `008` released. Decision passed to the owner (`coord ask q-20260927T140209-2989a695`).

### Owner direction (2026-09-27)

R-236b lands the readback as **MEASURED-PARTIAL**. C1 (the 32-session probe) is NOT run: every TestPage
hit on Cronus284 today wedged the server (the a2-prep session's hit, and this second C1b run's call 1),
so the readback was never tested against a live hit it could recover. State plainly: both live TestPage
hits wedged the server, so there was no server left to read the kept answer back from. R236 stays OPEN;
this task neither closes nor narrows it.

C2 skips `itest:tables`: it cannot pass until R-236c lands (LethAL refuses TestPage tests up front, as a
named "TestPage refused, not run" result). C2 runs `itest:bcdev`, `itest:hang` and `itest:chunked` on
Cronus28.

### C2 (2026-09-27, Cronus28, control app 1.0.0.20)

- Lease: `coord lease Cronus28 bugs`, attempt `047`, released after Task 11. `itest:hang`'s rerun ran
  under a second lease, attempt `048`, released after.
- Publish: before, `LethAL Control` 1.0.0.19 was installed Global (1.0.0.16 and 1.0.0.18 published, not
  installed). `Publish-BcContainerApp ... -sync -upgrade` for `LethAL_LethAL Control_1.0.0.20.app`
  printed `Synchronizing`, `Upgrading`, `successfully published`, no refusal. After, 1.0.0.20 is
  installed Global, Synced. No doctor run on any of the three fixture configs reported an orphaned
  server-side lease, so no `force-reset-lease` was needed.
- `itest:bcdev`: PASS. `killed=3 survived=12 noCoverage=4 baselineGreen=true`. All four R-236b
  kept-answer pins passed inside `protocol-invariant probes PASS`, including the discrimination pin:
  `GetOpAnswer` for `opSeq - 1` returns `found: false`.
- `itest:chunked`: PASS, both legs. Unbounded leg killed 17 / survived 7 / noCoverage 2, `warmKills` 9,
  `groupedCalls` 33. Chunked-2 leg the same 17 / 7 / 2, `warmKills` 5, `groupedCalls` 57. Verdict and
  `killingTest` identity across legs held.
- `itest:hang`: **FAIL, twice.**
  - Run 1 (lease `047`): `every mutant must be scored`, `4 !== 40`, wall 640 s. M0004
    (`lethal.void-method-call`, `src\HangLogic.Codeunit.al:37`, expected `timeout-killed`) came back
    `error`, a stranded-container quarantine. The run stopped at 4 of 40 mutants; the OFF leg never ran.
  - Rerun (lease `048`, same code, with this session's diagnostic print `7bee6a5` and permanent test
    `18c6ae5`): **FAIL the same way**, `4 !== 40`, wall 640 s. New diagnostics, printed before teardown
    deleted the scratch store: M0004's `failureMessage` is `RunMutantMany connection failed after
    dispatch: TimeoutError: The operation timed out.; answer readback: the server holds no committed
    answer for a10/35210 (it holds a9/35209)`. Four `lease-renew-unanswered` warnings fired during the
    hang (`RenewLease` `AbortError` twice in a row, four separate times): the server stopped answering
    lease renewal too, not only M0004's own call, for the whole hard-cap window. The readback (R-236b)
    behaved correctly: the server's kept-answer row still named the PREVIOUS op (`a9/35209`), not this
    mutant's (`a10/35210`), so `GetOpAnswer` found nothing to accept and the verdict correctly stayed
    `in-flight-unknown` rather than a false accept.
  - Judged: the pre-existing M0004 `StopHungRunAt` flake (R289), judged not caused by R-236b.
    Offline analysis (`docs/measurements/2026-09-27-r289-hang-rootcause.md`):
    the readback only appends text to an `in-flight-unknown` result that `runManyOnce` already
    classified, and it is never reached before a confirmed 408; the stop path, client and server, is
    textually unchanged by R-236b. State plainly, and do not read past it: this is 2 of 2 same-shape
    failures on `lethal/lane-bugs` today (lease `047` and the rerun, lease `048`) against 1 of 3
    same-shape runs on `master` on 2026-09-26 (`docs/measurements/2026-09-27-nst-wedge-incidents.md`
    §3). The sample is too small either way to rule R-236b out; the offline mechanism analysis, not the
    rate, is what the "judged not caused by R-236b" judgement rests on.
- `itest:tables`: **SKIPPED** per owner direction. It cannot pass until R-236c lands.
- Write cost: only `itest:chunked` has a recorded pre-fix wall time to compare against, ~95 s (R208,
  2026-09-04) versus 96 s today. No pre-fix wall time is recorded for `itest:hang` or `itest:bcdev`.

**Acceptance verdict, per owner direction: MEASURED-PARTIAL. R236 stays OPEN.** C1 was not run (both
live TestPage hits that day wedged Cronus284 before it could start). C1b never produced a measured
pass (the first attempt was invalid, no prep session; the second exited 0 but was VACUOUS, zero calls
arrived whole). C2's `itest:hang` fails on a judged-unrelated pre-existing flake, and `itest:tables` is
skipped by design pending R-236c. No mechanism label closes or narrows R236 from this OUTCOME.
