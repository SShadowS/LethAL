# Design: `RunMutantMany`, one call per mutant, a server-side loop of today's single-method run (R198, second draft, revision 2)

Status: DRAFT for adversarial review before any code. Second draft, revised once: revision 1 was
reviewed on 2026-09-03 and refused with twelve findings, all bounded edits to the same design and
no structural change; this revision applies every one and lists them at the end with what
changed. The first draft (`2026-09-02-r198-run-mutant-many.md`) was refused with ten findings,
also listed. Every platform fact this draft rests on was MEASURED on Cronus283 on 2026-09-03
(`scripts/r198-group-runner-probe/README.md`, experiments E1 to E10 and the stop race, raw output
in `results.measured.txt` and `stop-race.measured.txt`); the measurements are cited by experiment
number and the numbers quoted are the committed run's.

## 1. The cost this removes, measured

Run 2 of the Document Output Templates slice (2026-09-03, hosted sandbox, 741 mutants): the 245
survivors cost 73 of 148 minutes, 10,134 test calls at 0.43 s each; the same tests run in ~0.11 s
on a container, so ~0.3 s of every call is the HTTPS round trip and the fence. A survivor runs
every covering test (median 14, p90 112, max 214). The probe's LOOP shape runs a method in ~55 ms
on a container including its suite rebuild (E7, committed run), against ~72 ms for a separate
call on the same container (E7c) and ~430 ms on the sandbox. On a container the saving is ~17 ms
per method; on the sandbox it is the ~0.3 s round trip per method.

**Prediction (pre-committed):** the survivors' 73 minutes become 10 to 20 on the same slice, the
kills' 13 minutes change little (R197 already made most of them one call), no verdict and no
`killingTest` moves on any gate.

## 2. What changes on the server (`extensions/lethal-control`)

### 2.1 A new OData action, `RunMutantMany`

```
RunMutantMany(TargetAppId, ArtifactId, AttemptId, MutantId,
              TestMethods: Text,        /* JSON array of {index, codeunitId, method, budgetMs}, index 1..N */
              StopAtFirstFailure: Boolean,
              RequestCeilingMs: Integer, /* the whole call must answer inside this; see cap */
              StopGraceMs: Integer,
              LeaseEpoch, LeaseToken, ServerGeneration, OpSeq) ResultJson
```

`RunMutant` and `RunMutantWithCoverage` keep their signatures (baseline, kill confirmation, older
clients); `RunMutant` gains ONE behaviour, the progress row (below).

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
- **Three terminations, always named.** `endedBy` is ALWAYS present in the answer with exactly one
  of `"complete"` (every requested method ran), `"failure"` (`StopAtFirstFailure` and a method's
  result was not `2`), `"cap"` (the next method could not be started inside the ceiling, below),
  or `"displaced"` (the loop found the op no longer its own, below). `ranCount` is the number of
  entries in the answer and means one thing in all four cases. The answer lists exactly the
  methods that RAN, in order, each with the same `codeunitResults` shape `RunMutant` returns plus
  `durationMs` measured server-side. Methods after them are NOT in the answer. `BuildStatus`'s
  house rule of omitting blank keys does not apply to `endedBy` or `ranCount`.
- **Cap, headroom-aware.** Before starting method `i` the loop checks
  `elapsedMs + budgetMs[i] + StopGraceMs > RequestCeilingMs`; if so it ends with `endedBy: "cap"`.
  So no method is STARTED whose budget plus the stop's grace cannot be spent inside the ceiling,
  which is what keeps the R53 stop reachable for every method of the call (a stop for a method
  that started at `t` fires at `t + budget` and lands inside `t + budget + grace`, all inside the
  ceiling). A method already running is never interrupted by the cap; `TryStopHungRun` is the only
  thing that ends a running method. With the 180 s floor and a 30 s grace, a 330 s ceiling lets a
  second method start only while `elapsed < 120 s`; the client continues with a new call (§3.4).
- **Progress in its own table, `LC Op Progress`**, one row per op, key `(Attempt Id, Op Seq)`:
  `Method Index`, `Method Codeunit Id`, `Method Name`, `Method Token` (a fresh GUID per method),
  `Started At` (server `CurrentDateTime`), `Last Completed Index`, `Session Id`, `State`
  (`running` | `between` | `done`). Written ONLY by the session that runs the op, and only by fresh
  `Get`/`Insert` per write, never from a record held across a method (F4; E10). Sequence per
  method: before it, `State := running`, method fields, fresh token, `Commit()`; **immediately when
  `RunAllTests` returns, before `TestResultsToJSON` or anything else**, `Last Completed Index := i`,
  `State := between`, `Commit()` (this ordering is a named invariant, `PROGRESS_BETWEEN_FIRST`,
  pinned by a test on the AL source: the smallest window between a method's end and the row
  saying so). E3/E7 measured that commits between test runs carry nothing of the test's writes.
  `TryFinishRun` sets `State := done` in its transaction. **`RunMutant` (single method) writes the
  same row** with index 1, so the stop's predicate below is uniform and an ABSENT row is always a
  refusal, never a pass. A row that is missing mid-loop (deleted under the loop) is a `runError`
  (`progress-row-missing`); the loop never re-creates it.
- **Cleanup of old rows** happens only in `AcquireLease`'s GRANTING branch, under the lease lock,
  and deletes only rows with `Op Seq <= Last Completed Op Seq` of the lease being granted: a live
  op's row is never deleted by a competing acquire.
- **The loop never touches `LC Lease` during phase 2** except one READ after each `between` write:
  if the marker no longer names its own `(Attempt Id, Op Seq)` as the active run (the op was
  stopped, tombstoned or force-reset while a method was finishing), the loop ends with `endedBy:
  "displaced"` and runs nothing further. This is what stops a stopped session from running the
  next method unmutated in the ~4 s before `StopSession` takes effect (E8 measured that latency),
  and from deleting a suite a newly admitted op is using. Named invariant `LOOP_READS_LEASE_ONLY`.
- **`GetOperationStatus`** adds `opProgress: {methodIndex, codeunitId, method, token, startedAt,
  lastCompletedIndex, state}` and `serverNow`, read in one transaction, for the row keyed by the
  MARKER's own `(Op Attempt Id, Op Seq)`, never a `FindLast`; when the marker is idle it reports
  the row for the last tombstoned op, keyed the same way, so a reconciliation can read the state
  a stopped session left.
- **A NEW action `StopHungRunAt(…, MethodIndex, MethodToken)`** beside `StopHungRun`, which keeps
  its signature and its op-grain behaviour for older clients (R58's reasoning: BC validates an
  action's request shape before its body runs, so adding parameters to `StopHungRun` would turn
  every stop from an older client into a 400). `TryStopHungRunAt`, under the lease lock it
  already takes, refuses unless ALL of: the marker is our `(AttemptId, OpSeq)` and not tombstoned
  (today's checks); the progress row exists and reads `Method Index = MethodIndex`, `Method Token =
  MethodToken`, `State = running`. A mismatch is `method-completed`; a missing row is
  `no-progress-row`; both in `reason`. Only then it stops the recorded session and tombstones the
  op, as today. E8 measured the miniature: a stop asked for a finished method is refused, a stop
  for the running one ends the session and the held call returns within 4 s. Lock order everywhere
  is lease then progress; the loop takes only progress.
- **Attestation** is read once after the loop, an OR over everything that executed under this
  activation, which is what `guardObserved` means per mutant.
- **`HarnessInfo`** bumps `semver` to `1.0.0.17`; `protocolVersion` stays (added actions, one
  added behaviour that no older client observes).

### 2.2 What the server never does

- Never runs two methods under one suite run (E1).
- Never writes progress from a runner trigger (the stock runner is used unchanged).
- Never interrupts a running method except through `TryStopHungRunAt`.
- Never returns a method it did not run, and never omits `endedBy` or `ranCount`.

## 3. What changes on the client (`packages/runner`)

### 3.1 Version gate, both directions

`MIN_CONTROL_VERSION` 1.0.0.17 in lockstep with `app.json` (R28's test pins the pair). A control app
without the actions is refused by the existing version gate before any call. A 404 on
`LethALControl_RunMutantMany` or `_StopHungRunAt` after the gate passed is a **hard error**
(`control-app-route-missing`), never reconciled, never retried. The other direction, a NEW server
with an OLDER client, keeps working unchanged: `RunMutant` and `StopHungRun` keep their
signatures, and the progress row `RunMutant` now writes is invisible to a client that never asks.

### 3.2 `RunMutantTransport.runMany(req)`: the watchdog lives INSIDE it

One POST, the same fence coordinates as `run`, the same classified exits. While the request is
open, the transport itself polls `GetOperationStatus` every `WATCHDOG_POLL_MS` (5 s) on a second
connection and is the SOLE writer of `stopFired`:

- **Identity first.** On every poll, `opProgress.methodIndex` must be in `1..N` and
  `opProgress.codeunitId`/`method` must equal `req.methods[methodIndex - 1]`'s, checked against
  the CLIENT's own request array. A disagreement means the server is running something this
  request did not ask for at that index (a chunk-relative/absolute mix-up, an off-by-one, another
  op's row): the transport aborts the request and returns `in-flight-unknown` with the disagreement
  in `failureMessage`. No stop is fired on a row that fails this check.
- From `opProgress.startedAt` and `serverNow` (server clocks only) it computes the running method's
  `elapsed`. When `elapsed > req.methods[methodIndex - 1].budgetMs` and `--stop-hung-sessions` is
  on, it fires `StopHungRunAt(methodIndex, token)` ONCE and records `stopDecision = {methodIndex,
  token, codeunitId, method}` from its OWN request entry. The hook's answer is kept.
- `method-completed` or `no-progress-row` means the group moved on (or ended) between the poll and
  the stop: the transport clears `stopFired`, keeps waiting, and may decide again for a later
  method. `already-completed` means the op finished: keep waiting for the answer. Any other refusal
  or a throw is kept as `stopHookError` for the quarantine note (today's rule).
- Without `--stop-hung-sessions`, a method over its budget aborts the request at that moment
  (`in-flight-unknown`, reconciled by the orchestrator: rule 2, ours and active, polled with the
  GROUP budget, §3.5).
- **Hard cap, below the ceiling.** The request is aborted at `RequestCeilingMs` (the same value
  sent to the server), which the caller sets below the gateway's idle timeout (§3.4). Because the
  server never starts a method that cannot finish its budget and grace inside the ceiling, this
  abort fires only if the server's own cap logic failed, and it is scored `in-flight-unknown`.

**Scoring the held request after a stop:**

- `stopFired`, hook answered `stopped: true`, response 408 and `isAlStopResponse`: `timeout`,
  today's rule, unchanged.
- `stopFired`, hook answered `stopped: true`, response any OTHER non-2xx (R202: measured 1 in 33,
  a 400 "Cannot establish a connection to the SQL Server/Database"): the stop's answer is a
  DECISION, not a termination (`TryStopHungRun`'s own comment: "the stop does not prove anything
  by itself"), so the transport does not score from it. It polls `GetOperationStatus` twice, one
  `WATCHDOG_POLL_MS` apart, and requires BOTH reads to show the op tombstoned at our `OpSeq` AND
  the progress row still at `(stopDecision.methodIndex, stopDecision.token)` with
  `lastCompletedIndex < methodIndex` (a session that really died inside method k never writes
  `between` for k; a session still alive advances the row). Only then `timeout`, with BC's status
  and body in `failureMessage`. Anything else stays `in-flight-unknown`, reconciled as today. The
  same rule applies to the single-method `run`, which now has a progress row to read.
- `stopFired` but the hook did NOT confirm (refused, threw, or unanswered when the response
  arrives): the response is scored on its own merits, and a non-2xx is `in-flight-unknown`.

The `timeout` verdict names `killingTest` = `stopDecision.method`, taken from the client's request
entry at the index it decided on, which the identity check above already tied to the server's
row. The methods that ran before it are lost with the answer (the verdict does not need them: the
mutant is `timeout-killed` by that method); their `test_results` rows are not written.

### 3.3 The answer is asserted before it becomes verdicts

`GroupVerdict` is built only if ALL hold, otherwise the mutant is `error` with cause
`group-answer-malformed` and the answer text recorded, never a per-method verdict:

- `status = ran`, `endedBy` present and one of the four values, `ranCount` present;
- the answer's methods are a PREFIX of the request: entry `i` has index `i`, and the same
  `codeunitId` and `method` as request entry `i` (the §I5 identity guard, per entry), and there are
  exactly `ranCount` entries;
- `endedBy = complete` implies `ranCount = N`; `endedBy = failure` implies entry `ranCount`'s result
  is not `2` and every earlier entry's is `2`; `endedBy = cap` or `displaced` implies every entry's
  result is `2` (a failure would have ended the loop as `failure`);
- each entry carries `codeunitResults` for exactly its own method and a `durationMs`.

Three of thirty-five methods returned, all passing, with `endedBy = complete` is therefore an
`error`, not a survivor. `endedBy = displaced` is scored like `cap` (the ran prefix is real) and
the continuation call is issued, which then meets the fence's own answer for the displaced op.

### 3.4 The mutant loop consumes a sequence either way, and a survivor must have been attempted in full

`runMutantsOnBackend`'s covering loop iterates `for await (const step of coveringRuns(m, ordered,
budgets))`. The generator yields `{ ref, verdict, lostAck, retried, retryAfter, original,
testBudgetMs, groupBudgetMs }` per test: `testBudgetMs` is the per-test budget the quarantine text
quotes ("raise the floor with `--mutant-timeout-ms`"), `groupBudgetMs` is what `classifyRetryRefusal`
and the lost-ack polls use (§3.5). Two meanings, two fields.

- backend WITHOUT `runMany` (al-runner): one `runFenced` per test, byte-for-byte today's loop;
- backend WITH it: `runFencedMany` for the ordered covering set with `StopAtFirstFailure: true`,
  `RequestCeilingMs = REQUEST_CEILING_MS` (default 330 s, below the 360 s hosted-proxy ceiling
  recorded at `orchestrator.ts` "360 s is the hosting proxy's own ceiling" from the first field
  run; configurable with `--request-ceiling-ms`, and to be pinned on the sandbox by a probe that
  sleeps server-side, listed in §7) and `StopGraceMs = 30 s`, yielding each returned method's
  verdict in order; on `endedBy = cap` or `displaced` it issues the NEXT call for the methods after
  `ranCount` (a new op, new opSeq, indices renumbered from 1 for that call and mapped back by the
  generator's own cursor into `ordered`) and keeps yielding; on `timeout` it yields the timeout
  verdict for the stopped method and stops.
- **Attempted set.** The generator keeps `attempted: Set<testKey>` of every method a call REPORTED
  as run. Before `survived` can stand, the loop body asserts `attempted` equals the set of
  `ordered` exactly; otherwise the mutant is `error` with cause `group-coverage-incomplete`.
  `coveringTests` is recorded from `attempted`, not from `covering`, on every path (today's
  unconditional `covering.map(qualifiedTestName)` moves behind this).

The loop BODY, with every branch R53, R114, R122, 5C-B2 and R194 put there, is otherwise unchanged:
a `fail` still goes to the confirmation rerun (single-test `RunMutant`, no mutant active), a
`timeout` is still `timeout-killed`, a lease answer is still classified before anything else.

### 3.5 Lost ack of a group call

Reconciled by R194's rules for the op as a unit. `reconcileLostAck` gains a poll-budget parameter:
`runFenced` passes the test's budget for a single-method op (today's numbers), `runFencedMany`
passes `RequestCeilingMs` for a group op, and BOTH of its polls (rule 2's `pollUntilOpClears` and
the `again` branch) use it instead of the fixed 8 attempts, so a group that is simply still running
at 30 s is polled to its end rather than condemned as a stranded tier. A `completed`/`not-started`
reconciliation retries the WHOLE call once as a fresh attempt from the first method of that call
(a chunk, not the mutant's whole set). **Stated honestly:** the retry's `killingTest` is the retry's
first failure; under R197's order that is the same test unless the suite is flaky, and a flaky
suite is what R122 exists to name.

## 4. What does NOT change

- The baseline: per test, with coverage (`RunMutantWithCoverage`), because coverage is per test;
  R192 already stops it repeating on resume. R56's stale-test-app guard lives there and is untouched.
- The kill confirmation: one single-test call with no mutant active.
- al-runner: no `runMany`; the sequential generator is today's loop.
- The fence's rules and R194's reconciliation: an op is an op; a chunk is an op.
- The verdict rules: nothing new can be a kill; `timeout` still requires a CONFIRMED stop AND, off
  the 408 path, the progress row's proof of death; `error` is never a verdict.
- Every verdict and every `killingTest` on every gate (§8).

## 5. Where this can produce a wrong verdict, and why it does not

- **A stop decided for method k landing on k+1 (F1).** The stop names `(k, token_k)`; the server
  refuses under the lock unless the progress row says `k`/`token_k`/`running`. The remaining window
  is between `RunAllTests` returning and the `between` write, which `PROGRESS_BETWEEN_FIRST` makes
  the runner's own return path and nothing else; it recurs once per method, so a survivor with 112
  covering tests has 112 such windows in one op, each the same size as today's single-method
  window between a test's end and phase 3, and each ending a method that had exceeded its budget.
- **A gateway error after our stop read as a kill (review 2, finding 1).** Not from the stop's
  answer: only from the progress row proving the session never advanced, across two polls.
- **`killingTest` naming a method the server was not running (finding 2).** The watchdog checks
  the server's `(index, codeunitId, method)` against the client's request before it may fire, and
  names the method from its own request entry.
- **R53 unreachable inside a long call (finding 3).** No method starts unless its budget and grace
  fit inside the ceiling; the client's hard cap is the ceiling itself, below the gateway's.
- **A still-running group condemned as stranded (finding 4).** The lost-ack polls use the group's
  budget.
- **A survivor whose chunks skipped tests (finding 5).** `attempted` must equal `ordered`.
- **State leaking from method k into k+1 (F5).** Cannot: each method is its own `CODEUNIT.Run`
  under the stock runner, identical to today (E7 passes, E1 shows what the alternative does).
- **A partial answer read as a survivor (F2, F8).** §3.3 refuses it.
- **A watchdog that never sets `stopFired` (F3).** Inside the transport, sole writer.
- **A stale write reverting the tombstone or the heartbeat (F4).** Own table, one writer, fresh
  `Get` per write; E10 shows a stale write would RAISE, and the loop's boundary would catch it.
- **A stopped session running on unmutated (finding 12).** The loop reads the marker after each
  `between` write and ends as `displaced`.
- **A gateway timing out a long group (F10).** The ceiling bounds the whole call; chunks continue.

## 6. What refuses this design

- A gate where any mutant's verdict or `killingTest` differs from its baseline.
- A sequence in which a method's result becomes a verdict without §3.3's assertions passing, or a
  `survived` recorded with `attempted ≠ ordered`.
- A stop scored `timeout` whose hook did not answer `stopped: true`, or, off the 408 path, whose
  progress row advanced.
- A verdict for a method the server did not report running.
- A `RunMutantMany` op count on a gate that differs from the pre-committed number (§8).

## 7. Tests that must exist before the gate

- `run-mutant-transport.test.ts`: §3.3's assertions each red on a crafted answer (missing
  `endedBy`, wrong `ranCount`, identity mismatch at entry 2, a `failure` whose last entry passed);
  the identity check refuses a row naming another method and never fires the stop on it; the
  watchdog decides from server clocks only (a skewed client clock changes nothing); 408 is
  `timeout`; 400-after-confirmed-stop is `timeout` only when two polls show the row unmoved and
  `in-flight-unknown` when the row advanced or the op is not tombstoned; unconfirmed-stop 400 is
  `in-flight-unknown`; `method-completed` and `no-progress-row` clear `stopFired` and wait; cap and
  `displaced` yield a continuation; 404 is a hard error; the hard cap aborts at the ceiling.
- `orchestrator.test.ts`: a differential test, one fake backend with and without `runMany`, the
  same suite of mutants, asserting identical per-mutant verdicts, `killingTest` and
  `coveringTests`; a survivor with N covering tests makes one call, and with a forced small
  ceiling makes `ceil` chunks with `attempted = ordered`; a chunk that skips a test yields
  `group-coverage-incomplete`, never `survived`; a lost group ack polls with the group budget and
  retries once, whole chunk, recording the retry's killer; the two budget fields reach their two
  consumers.
- `resume.test.ts`: carried verdicts from a grouped run carry the same coverage facts.
- Control app: `alc` compile; a source test pinning `PROGRESS_BETWEEN_FIRST` (the `between` write is
  the first statement after `RunAllTests`) and `LOOP_READS_LEASE_ONLY`; `itest:hang` extended with a
  hang INSIDE a group (a second method after the hanging one) scoring `timeout-killed` with
  `killingTest` = the hung method, and a stale-index stop refused, both pre-committed by name; the
  ON leg's single-method mutant still `timeout-killed` through `StopHungRunAt` with the row
  `RunMutant` now writes.
- Store and report: `test_results` gains `op_kind` (`single` | `many`), and `SessionReport` gains
  `groupedCalls` (count of `RunMutantMany` ops), with the full ripple CLAUDE.md lists (`events.ts`,
  `report-fold.ts`, `report.ts`, `generate-schemas.ts`, `schemas.test.ts`, the `report-equality`
  snapshot, every committed sample report regenerated).
- Live: bcdev 3/12/4, tables 299/63/15 (one expected baseline failure, `untargetedTriggerCount` 0,
  screen `partial`), al-runner 3/16/0, every per-mutant verdict and `killingTest` unchanged; and
  `groupedCalls` equal to the pre-committed NUMBER (§8), asserted as a number so an empty set cannot
  satisfy it; the tables gate additionally runs one survivor with `--request-ceiling-ms` forced low
  enough to chunk and asserts its verdict, `killingTest` and `coveringTests` identical to the
  one-chunk run, so the continuation path has a live gate.
- Sandbox probe (owed before the hosted prediction is read): a `RunMutantMany` of one method that
  sleeps server-side for N seconds, N rising, to pin the gateway ceiling the default is set under.

## 8. Pre-committed numbers

The group path is used for EVERY mutant that reaches the covering loop on a backend with
`runMany`, including one with a single covering test, so the count is derivable from the frozen
baselines: one `RunMutantMany` op per mutant scored `killed`, `survived` or `timeout-killed` on a
container (no chunking, no lost ack). A lost-ack retry adds one and is announced by its warning,
which makes a differing count something to read, not absorb.

| what | prediction |
|---|---|
| bcdev / tables / al-runner verdicts | unchanged, every mutant, every `killingTest` |
| `groupedCalls`, bcdev gate | **15** (3 killed + 12 survived) |
| `groupedCalls`, tables gate | **362** (299 killed + 63 survived), plus 1 for the forced-chunk survivor's second chunk |
| `groupedCalls`, al-runner gate | **0** |
| hosted Templates slice, survivors | 73 min to 10 to 20 min |
| hosted Templates slice, calls | 17,300 to under 4,000 |
| verdict moved anywhere | 0 |

---

## Findings of the first review (2026-09-02), and what this draft does with each

| # | finding | here |
|---|---|---|
| F1 | a stop after method k passed scores a false kill | §2.1 per-method refusal under the lock, `PROGRESS_BETWEEN_FIRST`, §5 |
| F2 | a partial answer is a survivor | §3.3 completeness, §3.4 `attempted` |
| F3 | watchdog beside the transport never sets `stopFired` | §3.2, inside and sole writer |
| F4 | progress on the lease row via stale `Modify` | §2.1 own table, one writer, fresh `Get`; E10 |
| F5 | isolation across an added `Commit` unmeasured | E3, E7 measured; the stock runner per method, §2.1 |
| F6 | retry re-runs the prefix, `killingTest` retry-dependent; per-test budget for group classification | §3.5 stated, group budget in both polls |
| F7 | `killingTest` from the diagnostic stop answer | §3.2 from the client's request entry, identity-checked |
| F8 | identity guard has no group form | §3.3 per entry, §3.2 per poll |
| F9 | `budget` missing from the generator tuple | §3.4, two fields |
| F10 | `spent`/`durationMs` undefined; mismatch names the wrong method; 404 reconciles; cap above idle timeout | §2.1 `durationMs` per method; §3.3 per-entry identity; §3.1 hard error; §2.1/§3.2 ceiling |

## Findings of the second review (2026-09-03, revision 1), and what revision 2 does with each

| # | class | finding | revision 2 |
|---|---|---|---|
| 1 | 1 | the R202 rule scores a kill on the stop's own answer, which is a decision, not a termination | §3.2: only the progress row's proof of death, across two polls; R202 rewritten to say so |
| 2 | 1 | `killingTest` "cross-check" compared a server value with itself | §3.2: identity checked against the CLIENT's request array before any stop; `killingTest` from that entry; status keyed by the marker, no `FindLast` |
| 3 | 1 | hard cap 450 s above the 360 s ceiling; R53 unreachable for late-starting methods | §2.1 headroom-aware cap on the server; §3.2 hard cap = the ceiling; default 330 s |
| 4 | 2 | `reconcileLostAck` polls 8 s; a 240 s group is condemned as stranded | §3.5 poll budget parameter, both polls |
| 5 | 2 | chunks' union never checked against the covering set | §3.4 `attempted = ordered` or `group-coverage-incomplete`; `coveringTests` from `attempted` |
| 6 | 2 | single-method stops fail the new predicate (no row); added parameters break older clients | §2.1 `RunMutant` writes the row; `StopHungRunAt` is a NEW action; §3.1 both directions |
| 7 | 2 | the F1 window includes `TestResultsToJSON`, once per method | §2.1 `PROGRESS_BETWEEN_FIRST`; §5 states the recurrence honestly |
| 8 | 2 | anti-inertness predicate can quantify over an empty set; no store plumbing; chunking never exercised live | §8 numbers; §7 `op_kind`/`groupedCalls` with the ripple; forced-chunk survivor on the tables gate |
| 9 | 3 | README E7/E8 rows narrated run 1 while the raw file is run 3; race tally uncommitted | README re-synced to the committed run; 20 more rounds recorded with modes (`stop-race.measured.txt`): 32 of 33 answered 408, the 400 was GROUP mode 10 s after a publish |
| 10 | 3 | `stoppedAfter` meant three things; `endedBy` unspecified | §2.1 `endedBy` always present, four values; `ranCount` |
| 11 | 3 | `budget` would carry two meanings in the loop body | §3.4 `testBudgetMs` and `groupBudgetMs` |
| 12 | 3 | a stopped session's loop keeps running unmutated for ~4 s and can delete another op's suite | §2.1 marker re-read after each `between`, `endedBy: displaced`; cleanup delete scoped and confined to the granting branch |
