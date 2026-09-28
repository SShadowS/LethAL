# R289 pre-commitment: hang probes, stop rule and decision table

Date: 2026-09-27. Plan: `docs/superpowers/plans/2026-09-27-R-289-hang-stop.md`. Roadmap item: `docs/roadmap/R289.md`.

This file is committed ALONE, before any live probe runs. Task 6 applies section 7 to the evidence and cites this commit. Nothing here may be edited after the first probe; a change of mind is written in the readout, beside the evidence, not here.

**Where the probes run.** Cronus284 (control app 1.0.0.20), under `coord lease Cronus284 bugs`, one run at a time, released right after. The `sandbox-hang` target and test apps are published to Cronus284 first (target, then tests), per orchestrator ruling 1. Cronus28 is the fallback only if Cronus284 cannot be made ready; the readout says so if it is used. Cronus281, 282 and 283 are off limits. We never restart a container or its server (NST, the Business Central server process).

## 1. Hypotheses

- **H1, starvation:** the tight loop starves the NST. Other sessions' calls, `$metadata` included, stop being answered from the moment the loop starts, before any stop is sent.
- **H2, lock across the stop:** calls answer until `StopHungRunAt` runs. Then calls that take the `LC Lease` lock (renew, status, stop) block behind the stopping session, while calls that take no lock keep answering.
- **H3, StopSession wedges the NST:** all calls answer until AL executes `StopSession`, then all stop, `$metadata` included. The trace's `stop-sent` shows only that the CLIENT sent the request; a request queued at OData or behind a lock looks the same. So H3 needs either server-side evidence that AL entered `StopSession`, or a decisive plain-versus-locked comparison in P2. Without one of those it stays undecided.
- **H4:** the failure does not recur within the run cap.
- **HB, Bun timeout:** Bun's `fetch` has a default timeout below 330 s that raised the live `TimeoutError`. A matching elapsed time and error text on a live run SUPPORTS HB; it does not by itself prove which layer raised the live error.
- The four `RenewLease` `AbortError`s already recorded fit H1, H2 and H3 alike. They do not separate them.

**Task 1 Step 8's two measured lines** (Bun 1.3.14, Windows x64, offline, test server with `idleTimeout: 0`):

```
{"bun":"1.3.14","arm":"headers-never","fetchMs":300508,"fetchError":"TimeoutError: TimeoutError: The operation timed out."}
{"bun":"1.3.14","arm":"headers-then-stalled-body","fetchMs":300519,"fetchError":"TimeoutError: TimeoutError: The operation timed out."}
```

Reading: Bun 1.3.14's `fetch` ends by itself after about 300 s (300.5 s measured) with `TimeoutError: The operation timed out.`, the same text as the live third occurrence, and below LethAL's 330 s cap (`requestCeilingMs + stopGraceMs`). This SUPPORTS HB. It does not prove which layer raised the live error.

Two limits on that measurement:
- The first run used the brief's script unchanged and measured the TEST SERVER's own 10 s idle timeout (`Bun.serve` closed the socket at about 12 s), not the client's. It was rejected; only the second run above counts.
- A body that stalls AFTER real headers was NOT measured. In the second arm the test server never sent headers, so both arms measured the same thing: `fetch` waiting for headers.

## 2. Shared timeline

One clock: local epoch milliseconds (`Date.now()`). The gate's trace (`LETHAL_R289_TRACE`) and the sidecar run on the same host, so their times are directly comparable. The server's own clock is used only through a difference taken inside one answer (`serverNow - startedAt`).

- **t0 bracket** (when M0004's loop started): take the FIRST trace `poll-ok` for M0004's op (its `rowAttemptId`/`rowOpSeq` equal the op's `attemptId`/`opSeq`) that has `state: "running"` and a `methodIndex` naming M0004's covering method. Then:
  - `t0_early = sentAt - (serverNow - startedAt)`
  - `t0_late = at - (serverNow - startedAt)`

  If the previous poll for the same op answered `between` or had no row, its `at` is a further lower bound. **If no matching poll answers, t0 is UNDECIDED** and H1 cannot be read from that run.
- **ts** = the trace's `stop-sent` time for M0004's op. It shows only that the client sent the stop.
- **Sidecar samples:** each call has a send time `s` and an end time `e` (the answer, or `s + 10 000` on a timeout). A sample counts as "failed before X" only if `e < X`. A sample sent before X that times out after X is AMBIGUOUS, and separates neither H1 from H3 nor H1 from H2.

## 3. Probe P1 (Task 4): a sidecar beside the real gate

The sidecar polls every 2 s, each call with a 10 s timeout. A "failure" of a column means two consecutive failed samples, under the send/end rule in section 2.

| Column (sidecar, every 2 s) | H1 | H2 | H3 |
| --- | --- | --- | --- |
| `GET $metadata` | fails before ts, after t0_early | answers throughout | fails after ts |
| `GET Company` | fails before ts, after t0_early | answers throughout | fails after ts |
| `RegisteredArtifact` (AL, no lease lock) | fails before ts, after t0_early | answers throughout | fails after ts |
| `RenewLease`, bogus credentials (AL, takes the `LC Lease` lock, changes nothing) | fails before ts, after t0_early | fails after ts | fails after ts |
| SQL blocking on `LC Lease` | none | present, head = the stopping session | none |

**Reading rules:**
- H2 is "proven" only with the SQL column collected and showing the chain.
- If SQL collection FAILED, a pattern where only the lock probe fails is reported as "consistent with H2, not proven".
- H3 is never decided from P1 alone: P1 cannot show that AL entered `StopSession`. A P1 pattern matching the H3 column is reported as "consistent with H3, not proven", and sends the run to P2.

## 4. Probe P2 (Task 5): isolated arms

Runs only if P1 ends undecided (section 5).

**The loop P2 copies.** Task 2 emitted `fixtures/sandbox-hang` offline and read the branch M0004 selects in `CountUpTo` (the fixture's own code):

```
end else if MutationSelector.Active('M0004') then begin
  begin
        Counter := 0;
        repeat
            if not LethALReachLatch then begin MutationSelector.Reached('M0004'); LethALReachLatch := true; end; ;
        until Counter >= Limit;
        exit(Counter);
    end
end
```

Task 2's table for the five `timeout-killed` mutants:

| Line | Operator | Mutant | `MutationSelector.` call on the hanging path | Evidence |
|---|---|---|---|---|
| 37 | `lethal.void-method-call` | M0004 | No, after the first pass | Mutation replaces the `Advance();` call inside `CountUpTo`'s own `repeat` body with `;`. The loop body's only `MutationSelector.` call is `Reached('M0004')`, guarded by `if not LethALReachLatch`; it fires once, sets the latch, and every later pass skips it. Nothing else in the loop body or in `until Counter >= Limit` touches `MutationSelector`. |
| 43 | `lethal.empty-block` | M0008 | Yes, every pass | `CountUpTo`'s loop is unmutated here and still calls `Advance();` on every pass. `Advance()` opens with its own dispatch chain, `if MutationSelector.Active('M0008') then ...`, re-entered fresh (fresh local `LethALReachLatch`) on every call, so every loop pass re-runs `MutationSelector.Active('M0008')` and `Reached('M0008')`. |
| 44 | `lethal.remove-assignment` | M0009 | Yes, every pass | Same mechanism as 43: `Advance()` is re-entered by the unmutated caller loop every pass; its chain evaluates `Active('M0008')` (false) then `Active('M0009')` (true) fresh each call. |
| 73 | `lethal.remove-assignment` | M0019 | Yes, every pass | `WalkOneRow`'s own `until NextRow() = 0` calls `NextRow()` every pass. `NextRow()`'s dispatch chain evaluates `Active('M0011')`, `Active('M0012')`, `Active('M0013')` (all false) before falling to its own unmutated default branch, fresh on every call. |
| 145 | `lethal.void-method-call` | M0037 | No, after the first pass | Identical shape to line 37: `SpinUntil`'s own loop body's `Reached('M0037')` call is latch-guarded to fire once; nothing else in the loop (body or `until Counter >= Target`) calls into `MutationSelector`. |

So for lines 37 and 145 the only selector call is latched to fire once, and the part that spins calls nothing. For 43, 44 and 73 a callee (`Advance` or `NextRow`) calls `Active()` on every pass. P2 copies the line 37 shape, because M0004 is the mutant whose stop failed.

**The arms.** Both use `LoopNoGuard`: the M0004 shape with no call inside the loop except one bound check (`CurrentDateTime() - T0 > Run.MaxMs`, evaluated about once every 16.7 million passes). That bound check is the one difference from the emitted AL. A run's answer must name the method that ran; a run whose answer names another method is discarded.

- **Arm A:** `LoopNoGuard` + the locked-stop analogue (`Run.LockTable(); Run.Get(1); StopSession(...); Run.Modify(); Commit();`).
- **Arm B:** `LoopNoGuard` + a plain `StopSession`, no lock held.

Predictions, per arm (probes: `ProbeLock` takes the same lock, `Ping` and `$metadata` take none):

| Arm | H2 | H3 |
| --- | --- | --- |
| A (locked stop) | `ProbeLock` blocks after the stop; `Ping` and `$metadata` keep answering | all three stop answering after the stop, `$metadata` included |
| B (plain stop) | the stop lands, the loop ends, nothing blocks | all three stop answering after the stop, `$metadata` included |

P2's locked stop is an ANALOGUE: it locks one table, while `TryStopHungRunAt` locks `LC Lease` and `LC Op Progress`. Every P2 conclusion is stated at that scope.

## 5. Stop rule

- P1 stops after the first failing run whose timeline gives a decided row of the decision table, or after 2 failing runs whatever they show. It never exceeds 4 runs.
- P2 runs only if P1 ends undecided.
- P2 runs A and B as PAIRS (A then B, same container state). Any conclusion that depends on the plain-versus-locked difference needs at least 2 complete pairs with the same answer; otherwise it is "not decided".
- P2 never exceeds 4 pairs (8 runs).

## 6. Wedge policy

Both probes can wedge the server. The gate P1 runs beside is the one that wedged Cronus28 on 2026-09-26.

After every run, run `lethal doctor` against that run's config. If it fails and has not recovered after 10 minutes, stop and `coord ask` the owner, attaching the NDJSON files. We do not restart anything.

## 7. Decision table

Copied from the plan's Task 6 Step 1.

| Evidence | Cause | Proposed direction for R-289b |
| --- | --- | --- |
| H2 column matched AND SQL chain collected, headed by the stopping session | `TryStopHungRunAt` holds `LC Lease` across a `StopSession` that does not return promptly | C2, after its failure-window design; plus bounded watchdog calls. An in-session stop as well if the loop also outlives the stop |
| H2 column matched, SQL collection failed | consistent with H2, NOT proven | not decided: rerun with SQL collection fixed, or owner |
| H1 column matched with t0 decided | the loop starves the NST | an in-session stop (C1 variant proven against emitted AL, or the injected loop guard) |
| H3 column matched in P1, and P2 decisive (2 matching pairs where plain AND locked both wedge) | `StopSession` on a no-guard loop wedges the NST, lock or not | an in-session stop, plus a Microsoft report through the owner (arm B is its repro) |
| P2 decisive: locked wedges, plain does not (2 matching pairs) | holding a lock across `StopSession` is what wedges (analogue scope) | as the H2 row |
| HB: Bun offline timeout measured AND live elapsed/error match | supports: the call ended at Bun's timeout, not our 330 s cap | a separate client fix, independent of the above |
| H4, t0 undecided where it matters, only ambiguous samples, or no row fits | not decided | owner via `coord ask`; no fix built on a guess |

## ADDENDUM (appended after the P1 dry runs, before any live P1 run; nothing above this line changes)

The orchestrator ruled a P1 redesign after the 2026-09-27/28 dry runs below. This section is the
record of that ruling. It is still written before any live P1 run counts.

- **`$metadata` is dropped from the sidecar entirely.** `GET $metadata` answers headers fast, then
  its body stalls short of complete and never finishes: measured at 65,262 bytes, twice, on a plain
  `curl` call outside the sidecar. A held `$metadata` call can occupy one of the BC user's own OData
  V4 slots for as long as it is open, so a probe meant to watch for throttling must not risk causing
  it.
- **The sidecar authenticates as a separate BC user**, never the gate config's. That user is to be
  created by the owner and is not yet available; until it exists, no live P1 run may proceed.
- **The sidecar's own concurrent requests never exceed 2**, enforced in code
  (`scripts/r289-probe/sidecar.ts`'s `pickProbesToRun`, unit-tested in `sidecar.test.ts`), not left to
  chance.
- **Why:** Business Central throttles OData V4 at 5 concurrent requests per user. The container's
  Application event log recorded Id 705, "Request was throttled", at 5 requests running and 6
  waiting on `ODataV4`, while the sidecar and the gate shared one user. A probe that shares the
  gate's user and holds slots open can throttle the gate it is trying to observe.
- **Every earlier live step is void.** All live activity from 23:5x on 2026-09-27 through 00:15 on
  2026-09-28 (local time) is superseded by this ruling and does not count toward any P1 reading. No
  P1 gate run was started in that window. See
  `docs/measurements/2026-09-27-nst-wedge-incidents.md` for the measured incident.
