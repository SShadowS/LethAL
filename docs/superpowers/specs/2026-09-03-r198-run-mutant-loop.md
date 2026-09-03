# Design: `RunMutantMany`, one call per mutant, a server-side loop of today's single-method run (R198, second draft, revision 5)

Status: DRAFT for adversarial review before any code. Second draft, revised four times. Revision 1
was reviewed on 2026-09-03 and refused with twelve findings; revision 2 applied them and was
refused with ten, of which one (the non-408 kill rule for R202) was DELETED rather than repaired;
revision 3 was refused with ten more, none class 1, of which one was a platform question and is
MEASURED (E11); revision 4 was refused with ten more, none a design change: an inherited false-kill
window the draft had claimed closed (now R204, with a narrowing), two ordering errors in the
answer check, a scope narrowing on E11, and six wording or plumbing edits, all applied here. All
five review tables are at the end. The first draft (`2026-09-02-r198-run-mutant-many.md`) was
refused with ten findings, also listed. Every platform fact this draft rests on was MEASURED on
Cronus283 on 2026-09-03 (`scripts/r198-group-runner-probe/README.md`, experiments E1 to E10 and
the stop race, raw output in `results.measured.txt` and `stop-race.measured.txt`); the
measurements are cited by experiment number and the numbers quoted are the committed run's.

## 1. The cost this removes, measured

Run 2 of the Document Output Templates slice (2026-09-03, hosted sandbox, 741 mutants): the 245
survivors cost 73 of 148 minutes, 10,134 test calls at 0.43 s each; the same tests run in ~0.11 s
on a container, so ~0.3 s of every call is the HTTPS round trip and the fence. A survivor runs
every covering test (median 14, p90 112, max 214). The probe's LOOP shape runs a method in ~55 ms
on a container including its suite rebuild (E7, committed run), against ~72 ms for a separate
call on the same container (E7c) and ~430 ms on the sandbox. On a container the saving is ~17 ms
per method; on the sandbox it is the ~0.3 s round trip per method.

**Prediction (pre-committed):** the survivors' 73 minutes become 10 to 20 on the same slice; the
kills' 13 minutes change little (R197 already made most of them one call); HTTP calls to BC fall
from about 14,000 (10,134 survivor calls + 2,197 kill calls + 439 confirmations + 3 × 407
baselines; the store's 17,300 rows also count 9 reused baselines that made no call) to about
2,500 (245 survivors at ~1.2 calls each, 439 kill calls, 439 confirmations, 1,221 baseline calls);
plus the watchdog's `GetOperationStatus` polls, one per 5 s of open group call (about 245
survivors × ~2 s of call each: a few hundred); no verdict and no `killingTest` moves on any gate.

## 2. What changes on the server (`extensions/lethal-control`)

### 2.1 A new OData action, `RunMutantMany`

```
RunMutantMany(TargetAppId, ArtifactId, AttemptId, MutantId,
              TestMethods: Text,        /* JSON array of {index, codeunitId, method, budgetMs}, index 1..N */
              StopAtFirstFailure: Boolean,
              RequestCeilingMs: Integer, /* the server stops STARTING methods so the call answers inside this */
              StopGraceMs: Integer,
              LeaseEpoch, LeaseToken, ServerGeneration, OpSeq) ResultJson
```

`RunMutant` and `RunMutantWithCoverage` keep their signatures (baseline, kill confirmation, older
clients, and the long-budget fallback in §3.4); `RunMutant` gains ONE behaviour, the progress row.

- **One fence for the call.** Phase 1 `TryBeginRun` claims ONCE with `(AttemptId, OpSeq)`; phase 3
  `TryFinishRun` verifies and clears ONCE. The call is one op. Everything design §5 and R194 say
  about an op applies to it as a unit.
- **Phase 2 is a loop of today's `RunOneMethod`, verbatim.** For each requested method, in REQUEST
  order: build the throwaway suite, mark exactly that method `Run = true`, `Test Suite Mgt.
  RunAllTests`, collect `TestResultsToJSON`. Every method is its own `CODEUNIT.Run` of the test
  codeunit with the STOCK runner (130450), so isolation, the test codeunit's `OnRun`, its globals
  and its `RequiredTestIsolation` are today's by construction (E7: the loop passes the fixed-key
  leak test; E1: grouping methods under the stock runner FAILS it). Order is the request's, which
  is R197's.
- **The whole loop runs behind one catchable boundary.** A new codeunit `LC Run Many` (the shape of
  `LC Run Method`: `SetRequest`, `OnRun`, `Results`) is invoked through `if not Runner.Run() then`.
  Any raise inside phase 2, including a platform concurrency raise on a write (E10: a stale
  `Modify` RAISES "Sorry, we just updated this page" and does not silently overwrite), is caught,
  phase 3 still runs, and the answer carries `runError` instead of results.
- **Three terminations, always named.** `endedBy` is ALWAYS present in a `ran` answer with exactly
  one of `"complete"` (every requested method ran), `"failure"` (`StopAtFirstFailure` and a method's
  result was not `2`), or `"cap"` (the next method could not be started inside the ceiling).
  `ranCount` is the number of entries in the answer, at least 1, and means one thing in all three
  cases. The answer lists exactly the methods that RAN, in order, each with the same
  `codeunitResults` shape `RunMutant` returns plus `durationMs` measured server-side. Methods after
  them are NOT in the answer. `BuildStatus`'s house rule of omitting blank keys does not apply to
  `endedBy` or `ranCount`. The server never emits `ranCount = 0`: method 1 ALWAYS starts (below).
- **Cap, headroom-aware, from method 2.** Before starting method `i >= 2` the loop checks
  `elapsedMs + budgetMs[i] + StopGraceMs > RequestCeilingMs`; if so it ends with `endedBy: "cap"`.
  So no LATER method is started whose budget plus the stop's grace cannot be spent inside the
  ceiling, which keeps the R53 stop reachable for every method of the call. Method 1 is exempt:
  today's single-method call has no ceiling at all, and the CLIENT never places in a group a
  method whose `budgetMs + StopGraceMs > RequestCeilingMs` (§3.4 routes it through `RunMutant`), so
  the exemption is never exercised by a well-behaved client and a `ranCount = 0` cannot occur. A
  method already running is never interrupted by the cap; `TryStopHungRunAt` is the only thing
  that ends a running method. With the 180 s floor, a 30 s grace and the 300 s default ceiling, a
  second method starts only while `elapsed < 90 s`; the client continues with a new call (§3.4).
- **Progress in its own table, `LC Op Progress`**, one row per op, key `(Attempt Id, Op Seq)`:
  `Method Index`, `Method Codeunit Id`, `Method Name`, `Method Token` (a fresh GUID per method),
  `Started At` (server `CurrentDateTime`), `Last Completed Index`, `Session Id`, `State`
  (`running` | `between` | `done`). Written ONLY by the session that runs the op, and only by fresh
  `Get`/`Insert` per write, never from a record held across a method (F4; E10). Sequence per
  method: before it, `State := running`, method fields, fresh token, `Commit()`; **immediately when
  `RunAllTests` returns, before `TestResultsToJSON` or anything else**, `Last Completed Index := i`,
  `State := between`, `Commit()` (a named invariant, `PROGRESS_BETWEEN_FIRST`, pinned by a test on
  the AL source). E3/E7 measured that commits between test runs carry nothing of the test's
  writes. `TryFinishRun` sets `State := done` in its transaction. **`RunMutant` (single method)
  writes the same row** with index 1, so `GetOperationStatus` reports one shape for every op. A row
  that is missing mid-loop (deleted under the loop) is a `runError` (`progress-row-missing`); the
  loop never re-creates it.
- **Cleanup of old rows** happens only in `AcquireLease`'s GRANTING branch, under the lease lock,
  and deletes only rows with `Op Seq <= Last Completed Op Seq` of the lease being granted: a live
  op's row is never deleted by a competing acquire.
- **The loop never touches `LC Lease` during phase 2** except one READ, in its own transaction,
  AFTER each `between` `Commit()` has completed: if the marker no longer names its own `(Attempt
  Id, Op Seq)` as the active run (the op was stopped, tombstoned or force-reset while a method was
  finishing), the loop runs nothing further and phase 3 answers as §2.3 says. This is what stops a
  stopped session from running the next method unmutated in the ~4 s before `StopSession` takes
  effect (E8 measured that latency), and from deleting a suite a newly admitted op is using.
  Named invariant `LOOP_READS_LEASE_ONLY`. Lock order everywhere is lease then progress; the loop's
  progress transactions never hold anything while the lease is read. The read only stops FURTHER
  methods; it is not a source of any answer (phase 3 is, §2.3). Measured after this was designed,
  on a container: E11 shows a stop lands at the target's next database call, so in practice the
  stopped session dies at its next write, and E11's 80 pings show session ids are never reused,
  so a pending stop cannot reach a later request there. On the hosted sandbox this is unmeasured;
  the failure direction if it were false is a quarantine (a later call with `stopFired` false gets
  a 408 it cannot score, `in-flight-unknown`, reconciled, quarantined), never a verdict.
  `NextSuiteName` is per session (E11: a fresh session per request restarts it at 1), so suite
  names are unique within one call and NOT across ops; `LOOP_READS_LEASE_ONLY` is what keeps a
  displaced loop off a new op's suite, not the names.
- **`GetOperationStatus`** adds `opProgress: {attemptId, opSeq, methodIndex, codeunitId, method,
  token, startedAt, lastCompletedIndex, state}` and `serverNow`, read in one transaction, for the
  row keyed by the MARKER's own `(Op Attempt Id, Op Seq)` when a run is active, and by the last
  tombstoned op's key when the marker is idle. The row always says whose it is; a client that
  cannot match `attemptId`/`opSeq` to its own op treats the row as "not mine".
- **A NEW action `StopHungRunAt(…, MethodIndex, MethodToken)`** beside `StopHungRun`, which keeps
  its signature and its op-grain behaviour (R58's reasoning: BC validates an action's request shape
  before its body runs, so adding parameters to `StopHungRun` would turn every stop from an older
  client into a 400). `TryStopHungRunAt`, inside the lease-locked transaction it already takes,
  reads the progress row LOCKED (`LockTable`, then `Get`), so the read serialises against the
  loop's in-flight `between` write rather than seeing a snapshot, and refuses unless ALL of: the
  marker is our `(AttemptId, OpSeq)` and not tombstoned (today's checks); the row reads `Method
  Index = MethodIndex`, `Method Token = MethodToken`, `State = running`. A mismatch is
  `method-completed`; a missing row is `no-progress-row`; both in `reason`. Only then it stops the
  recorded session and tombstones the op, as today. E8 measured the miniature: a stop asked for a
  finished method is refused, a stop for the running one ends the session and the held call
  returns within 4 s for a pure CPU spin (E8) and before one HTTP round trip plus a 20 ms poll
  could complete for a session polling the database (E11, an upper bound: the interval itself was
  not logged). `StopHungRunAt` is called ONLY by `runMany`'s watchdog, which is where the token
  comes from; the single-method `run` keeps calling `StopHungRun`, whose signature is unchanged.
  BOTH stop paths write the stop record §2.3 describes.
- **Attestation** is read once after the loop, an OR over everything that executed under this
  activation, which is what `guardObserved` means per mutant.
- **`HarnessInfo`** bumps `semver` to `1.0.0.17`; `protocolVersion` stays (added actions, one
  added behaviour that no older client observes).

### 2.2 What the server never does

- Never runs two methods under one suite run (E1).
- Never writes progress from a runner trigger (the stock runner is used unchanged).
- Never interrupts a running method except through `TryStopHungRunAt`/`TryStopHungRun`.
- Never returns a method it did not run, never omits `endedBy` or `ranCount`, never answers
  `ranCount = 0`.

### 2.3 Phase 3 after our own stop: `op-stopped` (R203, both grains)

Phase 3 ALWAYS runs and is the single source of this answer; the loop's marker read (§2.1) only
stops further methods. Two NEW fields on `LC Lease`, `Stopped Op Attempt Id` and `Stopped Op Seq`,
are written by BOTH `TryStopHungRun` and `TryStopHungRunAt` in the stop's transaction, and cleared
by `TryForceResetLease` with the other op fields. They are new fields, not the residual `Op Attempt
Id`/`Op Seq`, because a SUCCESSFUL `TryFinishRun` and `TryRecoverOp` leave those residues in a
state byte-identical to a stop's. `TryFinishRun` answers `lease-invalid` with `reason:
"op-stopped"` ONLY when ALL of: the `(Epoch, Token, Generation)` tuple still matches (a
force-reset after the stop minted a new generation and is a genuine loss, which MUST latch);
`Op Kind = none`; `Last Completed Op Seq = OpSeq`; `Stopped Op Attempt Id = AttemptId` AND
`Stopped Op Seq = OpSeq` (both, because `attemptId` restarts at `a1` per process and only the pair
is never reused). Every other refusal keeps today's reasonless `lease-invalid`. `RunMutant` gets
the same, since it is the same phase 3 and `TryStopHungRun` writes the same fields: this closes
R203 at the single-method grain too. Plumbing this needs, named so it is not a mid-build surprise:
`TryFinishRun` gains a `Reason` out-parameter, and BOTH call sites (`RunMutant`,
`RunMutantMany`) pass it to `BuildStatus` instead of the hardcoded blank, whose doc ("populated
only on phase-1 refusals") is updated. A phase-3 refusal DISCARDS `runError` and results exactly
as `RunMutant` discards `CodeunitResults` today, so `lease-invalid` and `runError` never co-occur
in one answer. E11 makes the case rare on a container (a stop lands at the target's next database call, so a
session that outruns it is one whose final stretch was CPU-bound) and makes the "continue" safe
there (the stopped session's id is never reused, and a stop on a dead id is a measured no-op,
R53); see §2.1 for the hosted residue and its direction.

## 3. What changes on the client (`packages/runner`)

### 3.1 Version gate, both directions

`MIN_CONTROL_VERSION` 1.0.0.17 in lockstep with `app.json` (R28's test pins the pair). A control app
without the actions is refused by the existing version gate before any call. A 404 on
`LethALControl_RunMutantMany` or `_StopHungRunAt` after the gate passed is a broken deployment,
but a path-routed portal can emit a 404 BC never saw, and one that arrives after phase 1 claimed
the op is indistinguishable at the status line: so it is reconciled and, when unresolved,
quarantined exactly as any non-2xx is today, and THEN the session aborts with
`control-app-route-missing`; never retried. The other direction, a NEW server
with an OLDER client, keeps working unchanged: `RunMutant` and `StopHungRun` keep their
signatures, and the progress row `RunMutant` now writes is invisible to a client that never asks.

### 3.2 `RunMutantTransport.runMany(req)`: the watchdog lives INSIDE it

One POST, the same fence coordinates as `run`, the same classified exits. While the request is
open, the transport itself polls `GetOperationStatus` every `WATCHDOG_POLL_MS` (5 s) on a second
connection and is the SOLE writer of `stopFired`:

- **Ours first.** The watchdog acts on a poll only when the answer says `opKind = run`,
  `opAttemptId` = ours and `opSeq` = ours, AND `opProgress.attemptId`/`opSeq` are the same pair.
  Anything else (the marker idle, another op's row, our op not yet claimed because the request is
  still queued at the gateway, which is R194 rule 2b's ordinary start-up state) means "nothing to
  decide yet": keep waiting, never abort, never fire a stop from it.
- **Identity second.** On a poll that IS ours, `opProgress.methodIndex` must be in `1..N` and
  `opProgress.codeunitId`/`method` must equal `req.methods[methodIndex - 1]`'s, checked against
  the CLIENT's own request array. A disagreement on OUR row means the server is running something
  this request did not ask for at that index: the transport aborts the request and returns
  `in-flight-unknown` with the disagreement in `failureMessage`. No stop is fired on such a row.
- From `opProgress.startedAt` and `serverNow` (server clocks only) it computes the running method's
  `elapsed`. When `elapsed > req.methods[methodIndex - 1].budgetMs` and `--stop-hung-sessions` is
  on, it fires `StopHungRunAt(methodIndex, token)` ONCE and records `stopDecision = {methodIndex,
  token, codeunitId, method}` from its OWN request entry. The hook's answer is kept.
- `method-completed` or `no-progress-row` means the group moved on (or ended) between the poll and
  the stop: the transport clears `stopFired`, keeps waiting, and may decide again for a later
  method. `already-completed` means the op finished: keep waiting for the answer. Any other refusal
  or a throw is kept as `stopHookError` for the quarantine note (today's rule). The transport
  keeps the LAST refusal reason and the row's `(state, methodIndex, lastCompletedIndex)`, and puts
  them into the abort message if the hard cap fires, so a loop stalled BETWEEN methods (row at
  `between`, every stop refused `method-completed`, nothing over budget to stop) is quarantined
  with a note that says exactly that, not "BC never answered with its stop confirmation".
- Without `--stop-hung-sessions`, a method over its budget aborts the request at that moment,
  returning `abortedVerdict`'s shape VERBATIM (`outcome: "deadline-exceeded"`, `operation:
  "in-flight-unknown"`, `fencedOp`), which `itest:hang`'s OFF leg pins and `counts.deadlineExceeded`
  folds from; reconciled by the orchestrator: rule 2, ours and active, polled with the GROUP budget
  (§3.5).
- **Hard cap.** The request is aborted at `RequestCeilingMs + StopGraceMs` on the client's clock
  (the server's `elapsed` starts at phase 2, the client's at dispatch; the grace absorbs queueing
  and phase 1, and the default 300 s + 30 s stays under the 360 s proxy ceiling). Because the
  server never starts a method that cannot finish its budget and grace inside the ceiling, this
  abort fires only if the server's own cap logic failed, and it is scored `in-flight-unknown`.

**Scoring the held request after a stop: today's rule, restated as the code has it
(`run-mutant-transport.ts`, the `stopFired` 408 branch and the fall-through).**

- `stopFired` and response 408 and `isAlStopResponse`: `timeout` (the predicate today's code has;
  the hook's `stopped` boolean is not consulted, a refusal only becomes `stopHookError`, and both
  grains keep that one predicate), with ONE narrowing for R204 that applies to both grains: before
  scoring, read `GetOperationStatus` once; if `opProgress.lastCompletedIndex >=
  stopDecision.methodIndex` (single grain: `>= 1`), the method's `between` write committed before
  the session died, so the method finished, and the run is `in-flight-unknown` instead. A
  narrowing, not a proof: a session killed inside its blocked `between` write rolls it back.
- Any other NON-2xx after a stop is `in-flight-unknown`, reconciled as today. Revision 2's rule
  for a non-408 answer (R202) is DELETED: the only termination proof in hand is BC's 408 naming the
  AL `StopSession` call; the stop's own answer is a decision, not a termination; a progress row
  that has not moved is what a slow, passing method looks like too; and `Lease.Table.al` records
  that a web-service session cannot read `Active Session` for a liveness check. R202 stays open,
  at its measured 1 in 34, outside this change.
- A 2xx after a stop (the stop was refused `already-completed`, or threw, or the session
  finished first) is PARSED AND SCORED exactly as if no stop had fired, which is what makes the
  finish-just-after-budget case honest today (the transport's own doc says so), with §2.3's
  `op-stopped` one of its parsed outcomes: scored `error`, cause `op-stopped` beside `result-lost`
  ("exceeded its budget; the stop was confirmed but the session finished first; no result, no
  verdict"), no lease-loss latch, no quarantine, continue. R203 at both grains.

The `timeout` verdict names `killingTest` = `stopDecision.method`, taken from the client's request
entry at the index it decided on, which the identity check tied to the server's row. The methods
that ran before it are lost with the answer (the verdict does not need them); their
`test_results` rows are not written.

### 3.3 The answer is asserted before it becomes verdicts

The answer is classified in `dispatch`'s EXISTING order first, shared with `run` rather than copied
(the file's own header warns against a third copy of its classified exits, and a test asserts
`run` and `runMany` yield identical `operation` values for the same HTTP conditions): the
call-level echo (`targetAppId`, `artifactId`, `attemptId`, `mutantId`), then `artifact-mismatch`,
`reserved-params`, `lease-invalid` with its `reason` (`op-stopped` among them, §2.3). Only a `ran`
answer goes further. Two consequences, pinned separately in `orchestrator.test.ts`:

**Session-aborting** (a bare `error` with no `operation`, which sets `transportErrorRef` and
throws at the end of the batch, exactly as today's single-method path does): a call-level echo
mismatch; `identityMismatch: true` (an answer produced while a stale or wrong binary was live
rejects the WHOLE call and the session, because the next mutant's "survived" would be measured
against a binary the session already proved wrong). `observedAny` is OR'd into `guardObserved`
only.

**Per-mutant** (`error` with a cause, recorded, the session continues): a `runError` answer on a
`ran` status (§2.1: a raise inside phase 2, `progress-row-missing` among them) becomes cause
`group-run-error` with the server's own text appended verbatim, the way `runMutantLineCountMessage`
carries a server statement today (R139: a wrong named cause is worse than silence); otherwise
`GroupVerdict` is built only if ALL of the following hold, else cause `group-answer-malformed`
with the answer text recorded, never a per-method verdict:

- `endedBy` present and one of the three values, `ranCount` present and `>= 1`;
- the answer's methods are a PREFIX of the request: entry `i` has index `i`, and the same
  `codeunitId` and `method` as request entry `i` (the §I5 identity guard, per entry), and there are
  exactly `ranCount` entries;
- every entry's `result` is `1` or `2` (BC's `0`, "not run", and `3`, "skipped", are real values
  the platform emits, E5, and an entry carrying one was not run);
- `endedBy = complete` implies `ranCount = N`; `endedBy = failure` implies entry `ranCount`'s result
  is `1` and every earlier entry's is `2`; `endedBy = cap` implies every entry's result is `2`;
- each entry carries `codeunitResults` with EXACTLY one test line (today's `lines.length !== 1`
  guard per entry, through `runMutantLineCountMessage` so the server's own `error` text travels),
  whose INNER `method`, the value BC produced rather than the server's echo of the request, equals
  the client's own request entry `i`'s method (today's per-line method check), and a `durationMs`.

Three of thirty-five methods returned, all passing, with `endedBy = complete` is therefore an
`error`, not a survivor; so is `endedBy = cap` with no entries. New `MutantErrorCause` values:
`group-run-error`, `group-answer-malformed`, `group-coverage-incomplete`, `op-stopped` (R203's row
says "like `result-lost`"; it is a distinct value, so `explain` can prescribe differently), each
with its `ERROR_CAUSE_INTERPRETATIONS` entry and an `explain` prescription, rippling through
`report.ts`, `explain.ts`, `generate-schemas.ts`, `schemas.test.ts` and `explain.test.ts`.

### 3.4 The mutant loop consumes a sequence either way, and a survivor must have been attempted in full

`runMutantsOnBackend`'s covering loop iterates `for await (const step of coveringRuns(m, ordered,
budgets))`. The generator yields `{ ref, verdict, lostAck, retried, retryAfter, original,
testBudgetMs, groupBudgetMs }` per test: `testBudgetMs` is the per-test budget the quarantine text
quotes ("raise the floor with `--mutant-timeout-ms`"), `groupBudgetMs` is what `classifyRetryRefusal`
and the lost-ack polls use (§3.5). Two meanings, two fields.

- backend WITHOUT `runMany` (al-runner): one `runFenced` per test, byte-for-byte today's loop;
- backend WITH it: the generator walks `ordered` with a cursor, IN ORDER, never skipping. A chunk
  is a CONTIGUOUS run of fittable methods starting at the cursor, at most `--max-methods-per-call`
  (default unbounded) long, ending before the first unfittable method; an unfittable method
  (`budgetMs + STOP_GRACE_MS > REQUEST_CEILING_MS`) is dispatched alone, AT ITS POSITION in
  `ordered`, through today's `runFenced` (single `RunMutant`, op-grain `StopHungRun`), and the
  cursor moves past it. R197's order is therefore preserved exactly, which is what keeps
  `killingTest` where the sequential path would put it; the server's method-1 exemption is never
  exercised by this client. Each `runFencedMany` call carries `StopAtFirstFailure: true`,
  `RequestCeilingMs = REQUEST_CEILING_MS` (default 300 s; `--request-ceiling-ms`; the 360 s figure
  is the hosted proxy's ceiling recorded at `orchestrator.ts` "360 s is the hosting proxy's own
  ceiling" from the first field run, and §7 owes a probe that pins it) and `StopGraceMs = 30 s`.
  Each returned method's verdict is yielded in order; on `endedBy = cap` the cursor advances by
  `ranCount` and the next call is issued for the rest (a new op, new opSeq, indices renumbered from
  1 and mapped back through the cursor); on `timeout` the timeout verdict for the stopped method is
  yielded and the walk stops; on `op-stopped` the `error` is yielded and the walk stops.
- **Attempted set.** The generator keeps `attempted: Set<testKey>` of every method a call reported
  with a mapped `pass`/`fail` result (§3.3's third bullet is what makes "reported" mean "ran"). A
  retried chunk (§3.5) REPLACES its original's entries, never adds to them. Before `survived` can
  stand, the loop body asserts `attempted` equals the set of `ordered` exactly; otherwise the
  mutant is `error` with cause `group-coverage-incomplete`. `coveringTests` stays `covering` on
  every path, as today: it names the tests that cover the mutant, not the ones that happened to
  run, and a kill's prefix must not redefine it.

The loop BODY, with every branch R53, R114, R122, 5C-B2 and R194 put there, is otherwise unchanged:
a `fail` still goes to the confirmation rerun (single-test `RunMutant`, no mutant active), a
`timeout` is still `timeout-killed`, a lease answer is still classified before anything else, with
`op-stopped` added beside `result-lost`.

### 3.5 Lost ack of a group call

Reconciled by R194's rules for the op as a unit. `reconcileLostAck` gains a poll-budget parameter:
`runFenced` passes the test's budget for a single-method op (today's numbers), `runFencedMany`
passes `RequestCeilingMs + StopGraceMs` for a group op, and BOTH of its polls (rule 2's
`pollUntilOpClears` and the `again` branch) size their attempts from it the way
`classifyRetryRefusal` already does (`max(OP_POLL_ATTEMPTS, ceil(budget / OP_POLL_DELAY_MS))`), so
a group that is simply still running at 30 s is polled to its end rather than condemned as a
stranded tier. A `completed`/`not-started` reconciliation retries the WHOLE call once as a fresh
attempt from the first method of that call (a chunk, not the mutant's whole set). **Stated
honestly:** the retry's `killingTest` is the retry's first failure; under R197's order that is the
same test unless the suite is flaky, and a flaky suite is what R122 exists to name.

## 4. What does NOT change

- The baseline: per test, with coverage (`RunMutantWithCoverage`), because coverage is per test;
  R192 already stops it repeating on resume. R56's stale-test-app guard lives there and is untouched.
- The kill confirmation: one single-test call with no mutant active.
- al-runner: no `runMany`; the sequential generator is today's loop.
- The fence's rules and R194's reconciliation: an op is an op; a chunk is an op.
- The verdict rules: nothing new can be a kill; `timeout` still requires the 408 after a confirmed
  stop, and nothing else; `error` is never a verdict.
- `coveringTests`: the covering set, on every path.
- NOT unchanged, and stated so nobody infers row parity: a `timeout-killed` mutant's
  `test_results` rows now hold the stopped method only; the methods that passed before it in the
  same call are lost with the answer.
- Every verdict and every `killingTest` on every gate (§8).

## 5. Where this can produce a wrong verdict, and why it does not

- **A stop decided for method k landing on k+1 (F1).** The stop names `(k, token_k)`; the server
  refuses under the lock, reading the row locked, unless it says `k`/`token_k`/`running`. The
  remaining window is between `RunAllTests` returning and the `between` write, which
  `PROGRESS_BETWEEN_FIRST` makes the runner's own return path; it recurs once per method, so a
  survivor with 112 covering tests has 112 such windows in one op, each the same size as today's
  single-method window between a test's end and phase 3, and each ending a method that had
  exceeded its budget. That window has TWO branches, and the design claims only one closed: if
  the session finishes before the stop lands (a CPU-bound tail) the answer is `op-stopped`, an
  `error`, not a kill (§2.3); if the stop lands first (the likely branch after E11, since the tail
  is database work) the 408 scores `timeout-killed` for a method that had passed. That second
  branch is INHERITED from R53 at the single grain, where the window is larger (it includes
  `TestResultsToJSON` and phase 3); R198 makes each window smaller and adds one per method. It is
  R204, with §3.2's after-408 narrowing applied at both grains, and it is not counted among what
  §6 closes.
- **A non-408 after our stop read as a kill (review 2, finding 1; review 3, finding 1).** Not
  scored. Deleted.
- **`killingTest` naming a method the server was not running (review 2, finding 2).** The watchdog
  acts only on our own row and checks its `(index, codeunitId, method)` against the client's
  request before it may fire; it names the method from its own request entry.
- **R53 unreachable inside a long call (review 2, finding 3).** From method 2 on, no method starts
  unless its budget and grace fit inside the ceiling; a method that cannot fit at all is sent
  alone through `RunMutant`; the client's hard cap is the ceiling plus the grace.
- **A still-running group condemned as stranded (review 2, finding 4).** The lost-ack polls use the
  group's budget.
- **A survivor whose chunks skipped tests (review 2, finding 5).** `attempted` must equal
  `ordered`, and only mapped `pass`/`fail` entries join it.
- **A successful stop tearing down the batch as a lease loss (review 3, finding 3; R203).**
  `op-stopped` is scored `error`, no latch.
- **A start-up poll aborting a healthy call (review 3, finding 4).** A row that is not ours is
  "nothing yet".
- **State leaking from method k into k+1 (F5).** Cannot: each method is its own `CODEUNIT.Run`
  under the stock runner, identical to today (E7 passes, E1 shows what the alternative does).
- **A partial or empty answer read as a survivor (F2, F8; review 3, finding 2).** §3.3 refuses it,
  including `ranCount = 0`.
- **A watchdog that never sets `stopFired` (F3).** Inside the transport, sole writer.
- **A stale write reverting the tombstone or the heartbeat (F4).** Own table, one writer, fresh
  `Get` per write; E10 shows a stale write would RAISE, and the loop's boundary would catch it.
- **A stopped session running on unmutated (review 2, finding 12).** The loop reads the marker
  after each `between` commit and runs nothing further.
- **A gateway timing out a long group (F10).** The ceiling bounds the whole call; chunks continue.
- **A loop stalled between methods (review 4, finding 6).** Not scored: the per-method stop cannot
  end it (nothing is `running`), an op-grain stop would name a method that already passed (F1),
  so it is quarantined at the hard cap with the refusal reasons in the note. A deliberate loss of
  an op-grain capability today's single-method path has, in exchange for F1.
- **A pending stop landing on a later request (review 4, finding 2).** Cannot on a container:
  E11 shows session ids are never reused across requests there (over a reused socket, which is
  LethAL's HTTP topology; HTTPS closes the connection per request, which reuses a server session
  strictly less) and a stop lands at the target's next database call; R53 measured a stop on a
  dead id as a no-op. Unmeasured on the hosted sandbox, where the failure direction is a spurious
  quarantine, never a verdict (§2.1).

## 6. What refuses this design

- A gate where any mutant's verdict or `killingTest` differs from its baseline.
- A sequence in which a method's result becomes a verdict without §3.3's assertions passing, or a
  `survived` recorded with `attempted ≠ ordered`.
- A stop scored `timeout` without BC's 408 naming the AL `StopSession` call.
- A verdict for a method the server did not report running.
- A `groupedCalls` count on a gate that differs from the pre-committed number (§8).
- A `lease-lost` latch caused by our own stop.

Not claimed closed: R204's inherited window (§5), narrowed here, and R202.

## 7. Tests that must exist before the gate

- `run-mutant-transport.test.ts`: `run` and `runMany` yield identical `operation` values for the
  same HTTP conditions (the shared classifier); §3.3's assertions each red on a crafted answer
  (missing `endedBy`, `ranCount = 0`, wrong `ranCount`, identity mismatch at entry 2, a `failure`
  whose last entry passed, an entry with result `0`, an entry with two test lines, a
  `lease-invalid` that also carries `runError` classified as the lease answer); the after-408
  narrowing refuses the `timeout` when `lastCompletedIndex >= methodIndex`, at both grains; the
  watchdog's `elapsed` is computed as `serverNow - startedAt` from two values of one server
  transaction, written as `elapsed > budget` so a parse failure (`NaN`) never fires a stop, with a
  test that a skewed client clock and an unparseable `startedAt` both change nothing; the watchdog ignores a row that is not ours (idle
  marker, another op's row, our op not yet claimed) and never fires on it; the identity check on
  our row refuses a foreign method and never fires the stop; the watchdog decides from server
  clocks only; 408 is `timeout`; every other non-2xx after a stop is `in-flight-unknown`;
  `op-stopped` is `error` with no lease-loss classification, at both grains; `method-completed` and
  `no-progress-row` clear `stopFired` and wait; cap yields a continuation; 404 is a hard error; the
  hard cap aborts at ceiling plus grace; a method whose budget cannot fit goes alone through `run`.
- `orchestrator.test.ts`: a differential test, one fake backend with and without `runMany`, the
  same suite of mutants, asserting identical per-mutant verdicts, `killingTest` and
  `coveringTests`; a survivor with N covering tests makes one call, and with
  `--max-methods-per-call 2` makes `ceil(N / 2)` with `attempted = ordered`; a KILL whose killer
  is entry 1 of chunk 2 names the right `killingTest` and confirms against the right test (the
  three index spaces, `ordered`, the chunk's 1..N and the answer's entries, mapped through the
  cursor); a chunk that skips a test yields `group-coverage-incomplete`, never `survived`; a retried
  chunk replaces its original's entries in `attempted`; an unfittable method in the middle of
  `ordered` is dispatched alone at its position and the order is unchanged; a lost group ack polls
  with the group budget and retries once, whole chunk, recording the retry's killer; the two
  budget fields reach their two consumers; `op-stopped` at both grains does not latch, and a
  `lease-invalid` after a force-reset still does.
- `resume.test.ts`: carried verdicts from a grouped run carry the same coverage facts.
- Control app: `alc` compile; a source test pinning `PROGRESS_BETWEEN_FIRST` (the `between` write is
  the first statement after `RunAllTests`), `LOOP_READS_LEASE_ONLY`, and the locked read in
  `TryStopHungRunAt`; `itest:hang` extended: its ON leg's hanging mutant is now scored through
  `RunMutantMany` (one method) + `StopHungRunAt` + the 408, `timeout-killed`, pre-committed by name,
  and its OFF leg keeps both of today's assertions (`deadline-exceeded` on the hanging run, "our
  timer, not BC's stop") through the group abort;
  a second arm with a passing method AFTER the hanging one scores the same `timeout-killed` with
  `killingTest` = the hung method; a stale-index stop is refused.
- Store and report: `test_results` gains `op_kind` (`single` | `many`), and `SessionReport` gains
  `groupedCalls` (count of `RunMutantMany` ops), with the full ripple CLAUDE.md lists (`events.ts`,
  `report-fold.ts`, `report.ts`, `generate-schemas.ts`, `schemas.test.ts`, the `report-equality`
  snapshot, every committed sample report regenerated).
- Live: bcdev 3/12/4, tables 299/63/15 (one expected baseline failure, `untargetedTriggerCount` 0,
  screen `partial`), al-runner 3/16/0, every per-mutant verdict and `killingTest` unchanged, and
  `groupedCalls` equal to the pre-committed NUMBER (§8) on each. A SEPARATE forced-chunk campaign on
  the tables fixture: `--only` one named survivor whose `coveringTests` count `n` is read from the
  frozen report before the run, `--max-methods-per-call 2`, asserting its verdict, `killingTest`
  and `coveringTests` identical to the full run's and `groupedCalls = ceil(n / 2)`; and ONE named
  killed mutant with `n >= 3` whose R197-ordered killer is at position 3 or later (read from the
  frozen report), same flag, asserting the same `killingTest` as the full run, so the chunked KILL
  path, where an index mis-mapping would be a false kill, has a live gate too.
- Sandbox probe (owed before the hosted prediction is read): a `RunMutantMany` of one method that
  sleeps server-side for N seconds, N rising, to pin the gateway ceiling the default is set under.

## 8. Pre-committed numbers

The group path is used for EVERY mutant that reaches the covering loop on a backend with
`runMany`, including one with a single covering test, so the count is derivable from the frozen
baselines: one `RunMutantMany` op per mutant scored `killed`, `survived` or `timeout-killed` on a
container (no chunking, no lost ack, no method with a budget over the ceiling). A lost-ack retry
adds one and is announced by its warning, which makes a differing count something to read, not
absorb.

| what | prediction |
|---|---|
| bcdev / tables / al-runner verdicts | unchanged, every mutant, every `killingTest` |
| `groupedCalls`, bcdev gate | **15** (3 killed + 12 survived; 4 no-coverage never reach the loop) |
| `groupedCalls`, tables gate | **362** (299 killed + 63 survived; 15 no-coverage; 377 deployed) |
| `groupedCalls`, forced-chunk campaign (one survivor, `--max-methods-per-call 2`) | **`ceil(n / 2)`**, `n` read from the frozen report before the run and written into the test |
| `groupedCalls`, forced-chunk campaign (one kill, killer at ordered position `k >= 3`, `--max-methods-per-call 2`) | **`ceil(k / 2)`**, `k` read from the frozen report before the run and written into the test |
| `groupedCalls`, al-runner gate | **0**, which is also what an unwired counter reports: the bcdev 15 and tables 362 carry the anti-inertness, this row only pins that al-runner is untouched |
| hosted Templates slice, survivors | 73 min to 10 to 20 min |
| hosted Templates slice, HTTP calls | ~14,000 to ~2,500 (derivation in §1) |
| verdict moved anywhere | 0 |

---

## Findings of the first review (2026-09-02), and what this draft does with each

| # | finding | here |
|---|---|---|
| F1 | a stop after method k passed scores a false kill | §2.1 per-method refusal under the lock, `PROGRESS_BETWEEN_FIRST`, §2.3, §5 |
| F2 | a partial answer is a survivor | §3.3 completeness, §3.4 `attempted` |
| F3 | watchdog beside the transport never sets `stopFired` | §3.2, inside and sole writer |
| F4 | progress on the lease row via stale `Modify` | §2.1 own table, one writer, fresh `Get`; E10 |
| F5 | isolation across an added `Commit` unmeasured | E3, E7 measured; the stock runner per method, §2.1 |
| F6 | retry re-runs the prefix, `killingTest` retry-dependent; per-test budget for group classification | §3.5 stated, group budget in both polls |
| F7 | `killingTest` from the diagnostic stop answer | §3.2 from the client's request entry, identity-checked on our own row |
| F8 | identity guard has no group form | §3.3 per entry, §3.2 per poll |
| F9 | `budget` missing from the generator tuple | §3.4, two fields |
| F10 | `spent`/`durationMs` undefined; mismatch names the wrong method; 404 reconciles; cap above idle timeout | §2.1 `durationMs` per method; §3.3 per-entry identity; §3.1 hard error; §2.1/§3.2 ceiling |

## Findings of the second review (2026-09-03, revision 1), and what revision 2 did with each

| # | class | finding | revision 2 |
|---|---|---|---|
| 1 | 1 | the R202 rule scores a kill on the stop's own answer, which is a decision, not a termination | narrowed to the progress row (revision 2); DELETED in revision 3, see below |
| 2 | 1 | `killingTest` "cross-check" compared a server value with itself | §3.2: identity checked against the CLIENT's request array; `killingTest` from that entry; status keyed by the marker |
| 3 | 1 | hard cap 450 s above the 360 s ceiling; R53 unreachable for late-starting methods | §2.1 headroom-aware cap on the server; §3.2 hard cap tied to the ceiling |
| 4 | 2 | `reconcileLostAck` polls 8 s; a 240 s group is condemned as stranded | §3.5 poll budget parameter, both polls |
| 5 | 2 | chunks' union never checked against the covering set | §3.4 `attempted = ordered` or `group-coverage-incomplete` |
| 6 | 2 | single-method stops fail the new predicate (no row); added parameters break older clients | §2.1 `RunMutant` writes the row; `StopHungRunAt` is a NEW action; §3.1 both directions |
| 7 | 2 | the F1 window includes `TestResultsToJSON`, once per method | §2.1 `PROGRESS_BETWEEN_FIRST`; §5 states the recurrence honestly |
| 8 | 2 | anti-inertness predicate can quantify over an empty set; no store plumbing; chunking never exercised live | §8 numbers; §7 `op_kind`/`groupedCalls` with the ripple; a forced-chunk arm |
| 9 | 3 | README E7/E8 rows narrated run 1 while the raw file is run 3; race tally uncommitted | README re-synced; 20 rounds recorded with modes (`stop-race.measured.txt`) |
| 10 | 3 | `stoppedAfter` meant three things; `endedBy` unspecified | §2.1 `endedBy` always present; `ranCount` |
| 11 | 3 | `budget` would carry two meanings in the loop body | §3.4 `testBudgetMs` and `groupBudgetMs` |
| 12 | 3 | a stopped session's loop keeps running unmutated for ~4 s and can delete another op's suite | §2.1 marker re-read after each `between`; cleanup delete scoped and confined to the granting branch |

## Findings of the third review (2026-09-03, revision 2), and what revision 3 does with each

| # | class | finding | revision 3 |
|---|---|---|---|
| 1 | 1 | the progress-row rule still kills on "no progress for 5 s", which a slow passing method also shows; no in-hand termination proof but the 408 | **Deleted.** §3.2: only the 408 scores `timeout`; every other answer after a stop is `in-flight-unknown` as today. R202 stays open outside this change |
| 2 | 2 | the headroom check at `i = 1` yields `cap` with `ranCount = 0`, which §3.3 accepts vacuously and §3.4 re-issues forever; the forced-chunk arm cannot be configured by a millisecond ceiling | §2.1 method 1 exempt, server never emits `ranCount = 0`; §3.3 `ranCount >= 1`; §3.4 the client sends an unfittable method alone through `RunMutant`; chunking forced by `--max-methods-per-call`, a count |
| 3 | 3 | `endedBy: displaced` cannot coexist with `status: ran` (phase 3 refuses), so the real outcome is a batch-invalidating `lease-lost` with a wrong note; latent at the single grain today | `displaced` removed from `endedBy`; §2.3 `reason: op-stopped` from phase 3 at both grains; §3.2/§3.4 scored `error`, no latch; filed as R203 |
| 4 | 3 | the watchdog's identity check reads a row it cannot prove is its own; a start-up poll aborts a healthy call; a retried chunk's residual row passes the check | §2.1 `opProgress` carries `attemptId`/`opSeq`; §3.2 "ours first": a row that is not ours is "nothing yet", never an abort, never a stop |
| 5 | 3 | §7 pinned `itest:hang`'s ON leg to a path with no caller; the single-method path has no `MethodToken` | §2.1 `StopHungRunAt` only from `runMany`; single `run` keeps `StopHungRun`; §7 ON leg pins `RunMutantMany` + `StopHungRunAt` + 408; `RunMutant`'s row kept for `GetOperationStatus`'s uniform shape and the long-budget fallback |
| 6 | 3 | recording `coveringTests` from `attempted` redefines a reported fact for every kill | §3.4 `coveringTests = covering` on every path; `attempted` guards `survived` only |
| 7 | 4 | the stop's read of the progress row may see a snapshot, not block on the in-flight `between` write; the marker re-read's transaction unstated | §2.1 `TryStopHungRunAt` reads the row LOCKED inside the lease-locked transaction; the marker re-read is its own transaction AFTER the `between` commit |
| 8 | 4 | §3.3 does not constrain entry results on `complete`; BC's `0` ("not run") could enter `attempted` | §3.3 every entry's result is `1` or `2`; §3.4 only mapped entries join `attempted` |
| 9 | 4 | client hard cap = ceiling on a different clock; a slow dispatch discards an earned 408 | §3.2 client cap = ceiling + grace; default ceiling 300 s so the cap stays under 360 s |
| 10 | 4 | tally denominators not derivable from committed files; §8 mixed two runs; §1's call count underived | §1 derivation; §8 two campaigns, two numbers; README/R202 denominators restated from the committed files (21 of 22 committed, 33 of 34 including the console-only rounds) |

## Findings of the fourth review (2026-09-03, revision 3), and what revision 4 does with each

| # | class | finding | revision 4 |
|---|---|---|---|
| 1 | 2 | `op-stopped` not gated on the credentials; "one field" for a pair; the residue looks like a record; the single grain never writes it | §2.3: two NEW fields written by BOTH stop paths, cleared by force-reset; answered only with the tuple matching, `Op Kind = none`, tombstone at `OpSeq`, and BOTH fields equal; every other refusal reasonless as today |
| 2 | 2 | continuing after `op-stopped` with a `StopSession` still in flight could kill a pooled session serving the next request; unmeasured | **Measured, E11**: the stop lands at the target's next database call (~50 ms; E8's 3.9 s was a pure CPU spin), and session ids are never reused (80 pings, 80 fresh ids), so a pending stop has nowhere to land; §2.3, §5 |
| 3 | 3 | §3.2 misdescribed today's code: a 2xx after a fired stop is parsed and scored | §3.2 restated: 408 → `timeout`; other non-2xx → `in-flight-unknown`; 2xx parsed and scored, `op-stopped` among its outcomes |
| 4 | 2 | §3.3 consumed a weaker guard than §I5's and dropped `identityMismatch` and the inner method check | §3.3: call-level echo, `identityMismatch` rejects the whole call, inner `testResults[0].method` per entry |
| 5 | 3 | `runError` landed in `group-answer-malformed` | §3.3: `runError` checked first, server text verbatim |
| 6 | 3 | a loop stalled between methods is quarantined with a note naming the wrong cause | §3.2 last refusal reason and row state in the note; §5 states the deliberate loss |
| 7 | 3 | the long-budget fallback could reorder `ordered` | §3.4: contiguous chunk, unfittable method alone at its position, cursor never skips |
| 8 | 4 | the chunked KILL path had no test and no gate | §7 unit test (killer at entry 1 of chunk 2) and a second forced-chunk campaign on a named kill; §8 |
| 9 | 4 | the loop's marker read was a second source of `op-stopped` | §2.1/§2.3: phase 3 always runs and is the single source |
| 10 | 4 | §1 omitted the watchdog polls | §1 counts them |

## Findings of the fifth review (2026-09-03, revision 4), and what revision 5 does with each

| # | class | finding | revision 5 |
|---|---|---|---|
| 1 | 1, inherited | the residual F1 window has a false-kill branch (stop lands after the test passed, before `between`), likelier than `op-stopped` after E11; §5 claimed only the benign branch | §5 names both branches; filed as R204 with §3.2's after-408 narrowing at both grains; §6 lists it as not closed |
| 2 | 2 | `runError` checked before `status` could swallow a genuine lease loss after a force-reset | §3.3 classifies in `dispatch`'s order first; §2.3 phase-3 refusals discard `runError` |
| 3 | 2 | echo mismatch and `identityMismatch` were per-mutant errors where today they abort the session | §3.3 two consequences, session-aborting vs per-mutant, both pinned |
| 4 | 3 | E11 measured the fallback, not the designed case; "tens of ms" unlogged; container only | §2.1/§5 scoped to the container, upper bound stated, hosted residue named as a quarantine direction |
| 5 | 3 | new `MutantErrorCause` values ripple unlisted; R203 and §3.2 disagreed on reuse vs new | §3.3 lists the four values and the ripple; `op-stopped` is a distinct value |
| 6 | 3 | §3.2 was stricter than the code it claimed to restate | §3.2 uses the code's predicate at both grains |
| 7 | 3 | the exact-one-test-line guard was dropped | §3.3 keeps it per entry with `runMutantLineCountMessage` |
| 8 | 3 | the OFF-leg abort shape unnamed; `itest:hang` OFF leg unpinned | §3.2 `abortedVerdict` verbatim; §7 OFF leg |
| 9 | 3 | a 404 never reconciled discards today's quarantine record | §3.1 reconcile and quarantine, then abort |
| 10 | 3 | `TryFinishRun` has no `Reason` out-parameter and phase-3 `BuildStatus` hardcodes a blank | §2.3 names the plumbing at both call sites |
| notes | 4 | duplicated clause; `elapsed` arithmetic; `NextSuiteName` per session; al-runner 0 vacuous; §1 "2 s"; `test_results` row parity; a third copy of `dispatch` | §3.4 fixed; §7 `elapsed > budget` with tests; §2.1 suite names; §8 note; §4 row parity; §3.3 shared classifier |

