# R53 probe — can a second session end one hung in an AL loop?

Measured 2026-07-31 against **Cronus281** (BC 28.1, runtime 17.0), from a clean publish of this
probe. Re-runnable: publish with the `bc-measure` skill's `deploy-probe.ps1`, then `drive.ps1`.

## Why this exists

`ROADMAP.md` R53 says a non-terminating mutant should be scored `timeout-killed`, and its stated
fix is *"`RunMutant` must enforce its own time limit inside AL and RETURN a terminal `timed-out`
result"*. That is **not implementable** — the row's own status cell already concedes it: AL cannot
preempt a running loop, so the session executing the hang cannot also enforce a deadline against
itself.

The only remaining mechanism is a **second session ending the first**. Whether BC permits that, in
the topology LethAL actually has, is a question about the platform — so it was measured rather than
argued.

## The topology it reproduces

Not `StartSession`. That was the obvious approach and is unavailable (the platform test runner
refuses it unless `TestIsolation = Disabled`), but it would also have measured the wrong thing:
LethAL's hung session is an **OData web-service session**, and whether *those* can be stopped is
the actual question. So the probe registers its own web service and uses two OData calls — one
busy in an AL loop, one trying to stop it.

Every loop is time-bounded. A negative result must not wedge the container.

## What was measured

| question | result |
|---|---|
| Does AL `StopSession`, called from a web-service session, end another web-service session **busy in an AL loop**? | **Yes.** `stopThrew:No`, and the loop never completed — its post-loop marker row was never written. |
| What does the stopped call's HTTP client receive? | **HTTP 408**, body: *"The server stopped the session (ID: 2683) because of a stop session request. The session was stopped by an AL StopSession call."* |
| Does state the hung session `Commit()`ed **before** hanging survive the kill? | **Yes.** The `hanging` row, written and committed before the loop, was still present afterwards. |
| Can the watchdog find its target in `Active Session` (2000000110)? | **No.** `visibleBefore:No` for a session it then successfully killed. |
| Is `Active Session` usable from a web-service session at all? | Barely: `total:1 selfVisible:No mySession:3188 rows:-3187/Web Service`. The session cannot see **itself**, and the one visible row carries a **negative** id. |

## What that means for the design

1. The mechanism works. A watchdog session can end a mutant that will not terminate, and the kill
   is clean — the hung AL never runs to completion.
2. **The 408 is the signal that makes the verdict trustworthy.** It is not a severed socket the
   client has to guess about: BC states, in the response, that the session was stopped by an AL
   `StopSession` call. That is the difference between `in-flight-unknown` and a terminal result.
3. **A watchdog must be TOLD the session id.** It cannot discover it, and cannot verify liveness
   afterwards, through `Active Session` — the current session is not listed and the id convention
   differs in sign. So the session that is about to run a mutant has to record its own `SessionId()`
   durably (and `Commit()`) *before* it starts, exactly as `HangFor` does here. That committed row
   survives the kill, which is what makes the approach viable at all.

## The open question this does NOT answer

Whether LethAL *should* stop sessions on a user's BC server is a product decision, not a technical
one. It is a materially more invasive act than anything the tool does today.
