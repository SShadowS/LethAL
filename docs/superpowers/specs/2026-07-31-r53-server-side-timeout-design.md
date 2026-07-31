# R53 — scoring a non-terminating mutant, without guessing

**Status:** design **v2**, 2026-07-31. v1 was reviewed and found unsafe; see §9 for what changed
and why. Measurement committed (`d2a3f13`, `scripts/r53-probe/`).
**Decision taken:** ship behind an opt-in flag, default off (user, 2026-07-31).

---

## 1. The entry's stated fix does not exist

`ROADMAP.md` R53 says the fix is that *"`RunMutant` must enforce its own time limit inside AL and
RETURN a terminal `timed-out` result"*. That is not implementable, and the row's own status cell
already concedes it: **AL cannot preempt a running loop.** The session executing the hang is the
same session that would have to notice the deadline, and it never gets control back.

## 2. What is actually broken

Measured on Continia Document Output: **M0013 is `negate-conditional` on
`until DOCustSetup.Next() = 0;`**, which becomes `<> 0` and never terminates. The client aborts, but
an abort is ambiguous — BC may still be executing — so it classifies `in-flight-unknown`, which
quarantines the tier. **125 of 138 mutants have never run** on that codeunit.

Raising `--mutant-timeout-ms` cannot help: 180 s and 330 s both aborted, and **360 s is the hosting
proxy's own ceiling** — a fact that turns out to matter far more than v1 of this spec realised (§4.1).

## 3. The mechanism, measured

Evidence and re-run instructions: `scripts/r53-probe/README.md`. Against Cronus281 (BC 28.1):

| measured | result |
|---|---|
| AL `StopSession` ends a web-service session busy in an AL loop | **yes** — the loop never completed |
| what the stopped caller receives | **HTTP 408**, *"The server stopped the session (ID: N) … by an AL StopSession call"* |
| state `Commit()`ed before the hang | **survives** the kill |
| finding the target via `Active Session` | **not possible** — `selfVisible:No`, negative ids |

**Not yet measured, and load-bearing (§7):** what `StopSession` does against an id that no longer
exists. If it silently no-ops, then "the stop did not throw" confirms nothing — an empty-vs-empty
confirmation sitting at the centre of a new verdict, which is this project's signature bug.

## 4. Design

### 4.1 The trigger: our own abort at budget, and nothing else

**`in-flight-unknown` is not "the budget elapsed".** In `run-mutant-transport.ts` it is also the
exit for a non-2xx at any moment, a connection reset after dispatch, and a 2xx with an unreadable
body. Worse, systematically: the budget is `max(2 × baseline, floor)`, so any test whose baseline
exceeds ~180 s produces a budget **above the proxy's 360 s ceiling** — the fetch dies at the proxy
*before the client's own timer fires*, on a run that is healthy and on-budget.

So a trigger of "about to return `in-flight-unknown`" would stop and score a mutant five seconds
into a five-minute budget, on a transient 503. That is a false kill, and `--resume` would carry it
forever (`timeout-killed` is in `CARRYABLE_VERDICTS`).

**The stop fires only when all of these hold:**

1. the client's **own** abort fired at budget — `outcome: "deadline-exceeded"`,
   `controller.signal.aborted === true` — not any other `in-flight-unknown` exit; and
2. `runFenced`'s existing reconciliation (`reconcileLostAck` → `GetOperationStatus`) reports the op
   **still active and ours**, rather than already completed.

Requirement 2 also puts the hook at the right layer. v1 hooked the transport, which runs *before*
reconciliation — bypassing machinery that already exists to prove a lost-ack run actually finished.

### 4.2 The confirmation: the 408, not a return value

v1 called the 408 "the whole design" and then made it unreachable: the client aborts the fetch at
budget, so the 408 arrives on a socket it already destroyed. What v1 actually consumed was
`StopHungRun`'s own return value — a much weaker signal.

**Invert it. At budget, do not abort.** Hold the original request open, fire `StopHungRun` on a
second connection, and score `timeout-killed` **only if the original request then resolves as the
408 whose body names the AL `StopSession` call.** Anything else quarantines.

This is what makes the probe's central measurement load-bearing, and it is the only signal that
proves end-to-end that the session stopped was the session serving **our** request. It also closes
the finish-at-budget+ε race for free: if the run completed just after the abort would have fired,
the held request returns the real result and we score that instead of a manufactured timeout.

### 4.3 AL — record the session id where it survives

`TryBeginRun`'s **fresh-claim branch only** records `SessionId()` on the run marker, before its
existing single `Modify`/`Commit`. It must be committed before phase 2, because phase 2 is where
the hang happens.

**The `op-in-flight` duplicate-claim branch must keep touching nothing.** A duplicate claim arrives
on a *different* session while the original is busy in phase 2; if it recorded its own
`SessionId()`, the watchdog would stop the wrong, idle session. Today that holds by accident. It
gets a pinning test.

`Session Id` must be cleared everywhere the other op fields are: `TryFinishRun`, `TryRecoverOp`,
and `TryForceResetLease`.

### 4.4 AL — `StopHungRun` is `StopSession` + `TryRecoverOp` semantics

v1 said "refuses unless the marker's `attemptId` matches", which is unsafe: **`TryFinishRun` clears
only `Op Kind`** and leaves `Op Attempt Id`, `Op Seq` and `Op Started At` residual. A completed run
whose ack was lost would match that predicate, and the recorded id names a **pooled OData session
that is alive and serving other requests**. Killing it and scoring `timeout-killed` for a test that
may have *passed* is the worst outcome this feature can produce.

`StopHungRun` therefore uses `TryRecoverOp`'s full predicate: lease tuple, **tombstone check**
(`OpSeq <= "Last Completed Op Seq"` → already completed → refuse), `Op Kind = run`, and **both**
`attemptId` and `opSeq` match. (v1 passed `opSeq` in the signature and then never used it. Attempt
ids are sequential per session — `a1, a2, …` — so they are a weak discriminator by construction;
the tuple plus `opSeq` is what actually carries the match.)

Then, in this order, in one transaction that commits only on a known-good stop:

1. refuse unless `Session Id > 0` — see §4.5;
2. `StopSession(recordedSessionId)`;
3. `TryRecoverOp` semantics: advance `Last Completed Op Seq`, `ForceClearActive`, clear the marker.

**Stop before clear.** Clear-then-stop with a failed stop leaves `Op Kind = none` while the hung run
still executes, and the next claim enters phase 2 concurrently against shared `AL Test Suite`
state — the exact interleaving the duplicate-claim branch exists to prevent.

### 4.5 `Session Id = 0` is refused explicitly

AL `Integer` defaults to 0, so a marker written before this change, or stranded across the schema
upgrade, reads 0 — **indistinguishable at the field level from a recorded id of 0.** Nothing in
this repo measures that `SessionId()` is never 0, and the probe already found sign inconsistencies
in the id namespace across surfaces. So: `Session Id <= 0` → refuse → quarantine, with a red-checked
test. v1 asserted this distinction was available without naming a mechanism.

### 4.6 Version gating: `MIN_CONTROL_VERSION`, not a protocol bump

v1 bumped `protocolVersion` 2 → 3. That contradicts this project's own doctrine (`harness.ts`): the
protocol moves when the **wire contract breaks**, and "a build that lacks an endpoint this client
calls" is exactly what `MIN_CONTROL_VERSION` (R28) exists for. Adding `StopHungRun` breaks no
existing call shape.

A `MIN_CONTROL_VERSION` bump gives the identical pre-publish refusal without forcing every
flag-off user to rebuild their control app for a feature they do not use.

## 5. Where a false kill can still come from

After §4, these remain, and they are **accepted residual risks of an opt-in flag** rather than
things the design defeats:

- **Exogenous slowness is not bounded by the baseline.** The lease fences LethAL's operations, not
  the user's own web sessions, job queue, or SQL contention on a shared container. Baselines are
  measured once at session start, so cache-cold drift hours into a sweep is unmodelled. A mutant
  that is *covered but untouched* (procedure-level coverage over-approximates) can blow 2×baseline
  for reasons unrelated to it.
- **The stopped path carries no attestation.** `ObservedAny` lives in a SingleInstance codeunit's
  memory and dies with the stopped session. Every other kill carries a failing assertion or an
  attestation; this verdict carries neither, and cannot say whether any instrumented site executed.
  **This verdict is evidentially weaker than every other kill, and the report must say so.**
- **A missing baseline gives a flat budget.** `2 × fallbackTimeoutMs`, not baseline-relative.
- **NST restart mid-hang.** Lease row, marker and `Server Generation` are all persistent and
  byte-identical across a bare restart, so neither fence nor client detects one. The recorded id
  then names whatever session the restarted NST assigned that integer to. No AL incarnation API
  exists to close this; it is documented and accepted, as the `ForceResetLease` deviation already is.

"Separately counted" is reporting, not protection: `timeoutKilled` is in the mutation-score
numerator and `--resume` makes it permanent. The honest claim is not that these cannot happen — it
is that they require an opt-in flag, and that every one of them is written down.

## 6. Failure modes

| situation | verdict |
|---|---|
| held request resolves as the 408 naming the AL stop | `timeout-killed`, budget recorded |
| held request resolves normally (run finished at budget+ε) | that result, scored honestly |
| reconciliation says the op already completed | existing lost-ack retry — **not** a stop |
| `StopHungRun` refused (tuple, tombstone, attempt/opSeq, `Session Id <= 0`) | quarantine |
| stop succeeded but `StopHungRun`'s own ack was lost | server state reads completed, so reconciliation retries the mutant once — another budget, another stop. **Modelled, not "unchanged"** |
| any other `in-flight-unknown` exit (503, reset, unreadable body) | quarantine — **no stop is attempted** |
| flag off | quarantine — unchanged |

## 7. Test plan

- **Extend the probe first:** measure `StopSession` against a dead id. Until that is known, "the
  stop did not throw" is not evidence (§3).
- Unit: every row of §6, especially the negatives — a refused `StopHungRun`, a non-deadline
  `in-flight-unknown`, and `Session Id = 0` must each be unable to produce `timeout-killed`.
- Unit: the duplicate-claim branch records no session id.
- Unit: `MIN_CONTROL_VERSION` refuses an older control app before publish.
- Red-check every one. The negatives are exactly the tests that pass whether or not the code is
  correct.
- Live: `itest:bcdev` and `itest:tables` per-mutant identical to frozen.
- `compile:fixtures` after any `.al` change.

**No frozen gate exercises this feature** — no fixture mutant hangs. The gates prove absence of
regression, not that the feature works. Closing R53 must state that plainly, and either add a
deliberately non-terminating fixture mutant or carry a DO run as the evidence.

## 8. Not in scope

Deciding whether a mutant is equivalent or merely slow; any change to the default path; R37's full
Document Output sweep (this unblocks it, running it is separate).

## 9. What changed from v1, and why

An adversarial review of v1 found three independent false-kill doors. Recorded because the reasoning
matters more than the conclusion:

1. **Trigger fired on transport noise.** v1 stopped whenever the transport was about to return
   `in-flight-unknown` — which includes a transient 503 and, systematically, every budget above the
   proxy's 360 s ceiling. → §4.1.
2. **Refusal predicate matched completed runs.** `TryFinishRun` leaves the attempt fields residual,
   so a lost-ack after a *successful* run would have matched, killing a live pooled session and
   scoring a test that may have passed. → §4.4.
3. **The evidence was quietly swapped.** v1 called the 408 "the whole design" while aborting the
   socket it arrives on, then consumed `StopHungRun`'s return value instead. → §4.2.

Plus: `MIN_CONTROL_VERSION` over a protocol bump (§4.6), explicit `Session Id <= 0` refusal (§4.5),
`TryRecoverOp` semantics and stop-before-clear ordering (§4.4), and an unmeasured assumption
promoted to a blocking test (§7).
