# R-658 pre-commitment: does LethAL Control's stop end a BASELINE test on BC?

Committed by lethal-bugs on 2026-10-22, before any lease or server call for R-658. This is revision 2, with:
- the deep review's fixes (`/coord/handoff/R-658/review-plan-deep.md`: C1, C2, I1-I5, M1-M5);
- the orchestrator's rulings on the STOP rule and case D;
- the delta review of the driver: a STOP is set first, only exits 0/1/2 release, and "answered" is defined once.

**What it covers.** The probe on `lethal/r658`, head `586c78359866212bc1fc2c37b70e848bd7175d8c`:
- the apps `scripts/r658-bc-probe/target` and `scripts/r658-bc-probe/tests`;
- the driver `scripts/r658-bc-probe/drive.ts` (listed in `scripts/typecheck-excluded.json`, like R649's);
- the lease wrapper `/coord/handoff/R-658/run-probe.sh`.

It follows R649's probe (`scripts/r649-bc-probe/`, `docs/measurements/r649/`, pre-commitment
`docs/superpowers/specs/2026-10-22-r649-bc-sleep-probe-precommitment.md`).

**Background:** R658 (`docs/roadmap/R658.md`); the code map `/coord/handoff/R-658/code-map.md`; R53 (the stop).

## 1. The question

For a BASELINE op (`RunMutant`, `mutantId ""`), when the client budget runs out and LethAL calls the existing
`StopHungRun`:
1. does BC end the running test session, and how soon;
2. is the server left clean: op completed, control-app lease released, the next acquire granted?

And does the answer differ between a test in a busy loop (L) and a test in `Sleep` (S)?

**A second question (case D): what does a baseline op do today, with NO stop, once LethAL abandons it?**
- R-649's "still running 20 minutes later" rests on the control app's op marker (`completed: false`, `state: running`).
- That marker cannot tell a live session from one that died, without reaching phase 3, at its first database call
  after the client aborted. In both cases nothing clears it.
- So R-649 shows the marker stranded, not that the session ran on. D measures which it is, on a short Sleep.

**It changes no product code.**
- It adds two throwaway AL apps, a driver, and (from the run) a measurement folder `docs/measurements/r658/`.
- No verdict rule, gate, baseline or control-app code moves.
- The fix is written from this probe's readings, after the run.

## 2. The server, the lease and the cost

- **The server: bc3 only.** The driver refuses (exit 2) unless `--server bc3` and `kraken coord holder bc3` names
  lane bugs. It makes no server call before that check.
- **The lease:** `/coord/handoff/R-658/run-probe.sh` takes `kraken coord lease bc3 bugs`, heartbeats every 60 s,
  runs the driver in the foreground, and releases the coord lease only as §8 allows.
  - Count the heavy jobs and get bc3's go BEFORE leasing.
  - The run waits until preproc's S1 gates on bc1/bc3 have finished (orchestrator condition).
- **The cost:** about 7 minutes on the lease.
  - C takes seconds; L and S about 70 s each (the settle wait); D about 60 s plus its cleanup; publish and removal
    about a minute.
  - A held request can take up to 240 s (the tap's cap).
  - After the STOP rule, the lease stays held until the owner's restart (§8).
- **The login** is read inside the driver from the secret file and is never printed.

## 3. The apps (compiled offline 2026-10-22, before any lease)

- **Compiler:** alc 18.0.43.1464 (`$LETHAL_ALC_DIR`).
- **Symbols:** `/coord/cache/bc-symbols/bc3/28.0.54946.56477-6725e7bb/Microsoft_System.app`, and LethAL Control
  1.0.0.23 (`CONTROL_APP` in `scripts/bc-linux-setup.ts`, sha256 `c2a95948…`, checked).
- **Output:** the gitignored `scripts/r658-bc-probe/build/bc3/`. Both apps compiled with exit 0 and no diagnostics.
- alc's output is not byte-stable between builds, so the driver records the sha256 of the files it actually
  publishes. The build of revision 2 is:
  - `target.app` sha256 `2aa9991d29db0c02f763329bb9a46744dfc964deb202d864cacb80745d934ea5`
  - `tests.app` sha256 `aaf0d60cfc1eb6f0a80bd6028c68dba21eeb7dc3375f88a7c19de76c92b86116`

**The target, "LethAL R658 BC Baseline Stop Probe"** (`d1d2d26c-a3b4-4a26-804f-903c1f1497f8`), ids 92940-92949:
codeunit 92940 is an Install codeunit that registers artifact `46f0516107e9ecda24671e5c5ddbabd0` (RunMutant refuses a
target with no registered artifact). Nothing else.

**The tests, "LethAL R658 BC Baseline Stop Probe Tests"** (`c189159c-3fa4-4909-9c63-b4b65bafc1cd`), ids 92950-92959.
One case per codeunit, each with `TestPermissions = Disabled`. No test reads or writes a table, calls out, or runs past
60 s on BC's own clock.

**The id check (2026-10-22):**
- Committed `app.json` ranges at 92000 and above: R340 92800-92849, R639 92900-92919, R649 92920-92939. None overlaps
  92940-92959.
- `/coord/handoff/*/probe` holds no `929[4-5]x` id. The only other mention of the range is R-456's offline alc probe
  (ids 92900-92949, in a scratchpad, compiled only, never published: `/coord/handoff/R-456/measurement.md`).
- `git grep` finds `929[4-5]x` only inside hashes and UUIDs, never as an object id.
- The two app GUIDs and the artifact id appear nowhere in the repo or under `/coord/handoff`.
- On the server, the driver reads both app ids absent (0 rows) before it publishes, or it stops.

## 4. The cases, in this order: C, L, S, D

| Role | Codeunit | Test | Body | Budget | Stop hook |
|---|---|---|---|---|---|
| C | 92950 | `Sleep100` | `Sleep(100)`. The control: ends far inside the budget, no stop is sent. | 20 s | wired |
| L | 92952 | `BusyLoop60s` | `repeat Spins += 1; until CurrentDateTime() - Started >= 60000;` No Sleep, no database call. | 20 s | wired |
| S | 92951 | `Sleep60000` | `Sleep(60000)`, then `Error('MEASURED elapsed …')` if BC's clock shows under 60000 ms. | 20 s | wired |
| D | 92953 | `Sleep30000` | `Sleep(30000)`. | 10 s | NONE |

L runs before S, because the settle wait (I1, below) is what proves a case's session is over before the next case
starts. Running first the case we expect to stop cleanly keeps a leftover from S out of L's readings.

**C, L, S: one call each** to the real `RunMutantTransport.run` (`LethALControl_RunMutant`), with `mutantId ""` and
`timeoutMs` 20 000.
- The stop hook is wired exactly as `BcDevMcpBackend.runViaTransport` wires it for a mutant:
  `onBudgetExceeded: (boundMs) => transport.stopHungRun({ attemptId, lease: {epoch, token, serverGeneration, opSeq},
  timeoutMs: boundMs })`, with the request's own `attemptId`, lease and `opSeq`.
- `stopGraceMs` is not set, as in `runViaTransport`, so the transport's 30 s default applies (equal to the
  orchestrator's `STOP_GRACE_MS`). So the transport aborts the held request at 50 s if BC has not answered it.

**The observation tap (C, L, S).** The transport takes an injected fetch, so no product code changes.
- For the RunMutant request only, the tap sends the real request on its own signal, aborted at 240 s after dispatch
  (under the proxy ceiling of about 362 s, R44). It records what BC finally sends on that connection: HTTP status,
  body and time.
- The transport still gets BC's answer if it comes in time, or a rejection at the moment ITS OWN signal aborts. So
  LethAL's verdict is exactly production's, and the record also shows whether BC answered after LethAL gave up.
- Simplification: the tap reads the body in full before handing the headers on. BC's OData action sends both together.
- Checked offline against a local fake server:
  - with a short grace, the transport gave up at 1010 ms while the tap still recorded the fake's 408 at 2502 ms;
  - with a long grace, the transport scored the same 408 as `timeout`.

**The settle read (I1, C/L/S after a stop).** The stop tombstones the op but leaves its progress row (`LC Op
Progress`) in place.
- After a stop, the driver waits until dispatch + 70 s, or the tap's answer if that comes later, still heartbeating.
  It then reads `GetOperationStatus` and records `opProgress.state` and `lastCompletedIndex`.
- This read comes before the release and before the next acquire, because a fresh acquire deletes tombstoned progress
  rows (`DeleteTombstonedProgress`).
- What it means:
  - `state running`, `lastCompletedIndex 0`: the session never wrote again after the stop.
  - `state between` (or `done`), `lastCompletedIndex 1`: the session survived and finished the method.
  - Checked in the control app: a single `RunMutant` fences its one method at index 1 (`Runner.SetFence(AttemptId,
    OpSeq, 1)` in `ControlApi`). `RunOneMethod` calls `ProgressBetween` as the first statement after `RunAllTests`
    returns. Phase 3 cannot mark `done` once the stop has cleared the marker.

**D: the abandoned baseline.** `timeoutMs` 10 000, with NO stop hook, as every baseline runs today.
- A pass-through tap: the transport's own abort reaches the connection, and the tap only records it.
- Still heartbeating, the driver reads status and progress at dispatch + 45 s and + 60 s. D's Sleep ends at 30 s.
- Then it calls our own `StopHungRun` with D's attempt and seq under the still-held lease, records the answer, and
  reads status once more.

**The status reads go through a second transport** (`reader`), not the one running the case (M4). So they never enter
that transport's R499 drain: the wait, up to 5 s, for its in-flight fetches before a scored result is returned. The
stop itself goes through the case's own transport, as in production.

**One control-app lease per case.**
- TTL 15 s, renewed every 5 s for the whole case, released after the case.
- A release that throws is retried once after the TTL has run out (M3).
- The next case's acquire is the read of the lease state. After D, that read is one more acquire, released at once.

## 5. The readings

**Per C, L, S case:**
1. **The stop:** whether `onBudgetExceeded` fired and when (ms after dispatch); `stopHungRun`'s answer (`stopped`,
   `reason`, `sessionId`) or its error; when it answered.
2. **The held request:**
   - LethAL's verdict as `transport.run` returned it (the `abortedVerdict` / 408 / `recoverKeptAnswer` path), minus
     `ref` and coverage: `outcome`, `operation`, `durationMs`, `failureMessage`, `stopState`;
   - from the tap: BC's HTTP status, the body (first 2000 characters), the time after dispatch, whether that was
     within `timeoutMs + stopGraceMs` (50 s), and whether it is BC's AL-stop 408 (`isAlStopResponse`: 408, "stopped
     the session", "StopSession");
   - what the orchestrator's baseline loop does with that verdict today (`baselineReading`): quarantine for
     `in-flight-unknown`; "did not pass at baseline" for `fail`/`error`; green for `pass`; otherwise "not green" with
     the outcome (a `timeout` lands here).
3. **The settle read** (after a stop): `opKind`, `completed`, `opProgress.state`, `lastCompletedIndex`, at
   dispatch + 70 s or later.
4. **The op status:** `GetOperationStatus` every 5 s from the moment the stop fired (from the end of the call, for
   C): each change of state, and the time from the stop to `completed: true`.
   - **Caveat:** `TryStopHungRun` itself writes `Last Completed Op Seq := OpSeq`. So `completed: true` after
     `stopped: true` is that tombstone, and says NOTHING about whether the session ended.
   - Session end is read only from the tap (reading 2) and the progress row (reading 3).
5. **The lease:** the control-app release (`released`, `reason`, and any retry); then a status read with the released
   tuple; then the next acquire (`granted`, or `reason` with `holder` and `opAttemptId`).

**For D:**
- LethAL's verdict and `baselineReading`;
- the tap's record of the abort;
- the two reads at +45 s and +60 s (`opKind`, `completed`, `opProgress.state`, `lastCompletedIndex`);
- the cleanup stop's answer, and the status after it;
- the release and the final acquire.

Plus, per case: `heartbeatProblems` (any refused or failed renew).

## 6. Predictions (stated before the run)

- **C:** `pass` in under 1 s; no stop; release `released: true`; next acquire granted.
- **L: row 1.** E8 measured a pure CPU spin stopped in about 3.9 s. R53's probe stopped an OData session busy in a
  pure AL loop, with a 408 on the held request. So:
  - `stopped: true` at about 20 s, and an AL-stop 408 at about 24 s (inside 50 s);
  - verdict `timeout`;
  - progress `running` / `0` at the settle read;
  - release granted.
- **S: row 2/3a or 2/3b, low confidence.** E11 (R198 spec, `2026-09-03-r198-run-mutant-loop.md`; R203's comment in
  `TryFinishRun`) says "a stop lands at the target's next database call".
  - If a Sleep is not interrupted, S's first database call is phase 3 at about 60 s: either a 408 then (2/3a), or a
    200 carrying `op-stopped` (2/3b).
  - LethAL's own verdict would then be `deadline-exceeded` / `in-flight-unknown`.
  - We lean to 2/3a.
- **D: the session reaches phase 3 at about 30 s.** A client disconnect does not end the session.
  - Expected: `completed: true` with progress `done` at +45 s and +60 s, and the cleanup stop answers
    `already-completed`.
  - Low confidence. This would mean R-649's 20-minute marker was a session that really ran on, not a dead one.
- **R-649 restated:** whatever D shows, R-649's "still running at 20 min" is a reading of the marker, not of the
  session (§1).

## 7. Decision table

**C, L and S each fall in exactly one row.** Read the rows in this order; the first row that matches wins.

| Row | What is read | R658 consequence (what the fix must do) |
|---|---|---|
| 5. STOP | Any STOP trigger in §8. | `StopHungRun` cannot be relied on to end a baseline op of this shape. bc3 is held and marked out of use until the owner's restart. The fix must keep such a test from stranding a server: stop wiring alone is not enough; the client must not release or report a server clean on the tombstone, and must name the stranded op loudly. |
| 0. Void | The stop was refused (`stopped: false`) or threw, and the op then completed. | No reading about the stop for this case. If it repeats, find why the stop is refused for a baseline op before any fix; a refusal reason other than `already-completed` is a control-app finding of its own. |
| "Lease orphaned" | The release is refused (after the M3 retry), or the next acquire is refused, after a confirmed stop. (The next-acquire refusal also fires the STOP rule.) | The control app's stop or release path is wrong for a run op: fix it in `TryStopHungRun` / `TryRelease` (control bump, hang gate re-proved on bc1-bc3). Until then the client must not count a stopped baseline as a clean server. |
| 1. Stop works | `stopped: true`; an AL-stop 408 within 50 s; progress `running` / `0` at the settle read; release granted. | Wire the stop for a baseline: drop the `mutantId` clause in `runViaTransport` (behind `--stop-hung-sessions`, or by default: a ruling). Score a stopped baseline test as not green, never a tier quarantine, and name it in the report. Wire the R516 cold confirm the same way. Add a bounded baseline-hang leg to `itest:hang`. |
| 2/3a. Stop lands late | `stopped: true`; an AL-stop 408 only AFTER 50 s (expected near the 60 s natural end); progress `running` at the settle read. | The stop takes effect at the session's next database call, not at once. Row 1's wiring still helps (the session dies at its next write instead of finishing), but LethAL has already given up and the tombstone lets a release and the next session in while the session runs on. So the fix must, after a confirmed stop with no 408 inside the grace, keep holding the lease and wait for BC's answer on the held request up to a stated cap, and only then release; past the cap, take the server out of use and say so. Document that a test making no database call keeps the server until its next one. |
| 2/3b. Stop ineffective | `stopped: true`, and BC answers the held request with a 200 carrying phase 3's `op-stopped` refusal, or progress reads `between` / `done` with `lastCompletedIndex 1`. | The session survived the stop and finished its method. `StopHungRun` does not end a session of this shape at all, and its tombstone is a false "over". The fix must not use the stop as the end of a baseline op; it must wait for the session's own end (the held answer or phase 3's progress) before releasing, and a cure needs a control-app change (for example, tombstone only after the session is gone): a control bump and the hang gate re-proved. File that as its own item. |

**D's rows:**

| Row | What is read | Consequence |
|---|---|---|
| D1. Phase 3 completed | `completed: true` at +45 s or +60 s without our stop; progress `done`; the cleanup stop answers `already-completed`. | A client disconnect does not end a baseline session: it runs to its natural end and cleans up after itself. A hang with no end strands the server for as long as it hangs, so R658's fix (some row above) is needed; a long finite test only costs time. R-649's 20-minute marker is then a session that really ran on. |
| D2. Still `run` / `running` | `opKind run`, `completed: false`, progress `running` at +60 s (D's Sleep ended at 30 s). The cleanup stop's answer is recorded; it fires the STOP rule (a stranded marker). | The session died at the abort, or hung, without reaching phase 3; the marker is stranded either way. Then the stranded marker, not a running session, is what blocked bc2 in R-649, and the fix must also recover a baseline op abandoned at the budget (the stop, or `RecoverOp` once the session is proven gone). |

In both D rows the cleanup stop's result is recorded.

## 8. The STOP rule (owner-approved, replaces the old "not completed in 5 min" rule)

After `stopped: true`, the stop has tombstoned the op (`Op Kind none`, `Last Completed Op Seq := OpSeq`). So after a
CONFIRMED stop, "not completed within 5 min" and "the next acquire is refused" can no longer fire: **only the tap
trigger is live.** The 5-minute and acquire triggers stay for a case whose stop was refused or threw, and for C.

**"Answered" means one thing.** BC has answered the held RunMutant request only with:
- an HTTP 200, or
- its AL-stop 408 (`isAlStopResponse`: 408, "stopped the session", "StopSession").

Anything else is NOT an answer: no status, a 502/503/504 from a gateway, or a 408 that is not the AL stop. The driver
uses one function (`bcAnswered`) for this, both in the per-case check and in the "settled" check after an error.

**The triggers:**
- BC did not answer the held RunMutant request (as defined above) by the tap's cap (240 s after dispatch);
- a refused or thrown stop (or C's call) whose op is not `completed` within 5 minutes;
- a case that throws before BC has answered the held request, or before its op reads completed (C2: never unpublish
  or run the next case unless BC has answered the held request);
- D's cleanup stop answers `stopped: true` (the marker was stranded), or D's op is not completed at +60 s;
- a control-app acquire after a case is refused;
- the driver crashes (an uncaught exception, an unhandled rejection, or an error out of `main`) after its first
  RunMutant was sent. It then exits 5; before that point, a crash exits 1.

**What happens:**
- The driver runs no further case. It makes no control-app release, no reset of any kind (no `RecoverOp`, no
  `ForceResetLease`, no `force-reset-lease`), and no unpublish.
- It sets exit code 5 first, before any log line. Removal checks a separate "a STOP was seen" flag as well as the code,
  and a failed evidence write cannot change either.
- It writes the evidence and exits 5 with a loud message. If `StopHungRun` answered `stopped: true`, **the
  control-app lease and `lethal doctor` will read bc3 CLEAN, and that must not be trusted**: the session may still
  run.

**The coord lease is KEPT.** This is an owner-approved exception to "release at once".
- The wrapper releases the coord lease ONLY when the driver exits 0, 1 or 2: every op it sent is settled, or it sent
  none.
- `lease.txt` says "released" only when `kraken coord release` succeeded, and "release FAILED" otherwise.
- Every other exit goes to the hold: 5 (the STOP rule), and 130, 137 or any other code from a signal or the OOM
  killer.
- So does an INT or TERM that reaches the wrapper while the driver runs, a Ctrl-C included. The wrapper traps both,
  because a signal during the driver means its session may be live.
- In the hold, the wrapper drops its traps and stays in a heartbeat-only loop until it is killed by hand. It makes no
  call other than `kraken coord heartbeat`, and prints `STOP: bc3 coord lease HELD, do not release until the owner
  restart + re-setup`.
- The lane tells the orchestrator, which marks bc3 out of use.
- The release comes only after the owner's restart and a clean `bc-linux-setup.ts --server bc3`.
- Meanwhile, `bun scripts/r658-bc-probe/drive.ts --server bc3 --status-only <opAttemptId>` (read-only, under the held
  lease) may be used to watch the op.

**Other stops (exit 1, apps removed):**
- either app id is present before publish (nothing is removed: not ours);
- a publish is refused, or an app does not read back installed;
- the first control-app acquire is refused;
- C does not pass (L, S and D are then not run).

## 9. Removal

Always, unless the STOP rule fired: tests app first, then the target. For each app, by app id:
1. uninstall if installed (`Microsoft.NAV.uninstall`, HTTP 204);
2. the bound `Microsoft.NAV.unpublish` (HTTP 204);
3. a read-back that must show 0 rows.

A failed removal exits 1. `--remove-only` retries it (no case run) and writes its own JSON under
`/coord/handoff/R-658/probe/`. After the STOP rule nothing is removed; the owner's restart and re-setup decide.

## 10. What stays on the server

- One row in LethAL Control's artifact registry, keyed by target `d1d2d26c-…`, which no API removes (as with R639 and
  R649).
- LethAL Control's own bookkeeping, as any LethAL session leaves it:
  - the lease row's `Last Completed Op Seq` advanced by four (one op per case);
  - its `Stopped Op Attempt Id` / `Stopped Op Seq` naming the last stopped op;
  - C's kept answer.

  Progress rows are deleted by the next fresh acquire.
- No table, so no schema ghost.

## 11. Notes for the fix (from the review, M5; not measured here)

- A stopped R516 cold confirm (an unmutated RunMutant) would today fall into `unstable`'s note, which says the wrong
  thing about a stop. If the fix wires the stop for the cold confirm, give it its own note.
- A stopped baseline that hits `completedBeforeStop` gets the `error` outcome. That is R204's case: BC's 408 arrived,
  but the method's own completion was recorded first. `didNotPassAtBaseline` then reports it as "did not pass at
  baseline", the wrong diagnosis for a test that passed and was then stopped.

## 12. Evidence

- `docs/measurements/r658/bc3-probe.json`, committed by the lane; `lease.releasedAt` is filled in after release;
- `/coord/handoff/R-658/probe/drive.log` (every step) and `lease.txt` (the coord lease token and times).
