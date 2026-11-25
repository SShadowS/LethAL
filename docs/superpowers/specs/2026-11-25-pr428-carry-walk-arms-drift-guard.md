# PR-428 pre-commitment (R1207): a carry walk that keeps its daemon past a kept refusal arms PR-56's drift guard

**Source:** R1207, filed by lethal-preproc from PR-411's spec review, L3. It was split out of PR-411 to land after
PR-410, which rewrote `carryWalkSend`.

## The gap
- `AlRunnerV3Backend.requestOne` arms PR-56's drift guard after every answer: `daemon.keptRefusal =
  firstKeptRefusal(...)`, the first row a `V3_SERVE_SAFE_REFUSALS` entry keeps.
- The next `requestOne` on that daemon checks its rows against the baseline (`keptRefusalDrift`). On drift it closes the
  daemon and re-runs the request on a fresh one.
- The PR-340 carry walk sends `[mutant, NONE, mutant]` on the lane's daemon. Since PR-410 the decision to keep or close
  is in `closeUnkeptWalk`: it closes when a row is not reusable.
- But when the walk KEEPS the daemon past a kept refusal row, nothing arms the guard. The next ordinary request on that
  daemon is then not checked, so a state leak from the kept refusal could reach its verdicts unseen.

## What is built
- **Arming:** when every answer is reusable (the daemon is kept), the walk arms `lane.daemonFor(mode)`, the daemon the
  lane's next request in this mode will use.
  - It arms only from the answers THAT daemon served. The walk records the daemon behind each answer, because
    `ensureDaemon` runs per request and can replace the daemon mid-walk (the recycle bound, `overRecycleBound`; review
    S1).
  - If some row of those answers is a kept refusal, the walk sets `keptRefusal` to the FIRST such row, in answer order
    (request 1, 2, 3; rows in order), as `{ text, test }`.
  - So an arm never lands on a daemon that was already closed (a silent no-op), and never names a refusal the armed
    daemon did not run.
  - Rows of the echo codeunit are skipped, as `firstKeptRefusal` skips echo entries (review M2).
  - The kept-refusal test is the predicate `firstKeptRefusal` uses (`notRun`, status `error`, message matched by
    `V3_SERVE_SAFE_REFUSALS`). It becomes one shared function, `isKeptRefusalRow`, so the two cannot drift apart.
- **No answers kept refusal:** the walk leaves `keptRefusal` as it was. It never clears an earlier arm, as R1207 says,
  so a walk cannot disarm a guard that an earlier request set.
- **A closed daemon:** nothing is armed. Its replacement starts unarmed, as today.
- **Skipped walks** (PR-410) send nothing, so they arm nothing.
- **Unchanged:** the walk's own requests are not drift-checked. The walk judges its answers by its own rules
  (`judgeCarryRequest`), and R1207 asks only that the NEXT request is checked.
- **What arming also does (review S2):**
  - While a daemon is armed, `packCut` cuts the next packed request to its first unit. So arming also changes the next
    request's shape. Packing is a cost setting, not a verdict one, so no verdict is expected to move. The gate claim
    covers it.
  - "Never clear an earlier arm" means a drift warning can name a refusal from before the walk (`prior.text`), so that
    warning's diagnosis may point at an older refusal than the one that caused it (review M1). It errs toward more
    checking; a drift always re-runs the request on a fresh daemon.
- **Not changed here (review M3):** the stop-signal return at the top of the walk loop skips `closeUnkeptWalk`, so an
  answer already received neither closes on an unkept row (already so today) nor arms. The session is stopping, so the
  next request does not come.

## Pre-committed results
- **Unit tests,** on the shell backend of `pr340-carry-walk.test.ts`, each red-checked:
  - A walk whose answers hold a kept refusal row and that keeps the daemon leaves `daemon.keptRefusal` set to that row's
    text and test. A following `requestOne` on that daemon is counted as armed (`armedRequests`) and drift-checked.
    Red if the arming is removed.
  - A walk with no kept refusal leaves an earlier arm in place and leaves an unarmed daemon unarmed. Red if the walk
    clears or sets the arm on a refusal-free answer.
  - A walk that closes the daemon (an unkept row) arms nothing.
  - The kept refusal in the NONE answer (request 2) arms too.
  - A kept refusal in the echo codeunit's rows does not arm.
  - Recycle mid-walk: request 1 on daemon A holds the kept refusal, and requests 2 and 3 run on a fresh daemon B. B is
    armed only from what B served, and A, already closed, is never armed. Red if the walk arms the daemon it hoisted
    from request 1.
  - The check really runs: after an arming walk, a next request whose rows drift from the baseline sends
    `al-runner-v3-serve-drift-after-kept-refusal` and re-runs on a fresh daemon. Red if the arming is removed.
  - The shared predicate: `firstKeptRefusal` returns what it returned before, over the existing PR-56 tests.
- **Gates:**
  - **itest:alrunner-v3-carry:** unchanged, per its baseline (8 killed / 5 survived, 3 walks, 0 skipped). The fixture's
    walks keep no refusal, so nothing is armed and nothing moves.
  - **itest:alrunner-v3:** 0 verdict, killingTest, note or warning moves. No leg is predicted to walk past a kept
    refusal. If one does, its next request is now drift-checked, and a packed next request is cut to one unit
    (`packCut`); any `serve-drift-after-kept-refusal` warning, or a moved figure, is listed, not passed.
  - **BC legs,** as `selectLegs` picks them: no moves (a v3-only change).
- **No DO run:** the change only arms an existing check. Where that check fires, it replaces a drifted answer with a fresh
  daemon's, which can change that request's verdicts; that replacement is the correction R1207 asks for. On DO, PR-410
  now skips every walk (129 of 129 in c4's files), so a DO run would not exercise it.
