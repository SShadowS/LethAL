# Design: `RunMutantMany`, one fenced call per mutant instead of one per covering test (R198)

Status: **REFUSED AS DRAFTED** by adversarial review, 2026-09-02. Not implemented. The review found
three ways the draft produces a wrong verdict and one way its headline mechanism silently does
nothing; two of the fixes are platform probes that must run before a second draft. Sections 1 to 8
are the draft as reviewed, unedited; the review and the prerequisites follow.

## 1. The cost this removes

Measured 2026-09-02 on a hosted sandbox (R198's row): 9,963 fenced `RunMutant` calls at 0.46 s
each, against 0.11 s for the same tests on a container. The test is the smaller part of a hosted
call; the round trip, the TLS handshake (R194 half 1 made every request a fresh connection) and
the fence's three phases are the rest. A survivor ran 35 covering tests on average and cost 17 s;
196 survivors cost 55 minutes against 26 for 296 kills. R197 cut the kill side by trying the
likely killer first; nothing cuts the survivor side, because a survivor must run every test.

## 2. What changes on the server

**A new OData action, `RunMutantMany`**, beside `RunMutant` (which stays, unchanged, for the
baseline's coverage runs and for any client that never learns the new one):

```
RunMutantMany(TargetAppId, ArtifactId, AttemptId, MutantId,
              TestMethods: Text /* JSON array of {codeunitId, method} */,
              StopAtFirstFailure: Boolean,
              LeaseEpoch, LeaseToken, ServerGeneration, OpSeq) ResultJson
```

- **One fence for the group.** Phase 1 (`TryBeginRun`) claims ONCE with the group's
  `(attemptId, opSeq)`; phase 3 (`TryFinishRun`) verifies and clears ONCE. The group is one op.
  Everything design §5 and R194 say about an op (lost ack, reconciliation, retry once, late
  original) applies to the group as a unit.
- **Phase 2 runs each method as its own `RunOneMethod`**, i.e. its own suite build and its own
  `Test Suite Mgt.RunAllTests`, exactly as `RunMutant` runs one. This is deliberate and is the
  cost this design does NOT remove: selecting all N methods into one suite run would share one
  codeunit-isolation scope across them, which is not how LethAL has scored any mutant to date,
  and a verdict that changed for that reason would be a regression the baselines could not
  explain. What is removed is the round trip, the handshake and the fence per test.
- **Stop at first failure** when asked: the loop ends after the first method whose result is
  not `pass`. The response lists the methods that RAN, in order, each with the same
  `codeunitResults` shape `RunMutant` returns, plus `stoppedAfter` (the index of the failing
  method, or -1).
- **Progress on the lease row.** Two new fields, `Op Current Test` (Text[250], `codeunitId.method`)
  and `Op Current Test Started At` (DateTime), written with a `Modify` and `Commit` before each
  method starts, inside phase 2, outside the lock (phase 2 already commits between methods, see
  `LC Run Method`'s doc comment). `TryFinishRun` and `TryStopHungRun` clear them in their one
  transaction. `GetOperationStatus` reports them as `opCurrentTest` and `opCurrentTestStartedAt`;
  `StopHungRun` reports `currentTest` in its result, read before it clears.
- **Attestation** is read once after the loop, as `RunMutant` reads it once after its one run:
  `AttestationObservedAny` is an OR over everything that executed under this activation, which is
  what the client's per-mutant `guardObserved` already means.
- **`RunMutant` itself** does not change. `HarnessInfo` bumps `semver` to `1.0.0.17`;
  `protocolVersion` stays: an added action breaks no existing wire contract (the same reasoning
  R58's `RunMutantWithCoverage` used).

## 3. What changes on the client

- `MIN_CONTROL_VERSION` 1.0.0.17, in lockstep with `app.json` (R28's test pins the pair). An older
  control app is refused by the existing version gate with the existing message. The three gate
  containers and Cronus28 are republished before any gate runs.
- `RunMutantTransport.runMany(req)`: one POST to `LethALControl_RunMutantMany`, the same fence
  coordinates as `run`, the same classified exits (`in-flight-unknown` with `fencedOp`,
  `lease-lost` with reason, the 408 stop path). Its answer is a `GroupVerdict`: the per-method
  `TestVerdict`s that ran, in order, plus one group-level `operation`/`outcome` for anything that
  ended the group rather than a method.
- **Per-test budgets are kept, by a watchdog, not by the server.** The server cannot preempt a
  running test, so the client polls `GetOperationStatus` every `WATCHDOG_POLL_MS` (5 s) while the
  group request is open and reads `opCurrentTest` / `opCurrentTestStartedAt`. When the current
  test has been running longer than ITS budget (`max(2 × baseline, floor)`, the same number the
  per-test path uses), the R53 stop hook fires: `StopHungRun` stops the session, the group answers
  408, and the group is scored `timeout-killed` with `killingTest` = the `currentTest` the stop
  returned. Without `--stop-hung-sessions` the watchdog instead aborts the request at that moment,
  which is `in-flight-unknown` and reconciles as today (rule 2: ours and active, poll). A hard cap
  of `sum(budgets) + grace` still bounds the whole call.
- **The mutant loop consumes a sequence either way.** `runMutantsOnBackend`'s covering loop is
  restructured to iterate `for await (const step of coveringRuns(m, ordered))`, where the generator
  yields `{ ref, verdict, lostAck, retried, retryAfter, original }` per test: on a backend WITHOUT
  `runMany` (al-runner) it yields one `runFenced` per test, exactly today's loop; on a backend WITH
  it, it makes ONE `runFencedMany` call and yields that group's per-method verdicts in order,
  ending with the group-level verdict when one ended the group. The loop BODY, with every branch
  R53, R114, R122, 5C-B2 and R194 put there, is unchanged: it sees the same verdict shapes it
  sees today. A `fail` still goes to the confirmation rerun (a single-test `RunMutant` with no
  mutant active, unchanged), a `timeout` is still `timeout-killed`, a lease answer is still
  classified before anything else.
- **Order.** The group is dispatched in R197's order with `StopAtFirstFailure: true`, so the
  first failing method is the same test the sequential path would have met first. `killingTest`
  cannot change; that is what lets the baselines stand without a re-record.

## 4. What does NOT change

- The baseline: per test, with coverage (`RunMutantWithCoverage`), because coverage is per test.
- The kill confirmation: one single-test call with no mutant active.
- al-runner: no `runMany`; the sequential generator is byte-for-byte today's loop.
- The fence's rules and R194's reconciliation: an op is an op. A lost group ack is reconciled
  once and the whole group retried once; a late original of a GROUP is recognised by the same
  marker read.
- Every verdict and every `killingTest` on every gate. The R197 order plus stop-at-first-failure
  meets the same first failure the sequential path meets.

## 5. Where this can produce a wrong verdict, and why it does not

- **A method's failure caused by an earlier method's data in the same group.** Impossible by
  construction: each method is its own `RunAllTests`, so each gets the codeunit-isolation rollback
  it gets today. The reviewer's job is to find a way `Test Suite Mgt.RunAllTests` leaks state
  between two consecutive single-method suites within one session.
- **A hang in method k charged to method k+1.** `opCurrentTest` is written BEFORE each method
  starts, in its own committed transaction, so the stop's `currentTest` is the method that was
  running. `TryStopHungRun` reads it before clearing.
- **A stop that lands between two methods.** The session is stopped; the group answers 408; the
  marker is tombstoned by the stop. `currentTest` names the method whose row was last written,
  which is the method about to start or just finished. Scored `timeout-killed` on that test: a
  lie in the rare case the previous method had just finished and the next had not begun. The
  watchdog only fires when a test has exceeded its OWN budget, so this window is the few
  milliseconds between a method's end and the next row write; stated rather than closed.
- **The group answer is lost (`in-flight-unknown`).** Reconciled as one op. `completed`: the group
  ran to phase 3; retried once as a whole. `not-started`: as R194. `ours and active`: polled. No
  per-method verdict from a lost group is ever read, because none arrived.
- **A `lease-lost` mid-group.** Phase 1 is the only claim, so a lease loss surfaces only at phase
  3 (verify-and-clear refuses) after every method ran. The answer is `lease-invalid` with no
  reason, the loop's existing genuine-loss branch, and every method's result is discarded with it,
  as today's per-test path discards the single result.

## 6. What refuses this design

- Any verdict or `killingTest` moving on bcdev (3/12/4) or tables (299/63/15 over 377) after the
  control app is republished and the client bumped. The pre-commitment for the gate is exactly
  that: zero baseline diffs, zero re-records.
- The al-runner gate (3/16/0) moving at all: it must not even notice.
- A group that runs a method after `StopAtFirstFailure` should have stopped it.
- A watchdog stop that names the wrong test in a fixture where the hanging method is not first
  in the group. No gate fixture hangs by design (R164); this is proven offline with a fake that
  reports `opCurrentTest`.

## 7. Tests that must exist before the gate

- Transport: `runMany` request shape (the JSON array, the flag, the fence tuple); a `ran` answer
  parsed into ordered per-method verdicts with `stoppedAfter`; the 408 stop path carrying
  `currentTest` into a `timeout` verdict with that `ref`; every classified exit of `run` reachable
  from `runMany` with `fencedOp`; the watchdog firing the stop hook when `opCurrentTest` exceeds
  its budget and not before.
- Orchestrator: with a fake `runMany`, a mutant killed by the third of five ordered tests records
  the same `killingTest` as the sequential path and never dispatches the fourth; a survivor
  dispatches ONE group call; a group `timeout` is `timeout-killed` naming the current test; a
  lost group ack is reconciled once and retried once; a backend without `runMany` produces
  byte-identical events to today (pinned against the existing fakes).
- AL: `alc` compile of the control app (`/al-compile`), and `RunMutantMany` measured live on
  Cronus283 against `tables` before the gate is trusted: one mutant, five methods, stop at first
  failure, and the answer's `stoppedAfter` and per-method results read by hand.
- Live: bcdev, tables, al-runner unchanged, no baseline re-record.

## 8. Pre-committed numbers

The saving is not re-measured on the gates: their suites are small and their calls are 0.11 s.
On the measured hosted run, 196 survivors × 34 removed round trips × 0.46 s is about 51 minutes
of 80; that figure is quoted from arithmetic on R198's measurement, and the next hosted run on
this build is where it is measured.

---

## REVIEW

(appended by the adversarial review)

### Verdict: not safe to implement as specified (spec-adversary agent, 2026-09-02)

Ten findings; the ones that decide it, with the class the review gave each:

- **F1, class 1, a FALSE KILL.** R53's stop is honest today because of a per-OP tombstone:
  `TryStopHungRun` refuses `already-completed` when the op finished just after the budget, and the
  held request then returns the real result. A group is tombstoned once, after method N, so N-1 of
  the method boundaries have no such protection. A slow method that PASSES at 250 s against a 240 s
  budget, with the watchdog's decision up to 5 s stale plus a 0.46 s stop round trip, has the
  session stopped while method k+1 runs, and the group is scored `timeout-killed`. The draft sized
  the window as milliseconds; it is seconds. Fix: a per-method tombstone (`Op Method Index`) the
  stop must match, checked server-side under the lock, where R53 put the equivalent check.
- **F4, class 1, and it strands.** Progress fields on the LEASE row written with `Modify` from
  phase 2, outside the lock: AL's `Modify` writes every field of the in-memory record. A stale
  record reverts the tombstone `TryStopHungRun` just wrote (the op is un-tombstoned with a dead
  session id: `operation-orphaned` forever, a durable recycle), reverts the `Expires At` the renew
  heartbeat wrote (a live op classified orphaned), and if the platform raises on the stale write
  instead, the error is outside the `Codeunit.Run` boundary and phase 3 is skipped, which is the
  exact strand `LC Run Method`'s doc comment warns about. Fix: a separate `LC Op Progress` table
  keyed by `(attemptId, opSeq)`; and FIRST a probe of what the platform actually does on an unlocked
  `Get` then `Modify` after a concurrent committed write.
- **F5, class 1, the central safety claim is unmeasured.** §5 says per-method isolation is
  "impossible by construction" to break, citing `LC Run Method`'s comment, which is an argument
  about a constraint, not a licence to add a `Commit()` between two test runs. Whether
  `RunAllTests`'s codeunit-isolation rollback survives an intervening `Commit` in the same action is
  unmeasured, and the tables fixture ALREADY contains the shape that turns leakage into a kill with
  nothing asserted (arm K's duplicate primary key from a blank `Code[20]` key). Fix: a probe on
  Cronus283, method A inserts a fixed key and asserts nothing, method B asserts the row absent, run
  as two calls and as one group; if B fails only grouped, the design is rethought, not patched.
- **F3, class 2, the mechanism is a no-op.** `dispatch` scores a 408 as `timeout` only when ITS OWN
  timer set `stopFired`. A watchdog beside the call fires the stop, the 408 arrives with `stopFired`
  false, and the answer falls to `in-flight-unknown`: reconciled `completed` (the stop tombstoned
  the op), the whole group retried once at full cost, then `result-lost`. R53's purpose is absent
  and nothing says so. Fix: the watchdog lives inside the transport call and is the sole writer of
  `stopFired`.
- **F2, class 2, silently-empty confirmation.** Nothing verifies the group returned every method
  asked for. Three of 35 methods returned, all `pass`, `stoppedAfter: -1`, is byte-identical to a
  real survivor, recorded with all 35 as `coveringTests`. Fix: the server states its pass predicate
  (`Result = 2`, nothing else) and the requested count; the client asserts the answer is a prefix of
  the request, identity-matched at every index, and complete when `stoppedAfter` is -1; anything
  else is `error`, never a per-method verdict. Together with **F8**: the §I5 identity guard has no
  group form and must check every entry.
- **F6.** A lost group ack retries the WHOLE group, so `killingTest` becomes retry-dependent (the
  draft claimed it could not change); and `classifyRetryRefusal` polled with the per-test budget
  calls a healthy long group `original-stuck`, the defect R194's review already removed at the
  per-test grain. Fix: group budget for group-level classification; retry from `stoppedAfter`.
- **F7.** `killingTest` on a watchdog kill read from `StopHungRun`'s answer, which both the AL and
  the TS mark "diagnostic only, not evidence". Fix: from the watchdog's own decision, cross-checked
  against the echo; any disagreement or a refused stop is `in-flight-unknown`, never a kill.
- **F9, F10.** `budget` missing from the generator's tuple (six consumers in the body); `spent` and
  per-test `durationMs` undefined for a group; a group-level attestation mismatch names the wrong
  method; a 404 for the new route would reconcile as `not-started`, retry the group and quarantine
  instead of falling back; the "hard cap" of 105 minutes is above any gateway's idle timeout.

Sound, and kept for the second draft: attestation reset is per-op already, so a group OR is what
`guardObserved` means; suite names cannot collide inside a group; a status read during an active
op is legal by design; a mid-group lease loss surfaces once at phase 3; the confirmation rerun is
untouched; version gating by `MIN_CONTROL_VERSION` is the right seam and a new action is the right
shape (R25).

### Prerequisites for a second draft, in order

1. **Probe F5** on Cronus283: two methods, one inserts a fixed key and asserts nothing, the other
   asserts its absence; two calls versus one grouped action. This decides whether the design exists.
2. **Probe F4**: unlocked `Get` then `Modify` on a row another session has since committed to,
   measured for raise versus silent overwrite. Independent of the answer, progress moves off the
   lease row.
3. Redraft with: a separate progress table; a per-method tombstone in the stop; the watchdog inside
   the transport; prefix, identity and completeness assertions on the group answer; `killingTest`
   from the decision; group budgets for group-level reconciliation; retry from `stoppedAfter`; a
   404 fallback; a cap below the gateway's idle timeout, measured.
