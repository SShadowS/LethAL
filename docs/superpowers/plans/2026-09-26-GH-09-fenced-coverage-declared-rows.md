# GH-09: Fenced coverage with zero declared rows, implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Revision 2 (2026-09-26),** after review round 1 (`H:/lethal-coord/reviews/GH-09-plan/review-r1.md`) and the orchestrator rulings at the end of this file. Changed: the pre-fix prediction is now "Sandbox Logic's three kills are lost", not "a `declaredRows === 0` warning for every test", because the root-level selector rows still count as declared in this mixed fixture (finding 1); H2 is decided by a DISCRIMINATING live row read against the instrumented source, with a red-check, and the base-1 unit test is gone (finding 2); the compile steps are in dependency order and the pre-fix worktree's paths, symbols and published tests app are verified before it runs (finding 3).

**Goal:** Prove, live and per mutant, that a NAMESPACED app now gets fenced coverage attribution, rule out every other cause of `declaredRows === 0` that the reporter's app could have hit, and leave a live gate that goes red if namespaced attribution ever breaks again. That closes R212 and lets issue #9 close.

**Architecture:** No new product code is planned up front. The root cause is already fixed on `master` (see "State of play"). This task (1) puts a `namespace` into the fixture that actually tests attribution, `fixtures/sandbox-app`, so `itest:bcdev` and `itest:alrunner` become the permanent pin with no new gate code, (2) shows that the namespaced fixture reproduces the original failure on the pre-fix client, and (3) runs the coverage differential on the fixed client. Fixes are written only for a hypothesis that Task 1 CONFIRMS.

**Tech Stack:** Bun + TypeScript, AL (runtime 13 target / runtime 16 control app, BC 28.4 DK on `Cronus28`), `alc`, `bun test`.

**Spec:** GitHub issue #9 (`gh issue view 9 -R SShadowS/LethAL`, body and the owner's comment). Related: R212 (no namespaced fixture), R58 (fenced coverage, scope rule), R40 (extension object type integers 14/15), R175 (attribution lost, the `none` comparison), R29 (a shifted line frame names the wrong procedure with full confidence), R169 (fixture id blocks). Skills: `.claude/skills/coverage-differential`, `.claude/skills/al-probe`, `.claude/skills/control-app`, `.claude/skills/live-gate`.

## State of play (read this first)

The bug the issue reports is ALREADY root caused and fixed on `master`:

- `3db4a00` "fix(runner): read a namespaced app's SymbolReference, which declared nothing". `AppMethodIndex.fromSymbolReference` read the object arrays only at the ROOT of `SymbolReference.json`. A namespaced app puts its objects in a nested `Namespaces` tree, one level per dotted segment. So `declaredObjects()` was empty, `LineMap` dropped every row, and all 147 mutants went `no-coverage`. The fix is a recursive walk (`ingestScope`). Unit tests: `app-package.test.ts`, describe "fromSymbolReference with namespaces (issue #9)".
- `dff14ba` "feat(runner): the thin-coverage warning carries its evidence". `thinCoverageEvidence` now prints a sample of row keys, the declared count and sample, and the filter sent, and names "declares NO objects" as its own diagnosis.
- The owner commented on the issue with the root cause and left it open for the reporter to close. R212 is open: "the unit test pins the parse; nothing pins the pipeline."

So GH-09 is not "find the bug". It is: prove the fix end to end on a real server, make sure no SECOND cause hides behind the first, and pin it with a gate. The reporter's 8-digit id range was already refuted in `3db4a00` (an 8-digit app compiled and indexed correctly).

Two side reports in the same issue are NOT fixed and NOT filed: `lethal explain` refuses a `coverageMode: "none"` report (a survivor with no `coverageAttribution`), and `doctor`'s `company` check calls `api/v2.0` on the OData port, which is wrong on `bc-linux` (7048 vs 7052). Task 5 files both. They are out of scope for the fix.

## Hypotheses, ranked

Each row says what would confirm it and the cheapest probe. "Offline" means no container.

| # | Hypothesis | Status now | Confirming evidence | Cheapest probe |
|---|---|---|---|---|
| H1 | Namespaced objects are missing from the declared set (root-only `SymbolReference` read). | CONFIRMED and fixed in `3db4a00`, offline only. Never run end to end. | On the pre-fix client, the namespaced `Sandbox Logic`'s three kills become `no-coverage` and the fenced-vs-`none` comparison lists them under ATTRIBUTION LOST; on the lane head none are lost. A `declaredRows === 0` warning is NOT expected: in this mixed fixture the root-level `Mutation Selector` rows (the `Active` member every guarded site calls) still count as declared, and a resolved `Active` member can suppress the thin-coverage warning entirely. | Task 1 steps 6 and 8: the differential at `3db4a00~1` and at the lane head. |
| H2 | A second silent loss hides behind H1: once the declared set is right, the line map's FRAME is wrong for a file that starts with `namespace ...;`. `fileLineMapEntries` gives the first object base line 1, measured only with a COMMENT header (`DataShiftOps`), never with namespace directives. If BC numbers object lines from after the directives, every row lands 2 lines off. That can attach a row to the WRONG procedure and give a confident wrong covering set (R29); the warning fires only when no member resolves at all. | Untested. Only a live row that DISCRIMINATES the two bases can decide it. A row well inside a procedure resolves the same under both, and keeping the three `exact` kills proves nothing about the boundary. | The witness row (Task 1 step 8): `ClampPercentRuns`'s first row for `Codeunit 79000`, BC's row for `ClampPercent`'s `procedure` declaration line. Under base 1 it resolves to `ClampPercent`. Under the directive-implied base it lands two lines up, on `IsOverBudget`'s `end;` or a blank line, so it resolves to `IsOverBudget` or to nothing. `ClampPercentRuns` never calls `IsOverBudget`, so the right answer is known. | Task 1 step 8, `LETHAL_FENCED_COVERAGE_DUMP`, read against the INSTRUMENTED source; red-checked in Task 2. |
| H3 | After the fix, the line map THROWS for a namespaced object ("declares X but no line map was built"), because the parser nests objects under the namespace node and `fileLineMapEntries` only walks root children. | REFUTED offline 2026-09-26 while writing this plan: tree-sitter-al parses `namespace A.B.C;`, two `using` lines and a codeunit as four SIBLINGS at the root (`namespace_declaration, using_statement, using_statement, codeunit_declaration`), and `fileLineMapEntries` finds the codeunit. This says nothing about BC's frame, which is H2. | n/a | The live runs in Task 1 would throw loudly if it were wrong. No unit test: it would restate the implementation. |
| H4 | Other object kinds are missing from the declared set in the same way: `SYMBOL_ARRAYS`, `OBJECT_TYPE_NAME` and `OBJECT_KIND_TO_TYPE_NAME` have no `reportextension`, though tree-sitter-al parses `reportextension_declaration` (checked offline). A mutant inside a report extension would be silently `no-coverage`, the same class as H1. | Unknown whether operators emit mutants there. Not the reporter's cause (their mutants were in a codeunit), but the same shape. | `lethal run --dry-run` over a scratch app with a `reportextension` lists mutants inside it; its compiled `SymbolReference.json` has a `ReportExtensions` array the index ignores. | Task 1 step 2, offline. |
| H5 | An object sits OUTSIDE the app's `idRanges`, so `coverageObjectIdFilterOf` (built from `idRanges`, not from declared ids) filters its rows out on the server. | Not the reporter's case (their mutated codeunit 71179724 is inside 71179675..71179775). Unknown whether `alc` even allows it. | `alc` compiles an object outside `idRanges` without an error. | Task 1 step 3, offline: one `alc` compile of a scratch copy. |
| H6 | The `SymbolReference` layout differs under the reporter's `alc` 17.0 (Linux) from the `alc` 18 layout the fix was written against. | Unknown. We only have `alc` 18 locally. | The reporter re-runs on `master` and still sees "declares NO objects". | The GitHub comment below asks for exactly that run. |
| H7 | The `coverageObjectIdFilter` string is wrong: 8-digit ids, multi-range (`a..b` OR-ed with `c..d`) syntax, or length. | REFUTED for this report by its own numbers: the server scanned 11,561 rows and EMITTED 1,606 through the filter, so the filter matched real rows. 8-digit ids refuted in `3db4a00`. The multi-range form is unit-tested as a string only. | n/a | None needed for GH-09. |
| H8 | The selector triple sits inside the target's own range and confuses attribution. | REFUTED by design: `sandbox-app` already has that layout (79197-79199 inside 79000-79199) and attributes on every `itest:bcdev` run. | n/a | None. |
| H9 | The target's objects are in a different package than the one instrumented. | REFUTED by the owner's check: the real compiled app declares `codeunit:71179724` once the walk recurses. | n/a | None. |

## Decisions

1. **Namespace `sandbox-app`, not a new fixture.** R212 names this as the cheapest honest pin. `sandbox-app` is the fixture the coverage-differential skill calls "the fixture that actually tests attribution". Its three kills are all in `Sandbox Logic`. The per-mutant identity key (`astHash|codeunitName|procedure|operator|major`, `mutant-equality.ts`) has no line and no namespace in it, so the frozen baselines should compare equal with NO re-record. That is the prediction Task 1 pre-commits.
2. **Shape, taken from the issue.** A multi-segment dotted namespace (`LethAL.Sandbox.Logic`) on `SandboxLogic.Codeunit.al` only. `SandboxPricing.Codeunit.al` stays at the root, so the app is MIXED, which the fix claims to handle. The test app stays a SEPARATE extension, like the reporter's, and gains `using LethAL.Sandbox.Logic;`. The preamble is `namespace` line plus one blank line, so a frame error (H2) is at least 2 lines and shows up.
3. **No 8-digit range.** H7 and `3db4a00` refute it. Changing `sandbox-app`'s range would move R169's blocks and every gate config for no evidence.
4. **Fixes only for confirmed hypotheses.** H1 is fixed. H2, H4, H5 get a conditional section each. H6 waits on the reporter.
5. **H4 and H5 are filed, not fixed in GH-09,** unless the orchestrator folds them in. They are the same class of defect but not the reporter's, and H4 needs a live measurement of the `Code Coverage` object-type integer for a report extension before any code (R40's rule: the integers are measured, never guessed).

## Global Constraints

- `CLAUDE.md` build order: `bun run typecheck`, then `rm -rf packages/*/dist`, then `bun test`. Biome only on touched files: `bunx biome check <paths>`.
- No `!` non-null assertions. `exactOptionalPropertyTypes`: `...(v !== undefined ? { k: v } : {})`.
- Fixture compile ORDER (it is a dependency chain; `compile:fixtures` compiles each project against its EXISTING gitignored `.alpackages` and cannot certify the tests app against a target it has not seen): (1) bump `fixtures/sandbox-app/app.json` to `1.0.0.1`, and `fixtures/sandbox-tests/app.json` to `1.0.0.3` with its `sandbox-app` dependency at `1.0.0.1`; (2) `alc` the namespaced target with its output INTO `fixtures/sandbox-tests/.alpackages`, deleting the stale `LethAL_Sandbox App_1.0.0.0.app` there; (3) compile the tests app; (4) THEN `bun run compile:fixtures`, which must report both projects compiled (not skipped).
- Live work runs ONLY on `Cronus28`, under `coord lease Cronus28 bugs`, with a heartbeat every 5 minutes, released right after. Check it is running first (`pwsh -File U:\Git\agent-coord\containers.ps1 status -Names Cronus28`). Standing owner authorization covers publishing and gating there. Cronus281, Cronus282, Cronus283 are CentralGauge's: never lease or publish to them. Confirm `grep -h '"server"' fixtures/*/lethal.config.local.json` names only Cronus28 before any publish.
- One live run at a time, foreground, never polled.
- A differing verdict on any gate is a BLOCK reported to the owner. Never re-record a baseline. Never pin al-runner to an older build to make a gate pass (R125).
- Only a KILL is proof of lost attribution (coverage-differential skill). `no-coverage -> survived` against `none` is ordinary for `Sandbox Pricing`'s four mutants.
- Only fresh runs are inputs to the differential. Never a `--resume` run.

## Review Focus

1. **The fixture pins the regression.** Expected: on the PRE-FIX client (`3db4a00~1`), `Sandbox Logic`'s three kills become `no-coverage` and the fresh fenced-vs-`none` comparison lists exactly those three under ATTRIBUTION LOST. A `declaredRows === 0` warning is NOT expected and its absence is not a failure (the root-level selector rows stay declared). Pinned by the Task 1 step 6 run, recorded in the spec file. If those three kills are NOT lost on the pre-fix client, the fixture pins nothing and the plan stops there.
2. **Mixed root and namespaced objects are both declared, from REAL `alc` output.** Expected: `Sandbox Logic` (namespaced) and `Sandbox Pricing` (root) are both in `declaredObjects()`. Pinned by `app-package.test.ts` "GH-09: a real alc SymbolReference of a mixed namespaced app declares both objects", red-checked by removing the `Namespaces` recursion in `ingestScope`.
3. **BC's line frame under a namespace line (H2).** Expected: the witness row (`ClampPercentRuns`'s row at `ClampPercent`'s declaration line, measured) resolves to `ClampPercent` in the INSTRUMENTED namespaced source, and forcing the directive-implied base makes it resolve to `IsOverBudget` or to nothing. Pinned by `line-map.test.ts` "GH-09: the measured ClampPercentRuns declaration row resolves to ClampPercent in the namespaced instrumented frame", which carries the MEASURED row numbers from the dump (not a restatement of the base rule), red-checked by forcing the wrong base.
4. **A regression of H1 is caught by a gate, not only by a unit test.** Expected: reverting `ingestScope` to a root-only read turns `itest:bcdev` red on per-mutant equality (the three `Sandbox Logic` kills move to `no-coverage`). Pinned by `itest:bcdev` (`bcdev.baseline.json`) and demonstrated once by the Task 1 step 6c run on the pre-fix client, which is the same code.
5. **al-runner on a namespaced file.** Expected: `itest:alrunner` stays 3 / 12 / 4 with every per-mutant verdict equal on all four legs (one-shot, server, server+resource). A namespaced file may change what al-runner's `--coverage` emits (R220). Pinned by `itest:alrunner` against `al-runner.baseline.json`. Any difference is a BLOCK and a roadmap item, never a pin to an older al-runner.

---

### Task 1: Investigation (offline first, then Cronus28)

**Files:**
- Modify: `fixtures/sandbox-app/src/SandboxLogic.Codeunit.al` (add `namespace LethAL.Sandbox.Logic;` and one blank line at the top)
- Modify: `fixtures/sandbox-app/app.json` (version `1.0.0.1`)
- Modify: `fixtures/sandbox-tests/src/SandboxTests.Codeunit.al` (add `using LethAL.Sandbox.Logic;` above the codeunit)
- Modify: `fixtures/sandbox-tests/app.json` (version `1.0.0.3`, dependency `1.0.0.1`)
- Modify: `fixtures/README.md` (one line: `Sandbox Logic` is namespaced on purpose, GH-09/R212)
- Create: `docs/superpowers/specs/2026-09-26-gh09-namespace-precommitment.md` (before any live run)

Offline steps (no container):

- [ ] **Step 1: Namespace the fixture and compile, in dependency order.** Make the source edits above. Then follow the four-step compile order in Global Constraints exactly: bump both versions, `alc` the namespaced target into `fixtures/sandbox-tests/.alpackages` (replacing the stale `LethAL_Sandbox App_1.0.0.0.app`), compile the tests app, and only THEN `bun run compile:fixtures`, which must list both projects as compiled. Then `bun packages/runner/src/cli.ts run --project fixtures/sandbox-app --dry-run` and save the mutant list. Expected: the same mutants per procedure and operator as a dry-run on `master` (19).
- [ ] **Step 2: H4 probe (report extension).** In the scratchpad, copy `fixtures/sandbox-data` (it has Base App symbols), add one `reportextension` in its range with a procedure holding a comparison and an `exit`. `alc` it, dry-run it. Record: (a) do mutants appear inside the report extension, (b) does its `SymbolReference.json` carry a `ReportExtensions` array (at root or per namespace). Both yes means H4 is CONFIRMED offline as a silent `no-coverage` path. Delete the scratch copy after.
- [ ] **Step 3: H5 probe (object outside idRanges).** Scratch copy of `fixtures/sandbox-app`, change `Sandbox Pricing` to id 79250 (outside 79000..79199), `alc` it. An `alc` error REFUTES H5. A clean compile CONFIRMS that an object can escape the server-side filter.
- [ ] **Step 4: Find the H2 witness offline, before any live run.** Build the instrumented project exactly as a run would (`writeInstrumentedProject` over `generateMutationSet(fixtures/sandbox-app)`, as `growth.itest.ts` does, into the scratchpad) and open the instrumented `SandboxLogic.Codeunit.al`. Record the file line of its `namespace` line (must be line 1), of `IsOverBudget`'s closing `end;`, and of `ClampPercent`'s `procedure` line. Call the last one `D`. The witness is BC's row for line `D`, reported by `ClampPercentRuns`, the one test that calls `ClampPercent` and never `IsOverBudget`. It discriminates if line `D - 2` is NOT inside `ClampPercent`'s span (in the source today it is `IsOverBudget`'s `end;`). If instrumentation has moved things so that `D - 2` is still inside `ClampPercent`, there is no witness: use the contingency below and repeat this step.
- [ ] **Step 4 contingency (only if Step 4 finds no `procedure` line `D` for `ClampPercent` in the instrumented source at all; it does NOT help when the live run simply lacks a row at `D`, which is a stop per Step 8):** add `procedure Touch() begin end;` directly above `ClampPercent` in `SandboxLogic`, and one `[Test] procedure TouchRuns()` that calls only `Touch`. An empty body with no statements gives no operator a site, so the dry-run must show ZERO new mutants, and the frozen `itest:bcdev` figures (3 / 12 / 4, `groupedCalls` 15, `warmKills` 0) must stay. Pre-commit exactly that. If the dry-run shows any new mutant, stop and ask the orchestrator: new mutants move frozen figures, which is the owner's.
- [ ] **Step 5: Write the pre-commitment spec** before any live run. It must contain: the fixture diff; the prediction that `itest:bcdev` stays killed 3 / survived 12 / no-coverage 4, `groupedCalls` 15, `warmKills` 0, discrimination `vacuous`, with every per-mutant row equal to `bcdev.baseline.json`; the same for `itest:alrunner` on all four legs; the pre-fix prediction (Review Focus 1: the three `Sandbox Logic` kills, by procedure and operator from the dry-run, become `no-coverage` and are listed under ATTRIBUTION LOST; no prediction about the `declaredRows` warning); the H2 witness from Step 4 (the instrumented file lines, `D`, and what `D` and `D - 2` resolve to under base 1); and, if the contingency ran, its zero-new-mutants prediction. Commit it on the lane branch.

Live steps (Cronus28, under `coord lease Cronus28 bugs`, heartbeat every 5 minutes):

- [ ] **Step 6a: Publish the namespaced fixture.** `altool publishapp` the target (`1.0.0.1`) then the tests app (`1.0.0.3`). If a dev-endpoint publish is refused as a downgrade, unpublish the TESTS app first, then the target, then republish target, then tests (`.claude/skills/control-app`). Then confirm what is published: `Get-BcContainerAppInfo -containerName Cronus28` (Windows docker context) lists `LethAL Sandbox Tests` at `1.0.0.3` and `LethAL Sandbox App` at `1.0.0.1`.
- [ ] **Step 6b: Prepare the pre-fix worktree and VERIFY it before running.** `git worktree add U:/Git/LethAL-wt/gh09-prefix 3db4a00~1` (detached, non-destructive), `bun install` there. `bun install` brings no gitignored files, so copy in: the two namespaced `.al` files and both `app.json` files from the lane; `fixtures/sandbox-app/lethal.config.local.json`; `fixtures/sandbox-app/.alpackages/` and `fixtures/sandbox-tests/.alpackages/` (the latter holding the NEW `1.0.0.1` target symbol); and `fixtures/sandbox-app/.vscode/launch.local.json` if present. Then check, and record in the spec: (1) every absolute path in the copied config (`packageCachePath`, `controlSymbolPath`, `mcpCommand`) exists and points where intended, since the main checkout's config uses `U:/Git/LethAL/...` paths; (2) the worktree finds the installed AL compiler: run `bun run compile:fixtures` there and read which `alc` it names; (3) the published tests app (Step 6a) is the one compiled from these sources: the worktree's `sandbox-tests` `app.json` says `1.0.0.3`, and R56's stale-test-app guard does not refuse at run start. Any mismatch: fix the copy, never run past it.
- [ ] **Step 6c: Reproduce on the pre-fix client.** From the worktree:

  ```bash
  S=<scratchpad>
  bun scripts/probe-r58-differential.ts --project fixtures/sandbox-app --tests fixtures/sandbox-tests --mode fenced --out $S/prefix-fenced.json
  bun scripts/probe-r58-differential.ts --project fixtures/sandbox-app --tests fixtures/sandbox-tests --mode none   --out $S/prefix-none.json
  bun scripts/probe-r58-compare.ts $S/prefix-fenced.json $S/prefix-none.json
  ```

  Expected (H1 reproduced): `Sandbox Logic`'s three kills are `no-coverage` on the fenced side and listed under ATTRIBUTION LOST. A thin-coverage warning may or may not appear; its absence is not a failure. **Stop condition:** if those three kills are NOT lost, stop and report to the orchestrator: the fixture pins nothing. Remove the worktree after (`git worktree remove`).
- [ ] **Step 7: `itest:alrunner`** (local, no lease needed). Read the al-runner build line first. Expected as pre-committed.
- [ ] **Step 8: The coverage differential on the lane head,** with `LETHAL_FENCED_COVERAGE_DUMP=$S/fenced-rows.jsonl` on the fenced leg:

  ```bash
  LETHAL_FENCED_COVERAGE_DUMP=$S/fenced-rows.jsonl bun scripts/probe-r58-differential.ts --project fixtures/sandbox-app --tests fixtures/sandbox-tests --mode fenced --out $S/head-fenced.json
  bun scripts/probe-r58-differential.ts --project fixtures/sandbox-app --tests fixtures/sandbox-tests --mode none --out $S/head-none.json
  bun scripts/probe-r58-compare.ts $S/head-fenced.json $S/head-none.json
  ```

  Expected: ATTRIBUTION LOST 0; the fenced side has MEMBER-level entries for `Sandbox Logic`'s procedures (read the count, not just the verdicts); the only moves are `Sandbox Pricing`'s four `no-coverage -> survived`. Then decide H2 from the dump, against the INSTRUMENTED source of THIS run (the batch dir the run compiled; check it matches the Step 4 copy line for line): take `ClampPercentRuns`'s rows for `Codeunit 79000` with a POSITIVE hit count and `lineNo > 0` (BC also emits an object-level line 0 row, which says nothing about the frame; gpt-6-sol r2), and look for a row at exactly `D` or exactly `D - 2`, verifying against THIS run's instrumented source that `D` is `ClampPercent`'s `procedure` line and `D - 2` is `IsOverBudget`'s `end;`. A row at `D` (and none at `D - 2`): BC's frame is base 1 and H2 is REFUTED. A row at `D - 2` (and none at `D`): H2 is CONFIRMED (go to Task 3). Neither, or both: STOP and `coord ask` with the numbers; do NOT substitute another line (a line two or more lines into `ClampPercent` maps to `ClampPercent` under both bases and decides nothing). Also check that `ClampPercentRuns` is in no `IsOverBudget` mutant's covering set. Save the witness rows (object id, line numbers, test name) for Task 2.
- [ ] **Step 9: `itest:bcdev`,** foreground, under the lease. Expected as pre-committed. Release the lease.
- [ ] **Step 10: Record the results** in the spec file's "Measured" section: each prediction, met or not, with the output line that shows it. Commit.

Decision point after Task 1: H1 reproduced on the pre-fix client and absent on the head, H2 decided by the witness, H4 and H5 confirmed or refuted. Only then do the matching conditional tasks below. A pre-committed prediction that did not hold is a BLOCK to the orchestrator before anything else.

### Task 2: Offline pins (always)

**Files:**
- Create: `packages/runner/tests/data/gh09-mixed-namespace.symbolreference.json` (the REAL `SymbolReference.json` extracted from the Step 1 build of `sandbox-app` 1.0.0.1, BOM stripped; it holds names and ids only, no source)
- Modify: `packages/runner/tests/app-package.test.ts`
- Modify: `packages/runner/tests/line-map.test.ts` (or the file where `fileLineMapEntries` is already tested)

- [ ] **Step 1:** Test "GH-09: a real alc SymbolReference of a mixed namespaced app declares both objects". Load the committed JSON, `AppMethodIndex.fromSymbolReference`, expect `declaredObjects()` to contain `codeunit:79000` and `codeunit:79001` and `lookup` to name `IsOverBudget`. The existing issue #9 tests use a hand-written shape; this one uses what `alc` wrote.
- [ ] **Step 2:** Test "GH-09: the measured ClampPercentRuns declaration row resolves to ClampPercent in the namespaced instrumented frame". It builds the line map from the instrumented `sandbox-app` (the `writeInstrumentedProject` call from Task 1 step 4, into a temp dir) and looks up the MEASURED line numbers from Task 1 step 8, written into the test as literals with a comment naming the run and date. Expected: `D` resolves to `ClampPercent`, and no measured `ClampPercentRuns` row resolves to `IsOverBudget`. It depends on measured data, so it does not restate the base rule. If H2 was CONFIRMED, this test is written in Task 3 instead, red first.
- [ ] **Step 3: Red-check both** with the `mutation-red-checker` subagent. (a) Remove the `Namespaces` recursion in `AppMethodIndex.ingestScope`: Step 1's test goes red. (b) Force the directive-implied base (make `fileLineMapEntries` give the first object `previousEndLine + 3`): Step 2's witness resolves to `IsOverBudget` or to nothing, and the test goes red. Restore each; green. Report all four output lines.
- [ ] **Step 4:** typecheck, remove dist, `bun test packages/runner`, biome on the touched test files.

### Task 3 (conditional, only if H2 is CONFIRMED): the line frame under a namespace line

**Files:** `packages/runner/src/line-map.ts` (`fileLineMapEntries`, and the `baseLine` doc table), `packages/runner/tests/line-map.test.ts`.

- [ ] **Step 1: Red test first:** Task 2 step 2's test with the measured rows. It fails under the current base-1 rule.
- [ ] **Step 2:** Change the first object's base to what was measured (for example, the line after the last `namespace`/`using` node), keeping "previous object's end + 1" for later objects. Add a row to the `baseLine` doc table with the measured file and base.
- [ ] **Step 3:** The al-runner coverage path uses `fileLineMapEntries` too (`al-runner-coverage.ts`). If al-runner's frame differs from BC's, the two paths need separate rules. Decide from `itest:alrunner`'s per-mutant table, not by reasoning.
- [ ] **Step 4:** Red-check (revert the rule, the test goes red, restore). Re-run Task 1 steps 7 to 9. This IS a coverage change, so the differential (step 8) is its acceptance check, with ATTRIBUTION LOST 0 and the witness resolving to `ClampPercent` as the pass conditions.

### Task 4 (conditional, only if the orchestrator folds H4 into GH-09): report extensions in the declared set

Default is to FILE this (Task 5), not build it.

- [ ] **Step 1: Measure first** with the `al-probe` skill (ids 91500+): a probe app with a report extension whose procedure runs under a test; read `Code Coverage."Object Type"` for its rows. That integer goes into `OBJECT_TYPE_NAME` only once measured (R40's rule).
- [ ] **Step 2: Red test:** a SymbolReference with a `ReportExtensions` array (root and namespaced) declares `reportextension:<id>`; a line-map entry for `reportextension_declaration` exists.
- [ ] **Step 3:** Add `{ key: "ReportExtensions", objectType: <measured> }` to `SYMBOL_ARRAYS`, the name to `OBJECT_TYPE_NAME`, and `reportextension_declaration` to `OBJECT_KIND_TO_TYPE_NAME`, spelled identically in both. Red-check. Acceptance: the coverage differential on a fixture that has a report extension mutant (none exists today, so this needs a fixture arm and its own pre-commitment).

### Task 5: Roadmap and routing

Re-check the next free id right before each write (`ls docs/roadmap/`); R240 was the highest on 2026-09-26. Roadmap text cites names, never `file.ts:<line>`.

- [ ] **Step 1:** Close R212: `status: "done (<commit>)"` with one paragraph: `Sandbox Logic` is namespaced, the pre-fix client lost its three kills on it (the step 6c numbers), and `itest:bcdev` plus `itest:alrunner` now pin the pipeline per mutant.
- [ ] **Step 2:** File `lethal explain` refusing a `coverageMode: "none"` report (issue #9, side report 1). Name `explain.ts`'s survivor validation and `KNOWN_ATTRIBUTIONS`. Say the open question: should explain say "coverage not measured" rather than refuse.
- [ ] **Step 3:** File `doctor`'s `company` check calling `api/v2.0/companies` on the OData base URL (issue #9, side report 2). Name `HarnessVerifier.fetchCompanies` and `odataBaseUrl`. Measured by the reporter on `bc-linux`: OData on 7048, API on 7052.
- [ ] **Step 4:** If H4 was confirmed and not built: file it. If H5 was confirmed: file it (the filter is built from `idRanges`, not from the declared ids, in `coverageObjectIdFilterOf`).
- [ ] **Step 5:** `bun scripts/roadmap-index.ts`, then `bun test scripts/roadmap-index.test.ts`.

## GitHub comment draft (for the orchestrator to post on issue #9)

The owner already posted the root cause. This follow-up asks the reporter for the one check only they can do (H6), and routes the two side reports.

```markdown
Follow-up to the fix above.

`sandbox-app`, one of our live-gate fixtures, is now a namespaced app. On the client from before `3db4a00`, its namespaced codeunit's kills are lost and reported `no-coverage`, the same failure you saw. On current `master` it attributes normally, and `itest:bcdev` now fails if namespaced attribution breaks again (R212).

One thing we cannot check from here. You compiled with alc 17.0.34 on Linux. We only measured alc 18's `SymbolReference.json` layout. Could you re-run your original command on current `master` (`<sha>`) with the default `coverageMode: "fenced"`, and paste:

1. the `coverage-split` event line, and
2. any `[lethal] fenced coverage for ...` warning, word for word. It now prints the row keys, the declared count and the filter, so it says which side is wrong.

If it still says the artifact declares no objects, this prints the object ids alc wrote, with no source in it:

    unzip -p <your target>.app SymbolReference.json | tail -c +4 | jq '[.. | objects | select(has("Id") and has("Methods")) | .Id]'

(`tail -c +4` strips the byte order mark. `unzip` may warn about extra bytes at the start of a `.app`, which is harmless.)

Your two smaller reports are filed so they do not get lost: `explain` on a `coverageMode: "none"` report is <R-id>, and the `doctor` company check using the OData port for `api/v2.0` is <R-id>. No need to open separate issues unless you want to track them yourself.
```

## Out of scope, on purpose

- **The fix itself.** It landed in `3db4a00` and `dff14ba`.
- **An 8-digit fixture range.** Refuted (H7). It would move R169's blocks and every gate config.
- **A new namespaced fixture or a new gate.** Namespacing `sandbox-app` reuses two existing gates. Add a dedicated fixture only if Task 1 shows a namespace changes a verdict.
- **`itest:envtool`.** Its environment was deleted 2026-09-01. When it is restored, it runs the namespaced `sandbox-app`; its identity keys have no line or namespace, so the 2026-08-28 baseline should still compare. Say so in the submit note.
- **Namespaced test codeunits.** The reporter's test app was not reported as namespaced. Test names are keyed by codeunit name and method, which a namespace does not change.
- **The two side reports.** Filed in Task 5, not fixed.

## Submit note must say

- The pre-fix result (step 6c): the three lost kills under ATTRIBUTION LOST, and whether any thin-coverage warning appeared. If the kills were not lost, that the plan stopped.
- Every pre-committed prediction, met or not, with the line that shows it. `itest:bcdev` and `itest:alrunner` per-mutant equal, and NO baseline was re-recorded.
- The H2 witness: `D`, which positive-hit `ClampPercentRuns` row (`D` or `D - 2`, line 0 excluded) was found for `Codeunit 79000`, and which base it matched. Whether the Step 4 contingency ran.
- H4 and H5 results from the offline probes, and whether each was filed or built.
- Each red-check, red line and restored-green line.
- That the lease on Cronus28 was taken as `bugs`, heartbeated and released, and that no other container was touched.
- That Cronus28 now has `sandbox-app` 1.0.0.1 and `sandbox-tests` 1.0.0.3 published. If the merge is rejected, the orchestrator must republish the master versions (unpublish tests first).

## Orchestrator rulings (2026-09-26)

1. **`sandbox-app` is edited; no new fixture.** Review r1 confirmed that no frozen baseline pins lines, and that a namespace enters neither the manifest's `codeunitName` nor the `type:id` coverage key.
2. **No baseline re-record is expected.** ANY verdict change on `itest:bcdev` or `itest:alrunner` is a BLOCK reported to the owner, never re-recorded by the lane.
3. **The pre-fix signal is lost kills, not a warning.** On `3db4a00~1` the expected signal is that `Sandbox Logic`'s three kills become `no-coverage` and the fenced-vs-`none` comparison lists them under ATTRIBUTION LOST. A `declaredRows === 0` warning for every test is NOT expected: the selector rows still count as declared in this mixed fixture. If the three kills are NOT lost, stop: the fixture pins nothing.
4. **H2 needs a discriminating live witness,** read from `LETHAL_FENCED_COVERAGE_DUMP` against the INSTRUMENTED source, whose procedure differs between base 1 and the directive-implied base. If the fixture has none, add a short adjacent procedure and pre-commit the verdicts it adds. Red-check: forcing the wrong base changes the witness's resolution. A unit test that only restates base 1 is not evidence.
5. **Compile order:** bump versions, build the namespaced target into the tests' `.alpackages` (replacing the stale one), compile the tests app, THEN `compile:fixtures`. The pre-fix worktree's compiler and cache paths and the PUBLISHED tests app are verified before it runs, and the gitignored configs and symbols it needs are copied in.
6. **Live work** runs on Cronus28 only, under `coord lease Cronus28 bugs`.
7. **The GitHub comment draft** is posted by the orchestrator, and only if the live proof passes (Task 1 steps 6c and 8, and both gates per-mutant equal).
