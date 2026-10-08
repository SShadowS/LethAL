# R-514 plan r2: confirm a position-1 timeout unmutated when the batch's baseline was reused

[r2] Revised after `/coord/handoff/R-514/review-r1-opus-adversary.md` and the coordinator's
decisions. Every change from r1 is marked [r2]. Adopted: C1 (the 2x rule, in the position-1 confirm
AND in `confirmWarm`'s timeout grain on reused batches), I3 (a new cause, `reused-budget-stale`,
with its full ripple, plus a reuse clause in `RUNNER_DISAGREEMENT_NOTE`), I2 (the default-floor
outcome is documented, in the table and the CHANGELOG; no `confirmWarm` k=1 route), M1, M2.
I1 and I4: no warm-up and no mutated re-run now; ONE live probe instead
(`/coord/handoff/R-514/probe-precommitment.md`). Open questions: (1) no fresh-baseline confirm here,
the builder files it with M4; (3) the builder files option (C); (4) no.

Read `/coord/handoff/R-514/repro.md` first. Four repro tests (RED) and four controls (GREEN) exist,
uncommitted, at the end of `packages/runner/tests/resume.test.ts` (describe "R514: ...").

## Where every budget comes from (all routes checked)

Every per-test budget in the mutant phase comes from ONE function, `budgetOf` in
`runMutantsOnBackend`:

```
budgetOf(ref) = max(2 x (baselineDuration.get(ref) ?? fallbackTimeoutMs), minMutantBudgetMs)
```

- `baselineDuration` is built by `select` from the green baseline rows' `verdict.durationMs`
  (`runSession`'s select; `selectNamed` for probes). On a reused batch those rows ARE the snapshot's
  (`scoreBatch` pushes `reused.baseline` into `baseline`), so every duration is the snapshot's.
- `fallbackTimeoutMs` = `scope.baselineTimeoutMs` (default 120 000), for a test with no duration.
- `minMutantBudgetMs` = `--mutant-timeout-ms` ?? `MIN_MUTANT_BUDGET_MS` (180 000).

What reads `budgetOf` (each one carries a reused duration on a reused batch):
1. Single path (`coveringRuns.single`): `runFenced(..., { timeoutMs: budget })`. In the transport
   the budget is the soft deadline: with `--stop-hung-sessions` the stop hook (`StopHungRunAt`)
   fires at the budget and the hard abort is at budget + stop grace (30 s); without it, abort at
   the budget.
2. Grouped path: `fits()` (budget + stop grace <= request ceiling) decides chunking and which
   methods go alone; `methods[].budgetMs` is each method's budget in `RunMutantMany`, where the
   transport fires `StopHungRunAt` when that method's elapsed time passes `budgetMs`.
3. `CoveringStep.testBudgetMs`: the operator-facing notes, and `classifyRetryRefusal` on the single
   path (`groupBudgetMs` = budget there).
4. The kill-confirmation rerun after a `fail`: `runFenced` unmutated at `budget`.
5. `confirmWarm` (position > 1): the replay sends the chunk prefix's budgets, and for a timeout
   judges `kth.durationMs > budget`.

Not duration-derived: `groupBudgetMs` on the grouped path (ceiling + grace), the R198 inert warning
(floor only), the baseline's own deadline (`baselineTimeoutMs`), carried verdicts' `durationMs`
(record only), and the report (R272 already keeps reused durations out of `testMethods`).

So the place a `timeout` becomes a verdict covers all of them. Route 4 and route 5 already confirm.
Route 1 and route 2 at position 1 do not. That is the hole. [r2] Route 5 confirms with a 1x margin,
which on a reused batch has the same variance problem as C1, so it changes too.

## Options

### (A) Confirm a position-1 timeout unmutated, when the batch's baseline was reused — RECOMMENDED

Reuse the existing cold kill-confirmation block (today `if (v.outcome === "fail")`): activate
`null`, `runFenced` the same test once, no mutant. On BC this needs NO deploy: the instrumented
artifact with no active mutant is the unmutated program (that is how the `fail` confirm and the
baseline already run). Cost is one `activate(null)` call and one test run.

**The confirm's deadline is NOT the budget. It is `max(budget, baselineTimeoutMs)`.** Reason, from
the code: `bcdev-backend.ts` wires the R53 stop hook ONLY when a mutant is pending
(`pendingMutantId !== ""`). An unmutated run that overruns its deadline is ABORTED, which is
`in-flight-unknown`, which quarantines the tier and latches the session. With a low
`--mutant-timeout-ms` (budget below 120 s) the confirm gets the baseline's own deadline, so a
slow-day test is measured instead of quarantining. [r2] (I2) With the DEFAULT floor (180 000, which
is above `baselineTimeoutMs` 120 000) the deadline IS the budget. A test that is slow enough today to
overrun a 180 s budget unmutated is then aborted: `in-flight-unknown`, `stranded`, the tier
quarantined, the session latched. That is the same outcome a re-run baseline gives such a test (it
overruns the 120 s baseline deadline), so it is no worse than not reusing, and it is never a kill.
Documented in the table and the CHANGELOG. Not routed through `confirmWarm` with k=1.

[r2] (C1) **The kill rule is R53's 2x margin, not 1x.** The mutant's timeout is attributed to it
only if `2 x confirm.durationMs <= budget`: a fresh baseline taken today would have given the test a
budget at least as large as the one it overran. With 1x, ordinary variance kills: a 180 s budget,
a test at 175 ± 8 s today, a mutated run at 183 s (timeout) and a confirm at 172 s (pass) is a false
kill. The 2x rule is also safe on al-runner, whose in-VM timeout is budget/2.

What each confirm answer means:

| Confirm answer | Verdict | Why |
|---|---|---|
| `pass`, `2 x durationMs <= budget` [r2] | `timeout-killed`, `killPosition` 1, `killingTestFailure` from the MUTATED run | A baseline today would have budgeted at least this much; the mutant made the test overrun it. |
| `pass`, `2 x durationMs > budget` [r2] | `error`, cause `reused-budget-stale` (NEW) | The test is slower today than the reused baseline says; not the mutant. |
| `fail` / `error` / `timeout` | `error`, cause `unstable` (existing else branch) | Red unmutated today: says nothing about the mutant. |
| `deadline-exceeded` | `error`, cause `deadline-exceeded` (existing) | Infrastructure. |
| `in-flight-unknown` | `error`, `stranded`, tier quarantined, session latched (existing) | [r2] It overran the confirm deadline unmutated. With the default floor that deadline is the budget (180 s), so a test slower than 180 s today lands here. A re-run baseline would have quarantined the same way. |
| lease answers, op-in-flight, lost ack, `session-reused` | existing branches | Unchanged. |

Never a kill without a confirm `pass` at half the budget or less.

[r2] (C1) **`confirmWarm`'s timeout grain, on a reused batch:** confirmed only if
`2 x kth.durationMs <= budget`. Otherwise, when the replay completed with every entry passing,
`error`, cause `reused-budget-stale`. A replay that stops method k stays `warm-timeout-unconfirmed`
(existing). On a fresh batch `confirmWarm` is unchanged (1x, `warm-timeout-unconfirmed`).

Effect on run time: zero for a fresh baseline and for any batch with no timeout. On a reused batch,
one `activate(null)` + one unmutated run per position-1 timeout. For a genuine hang that run is the
test's normal duration (seconds). For a false kill it is the test's real duration today, at most
`max(budget, baselineTimeoutMs)`. R192 saves about 215 s of baseline per resume on the measured
run, so this cost is small. The 2x rule adds no runs.

Measured in r1 (scratch edit, 1x rule and cause `unstable`, reverted with Edit): all 4 repros
GREEN, direction 2 GREEN with one unmutated BSlow confirm per kill at `timeoutMs` 120 000, controls
unchanged, full `bun test packages/runner` 5237 pass / 0 fail. So no existing test pins the old
behaviour on a reused batch. [r2] The 2x rule and the new cause are not yet measured; the builder
re-measures.

### (B) A budget floor for reused durations — REJECTED, narrows only

For example: treat a reused duration as unknown (`fallbackTimeoutMs`), giving
`max(2 x baselineTimeoutMs, floor)` = 240 s by default.
- Does not close (b1): a test that is red or hung today times out under ANY budget.
- Does not close a slow day beyond the new floor either.
- Costs every genuine hang kill on a reused batch the full inflated budget (240 s instead of
  `max(2d, floor)`), which is exactly the slow path R53 shortens. Large run-time cost, no closure.

### (C) Re-measure T's baseline when a position-1 timeout happens on a reused baseline

The re-measure run IS (A)'s confirm (unmutated, at the baseline deadline). (C) adds only one thing:
feed the measured duration back into later budgets, so later mutants covered by T get a correct
budget instead of each paying a timeout + confirm + `error`. Better verdicts on a slow day; no
effect on false kills; needs a mutable duration map shared across shards. [r2] Not in this fix:
**the builder files it as a roadmap item** (decision 3).

### Recommendation

(A), on the reused path only, with the confirm deadline `max(budget, baselineTimeoutMs)`, [r2] the
2x rule in both confirms, and the new cause `reused-budget-stale`. It closes all four repros, keeps
a genuine hang `timeout-killed`, and changes nothing for a fresh baseline.

## Code

### orchestrator.ts

1. `runMutantsOnBackend` args: add
   ```ts
   /** R514: this batch's baseline came from a stored snapshot (R192), so its durations, and every
    *  budget derived from them, are from another day. A position-1 `timeout` is then confirmed
    *  unmutated before it is scored, and every timeout confirm uses R53's 2x margin. */
   readonly baselineReused: boolean;
   ```
   [r2] Add the same field to `confirmWarm`'s `args` type (it is passed `args` from the loop
   already, so no call-site change beyond the type).
2. Callers:
   - `scoreBatch`'s sequential call: `baselineReused: reused !== undefined`.
   - `ScoreBatchInput.executeCovering`: add a third parameter `baselineReused: boolean`;
     `scoreBatch` passes `reused !== undefined`; `runSession`'s `executeCovering` (workers > 1)
     forwards it to its `runMutantsOnBackend` call.
   - `runProbes`: `baselineReused: false` (`runNamedMutants` calls `scoreBatch` with no `snapshot`,
     so it never reuses).
   Do NOT put the flag on `CoveringPlan` (built by `select`, which does not know about reuse) or on
   the attestation ledger (one meaning per type).
3. The timeout branch: keep the `groupPosition > 1` → `confirmWarm` block as it is. Wrap today's
   position-1 scoring in `if (!args.baselineReused) { ...timeout-killed...; break; }`, so a
   reused-batch timeout falls through to the confirm block.
4. The confirm block: condition `v.outcome === "fail" || v.outcome === "timeout"` (only a reused
   batch's timeout can reach it). Inside:
   ```ts
   const timedOut = v.outcome === "timeout";
   // R514: an unmutated run has no stop hook (bcdev wires R53's only for a pending mutant), so an
   // overrun is an abort and a quarantine. A timeout's confirm runs at the baseline's deadline when
   // that is longer, and judges the duration against the budget with R53's 2x margin.
   const confirmMs = timedOut ? Math.max(budget, args.fallbackTimeoutMs) : budget;
   ```
   Use `confirmMs` for `runFenced`'s `timeoutMs` AND for `classifyRetryRefusal(confirmOriginal, …)`.
   The `fail` path is byte-for-byte unchanged (`confirmMs === budget`).
5. [r2] Before the existing `confirm.outcome === "pass"` branch add
   `confirm.outcome === "pass" && timedOut && 2 * confirm.durationMs > budget` → `error`, cause
   `reused-budget-stale`, note: "`<T>` completed unmutated in X ms, more than half the Y ms budget
   set from run N's reused baseline (R192), so the timeout at position 1 is not attributed to the
   mutant; a run without `--resume` re-measures the baseline (R514)". The note needs the reused run
   id: pass it with the flag (`baselineReused: { runId: number } | undefined` instead of a boolean is
   acceptable if the builder prefers; then every "boolean" above reads "defined"). In the `pass`
   branch: `verdict = timedOut ? "timeout-killed" : "killed"`. `killingTestFailure = v.failureMessage`
   stays (the mutated run's text).
6. [r2] `confirmWarm`, timeout grain: replace `kth.durationMs > budget` with
   `args.baselineReused ? 2 * kth.durationMs > budget : kth.durationMs > budget`. On a reused batch
   that branch returns cause `reused-budget-stale` with the same note shape ("… at position k of the
   replay …"); on a fresh batch it is unchanged (`warm-timeout-unconfirmed`).
7. Doc comments: the confirm block says a position-1 timeout on a reused batch is confirmed too and
   why; `confirmWarm`'s header comment gains the reused-batch rule. The `resume-baseline-reused`
   warning text gains one clause: "a timeout is confirmed unmutated, with R53's 2x margin, before it
   is scored (R514)". (Tests assert that warning by `includes(...)`; the builder greps for
   exact-text asserts first.)

### [r2] (I3) The new cause `reused-budget-stale`: the full ripple

In order (CLAUDE.md's `SessionReport` ripple, applied to a value domain; precedent: R-204b's
`stop-outcome-unconfirmed`, commit 9dc63a03):

1. `report.ts`: add `| "reused-budget-stale"` to `MutantErrorCause` (comment: `// R514: a timeout on
   a reused baseline whose unmutated confirm took more than half the budget.`). The `Record<>` in
   `ERROR_CAUSE_INTERPRETATIONS` then fails to compile until its entry exists:
   - `meaning`: "This batch reused a stored baseline (`--resume`, R192), so the test's time budget
     came from an earlier run. The test timed out under the mutant; re-run once with no mutant it
     passed, but took more than half that budget, so it is slower today than the stored baseline
     says. No verdict. Re-run without `--resume` to measure the baseline again (R514)."
   - `entailedNegative`: "Not `timeout-killed`: a baseline measured today would have given the test
     a larger budget, so the timeout is not the mutant's. Not `unstable`: the test passed with no
     mutant; only its stored duration is out of date. Not `survived`: the mutated run never
     finished."
   - `basis`: "R514".
2. `report.ts` `errorBreakdown`: add `"reused-budget-stale"` to `named`, so the banner shows it.
3. `events.ts`: nothing (it uses the named type).
4. `explain.ts`: `EXPLAIN_SCHEMA_VERSION` 13 → 14, with a version note: "14: R514 added the cause
   value `reused-budget-stale` to `$.notMeasured[].cause`. A new value, so it bumps (R233); v13 is
   frozen." `KNOWN_ERROR_CAUSES` follows `ERROR_CAUSE_INTERPRETATIONS` by itself.
5. Schemas:
   - `schemas/explain-v14.schema.json`: the explain schema is HAND-WRITTEN (generate-schemas.ts says
     so). Copy v13, change the version const, add the value to the `cause` enum. v13 stays as is.
   - `bun scripts/generate-schemas.ts`: regenerates `schemas/report-v3.schema.json` and
     `schemas/stream-v1.schema.json` in place (+1 enum line each, as R-204b). `REPORT_SCHEMA_VERSION`
     (3) and `STREAM_SCHEMA_VERSION` (1) do NOT move (explain.ts's version note 2 says why).
   - `schemas/README.md`: v14 row current, v13 row "from builds before R514 (v14 added the cause
     `reused-budget-stale`)".
   - `docs/using-lethal-from-an-agent.md`: the two v13 references → v14.
6. `tests/schemas.test.ts`: add `"explain-v14.schema.json"` to the pinned root-required list (same
   list as v13), add `expect(required("explain-v14.schema.json")).toEqual(required("explain-v13.schema.json"))`
   with a comment "R514's v14 added a cause value, not a required field", and add
   `"reused-budget-stale"` to the `notMeasured` cause domain pin.
7. Snapshots: `bun test --update-snapshots` only for a file whose snapshot the builder shows
   contains the cause list or the explain version, whole file, on purpose, with the diff in the
   submit note. None is expected.
8. **Committed sample reports do NOT need regenerating.** An added enum value leaves every existing
   report valid against `report-v3` (no report holds the value), `REPORT_SCHEMA_VERSION` does not
   move, and no committed explain output exists to re-validate (the repo's only v13 references are
   prose). `schemas.test.ts`'s gift-card validation stays green.
9. Not touched: `packages/runner/itest/chunked.itest.ts`' `assertNoNewCauses` list (that gate never
   resumes, so the cause cannot appear there; changing gate code would need a pre-commitment).

### [r2] (I3) `RUNNER_DISAGREEMENT_NOTE` gains a reuse clause

`runner-disagreement.ts`: append to the literal:
"; and if this batch's baseline was reused by `--resume` (R192), the green set is from that earlier
run too, so a test that has gone red since fails here as well: re-run without `--resume` to
re-measure it". The constant is the one shared literal (grep finds no copy in tests, snapshots or
docs). The note is attached only in a hub coverage mode, so a fenced run's `unstable` note is
unchanged.

## Tests

`ClockBackend` [r2]: replace the `hangsUnderMutant` flag with `mutatedMs?: number` (BSlow's
simulated time while a mutant is active; `Infinity` is a hang; absent = `slowMs`).

Flip the repros (remove their `console.log` lines; "repro" → "fixed" in the names):

1. (a) single, (a) grouped max1, (b1), (b2): no `timeout-killed`/`killed` in the scored batch;
   [r2] each scored mutant is `error`, cause `reused-budget-stale`, note naming the reused run; and
   every unmutated BSlow run after a covered timeout was sent at `timeoutMs` 120 000, one per
   position-1 timeout (the deadline pin).
1b. [r2] (C1) **The (budget/2, budget] band gives error.** Reused batch, BSlow unmutated 1500 ms,
   mutated 2500 ms, budget 2000. The covered run times out; the confirm passes at 1500 (inside the
   budget, more than half of it). Expected: `error`, `reused-budget-stale`. The r1 1x rule would have
   scored `timeout-killed`.
1c. [r2] (C1) **`confirmWarm` on a reused batch.** Default grouped settings (one call, AFast at 1,
   BSlow at 2), reused batch:
   - BSlow unmutated 1500, mutated 2500: `error`, `reused-budget-stale` (today: the replay passes at
     1500 <= 2000, so it is a kill).
   - BSlow unmutated 800, mutated `Infinity`: `timeout-killed`, `killPosition` 2.
2. [r2] Direction 2, moved off the boundary: reused batch, BSlow unmutated 800 ms (2 x 800 = 1600 <=
   2000), mutated `Infinity`. Every scored mutant `timeout-killed` by BSlow, `killPosition` 1, one
   unmutated BSlow confirm per kill at 120 000.
3. Fresh batch is scored as today: no resume, BSlow 800 unmutated / `Infinity` mutated: every
   mutant `timeout-killed`, ZERO unmutated BSlow runs after a covered run. Plus control (c) and the
   grouped control stay green unchanged.
3b. [r2] Fresh `confirmWarm` keeps the 1x rule: the existing
   `orchestrator.test.ts` test "a warm timeout whose replay completes k inside budget is
   timeout-killed …" stays green unchanged. If red-check B3 below does not turn it red (its replay
   may be under half the budget), add a fresh-batch case with a replay at 0.75 x budget that must stay
   `timeout-killed`.
4. The fail path is unchanged on a reused batch: a covered run that `fail`s, the confirm passes:
   `killed`, and the confirm was sent at the budget, not at 120 000.
5. A confirm that overruns unmutated is a strand, never a kill. Reused batch, BSlow's unmutated
   confirm answers `in-flight-unknown`: `error`, cause `stranded`, the session latched (`quarantined`
   defined), no `timeout-killed`. [r2] This is the default-floor slow-day outcome (I2); the test
   comment says so.
6. (c2) stays as a measurement of today's rule for a fresh baseline, renamed "R514 ruling: a fresh
   baseline's position-1 timeout is not confirmed", asserting the kill, with a comment pointing at
   the new roadmap item for the fresh-baseline exposure.
7. [r2] (I3) The cause's ripple: `ERROR_CAUSE_INTERPRETATIONS["reused-budget-stale"]` exists and its
   `basis` is "R514"; the banner of a report holding one such mutant shows `reused-budget-stale 1`;
   an explain of that report lists it under `notMeasured` with that interpretation and
   `explainSchemaVersion` 14; the schema pins above.
8. [r2] (I3) `RUNNER_DISAGREEMENT_NOTE` contains "--resume" and "R192" (one assertion; the existing
   R59 tests that use `describeRunnerDisagreement` stay green).

### Red-checks, one per direction (Edit tool only for the revert and the restore; report the red
### output, then the restored green)

| Id | Revert | Must go RED | Must stay GREEN |
|---|---|---|---|
| A | `baselineReused` always false (or step 3's guard removed) | 1, 1b, 1c (stale half) | 2, 3, 4 |
| B [r2] | Position-1 confirm uses 1x (`durationMs > budget`) | 1b | 1, 2 |
| B2 [r2] | `confirmWarm` on a reused batch uses 1x | 1c (stale half) | 1c (kill half), 3b |
| B3 [r2] | `confirmWarm` uses 2x on a FRESH batch too | 3b (or its added 0.75x case) | 1c |
| C | Confirm deadline = `budget` | 1 (the deadline pin) | 2, 3, 4 |
| D | Confirm never confirms (`pass` → error too) | 2, 1c (kill half) | 1, 1b |
| E | Confirm on every position-1 timeout (drop `!args.baselineReused`) | 3 | 1, 2 |
| F | `executeCovering` forwards `false` instead of the flag | a workers = 2 variant of 1 (single path; add it) | 2 |
| G | `pass` branch scores `killed` instead of `timeout-killed` for a timeout | 2 | 1 |
| H | `fail` path uses `confirmMs` computed as for a timeout | 4 | 1, 2 |
| I [r2] | New branch uses cause `unstable` instead of `reused-budget-stale` | 1, 1b | 2 |

F needs one extra test: (a) single with `workers: 2` (the builder checks how the existing worker
tests build a `backendFactory`; if `CountingBackend` cannot serve two workers simply, use the
orchestrator.test.ts worker fakes and say so).

## Builder rules (as R-512)

- Edit/Write tools only for every file, red-check reverts and restores included. No `sed -i`,
  heredocs, `cat >>`, shell redirects into files.
- Never read `lethal.config*.json`. No credentials anywhere.
- Typed errors extend `Error` directly (none is needed here).
- Verify loop: `bun run typecheck`, `rm -rf packages/*/dist`, `bun scripts/verify.ts`;
  `bunx biome check` on touched files only.
- Roadmap: R514 status `fixed in <commit>, live gate pending` until itest:hang AND the R514 probe
  pass against their pre-commitments; then `done (<commit>)`. Regenerate `ROADMAP.md`
  (`bun scripts/roadmap-index.ts`) before the final verify; run `bun test scripts/line-citations.test.ts`.
- [r2] **File two new roadmap items** (check the next free id with `ls docs/roadmap/` right before
  each write; names, not file:line):
  - Decision (1): "A fresh baseline's position-1 timeout is scored with no unmutated confirm": the
    (c2) measurement (a test that slows more than 2x inside one run is `timeout-killed`), plus M4
    (with workers > 1, durations measured on one tier set budgets on others). Evidence: repro (c2).
  - Decision (3): "A confirm that finds a reused duration stale does not correct later budgets"
    (option C): each later mutant covered by the same test pays a timeout + confirm + `error`.
  - Decision (4): no change to the suspect mark; say so in R514's closing text.
- CHANGELOG under `### Fixed` [r2]: "A resumed batch that reused a stored baseline (R192) no longer
  scores a timeout as `timeout-killed` without an unmutated confirm. The test is re-run once with no
  mutant, and the kill stands only if it finishes in at most half its budget (R53's margin);
  otherwise the mutant is an `error` with the new cause `reused-budget-stale`. With the default
  `--mutant-timeout-ms` a test that overruns its budget even unmutated is stopped as a re-run
  baseline would stop it: the run is quarantined, never a kill. A `timeout-killed` recorded on a
  reused baseline BEFORE this fix is still carried by `--resume`; re-run without `--resume` to
  re-score it (R514)." Plus under `### Changed` (or wherever R-204b's v13 entry sits): "`lethal
  explain` schema v14: the cause value `reused-budget-stale` (R514)."
- Commit the pre-commitments BEFORE the live runs:
  `docs/superpowers/specs/2026-10-08-r514-hang-reused-baseline-confirm-precommitment.md` (text in
  `hang-precommitment.md`) and
  `docs/superpowers/specs/2026-10-08-r514-reuse-probe-precommitment.md` (text in
  `probe-precommitment.md`).

## [r2] (I1, I4) Live evidence: one probe, not new code

Neither a warm-up nor a mutated re-run is built now. One probe (two runs) measures both:
- I1: BC's first-call cost after a publish against steady state, on the hang fixture's tests. On a
  reused batch nothing runs between the publish and mutant 1's first covering run, so that run
  absorbs any first-call cost.
- I4: a resume with reuse of the hang fixture: the 5 hangs stay `timeout-killed`, each with one
  unmutated confirm.
It cannot be a plain `lethal run`: the CLI has no clean interrupt (no SIGINT handler), and killing it
mid-run can leave a hung BC session and a held lease. So it is a one-off script modelled on
`hang.itest.ts` that stops run 1 with a planned throw from `activate`, before any BC call for that
mutant. The full method, the predictions and what result changes this plan are in
`probe-precommitment.md`.

## Open questions

None left from r1. Decided: (1) no fresh-baseline confirm here, filed; (2) new cause
`reused-budget-stale`; (3) option C filed; (4) suspect mark unchanged.
