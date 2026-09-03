# Design: session-warm verdicts and the warm confirmation (R206), with the per-method cost cut (R198 follow-up)

Status: **APPROVED FOR IMPLEMENTATION**, revision 5. Revision 1 was refused (2026-09-03) on ten
findings; revision 2 the same day on nine more (three blocking: the session-freshness premise,
the suite map's key, an unreachable abort channel); revision 3 the same evening on eight (two
blocking: an OFF-mode replay bound that named a branch bcdev never takes, and the provenance of
the per-entry `method` value); revision 4 was judged SAFE with four local corrections (one class
2: the predicate's field was one omission away from being silently zeroed) and five notes, all
applied here as revision 5 and listed at the end. Amends
`2026-09-03-r198-run-mutant-loop.md` §2.1, §3.4 and §5. Second opinion: gpt-5.6-sol,
`scratchpad/pi-sol-run3.md`.

## 1. What was measured, and what it means

Run 3 of the Document Output Templates slice (741 mutants, hosted sandbox): 8 verdicts moved
`survived` → `killed`, all cache code, every killer at position 2 or later of its group call,
every failure a stale-cache assertion; 20 kills kept their verdict with a different killer; 0
moved `killed` → `survived`. Mechanism: each method is its own `CODEUNIT.Run` under Microsoft's
`Test Runner - Isol. Codeunit`, and the DATABASE rolls back per method, **including writes the
test body itself `Commit()`s** (probe E12, measured 2026-09-03 and re-measured the same evening
after the revision-2 review found one of its four data reading the wrong key: a committed row is
absent for the next method in the same call, for the next call, in the row count, and now in the
`k2VisibleAfterRun` read as well), but a `SingleInstance` codeunit's variables live for the
SESSION (Microsoft's `SingleInstance` documentation), a group call is one session, and the
pre-R198 path gave every test a fresh session. `ClearAll` is documented as NOT touching
single-instance codeunits; no AL API resets them. So inside one session the only cold method is
the first, and the database is the same for every method.

**The freshness premise, and where it is measured.** "Every call gets a fresh session" was
measured on a container (probe E11: 80 requests, session ids strictly increasing, none reused).
On the hosted sandbox the SAME PHENOMENON is measured by run 2 against run 3, not the session id:
run 2 ran each covering test in its own request, and the 8 mutants survived there; run 3 killed
them only at positions 2 and later, through a cache the earlier methods of the same call had
populated. In run 2 those same earlier tests ran in the immediately preceding requests. Had the
sandbox handed consecutive requests one session, the cache would have been warm in run 2 and
those mutants killed there. **And the session id itself is measured on the sandbox, from BC's
own words, already in run 3's report:** each of its eight `timeout-killed` mutants carries the
408 text naming the stopped session (`session (ID: N)`): 2037, 2126, 2205, 2316, 2395, 2473,
2624 in scoring order, and 3052 for the one scored in a later resume iteration. Three pairs of
stopped calls had NO mutant scored between them (M0025→M0026, M0038→M0039→M0040) and are 79, 79
and 78 ids apart. Each hang lasted ~185 s (the 180 s budget floor plus the stop), during which the
watchdog polled `GetOperationStatus` every 5 s and the lease renewed every 5 s (TTL 15 / 3): about
37 + 37 requests, plus the stop and the next call, which is the gap. Every one of those requests
received its own session; a platform that pooled a user's web-service sessions would have handed
the polls one session and the gap would be one or two. The two windows WITH mutants scored in
between measure the path the guard is about rather than the poll path: M0026→M0038 is 111 ids with
11 mutants scored between, M0040→M0058 is 151 with 17 (no `no-coverage` in either window); after
the same ~74-79 hang-window requests that leaves about 3.4 and 4.5 fresh ids per scored mutant,
one group call plus one confirmation plus the odd renewal, each its own session. An id that tracks
the count of intervening requests across three window sizes is not being served from a pool. It is
nonetheless a measurement of one run on one environment, and BC's web-service session handling is
not documented as fresh-per-request. **This design therefore does not assume freshness: §2.1
asserts it per call from the server's OWN per-session state, on the first call of a process as on
any other, and a call that did not get a fresh session records an error and never a kill.** Run 4's
`session-reused` count is expected to be 0 BECAUSE run 3 already measured the allocator; that zero
is not a control for the guard (an allocator that hands every request a fresh session yields zero
whether the guard is wired or reads a field the server never sends). The guard's positive control
is the unit test in §6 with a backend that answers a reused session, and the gates' store-level
check that the session ids are live data.

**Ruling this design implements.** A kill is: *the test fails (or exceeds its budget) with the
mutant active, in a session that was fresh at the call's start, where the same ordered prefix of
tests passes (and completes inside budget) without it in another fresh session.* That is the
context the target's own CI runs in (many methods per session) and the product runs in (a warm
cache); the cold-per-test context was an accident of one session per request. The direction of
the residual error is the accepted one: a test that fails only cold hides a kill (a false
survivor), never manufactures one.

## 2. The warm confirmation (what changes in the orchestrator)

### 2.1 The session guard (every call, every op kind)

The control app stamps two numbers on every answer that ran a test method
(`RunMutantWithCoverage`, `RunMutant`, `RunMutantMany` at call level), and `sessionId` on every
`RunMutantMany` entry as well:

- **`testRunsBefore`**: a DEDICATED counter on `LC Control State`, `TestMethodRuns`, with exactly
  ONE writer, `NoteTestMethodRun()` (an increment), called immediately before the runner is
  invoked at each of the two run sites (`LC Run Method`'s `RunAllTests` and `LC Run Many`'s
  `RunTests`), and one reader, read ONCE at the top of `RunMutant` before anything else (the
  coverage action delegates to `RunMutant` and re-opens its JSON, so both answers carry the same
  number from that one read; `RunMutantMany` reads it at its own top). The codeunit is
  `SingleInstance`, so the counter lives exactly as long as the session. **This is the guard's
  predicate.** A fresh session has run no test method and reports 0. A session the platform handed
  to this call after another call had run tests in it reports how many, whatever the id allocator
  did, and on the first test-running call of a process (under `--resume`, R192 reuses the baseline
  snapshot, so that call is a MUTATED one) exactly as on any other: the predicate needs no
  predecessor to compare against. It is NOT the suite-name counter (`SuiteCounter` behind
  `NextSuiteName`): that one exists to name suites, the next cost cut after §4 (one suite per
  session) would stop incrementing it, and `ResetAttestationState`'s comment ("clears every
  in-memory field the instance carries between calls") invites a `:= 0` that would make every
  session read fresh with no test failing anywhere. The dedicated field carries a comment naming
  it as the session-freshness predicate and saying it is never reset, `ResetAttestationState`
  carries the same sentence, and a source test asserts no procedure but `NoteTestMethodRun`
  assigns it and that both run sites call it. **Scope, stated honestly:** the predicate proves no
  test OF OURS ran in this session; it cannot see a test some other consumer ran in a session the
  platform then handed us, a narrower residual than the session id had. **Why it is the property
  and not a proxy for it:** the counter is single-instance state exactly as the target's cache is,
  so it shares the lifetime of the thing it stands for whatever BC's session handling turns out to
  be. If BC ever pooled a session but re-instantiated single-instance codeunits per request, the
  counter would read 0 AND the cache would be empty, both correctly; the guard no longer depends
  on "a `SingleInstance` instance lives per session" being true, which is what closes revision-3
  F3 rather than narrowing it.
- **`sessionId`** (`SessionId()`): recorded on every row as data. Within-call constancy is asserted
  (every entry's id equals the call's), and the gates assert FROM THE STORE that the distinct ids
  among grouped rows equal `groupedCalls` and among single-call rows equal their row count, which
  proves the field is live data rather than a constant. §1's hosted numbers are ids of this kind.

The transport refuses as malformed an answer that ran and lacks either number, or an entry whose
`sessionId` differs from the call's. That check lives INSIDE the `ran` branch, after the `runError`
test, beside `endedBy` and `ranCount`: a phase-1 or phase-3 refusal (`lease-invalid` with any
reason, `artifact-mismatch`, `reserved-params`, a `runError` whose loop raised before running) ran
nothing, carries neither number, and keeps its own class, since reclassifying a confirmed lease
refusal as a per-mutant malformed answer would let the session run on under a lease it cannot
prove. On the SINGLE path (`RunMutant`) the same rule: a `ran` answer without both numbers is a
protocol fault and takes the malformed shape (a call-level error with no cause and no operation,
so the session aborts with the words), never `inFlightUnknown`, which would quarantine a tier and
latch a lease for a wire-shape mismatch; `MIN_CONTROL_VERSION` makes it unreachable in practice
and the baseline is where it would land. **A call with `testRunsBefore > 0` ran in a REUSED
session**, whose state at the call's start was another call's, possibly another mutant's:

- a mutated call (single or many) that fails or times out in a reused session: `error`, cause
  **`session-reused`** (NEW), never a kill; the note names the session id (the thing a reader can
  trace) and the count (which under §4 is the previous call's method count, not a suite count);
- a mutated call that passes in a reused session: `survived` stands (a reused session can hide a
  kill, the accepted direction, never manufacture one) and the rows record it;
- a confirmation of either kind (§2.2) in a reused session: `error`, cause `session-reused`;
- a baseline call: recorded; the first reuse observed anywhere in the session emits a warning
  once (`session-reuse-observed`), so a platform that pools sessions is visible at the top of the
  log, not only in the per-mutant causes. The gates do not subscribe to it; they read the count
  from the report and the ids from the store.

A `SingleInstance` instance lives per session, so "this session has built no suite" is exactly
"this session has run no test", which is the state the ruling in §1 needs. `MIN_CONTROL_VERSION`
moves to the build that stamps both numbers. A backend whose answers carry neither (al-runner: a
process per test, cold by construction) is outside the guard and says so in `capabilities()`. What
`killPosition = 1` then means (§2.4) is asserted, not inferred.

### 2.2 The confirmation

Today a `fail` is confirmed by re-running the killing test ALONE, unmutated, in a fresh session
(cold), and a `timeout` is scored `timeout-killed` on BC's 408 with no confirmation. For a kill of
EITHER kind at group position 1 that stays, under the guard above. For a kill at group position
**k > 1**, both kinds are confirmed the same way:

- **The replay.** Methods 1..k of the call that produced the failure (the `chunkPrefix` the step
  carries: never recomputed from `ordered`, never an earlier call's methods; the `call`-kind step
  carries `methodIndex` from the transport result rather than re-deriving it), in that order,
  unmutated (`activate(null)` first, as today), through ONE `RunMutantMany` call with
  `StopAtFirstFailure` and `confirmation: true`. The answer is asserted by R198 §3.3's rules and
  §2.1's guard before it counts; each entry's `durationMs` is the server's own.
- **A `fail` at k is confirmed** iff the replay answers `endedBy: complete` AND `ranCount = k`
  AND every one of its k entries passed: `killed`, `killingTestFailure` from the mutated run,
  `killPosition = k`. Stated positively on purpose: "every method that ran passed" is satisfied by
  a `cap` answer with one entry, and `entries.every(pass)` is the wrong implementation. If a method
  fails in the replay, two causes, because they are two phenomena:
  - method **j < k** fails: `error`, cause **`warm-prefix-unstable`** (NEW): a prefix method
    fails without the mutant, in the position it had; the suite's own order sensitivity. The note
    names method j and its position; the R26 permissions diagnosis reads entry j's text and names
    entry j's ref.
  - method **j = k** fails: `error`, cause **`unstable`**, today's cause and today's meaning (the
    killer fails without the mutant); `counts.unstable` absorbs it as it does a cold one; the R26
    diagnosis reads entry k's text. The R59 runner-disagreement note is NOT attached from a
    replay: it states that a hub-green test failed unmutated under the hub's own conditions, and
    a failure at position k of a warm session is not those conditions. The cold single-test
    confirmation at position 1 keeps attaching it as today.
- **A `timeout` at k is confirmed** iff the same three conditions hold (complete, `ranCount = k`,
  every entry passed, so entry k is present) AND entry k's replay `durationMs` is inside its own
  budget (`budgetOf(k)`, the cold-measured one): the mutant, not the warm session, made it exceed
  the budget: `timeout-killed`, `killPosition = k`. This is also a NARROWING of R204 for k > 1,
  and the new hang arm's main value: a method that merely finished just after its budget will miss
  its budget unmutated in the replay too, and scores `warm-timeout-unconfirmed` rather than a kill.
  If method k completes unmutated but OUTSIDE its budget, or the replay's own watchdog STOPS
  method k: `error`, cause **`warm-timeout-unconfirmed`** (the same fact either way: unmutated,
  the warm session cannot complete k inside the budget measured cold; a stop is an overshoot the
  poll interval caught, not a different finding, and this precedence is stated so the two
  outcomes cannot compete). If the replay fails or stops before k: as the `fail` case's outcomes,
  with a stop at j < k scored `warm-prefix-unstable` (the prefix does not complete without the
  mutant).
- **The premise a warm timeout rests on.** "Methods 1..k-1 passed with the mutant" is
  server-side only: the mutated call's per-method answers are lost with the 408 (R198 §4), so it
  rests on `LC Run Many` honouring `StopAtFirstFailure` (a mutated failure at j < k would have
  ended the call at j as a `failure`, not run on to k). The client asserts nothing about it, and
  does not need to: the replay establishes that 1..k pass unmutated, which is what the
  confirmation needs.
- **Any other end of the replay** is `error`, never a kill, never a lease latch, with its own
  cause: `endedBy: cap` → **`warm-confirmation-incomplete`** (NEW; the replay is a slower re-run
  on wall clock, so the server's cap can fire on a prefix that fitted once: not a malformed
  answer); a lost ack → R194's rules on the replay as on any group call, and a second loss →
  `result-lost`; a lease answer → classified as today; malformed → the existing
  `group-answer-malformed`; a per-entry fault (`mapRanResult` returning `error`: a result enum
  the client refuses, a line count that does not match) → a call-level error with no cause and no
  operation, which ABORTS THE SESSION exactly as it does on a covering call today; a
  **`stopped-after-completion`** from the replay (R204's narrowing applied by the transport after
  the replay's own 408: the stop landed on method k after its completion was committed) →
  `warm-timeout-unconfirmed`, since the replay could not establish that k completes inside its
  budget, with a note saying the stop happened DURING THE CONFIRMATION REPLAY, never the covering
  call's R204 text, which would describe the mutated run; and the transport's **`abortSession`**
  (a 404 on the action, or the watchdog's identity disagreement) honoured by the replay exactly as
  a covering step honours it: the mutant is recorded and the session aborts at the end of it,
  because a server answering something this request did not ask for is not one to keep scoring
  against.
- **The replay's watchdog and budgets: an ordinary group call, nothing special.** The replay runs
  with the same per-method budgets `budgetOf(i)` the mutated call had, in the same mode the session
  runs in. With `--stop-hung-sessions` the stop hook ends a method that hangs unmutated, and the
  stop is scored above (j < k: `warm-prefix-unstable`; k: `warm-timeout-unconfirmed`). WITHOUT the
  flag the transport aborts at a method's budget exactly as it does on any group call, the abort
  carries `operation: in-flight-unknown`, and `runFencedMany` treats it as a LOST ACK: reconciled
  with the group budget, retried once (a second replay) when the op is proven complete, and
  quarantined when unresolved, which is exactly what today's cold confirmation does in that mode
  (its abort takes `requiresUnsafeLatch` at the confirmation branch, not the quiet
  `deadline-exceeded` branch, which only al-runner's operation-less abort reaches). Revision 3
  claimed a bounded no-quarantine path here and was wrong twice over: that branch is unreachable
  on bcdev, and a session left running at an old `opSeq` makes the NEXT call's `TryBeginRun`
  answer `lease-invalid` with no reason (branch 6), which latches the lease and invalidates the
  batch; there is no "next call's op-in-flight poll", since `op-in-flight` is answered only for the
  same `(attemptId, opSeq)`. So: no special case, no `enforceBudgets` switch, and
  `warm-confirmation-incomplete` is reserved for the clean terminated answer `endedBy: cap`. The
  hard cap (ceiling + grace) stays as the outer bound in both modes, as on every group call.
- The replay does NOT try to reproduce the mutated run's cache contents: same initial state (a
  fresh session, asserted by §2.1; the same database per E12), same stimuli in the same order,
  minus the mutation. A difference that arises because the mutant populated the cache differently
  in an earlier prefix method is a causal, sequence-level kill, and is what this confirmation is
  for.
- The cold single-test confirmation is NOT run in addition for a warm `fail`: the replay subsumes
  it.
- **`spent`.** The replay's k durations are recorded on its rows and are NOT added to the
  mutant's `spent`, exactly as today's cold confirmation's duration is not.

Cost: one extra group call per warm kill, k methods long. **Run 3 had 198 warm kills of 456**,
replaying 1,811 methods in place of 198 single-method cold confirmations (computed from run 3's
store, 2026-09-04). An earlier draft of this line said 28, which was the count of mutants whose
VERDICT OR KILLER differed between run 2 and run 3 (8 + 20) and not the count of kills whose
killer was not first in its call; the two are unrelated, and the correction is recorded in
`2026-09-03-r206-build-precommitment.md`.

### 2.3 Near the server's cap

The server refuses to START a method when `elapsed + budget + grace > ceiling` (R198 §3.2), which
with the 180 s floor and the 300 s / 30 s defaults is `elapsed > 90 s`. A mutated call that
started method k at 89 s can have a replay that would start it at 91 s: `endedBy: cap`,
`warm-confirmation-incomplete`, a kill that becomes an error. Safe direction, stated: on a real
project `warmKills` can differ between two runs by the number of kills near that boundary, and
the row's note says which boundary. The gates are nowhere near it (their longest call is seconds).

### 2.4 `killPosition`

On every `killed` and `timeout-killed`: **one plus the number of test methods that ran before the
killer in the session that ran it**, which is the killer's 1-based position WITHIN ITS CALL. On
the sequential and al-runner paths every call runs one method, so it is 1 by definition, and the
field means the same thing on every path. It is never inferred from which confirmation ran. It
equals the killer's position in `ordered` ONLY when the mutant's covering tests fitted one call;
under `--max-methods-per-call 2` a killer at ordered position 5 is `killPosition 1` of chunk 3,
and the replay's prefix is always the CALL's (`chunkPrefix`), never `ordered`'s. It is a fact
about the order tests ran in, not about session state: the tables fixture, which has no
session-scoped state, kills 13 of 299 mutants at positions 2 to 5 (read from its store, run 334,
2026-09-03, an unchunked run, so those are ordered positions too), because the killer is not
always first in the ledger's order. What
tells a reader the kill was warm is `killPosition > 1` plus the caveat; what tells a reader a
position-1 kill was cold is §2.1's guard. Under `--resume` a carried verdict keeps the
`killPosition` of the run that scored it, and a re-run mutant is scored against a ledger that
started empty, so two mutants in one report can have been ordered by different ledgers; the
field is comparable within one scoring, and the caveat says so.

## 3. What changes on the wire, the client and the record

- **Control app.** `testRunsBefore` and `sessionId` on every test-running answer and `sessionId`
  on every `RunMutantMany` entry (§2.1); every entry also echoes **`lineNo`**, the function line it
  ran, and the client refuses as malformed a call whose entries do not carry distinct line numbers
  (a second guard against §4 item 1's collision, independent of the map's key). `RunMutantMany`
  accepts `MutantId = ''` exactly as `RunMutant` does (phase 1 claims with a blank mutant, nothing
  is activated; `IsActive` on a blank cached id is false); no signature change. A NEW call-level
  status **`suite-unresolved`** with a `reason` (§4 item 1). `MIN_CONTROL_VERSION` → the build that
  carries all of these. `BcDevMcpBackend.runMany` gains `confirmation: true`, which REQUIRES
  `pendingMutantId === null` (a throw otherwise, mirroring the `collectCoverage && pendingMutantId
  !== null` guard). No `enforceBudgets` switch: the replay is an ordinary group call (§2.2).
- **In-memory carriers.** `sessionId?` and `testRunsBefore?` on `TestVerdict` (`backend.ts`), on
  `RunMutantManyResult` and on `CoveringStep`, optional and spread-built (al-runner has neither).
- **Client-side duplicate refusal.** The chunker refuses, before dispatch, a chunk carrying two
  equal `(codeunitId, method)` pairs, naming the mutant: a caller-contract violation (throw), so
  the server's collision check is the second line, not the first.
- **Transport.** `suite-unresolved` is returned as a call-level `error` with NO cause and NO
  `operation`, so the orchestrator's transport-error path aborts the session with the server's
  words (R139/R56's channel), which is where a test app that does not resolve belongs. The branch
  sits BEFORE the `status !== "ran"` fallback and produces no `cause`, since `step.cause` is tested
  first in the loop body and would downgrade the abort to a per-mutant error. A
  `RunMutantManyResult` of kind `call` carries `methodIndex`. The replay's answer feeds
  `args.attestation.clean` exactly as the cold confirmation's does (it is a null-activation run
  that attests).
- **Generator (`coveringRuns`).** Each step carries `groupPosition` (1-based within its call) and
  `chunkPrefix` (the refs 1..position of that call).
- **Loop body.** The `fail` and `timeout` branches: §2.1's guard first; then `groupPosition > 1`
  → the warm confirmation through `runFencedMany`; else today's paths. Both record `killPosition`.
- **Record, the full R86 ripple:** `MutantRow.killPosition?` and a migrated `kill_position`
  column, `test_results.session_id` (`store.ts`); `record()`'s parameter; `mutant-scored` AND
  `mutant-carried` events (`events.ts`); both fold sites (`report-fold.ts`); `MutantOutcome.
  killPosition?` and the report mutant entry (`report.ts`); `CarriedVerdict.killPosition?` and
  both carried-replay call sites (`resume.ts`, `orchestrator.ts`); `explain`'s projection (a path
  pin refuses unknown fields) and its test; the schema (optional, R157's rule) and the
  `report-equality` snapshot; the mutation-elements export leaves it out (no field for it). FOUR
  NEW `MutantErrorCause` values (`session-reused`, `warm-prefix-unstable`,
  `warm-timeout-unconfirmed`, `warm-confirmation-incomplete`) with interpretations, `explain`
  prescriptions and the enum ripple; `counts.unstable` keeps counting `unstable` alone, and the
  banner's error breakdown lists each of the four when non-zero, so a run full of them does not
  read `error N [unstable 0]`. A NEW `Caveat` **`"session-warm"`** on every report with
  `groupedCalls > 0`, whose interpretation states the ruling in §1, that a cold-only kill is a
  survivor here, that a warm kill's `killPosition` is greater than 1, and that a position-1 kill's
  session was asserted fresh by its id (a kill without `killPosition` predates the field, under
  `--resume`). `CAVEAT_INTERPRETATIONS`, `interpretation.test.ts` (17 → 18) and `report.test.ts`
  counts follow. **`warmKills`** on `SessionReport` (optional, beside `groupedCalls`), folded from
  the scored and carried events as the count of `killed`/`timeout-killed` with `killPosition > 1`;
  never derived from a defaulted position. The `unstable` note for a warm j = k gets its own
  wording ("fails unmutated at position k of the replay, warm"), not today's "fails at baseline
  confirmation", which describes a cold-and-alone run nobody made. Ripple per CLAUDE.md: `bun
  scripts/generate-schemas.ts`, `schemas.test.ts` (both the root-required list, unchanged, and the
  older-reports expectation), the `report-equality` snapshot; the committed sample reports are NOT
  regenerated, since both fields are optional and the caveat is an added enum member. **Row parity,
  stated:** a warm kill writes k confirmation rows (`mutantCode: null`, `op_kind: many`) where a
  cold kill writes one; `hang.itest.ts` reads `op_kind` and must expect it.
- **`groupedCalls`** counts every `RunMutantMany` call, replays included (the `group-call` event
  `runFencedMany` emits); the gates pin it as `scored + warmKills`.
- **`--no-group-runs`** stays as the diagnostic mode: cold-per-test verdicts, the old cost.

## 4. The per-method cost (R198 follow-up, control app only)

Run 3 spent ~330 ms per method inside the loop on hosted SQL where a container spends 55 ms. The
loop rebuilds a suite per method: delete the suite and its lines, create, `SelectTestMethodsByRange`
(one line insert per method of the codeunit, 20 to 110 here), `Validate(Run,false)+Modify` on every
line, one `Run = true`, then `RunAllTests` (whose runner does `ModifyAll(Result)` and
`ModifyAll("Error Message Preview")` over EVERY line of the suite, then a Commit, then the result
writes and a Commit), then `TestResultsToJSON` (an `AllObj` query, an installed-app query, a scan
of all function lines, serialize, and the client parses it back). Changes, in order of saving,
keeping one `CODEUNIT.Run` of the test codeunit per method under the stock runner and per-method
results, and keeping BOTH named invariants, which the rebuilt loop must implement itself since it
no longer delegates to `LC Run Method` (so `PROGRESS_BETWEEN_FIRST` has two implementations, both
pinned by the source test in §6, which pins statement order, not behaviour; the `LC Run Method`
copy is exercised by the baseline, the cold confirmation and unfittable methods):

- **`PROGRESS_BETWEEN_FIRST`**: `ProgressBegin` (the `running` write, its own Commit) immediately
  before the run, and `ProgressBetween` as the FIRST statement after `RunTests` returns, BEFORE
  the function line is re-read, before any `CalcFields` on the error BLOBs, before the JSON is
  built. R204's after-408 narrowing reads `lastCompletedIndex`, and anything placed between the
  run's return and that write widens its false-kill branch.
- **`LOOP_READS_LEASE_ONLY`**: the marker re-read after each `between` commit, a plain `Get`,
  unchanged.

1. **Build the suite once per call, keyed on the PAIR.** At the start of every call, delete the
   suite name if it exists (the same delete `RunOneMethod` does; `NextSuiteName` restarts per
   session, so the name recurs across calls and each call cleans the last one's rows),
   `CreateTestSuite`, then `SelectTestMethodsByRange` once per distinct codeunit in the request,
   set every function line `Run = false` once, and resolve every requested **`(codeunitId,
   method)`** to its function line: the map is keyed on the pair, never on the method name alone
   (two test codeunits sharing a method name is ordinary in a BC test app, and neither gate has a
   multi-codeunit suite to catch a name-keyed map). **Validation, before any method runs:** a pair
   that resolves to zero or more than one line, or two pairs that resolve to the same line, REFUSE
   THE CALL: phase 3 tombstones the op as on any answer (no marker strands), and the answer is
   `status: "suite-unresolved"` with a `reason` naming the pair and the count (the text
   `RunOneMethod` uses, "expected exactly one method X, found N", or "pairs A and B resolve to line
   L"). No entry is produced, so the client's per-entry checks are not asked to carry it; the
   transport routes the status to the session abort (§3). Per method: previous function line
   `Run = false`, current `Run = true`: two updates.
2. **Position, then run through `Test Suite Mgt.RunTests(Line, ALTestSuite)` on a record filtered
   to exactly the codeunit header line and the current function line** (`SetFilter("Line No.",
   '%1|%2')` then `FindFirst`, so the record is POSITIONED on the header line before the call:
   `TestRunnerMgt.RunTests` ranges on the record's current `"Test Suite"` value and the runner's
   `OnRun` does `ALTestSuite.Get(Rec."Test Suite")`, and an unpositioned record silently runs
   nothing), not `RunAllTests`, which `Reset`s to the whole suite. Traced in the revision-1 review
   against `scratchpad/bcapps/` and re-traced in the revision-2 review: runner 130450 copies that
   record in `OnRun` BEFORE `TestRunnerMgt.RunTests` mutates its own copy, so `PlatformBeforeTestRun`
   receives the caller's `header|function` filter as `LineNoTestFilter` and `GetTestFunction`
   refuses every function outside it before `Run` is read; the two `ModifyAll`s touch the two
   filtered rows; the runner's codeunit loop finds one header; `GetLineNoFilterForTestCodeunit`
   widens only the module-level `CurrentTestFilter`, which does not reach the admission check.
   Every other function line's `Run` stays false as a second guard. A requested method that
   silently does not run leaves `Result = 0`, which the client's result-enum guard refuses loudly.
3. **Read the result off the FUNCTION line, AFTER `ProgressBetween`:** `Result`, `Start Time`,
   `Finish Time`, and on failure `Test Suite Mgt.GetFullErrorMessage` / `GetErrorCallStack`; build
   the per-method `codeunitResults` JSON in the SAME shape `TestResultsToJSON` produces (`name`,
   `codeUnit`, `result`, `testResults[{method,result,message,stackTrace,startTime,finishTime}]`),
   with the stack trace's `\`→`;` and `"` stripping copied from it, so the client's `mapRanResult`
   and R121's screen see byte-identical text. **Provenance, which is the whole value of the
   client's inner-`method` check (R198 §3.3):** `method`, `result`, `startTime` and `finishTime`
   are READ BACK off the function line record the run was filtered to (`Line.Name`, `Line.Result`,
   ...), exactly as `TestResultsToJSON` reads `FunctionTestMethodLine.Name`; NEVER taken from the
   request. An implementation that writes `One.Add('method', MethodName)` from the request turns
   `mapRanResult`'s `line.method !== ref.method` into a comparison of the request with itself and
   deletes the guard with no change in any count; a source test asserts the `method` key is
   assigned from a record field. The CODEUNIT line's `Result` is never read: under suite reuse
   `UpdateCodeunitLine` scans every function line of the codeunit, earlier methods' results
   included. The entry's `lineNo` is the function line's.
4. `ProgressBegin` inserts the first row fully populated (one write saved per call). The two
   progress commits and Microsoft's two runner commits stay. `RunTestsWithoutLoggingResults` is
   not used (no selection, no result).

`LC Run Method` (the single-method path, the baseline, the cold confirmation) is unchanged.

Expected: 140 to 200 ms per method on the sandbox (sol's estimate). Pre-committed for run 4:
survivors' total below 2,400 s (run 3: 3,165 s) on the same 237 survivors.

## 5. Where this can produce a wrong verdict, and why it does not

- **A kill in a session the platform did not refresh** (revision-2 F1, revision-3 F3). §2.1: the
  server reports its own per-session suite count on every answer, a reused session is
  `session-reused`, never a kill, on every path including position 1, the first call of a resumed
  process, and both confirmations.
- **A warm failure that is the suite's own order sensitivity.** The replay reproduces it without
  the mutant and records `warm-prefix-unstable` (j < k) or `unstable` (j = k).
- **A warm TIMEOUT that is the warm session's own slowness against a cold budget** (revision-1
  F1). The replay must complete method k unmutated inside its budget, or
  `warm-timeout-unconfirmed`; a replay stop on k is the same cause.
- **A replay that runs the wrong prefix.** From the step's own `chunkPrefix`, asserted complete
  and identity-matched before it counts.
- **A replay whose database differs from the mutated run's.** E12: committed writes roll back
  too; the database is the same at every method's start.
- **A replay that a cold-only kill would pass.** A survivor either way under warm semantics; the
  caveat says so.
- **Two requested pairs running one line** (revision-2 F2). The map is keyed on the pair, the
  server refuses a collision before running, and the client refuses duplicate `lineNo`s in one
  answer.
- **Suite reuse leaking a `Run` flag or running an unrequested method.** Every line starts false,
  exactly one is true per method, the runner's filter admits one function line, the identity check
  refuses a method not asked for at that index, and `Result = 0` is refused.
- **The rebuilt loop widening R204's window.** `PROGRESS_BETWEEN_FIRST` pinned on `LC Run Many`.
- **A replay quarantining a healthy tier.** Exactly as today's cold confirmation does and no
  more: with the flag its stop ends the call; without it an abort is a lost ack, reconciled,
  retried once when proven complete, and quarantined only when the op never resolves, which is a
  session that never finished, not a healthy tier. The replay adds no new path to that outcome
  (revision-3 F1 corrected the opposite claim).
- **A blank-mutant `RunMutantMany` outside a confirmation.** The backend refuses it without
  `confirmation: true`, which only the two confirmation branches pass, after `activate(null)`, and
  `confirmation: true` throws on a pending mutant.
- **An entry's `method` echoing the request** (revision-3 F2). §4 item 3: read off the record,
  pinned by a source test.
- **A confirmation satisfied by a short answer** (revision-3 F5). §2.2: complete, `ranCount = k`,
  every entry passed, entry k present.

## 6. Tests that must exist before the gate

- `orchestrator.test.ts`: a fake backend with a SESSION-SCOPED cache (a value that persists across
  methods within one `runMany` call and resets between calls) and monotone session ids, and a
  mutant killed only warm: the group path kills it with `killPosition > 1` after a replay that
  passes; the same suite with a prefix method that fails unmutated warm records
  `warm-prefix-unstable` naming THAT method, and `permissionsRefused` names that method when its
  text matches; the killer itself failing in the replay records `unstable` with no R59 note; the
  sequential path (`--no-group-runs`) records `survived`, the stated semantic difference; a
  position-1 `fail` takes the cold confirmation unchanged; a warm `timeout` whose replay completes
  k inside budget is `timeout-killed` with `killPosition`, one whose replay completes k outside
  budget or is stopped on k is `warm-timeout-unconfirmed`; a replay answering `cap` is
  `warm-confirmation-incomplete`; the replay runs exactly the chunk's prefix when the killer sits
  in chunk 2 under `--max-methods-per-call 2` (this is the chunked warm path's ONLY coverage,
  see the gates below); a resumed run carries `killPosition`. **The guard:** a backend that
  answers `testRunsBefore > 0` records `session-reused` on a failing mutated call, on a position-1
  kill's confirmation, on the FIRST call of a resumed run, and on a replay, and `survived` on a
  passing one, with the warning emitted once; a `suite-unresolved` answer aborts the session with
  the server's reason in the error; a chunk with two equal pairs throws before dispatch naming the
  mutant.
- `run-mutant-transport.test.ts`: a blank-mutant `runMany` round-trips; a `ran` answer without
  `sessionId` or without `testRunsBefore`, an entry whose `sessionId` differs from the call's, and
  two entries with one `lineNo` are each malformed, while a `lease-invalid`, `artifact-mismatch`,
  `reserved-params` or `runError` answer without either number keeps its own class; the same for
  a single `ran` answer; `suite-unresolved` is a call-level error with no cause and no operation.
  **And the guard's own two directions at the boundary:** a `ran` answer with `testRunsBefore = 0`
  and one with `testRunsBefore > 0` each reach the orchestrator with that value on the verdict, so
  the number is proven to TRAVEL, not only to be validated; a transport that always reported 0
  would pass every other test here and disable the guard.
- Report/schema: `killPosition` and `warmKills` optional, `session-warm` present iff
  `groupedCalls > 0`, the four causes in every enum, interpretation counts 18, snapshot updated,
  schemas regenerated, `explain` projection and test, the banner breakdown.
- Control app: `alc`; a source test pinning `PROGRESS_BETWEEN_FIRST` and `LOOP_READS_LEASE_ONLY`
  on `LC Run Many`'s new body as well as `LC Run Method`, the pair-keyed map (the key expression
  names both fields), and the `method` key assigned from a record field (§4 item 3).
  `itest:hang`'s existing verdicts unchanged, its `groupedCalls` pinned as `scored + warmKills`,
  and **a new arm, the only live exercise of a warm timeout**, designed around the kill ledger,
  which is `orderCoveringTests`'s FIRST key and decides these positions before members or names
  do: a target procedure `if Target <= 0 then exit(-1);` followed by `Counter := 0` and the same
  unbounded `repeat Advance() until Counter >= Target` loop as `CountUpTo` (SHARING `Advance()`,
  not a private copy, so the arm adds exactly ONE hang; a copy would add its own `empty-block` and
  `+= 1` `remove-assignment` hangs and the pin would be 7), and TWO tests, T1
  `SpinUntilAtZeroExitsEarly` asserting `-1` from `SpinUntil(0)` and T2 `SpinUntilReachesTheTarget`
  asserting `3` from `SpinUntil(3)`. **The names are load-bearing.** Sharing `Advance()` gives its
  two EXISTING hang mutants T2 as a second covering test, tied with `CountUpToReachesTheLimit` on
  members (2 each) and broken by NAME: `C` < `S`, so the existing rows keep `killPosition 1` and
  their verdicts; a T2 name sorting before `CountUpTo...` would move them to position 2, make them
  warm timeouts needing replays, and change `warmKills` and `groupedCalls`. And `A` < `R` keeps T1
  before T2 on the name key alone, so the arm survives a run under `coverageMode: "none"`, where
  `memberCountsByTest` is empty and the members key ties at infinity. T1 sorts first on
  the empty ledger (fewer members under the gate's fenced coverage, then name) and the guard line
  precedes the loop in manifest order, so every guard-line mutant (`negate-conditional`,
  `conditional-boundary`, `return-value`, the branch and whole-body `empty-block`s) is killed by
  T1 at position 1 FIRST, and from then on the ledger keeps T1 first. The `void-method-call` on
  `Advance()` then passes T1 and hangs on T2: `timeout-killed`, `killPosition 2`, after a replay
  that completes both unmutated inside budget. The loop's other kills (`conditional-boundary` on
  `until`, `loop-truncate`, `return-value` on `exit(Counter)`) are warm `fail`s at position 2 by
  the same order, so the warm `fail` grain is live too. `itest:hang`'s `timeoutKilled.length` pin
  (4, with its reasoning that a fifth hang means a cession stopped holding) becomes 5 with the
  fifth NAMED as this arm's, so the guard's reasoning survives the bump; `counts.errors === 0`
  now also depends on every replay succeeding. Every position of the arm is pre-committed from a
  `--dry-run` manifest (which fixes the manifest order the ledger argument depends on), never from
  the sort keys, in the build's precommitment spec before the run.
- bcdev: 3/12/4, `killingTest` unchanged, **`warmKills` 0** (measured: run 304, 2026-09-03,
  `fixtures/sandbox-app/lethal.sqlite`: all three kills at position 1), `groupedCalls` 15, every
  killed mutant carrying `killPosition`.
- tables: 299/63/15, `killingTest` unchanged, **`warmKills` 13** (measured: run 334, 2026-09-03,
  `fixtures/sandbox-data/lethal.sqlite`: 6 at position 2, 4 at 3, 2 at 4, 1 at 5) and
  `groupedCalls` 375 (362 + 13), and three named mutants' positions pinned from that run: `M0160`
  (batch 0, `ProcessedRequiresCategory`) 5, `M0164` (`FlaggedFiresModifyTrigger`) 4, `M0156`
  (`CategoryGuardNeedsCalcFields`) 2, so the field measures the order and not which branch ran.
  Every killed mutant carries `killPosition`.
- **The chunked warm path has NO live gate.** R198 §7/§8's two forced-chunk campaigns
  (`--max-methods-per-call 2`, `groupedCalls = ceil(n/2)` and `ceil(k/2)`) were never implemented:
  no itest mentions the flag, and R198's roadmap row describes the chunked proof as a differential
  unit test. Under R206 the kill campaign's number would be `ceil(k/2) + 1` when the killer lands
  at chunk position > 1, so revision 2's "keeps R198 §7's two campaigns" was doubly untrue. The
  chunked replay (`chunkPrefix` versus `ordered`, the one place the difference is verdict-bearing)
  is covered by the `orchestrator.test.ts` case above only. Filed as a roadmap gap (R208).
- Every gate: zero `session-reused` in the report, and from the store, SCOPED to the rows that
  came from an answer (a 408 body is not JSON and carries no id, so a `timeout` row has none, as
  does an aborted call's): every row with outcome `pass` or `fail` carries a session id; the
  distinct ids among such `op_kind = many` rows equal the number of group calls that ANSWERED,
  which is `groupedCalls` minus the calls that ended in a 408 or an abort (on the hang gate's ON
  leg, minus `counts.timeoutKilled`, 5); the distinct ids among such single-call rows equal their
  row count. This is the anti-inertness control for `sessionId` now that the predicate is
  `testRunsBefore`: scoped so it holds on all three gates, not softened to "some row has an id".
- Run 4 on the sandbox: the 8 R206 mutants confirmed warm and still `killed`; the 20 changed
  killers unchanged from run 3; zero `session-reused` (the sandbox's own freshness number, §1);
  survivors' total below 2,400 s.

## 7. What refuses this design

- A `killed` or `timeout-killed` at `killPosition > 1` whose replay did not pass every prefix
  method (and, for a timeout, complete method k inside its budget).
- A `killed` or `timeout-killed` whose call, or whose confirmation, ran in a session that had
  built a suite before the call.
- A kill at position 1 confirmed any differently from today (beyond the guard).
- A gate whose `warmKills` or any pinned `killPosition` differs from its number, or whose
  `session-reused` count is not zero.
- Run 4 slower on survivors than run 3.

---

## Findings of the review of revision 4 (2026-09-03), and what revision 5 does with each

Verdict on revision 4: safe to implement, with four local corrections and five notes; no false-kill
door, no rethink.

| # | class | finding | revision 5 |
|---|---|---|---|
| G1 | 2 | the predicate read `SuiteCounter`, a field `ResetAttestationState`'s comment invites clearing and the next cost cut would stop incrementing; either makes every session read fresh with nothing failing | §2.1: a dedicated `TestMethodRuns` with one writer at the run sites, never reset, commented at both places, pinned by a source test; scope and lifetime property stated |
| G2 | 3 | the store-level id check was false on any gate that scores a timeout (a 408 row has no id) | §6: scoped to `pass`/`fail` rows and to calls that answered; not softened |
| G3 | 3 | two replay endings unenumerated: `stopped-after-completion` (would carry the covering call's R204 note) and the transport's `abortSession` | §2.2: the first maps to `warm-timeout-unconfirmed` with a replay-specific note; the second is honoured as on a covering step |
| G4 | 3 | the arm's T2 name decides two EXISTING rows' positions (members tie with `CountUpToReachesTheLimit`), and `Advance()` must be shared | §6: names fixed and stated as load-bearing; `Advance()` shared |
| m1 | 4 | read the counter once, at the top of `RunMutant`, for both actions | §2.1 |
| m2 | 4 | the single-path malformed shape unstated (would land on `inFlightUnknown`) | §2.1: malformed, a session abort, never a quarantine |
| m3 | 4 | the note's count carries no information the boolean does not | §2.1: the note leans on the session id |
| m4 | 4 | `LC Op Progress` already carries `Session Id`, unreturned | noted; not needed by this design |
| m5 | 4 | transport tests validated the value but did not prove it travels | §6: both directions reach the orchestrator |

## Findings of the review of revision 3 (2026-09-03), and what revision 4 does with each

| # | class | finding | revision 4 |
|---|---|---|---|
| F1 | 2 | the OFF-mode replay bound named the quiet `deadline-exceeded` branch, unreachable on bcdev; the "next call's poll" recovery does not exist (a stale op latches the lease) | §2.2: no special case, no `enforceBudgets`; the replay is an ordinary group call whose abort is a lost ack, reconciled, retried once, quarantined when unresolved, as today's cold confirmation; §5 rewritten |
| F2 | 2 | §4 item 3 never said where the entry's `method` value comes from; from the request, the client's inner-method check compares the request with itself | §4 item 3: read back off the function line record, never the request; a source test pins it; §5 |
| F3 | 3 | the guard passed by default on the first call (a mutated one under `--resume`); run 4's zero offered as a control it cannot be | §2.1: the predicate is the server's per-session `suitesBefore`, needing no predecessor; §1 says why run 4's zero is expected and what the controls are; the ids-per-mutant evidence added |
| F4 | 3 | the hang arm ignored the kill ledger (first sort key), so only one of its two positions could be 2 | §6: the guard returns `-1` and T1 asserts it, so T1's kills seed the ledger first; positions pre-committed from a `--dry-run` manifest |
| F5 | 3 | "every method through k passes" is satisfied by a `cap` answer with one entry | §2.2: complete AND `ranCount = k` AND every entry passed; entry k present for the timeout grain |
| F6 | 3 | the malformed rule, read literally, reclassified lease refusals | §2.1: inside the `ran` branch, after `runError`; refusals keep their class |
| F7 | 3 | `killPosition` defined as call-relative and then called an ordered-position fact | §2.4: position within the call; equals the ordered position only when the tests fitted one call |
| F8 | 3 | "keeps R198 §7's two campaigns": they do not exist, and their numbers would change | §6: stated plainly; the chunked warm path is unit-covered only; roadmap R208 |
| n1 | 4 | the session id has no in-memory carrier | §3: `TestVerdict`, `RunMutantManyResult`, `CoveringStep` |
| n2 | 4 | `itest:hang`'s `timeoutKilled.length` 4 pin and `counts.errors` | §6: 5 with the fifth named; errors depend on replays |
| n3 | 4 | the warm j = k note reuses cold wording | §3: its own wording |
| n4 | 4 | the replay's attestation feed unstated | §3: feeds `attestation.clean` as the cold confirmation does |
| n5 | 4 | the warning assertion needs an emit subscriber in every gate | §2.1/§6: gates read the report count and the store ids, not the warning |
| n6 | 4 | duplicate pairs refusable client-side | §3: the chunker throws before dispatch |
| n7 | 4 | `generate-schemas`, `schemas.test.ts`'s older-reports expectation, sample reports | §3: named; samples not regenerated, and why |

## Findings of the review of revision 2 (2026-09-03), and what revision 3 did with each

| # | class | finding | revision 3 |
|---|---|---|---|
| F1 | 2 | freshness measured on a container; `killPosition = 1` published as "cold" on the sandbox | §1 names the hosted evidence (run 2 vs 3, then the 408 session ids) and does not rest on it; §2.1 asserts freshness per call, `session-reused` never a kill (the predicate moved from the session id to `suitesBefore` in revision 4) |
| F2 | 3 | suite map keyed on method name; multi-codeunit suites collide; no gate has one | §4 item 1 keys on the pair and refuses collisions before running; entries echo `lineNo` and the client refuses duplicates; tests in §6 |
| F3 | 3 | the up-front check could not reach the R139 abort channel | §4 item 1 answers a call-level `suite-unresolved`; §3 routes it to the session abort with the server's words |
| F4 | 3 | j = k mislabelled as order sensitivity; R59 note attached unconditionally; `counts.unstable` empty | §2.2 splits j < k (`warm-prefix-unstable`) from j = k (`unstable`); R59 not attached from a replay; banner breakdown |
| F5 | 3 | bcdev `warmKills 0` unsourced | §6 cites run 304 and its store |
| F6 | 3 | §5 "never quarantines" contradicted §2; OFF mode unbounded | §2.2 bounds OFF mode at the sum of budgets, routes to `warm-confirmation-incomplete`, states parity with today; §5 rewritten |
| F7 | 3 | no live warm timeout; stop vs over-budget precedence unstated | §2.2 precedence; §6 hang arm with a passing method first |
| F8 | 3 | `warmKills` consumed but never added | §3 adds it to `SessionReport`, folded from events, never defaulted |
| F9 | 4 | E12's `k2VisibleAfterRun` read key K1 | fixed and re-measured 2026-09-03 20:07 (`e12.measured.txt`, second block); §1 |
| n1 | 4 | `chunkPrefix` for a `call` step | §2.2: `methodIndex` on the `call` result |
| n2 | 4 | blank mutant permitted, not required | §3: `confirmation: true` requires `pendingMutantId === null` |
| n3 | 4 | record unpositioned before `RunTests` | §4 item 2: `FindFirst`, and why |
| n4 | 4 | `UpdateCodeunitLine` under reuse | §4 item 3: the codeunit line's `Result` is never read |
| n5 | 4 | the timeout grain's premise is server-side | §2.2, stated |
| n6 | 4 | a fourth replay ending (per-entry faults) | §2.2: aborts the session as today |
| n7 | 4 | `spent` and the replay's durations | §2.2: not added, as today |
| n8 | 4 | `--resume` mixes two orderings | §2.4, stated in the caveat |
| n9 | 4 | `killPosition` meant two things | §2.4: one definition, session-relative, on every path |
| n10 | 4 | near-boundary cap flake | §2.3 |
| n11 | 4 | new causes not counted | §3: banner breakdown |
| n12 | 4 | two `PROGRESS_BETWEEN_FIRST` implementations | §4 preamble: both pinned, statement order |

## Findings of the review of revision 1 (2026-09-03), and what revision 2 did with each

| # | class | finding | revision 2 |
|---|---|---|---|
| F1 | 1 | `timeout-killed` at a warm position had no control and a cold budget | §2: the same replay, plus method k inside its budget; `warm-timeout-unconfirmed` |
| F2 | 1/2 | `killPosition = 1` on every gate kill was a non-sequitur (tables kills 13 at 2..5) and would be "fixed" vacuously | §2 states it is an ORDER fact; §6 pins `warmKills` as numbers (0 / 13), `groupedCalls` as `scored + warmKills` (15 / 375), and three named positions |
| F3 | 2 | the replay's stop behaviour unspecified; both existing paths end badly | §2/§3: stop hook on with the flag, no per-method budget without it, every replay end enumerated, none a quarantine |
| F4 | 2 | `unstable` reused for a PREFIX failure; diagnoses named the killer | §2: `warm-prefix-unstable`, diagnoses from entry j |
| F5 | 2 | E1/E7 measured uncommitted writes only | E12 measured: committed writes roll back too; §1, §5 |
| F6 | 3 | a replay `cap` called a server fault | §2: `warm-confirmation-incomplete` |
| F7 | 3 | ripple omissions (carried event, resume, explain, row parity) | §3, in full |
| F8 | 3 | the rebuilt loop's invariants unnamed | §4 names both and the ordering; §6 re-points the source test |
| F9 | 3 | a missing method moved to the per-mutant channel | §4 item 1: an entry with `error` and no `testResults` (superseded by revision 3's F3) |
| F10 | 4 | suite lifetime under reuse unstated | §4 item 1: deleted at the start of every call |
