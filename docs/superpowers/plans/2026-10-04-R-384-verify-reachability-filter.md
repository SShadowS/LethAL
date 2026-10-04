# R-384: verify sends a new test only to the survivors its coverage reaches (plan r2)

Evidence with file:line is in `survey.md` beside this file. To be committed by the orchestrator as
`docs/superpowers/plans/2026-10-04-R-384-verify-reachability-filter.md`. Code references are
checked against `lethal/r384` at master 1d74be06.

## Changes since r1

Review (claude-adversary-r1) and rulings R1-R4. Changed sections are marked [r2].

- **Review 1.** Filterable = `invalidBaselineReason(v) === undefined` (exported) AND non-empty
  coverage; a reused-session pass no longer filters (rule 2; test F1).
- **Review 2.** `coverageFilter` gets a last optional `warn` callback, default `console.warn`;
  verify passes a no-op and prints its own true lines; `nonGreenIndex` left out (rules 3, 7; W1-W3).
- **Review 3.** Budget S = `running.length` in `planVerify`, fixed before filtering (The cap; C5).
- **Smaller.** refusedObjects from exactly `artifact.alSources` (rule 3); fail-closed fixtures 4
  and 6 keep S's member out of the failing test's coverage.
- **R1.** Stated limit in README and the agent guide; `--no-reach-filter`, owned by verify; filter
  state on stderr only, since no report field fits ("Report").
- **R2.** No new verdict, no schema bump; an unreached survivor stays `survived`; stderr counts
  survivors no new test reaches. r1's `reach` and `notReached` fields are dropped.
- **R3.** Hub modes off (as r1). **R4.** Same flag; exact texts in "The cap", pinned with `toBe`.

## Problem

Since R-371 a shared-helper edit turns many tests "new", and `planVerify` adds every new test to
every survivor's request (`verify.ts:914`). Extra runs are about S x N + 2N. Above
`--max-new-tests` (50) verify refuses `too-many-new-tests`: about 1 procedure edit in 6 on DC,
1 in 9 on DO, every edit on BaseApp Test (R-371 r2 relaxed table).

## Key finding: the coverage is already being collected

Verify runs on bcdev only (`cli.ts:5245-5266`). Its first unmutated run of every requested test
already passes `coverage: caps.coverage` (`orchestrator.ts:3864-3871`). Under the default mode,
`fenced`, that is `RunMutantWithCoverage` against the installed artifact, whose line map `attach()`
builds (`bcdev-backend.ts:616-635`). `selectNamed` throws that coverage away. So the "one extra
coverage run" costs **no extra call** in fenced mode. The filter runs AFTER the baseline and
BEFORE the first mutant, inside the lease, on coverage verify already has.

## The filter rule [r2]

Inputs, per verify: the running survivors (their manifest entries), each survivor's source-run
covering tests, the new tests, and the baseline rows `runNamedMutants` just measured.

1. **Whole-session switch.** The filter is ON only when `caps.coverage === "fenced"` AND
   `--no-reach-filter` is not given. In `none` there is no coverage. In the hub modes
   (`procedure`, `line`) the coverage comes from a `GuiAllowed=Yes` Web session, not the fenced
   session that produces verdicts (R55), so a branch on `GuiAllowed` can run on the fence and
   never on the hub. Hub coverage can therefore UNDER-report the fenced path (ruling R3). Off =
   every new test joins every survivor, exactly as today.
2. **Per test: decision 13's freshness, then readable coverage, or fail-closed.** A new test T is
   *filterable* only when `invalidBaselineReason(row?.verdict) === undefined` (a row exists, the
   outcome is `pass`, the session was not reused, and the server reported session keys:
   orchestrator.ts:6577-6587) AND `verdict.coverage` has at least one entry. Otherwise T joins
   EVERY survivor. Why: a reused-session pass skipped setup, so its coverage can miss S's member;
   dropping T would hide it from `selectNamed`'s strict check (orchestrator.ts:6512-6537) and S
   would score `survived` where today it is `error` ("not fresh"). Export the private function
   unchanged; never copy it.
3. **Per survivor: the source run's own rule.** Build `buildCoverageIndex` from the filterable new
   tests only. Call `coverageFilter` as the source run does (`orchestrator.ts:5586-5601`):
   `allTests` = the filterable tests, `localsAreUnnameable = isHubCoverageMode(mode)` (false
   here), and `warn` = a no-op (rule 7). T *reaches* S iff `coverageFilter` puts T in S's
   `covered` list. That covers an exact member hit, the object-level hit for any trigger
   (fallback 1), and every filterable test for a table trigger no filterable test touched
   (fallback 2).
   - **`refusedObjects`** = `coverageRefusedObjects` (line-map.ts:813) over exactly
     `artifact.alSources`, parsed as `lineMapFromSources` does (line-map.ts:936). Why: these are
     the files `attach` built the fenced line map from (bcdev-backend.ts:621-623), so the coverage
     lines were placed in them; the project on disk may have changed since, the installed build
     has not. `runNamedMutants` holds `artifact` (orchestrator.ts:6309) and hands it to `narrow`.
   - **`nonGreenIndex` is left out.** It serves R140's decline (a table trigger only a red test
     touches goes `uncovered`, not to fallback 2). In verify the red test joins every survivor
     anyway (rule 2), so leaving the index out can only ADD the filterable tests to S, never
     remove one; decision 13 then makes S `error`, as today.
4. **Per survivor: fail-closed.** S takes every new test when it is in `split.refused` (R298),
   in `split.unplaceable` (R175), or has no member key: `procedureName` "", no `triggerName`, no
   `coverageArmNames`.
5. **Never remove.** S's request = its source covering tests (untouched, even one that is new),
   then the new tests that reach it, then the fail-closed new tests. The filter only removes a
   new test that is NOT in S's source covering set.
6. **Unchanged:** decision 13 (every requested method needs a green fresh baseline), the rerun of
   EVERY new test (decision 11), killer-first ordering, and TestPage refusals.
7. **Console lines (review 2) [r2].** `coverageFilter` warns at selection.ts:580-594. Inside
   verify two lines are false: the R175 line calls S "reported no-coverage" and says to re-run
   with `coverageMode "none"`, while in verify S takes every new test (rule 4); and fallback 2
   says "all N green test(s)", while there N is only the filterable new tests. **Design: a last
   optional parameter `warn: (line: string) => void = console.warn`.** Both `lethal run` call
   sites (orchestrator.ts:5586, 5639) pass nothing, so `lethal run` prints the same bytes. Verify
   passes `() => {}` and prints its own lines from the returned `CoverageSplit`
   (`untargetedTriggerCount`, `unplaceable`, `refused`) through the existing `warning` event,
   code `verify-reach-fail-closed`: `${k} survivor(s) take every new test because coverage cannot
   place their code (R175/R298): ${ids}` and `${k} table-trigger survivor(s) take all ${M} new
   test(s) whose coverage could be read, because none of them touched that table: ${ids}`. Why a
   callback, not a `quiet` boolean or a quiet copy: a copy of `coverageFilter` could drift from
   the source run's rule, which the filter relies on; a boolean would also work, but a callback
   lets a unit test capture `lethal run`'s lines. `nonGreenIndex` is passed as `undefined`
   (rule 3). This edits `selection.ts` (signature only), so the al-runner gate runs (Live check).
8. **Stderr state line (R1).** Verify writes one line through a new optional `VerifyDeps.log`
   (default: stderr; `verifyFromCli` passes its stderr writer), never to stdout:
   - on: `[lethal] verify: reach filter on (fenced coverage): <N> new test(s), <F> joined every survivor because their coverage could not be used; <P> mutant run(s) instead of <S·N> without the filter; <U> survivor(s) no new test reaches.`
   - off: `[lethal] verify: reach filter off (<why>): every new test runs against every survivor.`
     with `<why>` one of `--no-reach-filter`, `coverage mode "procedure" is a hub mode`,
     `coverage mode "line" is a hub mode`, `coverage mode "none"`.
   Each text pinned with `toBe`. `log` is a dependency, not a report field.

"Reaches" is MEMBER granularity: at least one line of the mutant's procedure or trigger had
`No. of Hits > 0` in T's own call (`ControlApi.Codeunit.al:204-226`). For a trigger it is "any line
of the object". That is the same grain, function and arguments that picked S's covering tests in
the source run.

## Why no verdict moves from killed to survived (and the one class that can)

A mutant is a runtime-guarded statement inside a member body (schemata). A test that never
executes that statement runs byte-identical code under the mutant. Coverage is collected per
method in a fresh fenced session, at line level, and collapsed UPWARD to the member. So "T
executed the mutated statement" implies "T's coverage hits S's member". The filter drops only
tests whose coverage shows no line of the member (or, for a trigger, no line of the object).
Class by class:

| Class | Does coverage see it? | Handling |
|---|---|---|
| Ordinary statement in a public or local procedure | yes (fenced names locals) | filtered |
| Trigger of a table, page, codeunit `OnRun`, extension | object-level (fallback 1); table trigger seen by nobody → all tests (fallback 2) | filtered; over-approximates |
| Tier-2 call-site mutants (`swap-modify-flag`, `validate-to-assign`, `remove-calcfields`, filter literals, `write-txn-codeunit-run`) | yes: the kill needs the call site to run; the trigger it fires runs in the same call | filtered |
| `remove-commit` (killed by a later platform refusal) | yes: the refusal happens in the same test, after it executed the Commit's member | filtered |
| `forced-trigger-raise`, `insert-key-assignment` (trigger bodies) | object-level | filtered |
| Target-app event subscribers, manual subscribers a test binds | yes: same session, recorded | filtered |
| Setup: test `OnRun`, `Initialize`, handlers | yes: each method is its own `CODEUNIT.Run` (`RunMany.Codeunit.al:13-16`), and coverage is taken cold, so one-time setup is INCLUDED | over-approximates |
| Object in an `#if` wrapper (R298) | no | S fail-closed (rule 4) |
| A line coverage cannot place (R175) | no | S fail-closed (rule 4) |
| Mutant with no member key | no | S fail-closed (rule 4) |
| Declarative sites, compile-time effects | produce no mutant / none per mutant | n/a |
| Hub-mode sessions (GuiAllowed differs) | may under-report | filter off (rule 1) |
| al-runner, incl. R383/R407 | verify is bcdev-only. A project R383 disqualifies runs in `"none"`, and R354 refuses a mode mismatch | off (rule 1); pinned anyway |
| **State left by an EARLIER test in the same `RunMutantMany` call** (SingleInstance globals, data committed under disabled isolation, session settings) | **no** | **see below** |
| **Code run in ANOTHER session** (StartSession, TaskScheduler, job queue) | **no** (not in this session's coverage) | **see below** |

**The two residual classes.** In both, a test B that never runs S's member fails because of
something S's mutation did elsewhere: in an earlier test of the same call, or in a background
session. Today's verify could record that as a kill by B; with the filter, B is not sent. Two
facts bound this. First, the source run's selection has the same blind spot, so a fresh
`lethal run` over the edited suite would not send B to S either: filtered verify AGREES with a
fresh run, which is what `itest:agreement` checks. Second, R198 measured that writes do not leak
between methods in one call; only SingleInstance state and committed data can. **[r2] Ruled
(R1): a stated limit**, written in `README.md` (beside the existing `lethal verify` text) and in
`docs/using-lethal-from-an-agent.md` (the flag table at :158 and the verify section near :586), in
these words: "The filter sees only code a new test runs itself, in its own session. A test that
fails only because an EARLIER test in the same call left state behind (SingleInstance globals,
committed data), or because of code run in another session (StartSession, a scheduled task, the
job queue), is not sent to that survivor. A fresh `lethal run` has the same blind spot. Pass
`--no-reach-filter` to send every new test to every survivor, as before R-384." M4 still counts
those constructs, to size the limit; no session-wide switch is built.

**`--no-reach-filter` (R1).** `RUN_FLAGS` (cli.ts:1164) is the one strict `parseArgs` table every
subcommand shares, so the flag is scoped like `--max-new-tests` (cli.ts:1362-1366): a table row
`{ type: "boolean", default: false }` plus a `FLAG_OWNERS` row, `owners: ["verify"]`, `instead:
"It turns off lethal verify's coverage reach filter."`. Every other subcommand then REFUSES it by
name in `refuseFlagsThisSubcommandDoesNotOwn` (a boolean counts only when true, so the default is
not refused). Also: `VERIFY_FLAGS` (cli.ts:1375), the flag list in verify's refusal text
(cli.ts:1526), `VerifyCliConfig.noReachFilter`, `runVerify`'s args, `planVerify`.

## Fail-closed cases (each pinned by a unit test) [r2]

Every fixture below gives the failing test coverage that does NOT include S's member, so the test
goes red if the fail-closed clause is reverted (the test would otherwise be dropped from S).

1. Mode `none` → every new test joins every survivor. 2. Hub mode `procedure` or `line` → same.
   2b. `--no-reach-filter` → same.
3. Coverage unreadable: a `pass` with `coverage` undefined.
4. Coverage partial: outcome `fail`, `timeout`, `skip`, `error` or `deadline-exceeded`; the row
   carries coverage of a SIBLING member of S's object only. (Decision 13 then makes every
   survivor `error`, as today.) 4b. Not fresh (review 1): a `pass` with sibling-only coverage and
   `testRunsBefore: 3`; a second fixture with no session keys. Both join S.
5. Coverage empty: a `pass` with zero entries (R58's "thin coverage" signal, today only a warning).
6. Row absent (session stopped, lease lost, missing answer): T's row is missing while another,
   filterable test has sibling-only coverage; T joins S, the sibling-only test does not.
7. Coverage run failed or timed out: covered by 4 and 6.
8. Survivor without a site mapping: refused object, unplaceable, or no member key.
9. Mixed mode: the source and verify modes differ → R354 already refuses (pin it still fires
   first). A mixed session (some tests readable, some not) → per-test rule 2; pin both kinds in
   one session.
10. A table-trigger survivor no filterable test touches → fallback 2 → every filterable test.
    With a red test that does touch the table, S takes every filterable test plus the red one
    (`nonGreenIndex` left out, rule 3).

Every fail-closed test emits one existing `warning` event, code `verify-reach-fail-closed`,
naming the test or survivor and the case. No new event type.

## The cap [r2]

**Ruled (R4): the cap counts EXECUTIONS after filtering, under the same flag.** `--max-new-tests`
and `too-many-new-tests` stay; VERIFY_REFUSALS is unchanged. Names: N = new tests (TestPage-refused
ones excluded, as today, verify.ts:846); **S = `running.length` in `planVerify` (verify.ts:727-733)**,
the survivors left after equivalence marks, computed ONCE before any filtering and carried to the
late check as a number (review 3). It is never recomputed from the narrowed request map, the
TestPage-refused set, the `unreached` set or decision-13 errors: any of those is smaller, would
shrink the budget, and could refuse late a run that passes today. Budget `B = max x (S + 2)`;
before = `S·N + 2N`; after = `E = 2N + P`, P = Σ over survivors of the new tests joined that are
not already in that survivor's covering set; F = new tests that joined every survivor (rule 2).
Today's check is `N > max`, i.e. `before > B`. Since `E ≤ before`, no verify that passes today
refuses after this change.

`planVerify` reads the mode from `backend.capabilities().coverage`, as `runNamedMutants` does
(orchestrator.ts:6332), so it knows before any lease whether the filter is on.

- **Filter off (flag, hub mode, `none`), in `planVerify`, before any lease:** refuse iff
  `before > B` (= today's check). Detail, exactly:
  `${N} tests are new or edited since run ${runId}. The coverage filter is off (${why}), so they need ${before} extra test runs (${2N} unmutated, ${S*N} against ${S} survivor(s)). The budget is --max-new-tests ${max} x (${S} survivor(s) + 2) = ${B} extra test runs. Edit classes: ${classes}.${helpers} To run them all, pass --max-new-tests ${N}; or run lethal run again so this source is the recorded one`
- **Filter on, check 1, in `planVerify`, before any lease:** refuse iff `2N > B`; filtering cannot
  lower the two unmutated runs per test. Detail, exactly:
  `${N} tests are new or edited since run ${runId}. Each runs twice unmutated, ${2N} extra test runs, and the coverage filter cannot lower that; without the filter they would need ${before}. The budget is --max-new-tests ${max} x (${S} survivor(s) + 2) = ${B} extra test runs. Edit classes: ${classes}.${helpers} To run them all, pass --max-new-tests ${N}; or run lethal run again so this source is the recorded one`
- **Filter on, check 2, inside `narrow`, after the baseline and before the first mutant:** refuse
  iff `E > B`. Detail, exactly:
  `${N} tests are new or edited since run ${runId}. After the coverage filter they need ${E} extra test runs (${2N} unmutated, ${P} against ${S} survivor(s); ${F} test(s) joined every survivor because their coverage could not be used); without the filter they would need ${before}. The budget is --max-new-tests ${max} x (${S} survivor(s) + 2) = ${B} extra test runs. The unmutated runs had already run when this was found. Edit classes: ${classes}.${helpers} To run them all, pass --max-new-tests ${ceil(E/(S+2))}; or run lethal run again so this source is the recorded one`
- `${classes}` and `${helpers}` are built exactly as today's `tooManyNewTestsDetail`
  (verify.ts:969-986). `planVerify` hands `narrow` a closure that builds them only when check 2
  refuses, so a passing run pays no `explainNewTests`.
- **Late refusal.** Check 2 throws a `VerifyError` from `narrow`. It is safe: no mutant is in
  flight, and `runNamedMutants` rethrows from its catch and releases the lease in `finally`
  (orchestrator.ts:6455-6460). `refusalOutput` builds the usual shape carrying `verifyRunId`; its
  comment "before anything was measured" is amended. Today's tests pinning the old text
  (verify.test.ts, orchestrator.test.ts) are updated to the new text.

## Shape of the change [r2]

- New pure module `packages/runner/src/verify-reach.ts`: `narrowVerifyRequests({mode, enabled,
  survivors, coveringKeys, newTests, baseline, refusedObjects})` returns `{state: {on: true} |
  {on: false, why}, methods: Map<mutantId, TestMethodRef[]>, failClosedTests,
  failClosedSurvivors, unreached: Set<mutantId>, noNewTest: Set<mutantId>, joins: P}`. It reuses
  `buildCoverageIndex` and `coverageFilter`; the only `selection.ts` edit is rule 7's `warn`.
- `NamedMutantsConfig.narrow?: (baseline: readonly BaselineRow[], ctx: {coverage: CoverageMode;
  alSources: readonly AlSource[]}) => {methods, unreached}`, called in `runNamedMutants`'s
  `select` (orchestrator.ts:6431-6434) BEFORE `selectNamed`. A mutant left with no method is
  removed from `named` and returned in `NamedMutantsResult.unreached`.
- **A survivor no new test reaches (ruled R2): it stays `survived`.** No new verdict. Two cases:
  - it has source covering tests: they run as today, and it is measured as today;
  - it has none (a source `no-coverage` target, or every covering test is gone): nothing is sent.
    Verify answers `verdict: "survived"`, `testsRun: []`, and the existing `failureNote`: `no new
    test reaches it: the coverage of the ${K} new test(s) that could be read shows none of them
    running ${member}, so nothing was run (R-384)`. It counts toward exit 5, like any survivor.
  The `no-tests-to-run` refusal (verify.ts:931) is planned before the baseline and is unchanged.
- **Stderr count (R2).** Rule 8's "on" line carries `<U>` = survivors whose final request has no
  new test (both cases above), and when U > 0 a second line lists them:
  `[lethal] verify: survivors no new test reaches: ${ids.join(", ")}`.

## Report, identity, fingerprint, explain [r2]

- **SessionReport:** untouched; verify builds none.
- **Identity keys, digests, dependency fingerprint, store schema:** unchanged.
- **Explain inputs:** unchanged.
- **VerifyOutput: unchanged; `VERIFY_SCHEMA_VERSION` stays 4.** No existing field fits the
  filter's on/off state (verify.ts:1064-1140; schemas/verify-v4.schema.json has
  `additionalProperties: false` throughout): `refused` is for refusals, `quarantined` is exit 3
  only, `testPageRefused` is R-236c's list, and per-result `notRun` means "refused for TestPage",
  so a filtered-out test must not go there. The state goes to stderr only (rule 8); putting it in
  the JSON needs a new field and v5, a separate ruling. Per survivor, `testsRun` already shows
  which new tests were sent.
- **Events:** the existing `warning` type only.

## Offline measurement (a separate sonnet run, on the Windows host: the corpora are on `U:`)

**What the data allows: DO only.** The R-371 walk gives each edit's new-test set for DC, DO and
BaseApp, but survivors and per-test coverage exist only for DO
(`docs/campaign/2026-08-08-r85-swap-population/rung2.report.json`: 104 survived, 344 no-coverage,
per-mutant `coveringTests`, mode unrecorded). **DC and BaseApp after-filter numbers can only be
measured live**, by a fenced `lethal run` campaign with the baseline snapshot kept (store.ts:1351).
Script `scripts/r384-filter-measure/measure.ts`, outputs `RESULTS.md` and `output.txt` there:

- **M1.** Reuse `scripts/r371-reach-measure/product-measure.ts`'s walk (relaxed rule) on
  `U:/Git/do-rel2/Test`: per test-app procedure edit e, `NEW_e` as `Codeunit.Method` names.
- **M2.** S = survived + no-coverage; `reach(T) = {s survived : T ∈ coveringTests(s)}`. Report the
  name-match rate of `NEW_e` against the report; an unmatched name counts as fail-closed.
- **M3.** `before_e = S·N_e + 2N_e`, `after_e = 2N_e + Σ_{T∈NEW_e} |reach(T)| + S·|unmatched_e|`.
  Report p50/p90/max of N_e, before, after, after/before; the share of edits over 50·(S+2), before
  vs after; and p50/p90/max of |reach(T)|.
- **M4.** To size the stated limit (R1): count `StartSession`, `TaskScheduler.CreateTask`,
  `Job Queue Entry` and `SingleInstance = true` in the DO, DC and BaseApp app sources.
- **Stated limits.** The edit that kills a survivor usually adds it to T's reach, so after_e is a
  lower bound; the report predates R354 and its suite may differ from `do-rel2`. Do not run DC or
  BaseApp beyond M1 and M4.

## Live check [r2]

- **bcdev, under a Cronus28 lease** (tell the orchestrator before leasing):
  `LETHAL_ITEST_AGREEMENT=1 bun run itest:agreement` (sandbox-harden). It must stay green: verify
  agrees with fresh run B on every row, 4 killed and 1 skipped. New pre-committed pins: the
  captured `log` line starts `[lethal] verify: reach filter on (fenced coverage)`, and per
  survivor the exact `testsRun`, including at least one survivor whose `testsRun` LACKS a new test
  (proof the filter is not inert). Predictions go in
  `docs/superpowers/specs/2026-10-04-r384-reach-precommitment.md`, written BEFORE the run.
- Then `LETHAL_ITEST_VERIFY=1 bun run itest:verify` (sandbox-app): ClampPercent is still killed by
  the new test, LogAudit still survives, and the pre-committed `testsRun` holds.
- **al-runner:** verify does not run there, but rule 7 edits `selection.ts`, which the source run
  uses on every backend. Run `LETHAL_ITEST_ALRUNNER=1 bun run itest:alrunner` locally: all legs
  unchanged per mutant.

## Tasks (TDD; red-check every one: revert the named clause, see the named test go red, restore)

1. **`verify-reach.ts` and its tests.** Fail-closed cases 1-6, 8 and 10, one test each, with
   fixtures as written above (S's member never in the failing test's coverage).
   - **F1 (review 1):** case 4b. Red-check: drop the `invalidBaselineReason` clause, keeping only
     `outcome === "pass"` plus non-empty coverage → the reused-session test is dropped from S → red.
   - **F2:** case 4 and case 6. Red-check: treat a missing or non-pass row as "no coverage, so
     reaches nobody" → red.
   - **W1 (review 2):** a run of `narrowVerifyRequests` with an unplaceable survivor and a
     fallback-2 trigger, with `console.warn` spied: zero calls. Red-check: pass `console.warn`
     instead of the no-op → red.
   - **W2:** `coverageFilter` with no `warn` argument still calls `console.warn` with today's
     exact two strings (`toBe`). Red-check: change the default to a no-op → red.
   - **W3:** case 10 with a red test touching the table: S's request = every filterable test plus
     the red one. Red-check: pass a `nonGreenIndex` built from the non-filterable tests → red.
   - Positives: a member hit joins; a sibling-member hit does not (red-check: return every test);
     a trigger joins on an object-level hit; a local needs an exact hit under fenced; a source
     covering test that is new and no longer reaches S is KEPT (red-check: filter it).
2. **The `narrow` seam in `runNamedMutants`.** Phase order by call counters on a stateful fake:
   `narrow` runs after the last baseline run and before the first mutant run, and receives the
   loaded artifact's `alSources`. **RO:** verify builds refusedObjects from those: a survivor in an
   `#if`-wrapped object that is in the stored `alSources` but not in the project on disk is
   fail-closed. Red-check: build from the project directory → red. An `unreached` mutant is
   answered and never sent. A throw from `narrow` releases the lease (release counter = 1).
3. **Verify wiring.** Pass `narrow`; `unreached` → `survived`, `testsRun: []`, the `failureNote`
   above (`toBe`). Red-check: send the dropped tests instead → red. Case 9: the mode-changed
   refusal still wins. Decision 13 with a red new test: every survivor is `error`, as today.
   **State lines (R1, R2):** one test per rule-8 text, each `toBe` on the captured `log`, including
   `<U>` and the id list. Red-check: hard-code `on` → the hub and flag tests go red.
4. **The flag (R1).** `parseCliConfig(["verify", ..., "--no-reach-filter"])` sets `noReachFilter`;
   `["run", ..., "--no-reach-filter"]` and `["campaign", ...]` are refused with the `FLAG_OWNERS`
   text (`toBe`); the verify flag-list refusal text names it. Red-check: drop the `FLAG_OWNERS` row
   → `run` accepts it silently → red. A verify with the flag sends every new test to every
   survivor (red-check: ignore the flag).
5. **The cap (R4, review 3).** All three detail texts pinned with `toBe`.
   - C1: filter off, `N = max` passes and `N = max + 1` refuses (today's boundary, unchanged).
   - C2: check 1, `2N = B` passes, `2N = B + 2` refuses before any lease (lease counter 0).
   - C3: check 2, `E = B` passes, `E = B + 1` refuses after the baseline; lease released.
   - C4: the refusal names `ceil(E/(S+2))`. Red-check: count N instead of E → red.
   - **C5 (S fixed before filtering):** max 2, survivors A, B, C, new tests T1-T3 with no covering
     overlap; T1 reaches A and B, T2 reaches A, T3 reaches B, none reaches C. P = 4, E = 10,
     S = 3, B = 10: passes. Red-check: take S from the narrowed map (2, so B = 8) → refused → red.
   - C6: filter on, every test fail-closed, `N = max`: passes (nothing passing today refuses).
6. **Docs.** README and `docs/using-lethal-from-an-agent.md`: the stated limit (text above), the
   flag (flag table at :158), the state lines, the new cap text in the refusal table at :524;
   CHANGELOG. No schema file changes.
7. **Offline measurement** (sonnet, host), then the live gates with the pre-commitment.
8. **Finish.** `bun run typecheck`; `rm -rf packages/*/dist`; `bun scripts/verify.ts`;
   `bunx biome check <touched files>`; set `docs/roadmap/R384.md` status `done (<commit>)`;
   `bun scripts/roadmap-index.ts`. File roadmap items for the stated limit (cross-test state and
   other sessions) and for skipping the rerun of a new test that joins no survivor (it still costs
   2N; changing that needs a `NewTestState` value). Re-check the next free id first.

## Rulings folded in (r1's questions)

1. Residual classes → a stated limit plus `--no-reach-filter` (R1). 2. No new verdict; stays
`survived`, no schema bump (R2). 3. Hub modes off (R3). 4. Execution budget, same flag (R4).
Open: whether the filter state should also enter the JSON (needs a new field and v5; not built).
