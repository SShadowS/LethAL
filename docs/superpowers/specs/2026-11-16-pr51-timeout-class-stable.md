# PR-51: a timeout-killed verdict that does not depend on which covering test is met first (R1057), spec and pre-commitment

Written 2026-11-16, before any code or run for this task. Revised the same day after the spec-adversary review (Opus; F1-F8
name its findings), and again after its delta review: walking past non-terminal errors (F5) is dropped, noted later timeouts
are never scored, and F1 gets an explicit interface.

## The problem (R1057, measured in R-984 t5/t6)
The covering loop (`orchestrator.ts`, the per-mutant `for await (const step of coveringRuns(...))`) walks the covering tests
in R197's order (`orderCoveringTests`: earlier killers in the same procedure first, then narrowest, then fastest) and ends the
mutant at the FIRST non-pass step. R197's order depends on the session's kill history, and on v3 R987's per-window entries cap
changes how tests are packed. So for a mutant with one test that FAILS and another that HANGS, the verdict class depends on
which comes first: `killed` (fail first) or `timeout-killed` (hang first). DO's `CDOEMailHandler:462` was `timeout-killed` in
t5 (a hang at run position 1) and `killed` in t6 (an assertion at run position 1).

## The rule
For a mutant whose walk meets a test that timed out under it:
- **killed** when any covering test FAILS under it, and that kill is confirmed and reproduced (F1: with a confirm that runs the
  test the way its failing run did);
- otherwise the held timeout is scored through today's timeout path (`timeout-killed`, or today's `error` outcomes of it).

The killing TEST may still differ between sessions (R197's accepted class). The R1057 suggestion ("run the tests before the
hung one in covering order") is not used: when R197 puts the failing test first, no later hang is looked for, so the class
would still follow the order.

## Where and how
Only in the orchestrator's covering loop, for every backend. On bcdev without the stop (itest:hang's OFF leg) a hang is never a
`timeout` answer, so the held path does not exist there.

1. **Hold.** A `timeout` step that today goes on to the timeout path (group position 1: the cold path; position > 1:
   `confirmWarm`) is held: its `step`, verdict and budget are captured, and nothing about it is confirmed yet. The mutant-level
   fields (`verdict`, `cause`, `failureNote`, `permissionRefusedTest`, `runnerDisagreement`/`-Test`, `notReproduced`,
   `refusedPending`, `transportErrorRef`, `abortAfterRecord`) are snapshotted at that moment (F6).
2. **Walk on.** The generator is pulled again, as R577 (I4) already does after an unreproduced kill. Each later step:
   - **pass:** go on.
   - **fail:** handled as a first fail is today (warm or cold confirm, R577 reproduction), with one change (F1) for a fail
     whose row came from an ALONE request (on v3: `aloneCall`, the alone run after a stop, or a cut-recovery call):
     - the backend marks such a verdict (`TestVerdict.selection: "alone"`, set wherever `runOn` makes `alone` true);
     - its unmutated confirm and its reproduction pass an explicit run option (`RunOpts.alone: true`, threaded through
       `runFenced`/`singleStep`) that makes the backend run exactly that one test alone (`aloneCall`, under NONE for the
       confirm, under the mutant for the reproduction), never through routing state such as `timedOutMutants` or R897's
       `aloneAfterStop`; an alone answer is never cached as the codeunit's call;
     - no R653 kill pair is sent for it (`sendKillPair` skipped).
     Confirmed and reproduced: verdict `killed` with that test, the walk ends, the held timeout is dropped (named in the note).
     `kill-not-reproduced`: go on, as today. Any other confirm result (`unstable`, `warm-prefix-unstable`, `session-reused`,
     ...): the walk ends and the held timeout is scored (step 3).
   - **timeout:** its test name is noted on the held timeout, nothing more; go on. A noted timeout is never confirmed or scored.
   - **today's `continue`s keep continuing** (F4): R639/R978's `runner-refused` after a stop, R688's confirmed found-0 skip
     (which re-activates the mutant, as today).
   - **terminal answers keep today's handling and win** (F2): `safety` latched unsafe after the step, a `stranded` or
     `result-lost` cause, a lease loss, a `deadline-exceeded` (our own timer: the backend may still be busy), a
     `transportErrorRef` or `abortAfterRecord` set by the step. The held timeout is NOT confirmed then (no call goes out over a
     session or transport that just failed); it is named in the note, appended AFTER any `STRANDED_NOTE_PREFIX` text, never
     before it (`--resume` reads that prefix).
   - **any other answer that today ends the mutant as `error`** (for example `session-reused`, a permission refusal, a runner
     refusal not after a stop): the walk ends and the held timeout is scored (step 3). Walking past such errors is NOT done
     here: it would need the mutant re-activated after each error's confirm and the error's fields kept off a later kill (the
     review's delta findings 2, 3 and 7); that case belongs to R1066 (an error deciding the class).
3. **No kill found:** the snapshot of step 1 is restored (F6: nothing a later step set reaches the held verdict), and the held
   step goes through today's timeout path unchanged: cold confirm with R514/R516/R517's checks and `noteMeasured`, or
   `confirmWarm` with the HELD step's `chunkPrefix`; then R577's reproduction and stop evidence. If its reproduction fails
   (today's I4 would go on walking), the walk is already over: the end-of-walk logic runs as today (`survived` with
   `notReproduced` becomes `error`), with the held timeout's note. The tests a later step answered are named in one
   "after the timeout:" clause (names only, no diagnosis text, so no note claims a permission refusal or runner disagreement
   the report's counts do not carry).
4. **The kill ledger** (R197) records the test whose verdict stands.

**Interface, pinned:** `TestVerdict.selection?: "alone"` and `RunOpts.alone?: true` (v3 backend; bcdev never sets or reads
them, as its calls are fresh sessions). A backend that does not know `alone` refuses it by name rather than ignore it.

Not changed: any mutant whose walk meets no timeout (every step is handled by the same code); budgets; R197's order; the
per-test stop; v3's cut and alone routing (R895); bcdev's stop; survivors and the R198 attempted-set check. In particular a
FIRST kill measured alone (no held timeout; covering order puts B before A, codeunit order A before B) keeps today's in-context
confirm: changing it would move non-timeout verdicts, so it is filed as R1067 instead.

## What it costs
Only mutants whose walk meets a timeout pay (F7: whatever their final verdict). They pay the rest of their covering set:
- each remaining test runs once under the mutant: at its normal time if it passes or fails, at its full budget if it also hangs;
- on v3, every remaining test of a codeunit the held timeout cut runs as its own alone request (a fresh daemon request each,
  after the cut's daemon restart), not inside one call;
- a later kill in such a codeunit no longer re-hangs inside an R653 pair (F1's alone confirm sends no pair).

**DO, from R-984's latest window (dos3.sqlite run 8):** 6 mutants met a timeout (all `timeout-killed`; no `error` there came
from a timeout), out of 4,846 scored, all at run position 1. Their remaining covering tests: 70 (9, 22, 10, 10, 10, 9), with
1.9 s of baseline time in all. Bounds per window:
- lower: 70 extra test runs, most as alone requests (request plus daemon start each), plus 1.9 s of test time;
- upper: 70 x the budget (60-180 s) if every remaining test hung, about 1.9 h;
- known: the `:137` site has at least one more hanging test (t5 and t6 met different ones): one more full budget (~180 s).
The real figure is measured after the build (below). If the extra wall time exceeds 10 % of a DO window's, the result says so
and the cost question goes back to the orchestrator before merge.

## Predictions (pre-committed)
- **`itest:al-runner-v3`:** no figure moves. No mutant there meets a timeout: its baselines hold neither a `timeout-killed`
  nor an `error`.
- **`itest:hang`:** every per-mutant verdict and killing test unchanged in every leg (`hang.single.baseline.json` holds those
  only and does not move). The five `timeout-killed` mutants:
  - M0004 (`CountUpTo` :37), M0019 (`WalkOneRow` :73): one covering test each, nothing more runs.
  - M0035 (`SpinUntil` :145): its hang is the last step of its walk in both ON and SINGLE, nothing more runs.
  - M0008 (:43), M0009 (:44), in the `Advance` subscriber: covered by `CountUpToReachesTheLimit` and
    `SpinUntilReachesTheTarget` (`SpinUntilAtZeroExitsEarly` exits before `OnAdvance`), both hang under the mutant. The
    first hang (CountUp, first in R197's order) stops its call; the walk then sends a NEW call for SpinUntilReachesTheTarget,
    which hangs and is stopped: +1 grouped call and +1 stopped call each.
  - ON leg, therefore: `groupedCalls` 46 -> 48 (the check `killed + survived + timeoutKilled + 2 x warmKills` gains a term,
    pinned as a NUMBER in `HANG_FIGURES` like the others, never read back from the report: `heldSecondHangs: 2`, the
    timeout-killed mutants whose walk met a second hang); `STOPPED_CALLS_ON` 6 -> 8 (its formula, derived from verdicts, gains
    the same pinned term); `manyDistinct` = 48 - 8 = 40, unchanged. Cold confirms (4 ON, 5 SINGLE), `warmKills`
    (4) and every verdict count stay. `assertColdConfirms` and `stopRowFailures` key on the first timeout row and the killing
    test, so the extra hang rows do not disturb them.
  - SINGLE leg: no pinned stop count; `singleRows === singleDistinct` holds (stopped calls carry no session id).
  - BASELINE leg (no mutant times out) and OFF leg (no `timeout` answer): unchanged.
  - The gate's code and `docs/gates/hang.md` (the "46", "6 of them", "46 - 6 = 40" prose and `HANG_FIGURES`) are changed in
    the same change, to exactly these figures.
- **Unit tests** (each red when the specific part is reverted):
  - hang then fail -> `killed` with the failing test (red if the walk stops at the timeout);
  - hang, pass, hang -> `timeout-killed` with the FIRST hang, the second only noted;
  - fail first, then a would-be hang -> `killed`, the hang never run (red if a fail continues the walk);
  - hang then a fail that does not reproduce -> `timeout-killed`;
  - hang then a non-terminal error (`session-reused`; a fail whose confirm is `unstable`) -> the walk ends, the held timeout
    is scored with the snapshot's fields (red if the error's verdict or fields stand), and no later test runs (call counter);
  - hang then a stranded/in-flight step -> today's strand recorded, the held timeout's name after the stranded prefix, and the
    fake backend sees NO further call (call counter);
  - hang then a `deadline-exceeded` -> terminal, no held confirm sent;
  - hang then two transport errors -> today's §11 abort with the later test's note, no held confirm sent;
  - hang then an R639 refusal after a stop -> the walk continues; hang then a found-0 -> confirm, skip, re-activate, continue;
  - a held WARM timeout: the deferred `confirmWarm` and reproduction receive the held step's `chunkPrefix`; a later kill in the
    next call receives only that call's prefix;
  - F1: a later fail marked `selection: "alone"` is confirmed and reproduced with `RunOpts.alone`, and no kill pair is sent
    (red if the confirm runs in context or a pair is sent); the v3 backend runs an `alone` request as exactly one test under
    the asked selection, whatever its routing state (backend test, red if `timedOutMutants` or `aloneAfterStop` decide it);
    a backend that does not support `alone` refuses it by name (bcdev throws on `opts.alone`, unit-tested);
  - a later fail marked `selection: "alone"` whose alone confirm comes back `unstable` -> the walk ends and the held timeout is
    scored (red if the in-context R653 pair is sent instead);
  - a held timeout whose reproduction fails -> end-of-walk `error` with the held note, and no noted later timeout is scored;
  - the property: the same mutant gives the same class for its covering tests in every order and, on the grouped path, every
    packing (chunk size).
- **DO cost measurement** after the build: the six run-8 sites' files re-run on v3 with `triage-baseline.ts --only`, before
  and after, timing each timeout-meeting mutant's walk.

## Not in scope (stated, not fixed)
- An `error` met before a fail still ends the walk, whether or not a timeout was held before it: error-vs-kill (and
  timeout-killed-vs-kill when an error sits between the hang and the fail) stays order-dependent there. Filed as R1066.
- A first kill measured alone keeps today's in-context confirm. Filed as R1067.
- Which test kills (R197) stays order-dependent by design.
