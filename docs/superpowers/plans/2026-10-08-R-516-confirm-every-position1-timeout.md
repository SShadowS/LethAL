# R-516 + R-515 plan r2: confirm every position-1 timeout; give al-runner one-shot the budget it is judged by; re-budget a test once a confirm measures it

[r2] Revised after `/coord/handoff/R-516/review-r1-opus-adversary.md` and the coordinator's
decisions. Every change from r1 is marked [r2]. Adopted: I2 (T1b), I3 (a)(b)(c) (notes and a
budget provenance, with a test), I5 (costs), M1 to M8. I1: `--server` / resource-with-server is NOT
closed here; every claim is scoped to bcdev and al-runner one-shot, and the builder files a new
correctness-risk item for it (D3b). I4: Q2 is NOT done now; the one-shot lost-kill band is
documented, and Q2 goes into that same new item as its follow-up.

Read `/coord/handoff/R-516/repro.md` first. Five repro tests (RED) exist, uncommitted, at the end of
describe "R514: ..." in `packages/runner/tests/resume.test.ts`, plus the `alRunnerCompileMs` option
on its `ClockBackend`.

## [r2] Scope

Every fix and every CHANGELOG / interpretation claim below is about **bcdev and al-runner
one-shot** (static or resource selector, run through `sendOneShot`). **al-runner `--server` and
resource-with-server are out of scope**: their in-run limit is not the budget (I1), and the false
kill there stays open, filed as its own item (D3b). D1 and D4 still run on that path (the confirm is
backend-agnostic), and nothing there gets worse, but nothing there is claimed fixed.

## Step 2: what a confirm costs (measured from the code, the gates and the committed reports)

A confirm is one unmutated run of the killing test, at `max(budget, baselineTimeoutMs)`, per
position-1 timeout. It costs the test's NORMAL duration, not the budget (a genuine hang finishes
unmutated). It adds no deploy (bcdev: `activate(null)` on the same artifact).

| Gate / source | position-1 timeouts per run | added confirm cost |
|---|---|---|
| `itest:hang` ON (grouped) | 4 (lines 37, 43, 44, 73; line 145 is at position 2 and already replayed by `confirmWarm`) | 4 single unmutated runs |
| `itest:hang` SINGLE (`--no-group-runs`) | 5 (the same four, plus line 145 at position 1) | 5 single unmutated runs |
| `itest:hang` OFF | 0 (no stop flag: hangs are `deadline-exceeded`, never `timeout`) | 0 |
| `itest:bcdev`, `itest:envtool`, `itest:tables`, `itest:chunked`, `itest:harden` | 0 (`timeout-killed` count in every committed baseline: 0) | 0 |
| every `itest:alrunner` leg (7 baselines) | 0 (verdict domain in all 7: killed 51 / survived 54 / no-coverage 7; no timeout, no error) | 0 |
| DO rung1 (148 mutants), rung1 resumed, rung1 run2-partial | 1 each | 1 run |
| DO rung3 independent confirm (148) | 2 | 2 runs |
| DO rung2, r85 rung1/rung2, gift-card, r396 i/ii/iii, credit-limit demo | 0 | 0 |
| DO run 3 on the hosted sandbox (`docs/measurements/README.md` §"The eight", 741 mutants) | 8 (1.1 % of mutants) | 8 runs |

Per-run time of one confirm on the hang fixture: the R514 probe r3 measured exactly these confirms
(reused path, same five tests, Cronus28): 437, 106, 130, 148, 144 ms. Each hang already costs the
full 20 000 ms budget plus BC's stop, so the confirm adds under 2.2 % per hang and under 2.5 s per
leg. On the hosted run the mean test takes about 0.55 s (407 tests, 205 to 242 s baseline, R192)
against a 180 s default budget per hang: about 0.3 %.

[r2] (I5) **Backend-specific confirm cost.** On bcdev a confirm is one `RunMutant` call (the test's
own duration). On al-runner one-shot it is one FULL invocation: compile plus the test (12.5 s cold,
0.4 s warm-incremental on a two-file fixture, 65 s per invocation on a 553-file app, R222). On
`--server` it is one whole SUITE run, because `activate(null)` drops the cached suite. Each is paid
once per position-1 timeout only; zero on every al-runner leg today.

**Which `itest:hang` figures move (read from `hang.itest.ts` exactly).** Only rows the gate does not
pin by number. The confirm is a cold `runFenced` (one `RunMutant` call): its row is stored with
`mutant_code` NULL and `op_kind` NULL, outcome `pass`, with a session id.
- `groupedCalls`, `warmKills`, `manyDistinct`: unchanged (a single call is not a group call; no kill
  position moves).
- `sessionLiveness.answered`, `singleRows`, `singleDistinct`: each +4 (ON) / +5 (SINGLE). The gate
  asserts only `missing == 0`, `answered > 0`, `singleRows == singleDistinct`; all hold if each
  confirm gets its own BC session, which every existing fail-confirm row in the same legs already
  shows.
- The per-mutant timeout rows (`mutant_code` = the mutant, outcome `timeout`, op_kind, BC's stop
  words, duration window): unchanged; the gate filters by `mutant_code`, which a confirm row lacks.
- `counts`, verdicts, kill positions, `quarantined`, caveats, the SINGLE baseline (verdict +
  killingTest per mutant): unchanged, provided each confirm passes in at most 10 000 ms (half the
  20 000 budget). Measured 106 to 437 ms.

## Decisions (recommended)

### D1. R516 exposures 1 and 2: confirm EVERY position-1 timeout, fresh or reused, with R514's rule

Recommended over a narrower trigger. A narrower trigger ("only when the duration is old" or "only
on another worker") would need a clock or a tier identity at the verdict point, and still miss a
test that slows inside one run. The cost is in the table above: one normal-duration run per hang,
zero on every gate but `itest:hang`.

It closes exposure 2 with no per-tier budgets: `runMutantsOnBackend` runs per shard with that
worker's own backend, so the confirm measures the test on the tier that timed out (scratch: repro
(b) goes from `timeout-killed` to `error`). Per-tier baselines (N baselines) are rejected: they cost
a baseline per worker and buy only fewer `error`s on a slower tier, which D4 already buys cheaper.

[r2] (M7) D1 and D4 also reach `runNamedMutants`' probe path (`runProbes` calls
`runMutantsOnBackend` with `baselineReused: undefined`): a probe's position-1 timeout is confirmed
too, and a probe's later mutants are re-budgeted. No probe test pinned the old behaviour (the
scratch full-suite run in repro.md); the builder greps the `runProbes`/`runNamedMutants` tests for
`timeout-killed` and reports what it found.

Code (`runMutantsOnBackend`):
1. Delete the `if (args.baselineReused === undefined) { ...timeout-killed...; break; }` block, so
   every position-1 timeout falls through to the cold confirm.
2. The stale branch drops `args.baselineReused !== undefined &&`. [r2] (I3 c) The cause follows the
   BUDGET'S SOURCE (see D4): a budget set from a reused snapshot's duration gives
   `reused-budget-stale` with its R514 note; a budget from this run's baseline or from an R515
   confirm gives the NEW cause `timeout-unconfirmed`.
   [r2] (I3 b) The `timeout-unconfirmed` note prints both durations and their ratio:
   "`<T>` timed out at position 1 under the mutant; unmutated it completed in C ms on this backend,
   more than half its B ms budget, which was set from <'this run's baseline, D ms' | 'the confirm
   of mutant <code>, D ms (R515)'>; ratio C/D = R. The timeout is not attributed to the mutant
   (R53's 2x margin, R516)." Then, when R <= 1.25: "the test ran about as fast as when its budget
   was set, so this is R516's boundary band (the budget is twice its measured duration, or on
   al-runner one-shot the compile counts against it); raise --mutant-timeout-ms above twice this
   test's duration to re-score it", else: "the test is slower now than when its budget was set, or
   this worker's tier is slower than the baseline's; raise --mutant-timeout-ms to re-score it".
   (1.25 picks the wording only; no verdict reads it.)
3. `confirmWarm`'s timeout grain: the 2x rule on every batch. Fresh: a complete all-pass replay
   whose entry k took more than half its budget is `warm-timeout-unconfirmed` (existing cause).
   [r2] (I3 a) Its note on a fresh batch tells the two bands apart: entry k over the budget keeps
   today's "outside the budget" wording; entry k within the budget but over half of it says
   "completed unmutated in C ms at position k of the replay, within its B ms budget but more than
   half of it (R53's 2x margin, R516)". The cause's interpretation text says "in more than half the
   budget". Reused: unchanged (`reused-budget-stale`). One rule, so a 1.5x drift at position 2 is no
   longer a kill either (today's 1x rule kills it).
4. Comments: the confirm block, `confirmWarm`'s header, the `baselineReused` field doc.

Confirm deadline stays `max(budget, baselineTimeoutMs)`. With the default floor (180 s) that is the
budget. [r2] (M4) bcdev has no stop for an unmutated run, so a test that drifted past 180 s
unmutated is ABANDONED at that deadline: `in-flight-unknown`, `stranded`, the tier quarantined, the
session latched (R514's I2, now reachable on a fresh batch too). Today that same test is a false
`timeout-killed` on every mutant it covers, 180 s each. Documented, not changed.

**Known lost-kill bands (in the CHANGELOG and in `timeout-unconfirmed`'s interpretation).** The
rule kills only if `2 x confirm <= budget`.
- bcdev: where the budget is `2 x baseline` (the floor does not bind: baseline > floor/2, i.e.
  > 90 s by default, > 10 s at `itest:hang`'s 20 s floor) a genuine hang's confirm lands on the
  boundary, so about half of such kills become `timeout-unconfirmed` by noise.
- [r2] (I4) al-runner one-shot: the confirm is judged on its WALL clock, so a genuine hang is lost
  whenever `compile + body > budget / 2` for the unmutated run. Before D1 this applied to reused
  batches only (R514's M3); D1 extends it to fresh batches. Example: a 65 s compile (R222's 553-file
  app) loses every hang kill under a budget below 130 s, i.e. `--mutant-timeout-ms` below 130 000
  with fast tests. Not fixed here: judging al-runner's own per-test duration is the D3b item's
  follow-up.
Never a false kill. On every gate fixture no test is near either band (hang fixture: 0.1 to 0.44 s
against a 10 s half-floor; no al-runner leg produces a timeout).

### D2. The new cause `timeout-unconfirmed`: the full ripple (as R514's I3)

`report.ts` `MutantErrorCause` + `ERROR_CAUSE_INTERPRETATIONS` (meaning, entailedNegative, basis
"R516") + `errorBreakdown`'s `named`; `explain.ts` `EXPLAIN_SCHEMA_VERSION` 14 -> 15 with a version
note; `schemas/explain-v15.schema.json` (hand-written: new file via the Write tool from v14's text,
version const and cause enum changed; NOT `cp`); `bun scripts/generate-schemas.ts` (report-v3,
stream-v1 gain one enum line; their versions do not move); `schemas/README.md`;
`docs/using-lethal-from-an-agent.md` v14 -> v15; `tests/schemas.test.ts` (v15 in the pinned
root-required list, `required(v15) == required(v14)`, the cause domain pin). No committed sample
report needs regenerating (added enum value, report schema stays v3). A snapshot update only
whole-file and only where the builder shows the snapshot holds the cause list, the explain version
or `warm-timeout-unconfirmed`'s interpretation text (grep `__snapshots__` first).

[r2] (I1, I4) The interpretation's `meaning` names its scope and both bands: "On bcdev and
al-runner one-shot: the test timed out at position 1 under the mutant, then passed unmutated in
more than half its budget, so the timeout is not attributed (R53's 2x margin). Either the test is
slower now than when its budget was set, or (workers > 1) this worker's tier is slower, or the run
is in the boundary band: a test whose budget is twice its measured duration, or on al-runner
one-shot a test whose compile plus body takes more than half the budget. No verdict. Raise
`--mutant-timeout-ms` to re-score it (R516)." It claims nothing about `--server`.

### D3. R516 exposure 3, al-runner ONE-SHOT: make the in-run limit THE BUDGET (fix at the source)

Root cause, measured by repro (c) fresh: one-shot sends `AL_RUNNER_TEST_TIMEOUT_SEC =
floor(budget / 2000)` and `deadlineMs = budget`. With `budget = 2 x wall`, the in-run limit is about
the wall clock, so R53's 2x margin is gone before any confirm runs; a test whose body is within the
sub-second remainder of its wall clock times out under EVERY mutant. [r2] (M5) That needs the floor
not to bind (wall > floor / 2): the repro lowers the floor to 2000. At the defaults (180 s floor)
one-shot already gives at least about 1.5x; the "no drift" false kill is a lowered-floor or
long-test shape. repro.md and R516's item 3 say so.

Fix: one exported helper in `al-runner-backend.ts`, used by `sendOneShot` and by the test fake:
```ts
/** R516: the in-run limit IS the budget (as bcdev's stop fires at the budget); the client deadline
 *  is twice it, which leaves the compile a full budget of room (today: half). */
export function oneShotLimits(budgetMs: number) {
  return { testTimeoutSeconds: Math.max(1, Math.ceil(budgetMs / 1000)), deadlineMs: 2 * budgetMs };
}
```
Then a mutated run times out only when its BODY passes the budget, the budget is `2 x wall >= 2 x
body`, and R514's rule on the confirm's wall clock (`2 x (body + compile) <= budget`) is stricter
than like-with-like, never looser. Repro (c) reused and fresh both become `survived` (BSlow passes
under the mutant), a real verdict, where a confirm-side fix would leave every mutant covered by such
a test as `error` plus one confirm each.

[r2] `oneShotLimits` is used by `sendOneShot` ONLY. The canary, the contract probe, the
predefined-symbol probe and provisioning keep their own fixed timeouts
(`CANARY_TEST_TIMEOUT_SECONDS`, `HANG_TIMEOUT_SECONDS`, `PROBE_TEST_TIMEOUT_SECONDS`,
`PROVISION_TEST_TIMEOUT_SECONDS`).

Rejected: the backend capability "in-run fraction" judged in the orchestrator. It fixes the confirm
(the symptom) and leaves the run timing out under every mutant (an `error` and a confirm per mutant
instead of a verdict), and it adds a second meaning of "budget" to `ExecutionBackend`.

[r2] (I5) **Cost of D3.** A genuine one-shot hang now runs to the full budget before al-runner stops
it: 180 s instead of 90 s at the default floor, plus the compile. Twice the time per one-shot hang;
zero on every al-runner leg today (no hang). In the CHANGELOG.

Side effect to document: the baseline's in-run limit moves from 60 s to 120 s at the default
`baselineTimeoutMs` (it was half the stated figure). A test with a 60 to 120 s body that was
non-green on al-runner one-shot becomes green. No fixture test is near it.

### [r2] D3b. `--server` / resource-with-server: NOT closed here; the builder files a new item (I1, I4)

The daemon is spawned without `AL_RUNNER_TEST_TIMEOUT_SEC` (`defaultServerSpawn` inherits the
process env), so al-runner's `TestExecutor` uses its `DefaultTestTimeoutSeconds` of 60, timed on
the test BODY, while LethAL's `durationMs` (so every budget and the confirm) is the whole suite's
wall clock. The new item (section `correctness-risks`; title along the lines of "al-runner
`--server`: a timeout is judged on the suite's wall clock against a 60 s in-run limit LethAL never
set") carries:
- The review's sequence, exactly: T's body is 58 s and suite plus compile is 30 s. The baseline is
  88 s, so the budget is 180 s. Under an unrelated mutant T takes 61 s and times out (al-runner's
  60 s default). The confirm suite takes 88 s, 2 x 88 <= 180, so it is a false kill.
- Evidence: `defaultServerSpawn` (no env), `runViaServer` (`suite.wallMs` as every test's
  duration), `ensureServerSuite` (deadline `max(budget, 10 min)`), and `DefaultTestTimeoutSeconds =
  60` in al-runner's `TestExecutor` (the builder cites the source file and the al-runner build it
  read). Not measured live; no al-runner leg produces a timeout.
- Proposed close: spawn the daemon with `AL_RUNNER_TEST_TIMEOUT_SEC = ceil(F / 1000)`, F being the
  session's `--mutant-timeout-ms` floor (fixed for the daemon's life), and judge a server confirm
  as `2 x measuredDurationMs <= F` (R272's per-test figure). Probe first: does the daemon honour the
  variable, and does each row carry the test's own duration.
- Follow-up in the same item (I4, ex-Q2): on al-runner ONE-SHOT, judge the confirm on
  `measuredDurationMs ?? durationMs` instead of the wall clock, closing D1's `compile + body > F/2`
  lost-kill band (and R514's M3). Needs the same probe for one-shot's per-test figure.
The builder checks `ls docs/roadmap/` for the next free id right before writing, cites names not
file:line, and regenerates `ROADMAP.md`.

### D4. R515: after a passing timeout confirm, re-budget that test for the rest of the shard

In `runMutantsOnBackend`, a map local to the call (`measuredToday: Map<string, { ms: number;
byMutant: string }>`). Local, not shared across workers: each call is one shard on one worker's
backend, so a measurement stays with the tier it was taken on (a slow tier never inflates a fast
tier's budgets). Cost: each shard pays its own first stale confirm, at most `workers` per test per
batch.
- After a cold timeout confirm that answers `pass` (kill or stale alike): keep the larger of the
  stored and the new `confirm.durationMs`, with the mutant that measured it.
- [r2] (I3 c) `budgetOf(ref)` returns `{ ms, source }`: `ms = max(2 x max(baselineDuration ??
  fallback, measuredToday ?? 0), minMutantBudgetMs)`, `source` is `"floor"`, `"baseline"` (reused or
  not, from `baselineReused`) or `{ confirmOf: byMutant, durationMs }`, whichever set the max. It
  only ever raises a budget. `confirmWarm`'s replay is NOT fed in (a warm duration; YAGNI).
- [r2] (M2) `coveringRuns` stamps each `CoveringStep` with the budget it actually SENT and its
  source: the `timeoutMs` given to `runFenced` on the single path, `methods[i].budgetMs` on the
  grouped path. The confirm judges `2 x c <= step.testBudgetMs`, never a fresh `budgetOf` call: the
  map changes during the loop, and the judgement must be against what the timed-out run was sent.
- [r2] (I3 c) The stale cause follows the step's budget source: `"baseline"` on a reused batch gives
  `reused-budget-stale`; `{ confirmOf }` gives `timeout-unconfirmed` with the note naming that
  confirm ("its budget came from the confirm of mutant <code>, C0 ms (R515)"), even on a reused
  batch, because that budget is today's measurement, not the snapshot's; `"baseline"`/`"floor"` on a
  fresh batch gives `timeout-unconfirmed`.
- Works on fresh and reused batches alike (after D1 both confirm).

Why it cannot make a false kill: every kill is still decided by a confirm against the budget THAT
covering run was sent with (`2 x c <= budget_sent`, D1, M2). A larger budget cannot create a
timeout (a run that times out at B' > B times out at B too).
Why it cannot make a genuine hang survive: a hang never passes under a finite budget, and B' is
finite (`c <= max(budget, baselineTimeoutMs)`, so `B' <= 2 x` that). `survived` needs every covering
test to pass. The hang either confirms (kill) or, if the test is now slower again, `error`.
What it can do: a mutant that slows the test by less than `2 x c` now passes, where at the stale
budget it timed out and ended `error`. That is the verdict a baseline measured today would give.
Boundary: B' = 2c puts a later hang's confirm on the 2x boundary (`c' <= c` kills, `c' > c` is
`timeout-unconfirmed`); never a false kill.

## Tests (each pinned both ways, each direction red-checked with the Edit tool)

Flip the repros (remove `console.log`, "repro" -> "fixed"):
- T1 = repro (a): every scored mutant `error`, cause `timeout-unconfirmed`, one confirm each at
  120 000; the note carries both durations and the ratio (I3 b).
- [r2] T1b (I2): fresh batch, BSlow baseline 1000 ms (budget 2000), 1500 ms unmutated later, 2500 ms
  under the mutant: every scored mutant `timeout-unconfirmed` (the confirm at 1500 is inside the
  budget, over half of it). A fresh-only 1x rule (`confirm > budget`) scores it a kill.
- T2 = repro (b): the slow-tier mutant `error` `timeout-unconfirmed`; its confirm ran on worker 1;
  the fast-tier mutants `survived`, no confirm on worker 0.
- T3a/T3b = repro (c) reused / fresh: the fake's limit comes from `oneShotLimits` (imported, so the
  fake follows the real formula); both `survived`, zero confirms.
- T4 = repro (d): `["reused-budget-stale", "survived"]`, budgets `[2000, 10000]`, one confirm.
Direction tests (must stay green):
- T5 fresh genuine hang: BSlow 800 unmutated, `Infinity` mutated, no resume: every scored mutant
  `timeout-killed`, `killPosition` 1, ONE confirm each at 120 000 (replaces "R514 a fresh batch is
  scored as before"; the "R514 ruling" test is flipped into T1 and deleted).
- T6 fresh `confirmWarm` 2x: the existing "fresh confirmWarm keeps the 1x rule" test inverts to
  `warm-timeout-unconfirmed` at 0.75 x, with the "within its ... budget but more than half of it"
  note (I3 a); plus a fresh warm hang with replay at 0.4 x -> `timeout-killed`, `killPosition` 2.
- T7 al-runner backend (al-runner-backend.test.ts, real `run()`): env `AL_RUNNER_TEST_TIMEOUT_SEC x
  1000 >= timeoutMs` (new direction) AND `< deadlineMs` sent (old direction: the existing margin
  test rewritten to compare with the deadline, not the budget; al-runner-transport.test.ts's copy of
  the formula switches to `oneShotLimits`).
- T8 al-runner-shaped genuine hang (ClockBackend with `alRunnerCompileMs: 300`, BSlow 800,
  `Infinity` mutated): `timeout-killed`, one confirm.
- T9 R515 hang after a re-budget: reused, BSlow today 5000 unmutated at the first confirm,
  `Infinity` mutated: first scored mutant `reused-budget-stale`, the next `timeout-killed` at budget
  10 000 (never `survived`). [r2] (M3) Off the boundary: the second confirm returns 4900 ms (a fake
  hook), so `2 x 4900 <= 10 000` with margin; plus one assertion pinning the boundary itself: a
  second confirm of exactly 5000 is `timeout-killed` (`<=`, not `<`).
- [r2] T9b (I3 c): the same, but the second confirm returns 5200 ms: `timeout-unconfirmed` (NOT
  `reused-budget-stale`), the note naming the first mutant's confirm and 5000 ms.
- T10 R515 per shard: workers = 2, the slow tier re-budgets, the fast tier's budgets stay 2000.
- [r2] T11 (M2): grouped path with `maxMethodsPerCall: 1` on a reused batch, where the fake's
  `runMany` records each method's `budgetMs`; after a re-budget the stale note's "B ms budget"
  equals the `budgetMs` that call was sent, for both the first (2000) and the re-budgeted (10 000)
  run.
- [r2] T12 (M8): fresh-batch default-floor slow day: no resume, default floor (180 000), BSlow
  baseline 1000, its unmutated confirm answers `in-flight-unknown`: `error` `stranded`,
  `quarantined` defined, no `timeout-killed` (the fresh twin of R514's default-floor test).
- [r2] (M6) The two R508 tests (`lateVerdictThenCrash`): fire the lease heartbeat INSIDE M0002's
  unmutated confirm (the `before` hook on batch 1's null activation after M0002's timeout), keep
  both existing assertions, add one that the confirm was dispatched, and pin the old shape (the
  heartbeat before the confirm) as "no kill row recorded", so the fixture cannot silently stop
  exercising the late row.
- Ripple tests per D2.

| Id | Revert (Edit tool) | RED | GREEN |
|---|---|---|---|
| A | restore the fresh early kill | T1, T1b, T2, T5 (confirm count) | T3, T4 |
| A2 [r2] | fresh-only 1x rule (`confirm > budget` on a fresh batch) | T1b | T1, T5 |
| B | confirm `pass` on a fresh batch always `error` | T5, T8 | T1 |
| C | fresh stale uses `reused-budget-stale` | T1, ripple test | T5 |
| D | fresh `confirmWarm` back to 1x | T6 (0.75 x) | T6 (0.4 x), T5 |
| D2 [r2] | fresh `confirmWarm` note always "outside the budget" | T6 (0.75 x note) | T6 verdicts |
| E | `oneShotLimits` back to `floor(b/2000)`, deadline `b` | T7 (>= budget), T3a, T3b | T7 (< deadline), T8 |
| F | `oneShotLimits` deadline = budget (limit = budget) | T7 (< deadline) | T3 |
| G | R515 map never written | T4, T9 (budget 10 000) | T1 |
| H | R515 map written with `min`/replace instead of `max`, or budget not `max` with baseline | a T4 variant whose second confirm is faster than the first (budget must not drop) | T4 |
| I | R515 map hoisted to be shared across shards | T10 | T4 |
| J [r2] | `<=` -> `<` in the confirm rule | T9's boundary assertion | T9 (4900) |
| K [r2] | stale cause ignores the budget source (always `reused-budget-stale` on a reused batch) | T9b | T4 |
| L [r2] | confirm judged on a recomputed `budgetOf` instead of the sent budget | T11 | T4 |
| M [r2] | R508 heartbeat moved back before the confirm | the R508 "confirm dispatched" check | the other R508 asserts |

## Builder rules (as R-514)

- Edit/Write tools only for every file, red-check reverts and restores included (no `sed -i`,
  heredocs, `cat >>`, `cp`, shell redirects into files). `explain-v15.schema.json` is written with
  Write.
- Never read `lethal.config*.json`. No credentials. Typed errors extend `Error` directly (none needed).
- Verify loop: `bun run typecheck`, `rm -rf packages/*/dist`, `bun scripts/verify.ts`;
  `bunx biome check` on touched files only.
- Snapshots only whole-file, on purpose, with the diff in the submit note.
- Roadmap: R516 and R515 statuses `fixed in <commit>, live gate pending` until `itest:hang` passes
  against `hang-precommitment.md` (committed as
  `docs/superpowers/specs/2026-10-08-r516-hang-confirm-every-timeout-precommitment.md` BEFORE the
  run) and `itest:alrunner` passes unchanged against `alrunner-precommitment.md` (committed beside
  it); then `done (<commit>)`. [r2] R516's closing text says it is closed for bcdev and al-runner
  one-shot and names the D3b item. [r2] (M5) R516's item 3 gains: "the fresh 'no drift' false kill
  needs the floor not to bind (wall > floor/2); at the defaults one-shot already had about 1.5x".
  File the D3b item (check the next free id with `ls docs/roadmap/` right before writing; names, not
  file:line). Regenerate `ROADMAP.md` (`bun scripts/roadmap-index.ts`) before the final verify; run
  `bun test scripts/line-citations.test.ts`.
- [r2] CHANGELOG, every claim scoped to bcdev and al-runner one-shot (I1). `### Fixed`:
  - "On bcdev and al-runner one-shot, a timeout at group position 1 is now confirmed by one
    unmutated run on every batch, not only a reused one, and on the worker that saw it. The kill
    stands only if that run takes at most half the budget (R53's margin); otherwise the mutant is an
    `error` with the new cause `timeout-unconfirmed`. A warm replay uses the same half-budget rule.
    With the default `--mutant-timeout-ms`, a test that overruns its budget even unmutated is
    abandoned at the deadline on bcdev (an unmutated run has no stop), recorded
    `in-flight-unknown`, and the tier is quarantined; never a kill. Known lost-kill bands, never a
    false kill: a genuine hang can be reported `timeout-unconfirmed` where a test's budget is twice
    its measured duration (above the floor), and on al-runner one-shot wherever compile plus the
    test's body takes more than half the budget (R516). al-runner `--server` is not covered
    (R<new>)."
  - "al-runner one-shot now gives a test its whole budget in-run (it had half) and the process twice
    the budget, so a slow test no longer times out under every mutant. A genuine hang now takes the
    full budget to stop (180 s at the default, was 90 s), and a confirm there is a full invocation,
    compile included (R516)."
  - "Once a confirm measures a test slower than its budget allows, later mutants in the same batch
    and worker are budgeted from that measurement (R515)."
  - `### Changed`: "`lethal explain` schema v15: the cause value `timeout-unconfirmed` (R516)."

## Open questions

- Q1. The lost-kill bands of D1 (bcdev: a budget of `2 x baseline`; one-shot: compile + body >
  budget/2). Recommended: accept (lost kill, never false, zero gate sites); documented [r2].
- Q2. [r2] Decided (I4): not done here; the D3b item's follow-up.
- Q3. [r2] Decided (I1): the D3b item, filed by the builder.
- Q4. Re-budget headroom (D4 sets `2 x c`, R53's own formula). Recommended: keep `2 x c`.
