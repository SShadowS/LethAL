# R-204b plan r3: R204 (false kill after a test finished) and R202 (stop answered 400)

r3 applies `review-r2-gpt-6.1-sol.md`. What changed: Part R and its tests; Parts A and B are unchanged from r2.

Worktree `/work/lethal-wt/r204b`, master 11530ef8, control app 1.0.0.20. This is plan text only;
nothing in the repo was edited.
r1 was reviewed in `review-r1-gpt-6.1-sol.md` (verdict REVISE). This revision applies that review.

## Steps

1. **Landing 1 (client only, no control-app change):** Part A (R204 at the single grain) plus Part R (R202 fail-closed), with a new single-path leg in itest:hang.
2. **Landing 2 (deferred):** Part B, built only if the strengthened probe below passes. No control-app version bump now.

Builders: edit files only with the Edit and Write tools, never `sed -i` or inline scripts.

## Remaining R204 windows (unchanged from r1, short form)

- **W3, single grain.** `dispatch` scores a recognised stop 408 as `timeout` immediately. `TryStopHungRun` never consults the progress row, so it accepts a stop after `ProgressBetween` has committed, as long as phase 3 has not yet won the lease lock. The stop then lands in `TestResultsToJSON` and a passed test becomes a false kill. **Part A closes this.**
- **W1, grouped.** `TryStopHungRunAt` holds the progress lock while it calls `StopSession`. The loop's `ProgressBetween` blocks on that lock and is rolled back, so the row still reads k-1 and the result is `timeout`. The same can happen at the single grain without the lock. **Part B targets this.**
- **W2.** The stop lands after the test returns but before the platform commits the result. This is not closable from AL; it stays as the R53 residue.

## Part A — R204 at the single grain (adopted by sol as-is)

- At `dispatch`'s 408 branch, when `isAlStopResponse` is true, read `getOperationStatus` once. Refuse the timeout when the row is ours (attemptId, opSeq) and `lastCompletedIndex >= 1`. The result is `outcome: "error"`, cause `stopped-after-completion`, with no `operation`.
- Unavailable evidence (the read throws, there is no row, or the row is not ours) stays `timeout`.
- Use **one shared helper** for this and `runManyOnce`'s existing check, so the two grains cannot drift.
- Cause carrier: one optional `TestVerdict` field (e.g. `stopRefusal`), lifted into `CoveringStep.cause` on the single path. The cause already exists in `report.ts`, so there is no report change.

## Part R — R202 fail-closed (client only; lands with Part A)

**The unsafe sequence (sol):**
1. A real hang reaches its budget. Our stop is confirmed.
2. The held request answers 400 instead of 408, so it is not recognised → `in-flight-unknown`.
3. The R236b readback finds nothing kept.
4. Reconcile reads the op as tombstoned and returns `completed`. But that tombstone was written by OUR stop; it proves nothing about the session ending.
5. `runFenced` / `runFencedMany` retry once. The hang does not recur on the retry, so it passes and the mutant is scored **survived**.

That is direction (b): a real timeout turned into a survivor.

Two more holes (sol, review r2) in r2's "flag only when the stop is confirmed" rule:
- **Lost acknowledgement.** The server accepts the stop and tombstones the op, but the stop call's reply is lost, so the hook throws. r2 would have retried, and the retry could pass and survive.
- **Single-path race.** `dispatch` does not await the stop hook. The original 400 can arrive before the stop's reply, so the verdict is frozen unflagged. The reply then lands before reconciliation, which sees `completed` and retries.

**Fix (r3):**

- **Stop state, per call.** Each call records one `stopState`:

| state | meaning |
|---|---|
| none (field absent) | no stop was sent for this call |
| `issued` | the stop request was sent |
| `pending` | sent, no reply yet when the call ended |
| `confirmed` | the server replied `stopped: true` |
| `refused` | the server replied `stopped: false` with a reason |
| `unknown` | the stop call threw, its reply was lost or unparseable, or the bounded wait below ran out |

  - The state lives on the call's own closure and is copied onto the call's verdict as a field, never parsed from `failureMessage`.
  - Grouped call: the watchdog may stop more than once (it resets after a `method-completed` or `no-progress-row` refusal). The call's state is **retry-safe only if every stop attempt in it ended `refused`**. Any attempt that ended `issued`, `pending`, `confirmed` or `unknown` makes the call not retry-safe.
  - Requirement: every stop call (`stopHungRun`, `stopHungRunAt`) must have its own time bound, so "pending" always ends. Check this in the code; add a bound if one is missing.

- **The single-path race.**
  - `dispatch` keeps the hook's promise.
  - On **every** exit taken after `stopFired`, before returning, it waits for that promise with a bound (e.g. the call's `stopGraceMs`, capped).
  - Resolved → `confirmed`, or `refused` (the `bcdev-backend` hook throws `StopHungRun refused: <reason>` today; turn that into a typed result rather than a thrown text, so refused and lost are told apart). Threw for any other reason → `unknown`. Wait ran out → `unknown`.
  - So the state is final before the orchestrator decides whether to retry.

- **Stamp every ambiguous exit** with the state, on both paths:
  - non-2xx that is not the AL 408;
  - connection failed;
  - body unreadable;
  - the hard-cap or budget abort;
  - a malformed 2xx: no string `value`, `value` not JSON, `group-answer-malformed`, `group-run-error`, and the single path's own malformed-answer exits.
  - The two recognised 408 exits and a well-formed `ran` answer carry the state too, as data, but their scoring is unchanged.

- **Orchestrator rule** (in `runFenced` and `runFencedMany`, before any retry):
  - Retry only when the state is none or `refused`.
  - For `issued`, `pending`, `confirmed` or `unknown`: **no retry.** Record `error` with the new cause **`stop-outcome-unconfirmed`**.
  - On a malformed 2xx exit that today records `group-answer-malformed` or `group-run-error` without retrying: when the state is not none or `refused`, the cause becomes `stop-outcome-unconfirmed`. That exit never retries today, so this is a naming change only, and it keeps the report honest.
  - `unresolved` keeps today's quarantine.
  - R236b's kept-answer readback **still runs first**. A valid, identity-checked kept answer for this op stays recoverable and is scored as today.

- **New cause `stop-outcome-unconfirmed`, not `deadline-exceeded`.** Meaning: LethAL issued a stop for this run, and the run's answer could not be read. Whether the stop ended the run, or the test finished first, is not established. No verdict; `--resume` re-runs it. No new caveat.
  - Ripple, per CLAUDE.md:
    1. `MutantErrorCause` and `ERROR_CAUSE_INTERPRETATIONS` in `report.ts` (meaning, entailedNegative, basis R202). `explain.ts`'s `KNOWN_ERROR_CAUSES` derives from the interpretations.
    2. The events type in `events.ts`, which imports `MutantErrorCause`; confirm nothing else lists causes.
    3. The `report-fold.ts` accumulator, if it counts causes.
    4. The `report.ts` banner, if it names causes.
    5. `bun scripts/generate-schemas.ts`. The enum widens in the stream, report and explain schemas; whether that needs a new schema version is the generator's existing rule.
    6. `tests/schemas.test.ts` cause pins (the lists around `deadline-exceeded` / `warm-confirmation-incomplete`) and the older-reports expectation.
    7. `bun test --update-snapshots` for `report-equality`.
    8. The counts in `interpretation.test.ts` and `report.test.ts`.
    9. `explain.test.ts`, which iterates every interpretation.
    10. The cause list in `chunked.itest.ts`.
    11. Committed sample reports: regenerate only if a root-required field changes; widening an enum should not need it, but verify with `schemas.test.ts`.

- **Accepted loss.** A test that really passed, but whose answer could not be read after a stop was issued, becomes `stop-outcome-unconfirmed` rather than survived. How often this happens is unmeasured. It is never a kill. A valid kept answer still recovers it.

R202 stays **open** until the 400's meaning is measured. Part R makes it fail-closed; it does not close it.

## Tests for landing 1 (each with a red check per direction)

**Part A**
1. Single call, 408 + row ours with `lastCompletedIndex = 1` → `error` / `stopped-after-completion`. **Red:** remove the read.
2. Same with `lastCompletedIndex = 0` → `timeout`. **Red:** make the refusal unconditional.
3. The status read throws → `timeout`.
4. The row names another attemptId → `timeout`. **Red:** drop the identity check.
5. Orchestrator records the single-path refusal as `error`, never `timeout-killed` or `survived`.

**Part R**
Orchestrator tests, on a fake backend with a retry call counter, one each for the single and grouped paths:

6. State `confirmed` + 400 + no kept answer + reconcile `completed`, where a retry would pass → **no retry**, and the mutant is recorded `error` / `stop-outcome-unconfirmed`, not survived. **Red:** delete the guard → the retry runs and the mutant survives.
7. The same for `unknown` (lost acknowledgement), and for `pending` and `issued` → no retry. **Red:** make the guard check only `confirmed` (the r2 rule) → `unknown` retries and survives.
8. State `refused` + 400 + reconcile `completed` → **exactly one retry**, and the retry's pass **stands** (survived). **Red:** make the guard block every state other than none.
9. State none (no stop), lost ack (an empty 200 body) → exactly one retry, and its pass stands, as today.
10. A grouped call with two stop attempts, the first `refused` (`method-completed`) and the second `unknown` → no retry. Pins the "every attempt refused" rule.
11. A valid kept answer with state `confirmed` → still recovered and scored. Pins that R236b runs first.
12. A malformed 2xx with state `confirmed` → cause `stop-outcome-unconfirmed`; with state none → `group-answer-malformed`, as today.

Transport tests with **deferred promises** (`dispatch`), so each test controls the order:

13. **400 before the acknowledgement.** The hook promise stays pending, the fetch resolves 400, then the hook resolves `confirmed` inside the bound → the verdict's state is `confirmed`. **Red:** stop awaiting the hook promise → the state reads `issued` or none.
14. **Acknowledgement before the 400.** The hook resolves `confirmed`, then the fetch resolves 400 → `confirmed`.
15. The hook never resolves within the bound → `unknown`, and the call returns once the bound ends (fake timers). **Red:** an unbounded await → the test hangs or times out.
16. The hook rejects with a lost-reply error → `unknown`. The hook rejects with the typed refusal → `refused`. **Red:** collapse every rejection into `refused` (the r2 assumption).
17. Grouped watchdog: `stopHungRunAt` throws → `unknown`; answers `stopped: false` → `refused`.

## Live: itest:hang through the single path

- Add a third leg to `hang.itest.ts`: `--stop-hung-sessions` **with `--no-group-runs`**, which sends every covering test through `RunMutant` alone.
- What it pins:
  - Every hang mutant scores the same verdict as the grouped ON leg: `timeout-killed` stays `timeout-killed`.
  - Zero `stopped-after-completion` and zero `stop-outcome-unconfirmed`: Part A must not swallow a real hang. If R202's 400 shows up live, it appears as `stop-outcome-unconfirmed`. Pre-commit that as a gate failure that is re-run once, never as a baseline value.
  - The `line 145` mutant is scored without `killPosition` 2, because each call runs one method.
  - The existing `groupedCalls` and `warmKills` pins do not apply on this leg; the leg should assert `groupedCalls` 0.
- **Pre-commitment is needed.** This is a new leg with its own per-mutant table and a new baseline file, which the R332 record ritual covers (record once, exit 3, re-run to pass). Write the expected table into a spec before the first run.
- The existing ON and OFF legs are pre-committed **unchanged**. A real hang never reaches a commit of `ProgressBetween`, so neither part can move them.
- No other frozen figure moves: bcdev, tables and chunked fire no stops.

## Part B — deferred, gated on the strengthened probe

**Design (unchanged in substance):**
- Add `"Suite Name"` to `LC Op Progress`.
- `GetOperationStatus` reports the stopped method's committed `Test Method Line.Result`. The function line is resolved by (suite, codeunit, method) and must resolve to **exactly one** line; otherwise report nothing.
- The read uses **`ReadIsolation::ReadCommitted`**.
- A result is reported only if the line's `Start Time >= Progress."Started At"`.
- The after-408 helper also refuses on a committed Success or Failure when **both** index and token match the stop decision.

**How the single path gets a token:**
- Today `dispatch` has no stop decision and no token.
- In Part B, `bcdev-backend`'s `onBudgetExceeded` hook first reads `getOperationStatus` for row 1 and its token, then calls **`stopHungRunAt(1, token)`** instead of `stopHungRun`.
- That gives the single path the same locked ordering as the grouped call and a decision to match against.

**Optional field, reconciled:**
- `parseOperationStatus` keeps `methodResult` optional, because older status readers share it.
- Part B bumps `MIN_CONTROL_VERSION`, so a session against an older control app is **refused at start** by the existing version gate.
- During a run, a missing field is **unavailable evidence**: the result stays `timeout` (today's rule), never a refusal by guess and never a pass.
- A unit test pins that the version gate rejects the pre-Part-B version.

**Probe pre-commitment** (Cronus28, coord lease, `scripts/r198-group-runner-probe` with `$base` parametrised):

All arms use the **production shape**: one suite built per call, every function line set to `Run = false`, per method the two Run flags flipped and `Test Suite Mgt.RunTests` on the header|function filtered record, in the **same reused suite**, at **k = 1 and k = 3**. Cross-session reads use `ReadCommitted` and require **exactly one** matching line.

| arm | what | must read |
|---|---|---|
| A | slow-pass method with a database-polling pause after `RunTests`, before the loop's `between` write; stop during the pause | Success, Start Time fresh |
| A-lock | the **real ordering**: the stopper takes the lease lock, then the progress lock and Get, then `StopSession` and Commit, while `ProgressBetween` is blocked on the progress lock | Success after the 408, and `between` rolled back |
| B | hang, stopped mid-body | not Success or Failure |
| C | sleep, read mid-run without a stop | not Success or Failure |
| D | failing method, paused and stopped | Failure, fresh |
| S1 | **seeded stale Success**: the same suite name and line ran and passed in an earlier call, then a hanging execution is stopped mid-body | not a *fresh* Success (the Start Time guard rejects the stale line) |
| S2 | the same as S1 with a seeded stale **Failure** | not a fresh Failure |

- 10 rounds per arm; every round logs the stop's HTTP status and the first 400 characters of the body (R202 data).
- **Decision rule:**
  - Build Part B only if A, A-lock and D are 10/10, and B, C, S1 and S2 are 0/10.
  - A round that did not complete, or a failed read, **rejects the arm**; it is never counted as a pass.
  - Any fresh Success or Failure in B, C, S1 or S2 → Part B is refused and the finding is filed.

**Part B tests (red per direction):**
- Grouped and single:
  - Fresh Success → refused.
  - Fresh **Failure** → refused.
  - Stale result (Start Time before the progress start) → `timeout`.
  - Index or token mismatch → `timeout`.
  - More than one matching line, or none → `timeout`.
  - Field absent → `timeout`.
- Single path: the hook reads the token and calls `stopHungRunAt`. A failed token read falls back to today's `stopHungRun`, and the stale/fresh rules still apply.
- Live: the itest:hang single-path leg and the existing ON leg stay identical (pre-committed).
- Source-pin tests are kept, but only as a supplement.

## Open questions

1. (Settled in r3: the cause is the new `stop-outcome-unconfirmed`.) The bound on the hook wait: use `stopGraceMs`, or a smaller fixed cap? Default: `stopGraceMs`.
2. Part B's version is 1.0.0.21 or 1.0.0.22, depending on R-389. Decide later; there is no bump now.
3. Should R202's status line be updated now to name the retry path and Part R's fail-closed handling?
