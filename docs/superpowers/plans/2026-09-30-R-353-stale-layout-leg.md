# R-353 plan: a live al-runner leg that goes red if R349's per-deploy reset is removed

**Spec:** `H:/lethal-coord/tasks/R-353/task.md`, `docs/roadmap/R353.md`. Background: `docs/roadmap/R349.md`, `H:/lethal-coord/tasks/R-349/` (submit note, `r349-report.md`, the two live logs). **Pre-commitment:** `docs/superpowers/specs/2026-09-30-r353-stale-layout-precommitment.md`, committed ALONE and FIRST. HEAD `0abf71aa`. Planned offline only: no al-runner, no BC.

**Terms.** A *batch* is one instrumented copy of the project (`planArtifacts` splits at file granularity). A file with no mutant in a batch is copied *verbatim*. The *coverage index* maps a covered line to the procedure that holds it. R349's fix is the call `this.resetLayoutState();` in `AlRunnerBackend.deploy()`; the *red-check* deletes that one call.

## Why sandbox-app could not see R349

R349's live check split sandbox-app into two batches (`SandboxLogic`, then `SandboxPricing`). Batch 1's file, `SandboxPricing`, is reached by no test, so it has no covered line to misplace, and the stale layout moved nothing. A discriminating fixture needs batch 1's file to be COVERED and to hold a second procedure after the covered one, so that the covered procedure's instrumented lines fall inside the next procedure's span in the verbatim text.

## Decisions

**D1. A new fixture pair, not an arm.** `fixtures/sandbox-layout` (app "LethAL Sandbox Layout", ids 79700 to 79749, selector ids 79749/79748/79747 at the top of the range, no dependencies, runtime 13.0) and `fixtures/sandbox-layout-tests` (ids 79750 to 79799, depends on the target, bare `Error(...)`, no Library Assert). Checked: no fixture in any worktree uses 797xx. An arm of `sandbox-app` would change its mutant count (frozen at 19) and move `al-runner.baseline.json`, `bcdev.baseline.json` and `envtool.baseline.json`, which is a STOP; the new pair moves none.

Target files (full text; LF line endings per `.gitattributes`):

`src/LayoutAlpha.Codeunit.al`:
```al
codeunit 79700 "Layout Alpha"
{
    procedure IsBig(X: Integer): Boolean
    begin
        exit(X > 10);
    end;
}
```

`src/LayoutBeta.Codeunit.al`, exactly 40 lines. The header comment is load-bearing (it sets `Twice`'s verbatim span to lines 10 to 39) and says so:
```al
codeunit 79701 "Layout Beta"
{
    procedure Grow(X: Integer): Integer
    begin
        if X > 10 then
            exit(X + 1);
        exit(X);
    end;

    procedure Twice(X: Integer): Integer
    // R353. This header comment is load-bearing: it is what makes Twice's
    // span in the UNINSTRUMENTED text long enough to hold every line that
    // Grow occupies once Grow is instrumented.
    //
    // At maxGuardsPerBatch 7 this file is batch 1 and Layout Alpha is
    // batch 0. Batch 0 copies this file verbatim, so the coverage index
    // built during batch 0 knows this layout: Grow on lines 3 to 8 and
    // Twice on lines 10 to 39. Batch 1 instruments this file, and Grow
    // then runs from line 6 to line 41 of the emitted text.
    //
    // With R349's reset, batch 1 rebuilds the index from its own text, so
    // every line Grow executes is Grow's and every line Twice executes is
    // Twice's. Without it, a line of the instrumented Grow before line 9
    // is still Grow, but every executed line from 10 to 39 is read as
    // Twice, and every line of the instrumented Twice (from line 43 on)
    // is past the end of this 40-line file and names no procedure.
    // So Twice's two mutants LOSE their own test, TwiceOfThree, and GAIN
    // GrowAboveTen, which never calls Twice: both go from killed to
    // survived. Grow's five mutants keep GrowAboveTen and do not move.
    //
    // Do not shorten this comment, move Twice, or add a procedure to this
    // file without a new pre-commitment: the line numbers above are what
    // docs/superpowers/specs/2026-09-30-r353-stale-layout-precommitment.md
    // predicts from.
    //
    // (padding ends)
    begin
        exit(X * 2);
    end;
}
```

Tests, `src/LayoutTests.Codeunit.al`:
```al
codeunit 79750 "Layout Tests"
{
    Subtype = Test;

    var
        LayoutAlpha: Codeunit "Layout Alpha";
        LayoutBeta: Codeunit "Layout Beta";

    [Test]
    procedure AlphaIsBig()
    begin
        if not LayoutAlpha.IsBig(20) then
            Error('IsBig(20) must be true');
    end;

    [Test]
    procedure GrowAboveTen()
    begin
        if LayoutBeta.Grow(20) <> 21 then
            Error('Grow(20) must be 21');
    end;

    [Test]
    procedure TwiceOfThree()
    begin
        if LayoutBeta.Twice(3) <> 6 then
            Error('Twice(3) must be 6');
    end;
}
```
`app.json` files as the sandbox-symbols pair (fresh GUIDs, version 1.0.0.0, the dependency naming the target). Neither defines a preprocessor symbol.

**D2. Two batches at `maxGuardsPerBatch` 7.** Alpha has 3 raw specs, Beta 7. First fit: Alpha is batch 0, Beta batch 1, no `oversized-batch` warning (the budget equals Beta's count). The itest asserts `report.batches === 2` and the file partition, so an operator change that re-plans the batches fails loudly rather than quietly running one batch.

**D3. Legs: one-shot and `--server`. No resource leg.** Derived from the code, the one-shot leg is the ONLY transport R349's bug can reach live. The Cobertura path names a line's procedure through the index's line map, which is what goes stale. The `--server` path takes the procedure from the daemon's own `st.scope`; the index supplies only the file's object (identical in both layouts) and R318's renamed-member re-key (no such member here). The `serverSuite` half of the reset is cleared anyway by the `activate(null)` that opens every batch's baseline. So the `--server` leg is run as a pre-committed CONTROL: it must match the fixed table in the red-check too, and its equality check against the one-shot leg must fail on exactly the two predicted mutants. The resource leg runs through `--server` (`runOnce(..., true, "resource")`), so it shares that immunity; its per-deploy work (`installResourceSelector`) is rewritten on every deploy and is not a layout cache. It would add about 20 to 30 s and discriminate nothing R349 is about. Not added (open question 2).

**D4. New frozen baseline `packages/runner/itest/al-runner.layout.baseline.json`**, registered in `GATE_BASELINES` with `gateHow("LETHAL_ITEST_ALRUNNER=1 LETHAL_ALRUNNER_PATH=<al-runner.exe>", "al-runner.layout.baseline.json", "itest:alrunner")`, recorded only through `LETHAL_ITEST_RECORD_BASELINE=al-runner.layout.baseline.json` (R332). It pins the one-shot leg. No existing baseline moves (D1). **HARD GATE: no record run until the orchestrator has asked the owner and relayed a yes.** Until the file exists, `itest:alrunner` refuses to start (R332's missing-baseline refusal) once the wiring lands, so the wiring and the baseline must reach master in the same merge, and every live run before the record goes through the scratch driver in T5, never through the gate.

**D5. Where the leg lives.** In `al-runner.itest.ts`, after the sandbox legs and before `runSymbolLegs()`, so it runs through `itest:alrunner` as the task asks. Its table and checks go in a new `packages/runner/itest/layout-fixture.ts`, the `symbol-fixture.ts` pattern (the itest runs at import, R186). Checks are collected and thrown once, as `runSymbolLegs` does. The frozen-baseline step runs LAST and only if every table check passed, so a record run can never record a leg that disagrees with the pre-commitment.

**D6. Compare per `<batch>/<code>`.** Mutant codes restart per batch, so the existing `shape()` (sorted by `mutantCode` alone) would pair `0/M0001` with `1/M0001`. The layout legs use their own shape keyed by `mutantRef(batchIndex, mutantCode)` and carrying `verdict`, `killingTest`, `coveringTests`. Covering tests are pinned in the table because the frozen baseline (`normalizeForComparison`) does not compare them.

**D7. An offline guard for the fixture's purpose.** A `bun test` file, `packages/runner/tests/layout-fixture.test.ts`, re-runs the dry run's logic: `generateMutationSet` + `planArtifacts(7)` give the pre-committed 10 rows in 2 batches; after `writeInstrumentedProject` + `prepareBatchProject` for both batches, batch 0's `buildAlRunnerCoverageIndex` names Beta's instrumented line 8 `Grow`, lines 36 and 37 `Twice`, and lines 71, 73, 79 nothing, while batch 1's own index names them `Grow`, `Grow`, `Twice`. This fails in seconds if someone shortens the comment or the emitter moves lines, instead of after a 3-minute live run.

## Hand derivation (summary; the spec has the tables)

Batch 1's emitted Beta: `var MutationSelector` at lines 3 to 5, `Grow` 6 to 41, `Twice` 43 to 82 (26 header comment lines kept once). Baseline hits (statement lines only, per R220's `line-rate` measurement): `GrowAboveTen` 8, 10, 16, 22, 28, 36, 37; `TwiceOfThree` 71, 73, 79. Own index: all `Grow` / all `Twice`. Batch 0's index (Beta verbatim, `Grow` 3 to 8, `Twice` 10 to 39, 40 lines): 8 is `Grow`, 10 to 37 are `Twice`, 71+ are nothing. Result:
- Fixed, both legs: 7 killed / 3 survived / 0 no-coverage. Kills: 0/M0001, 0/M0002 (AlphaIsBig); 1/M0001, 1/M0003, 1/M0004 (GrowAboveTen); 1/M0006, 1/M0007 (TwiceOfThree). Survivors: 0/M0003, 1/M0002, 1/M0005.
- Unfixed, one-shot: 1/M0006 and 1/M0007 go killed to survived, covering TwiceOfThree to GrowAboveTen. 5 / 5 / 0.
- Unfixed, `--server`: unchanged, 7 / 3 / 0.

## Offline evidence already gathered (2026-09-30, scratchpad `r353/`, not committed)
- Dry run (`dryrun.ts`: `generateMutationSet`, `planArtifacts`, `writeInstrumentedProject`, `prepareBatchProject`, `buildAlRunnerCoverageIndex` per batch, each line's owner under its own and under batch 0's index): the 10 mutants, 2 batches, the line owners above. Run with `bun dryrun.ts app 7 LayoutBeta.Codeunit.al` from the scratch dir.
- `alc` 18.0.2732683: target exit 0; target with an EMPTY package cache exit 0; tests against the staged target `.app` exit 0 (also with ONLY that `.app` in the cache); both batches' instrumented directories with the al-runner static selector (control-registration files removed, as `deploy()` does) exit 0, with no mutant active and with M0001 active.

## Gates and baselines
- New: `packages/runner/itest/al-runner.layout.baseline.json` (D4), after the owner's yes.
- Unchanged, and why: `al-runner.baseline.json` and both symbol baselines (sandbox-app and sandbox-symbols untouched; `runOnce` gains an optional `maxGuardsPerBatch` that the existing legs do not pass, so they still run one batch); `bcdev`, `envtool`, `tables`, `harden` baselines (those gates never read the new directories). Any existing baseline moving is a STOP.
- Unit tests that change with the registry: `baseline-guard.test.ts` ("the registry names five gate baselines" becomes six) and `baseline-wiring.test.ts` (`WRITING_GATES` becomes `Record<string, readonly string[]>`; `al-runner.itest.ts` maps to both files; `baselineName` takes the constant name, `BASELINE_PATH` or `LAYOUT_BASELINE_PATH`; the preflight and `assertGateBaseline` checks run per constant). The "registry equals the committed baselines" test fails until the baseline file exists, which is the same R332 window as D4: expected, and it closes at T8.

## compile:fixtures
Picked up automatically: `fixtureProjects()` takes every `fixtures/<dir>` holding an `app.json`. No script change. But it SKIPS a project with no `.alpackages` (gitignored), so each machine stages: an `.alpackages` directory in the target (may be empty; measured, the target needs no symbols) and the target's `.app` compiled into `sandbox-layout-tests/.alpackages`. `fixtures/README.md` gets the staging line. The check passes only when both projects print `OK`, never `SKIP`. al-runner compiles from source and needs neither.

## Memory and cost
The leg adds two `runSession` calls, run one after the other, each with its own backend closed in `finally` and its scratch directory removed. Peak is one al-runner process (one-shot) or one daemon (`--server`), the same shape as the existing legs; nothing runs concurrently, and `workers` stays 1. Estimate: one-shot 16 al-runner invocations (6 baseline, 10 mutant) at about 8 s each (R349's two-batch sandbox-app one-shot leg: 138 to 167 s for 19), so about 130 s; `--server` about 25 to 35 s (R349: 25 s). About 3 minutes added to `itest:alrunner`. RAM is unmeasured on this machine; T6 samples the peak working set of al-runner processes once, reports it, and does not gate on it (no stored reference exists).

## Tasks
Each code task: `bun run typecheck`, `rm -rf packages/*/dist`, the named tests from the repo root, `bunx biome check <touched files>`, red-check where a test is added. Nothing is committed by the lane; the orchestrator commits.

1. **Pre-commitment, alone.** Commit `docs/superpowers/specs/2026-09-30-r353-stale-layout-precommitment.md` and nothing else, before any fixture file exists in the repo. Message the orchestrator the sha.
2. **Fixture.** Add the two projects exactly as D1. Stage `.alpackages` locally, run `bun run compile:fixtures`: `OK` for both new projects, no new `SKIP`. Add a `fixtures/README.md` section (what it is, the two-batch point, the staging line, the pre-commitment link). Run the dry run through `lethal run --dry-run --max-guards-per-batch 7` on the new target (or the D7 test) and confirm the 10 rows and 2 batches match the spec; a mismatch is a STOP.
3. **Offline guard (D7).** `packages/runner/tests/layout-fixture.test.ts`. Red-check: delete 5 lines of the header comment; the test must fail on the line-owner assertion; restore, `git diff` clean on the fixture.
4. **Leg code.** `layout-fixture.ts` (fixture paths, selector ids, `LAYOUT_MAX_GUARDS = 7`, the pre-committed rows, `assertLayoutRun(report, leg)` checking batches, partition, `baselineGreen` and every row, and a printer that dumps the table BEFORE asserting). `al-runner.itest.ts`: `GateFixture.maxGuardsPerBatch?` threaded into `runSession` with the `...(v !== undefined ? { k: v } : {})` form; `LAYOUT_BASELINE_PATH`; `preflightGateBaseline(LAYOUT_BASELINE_PATH, "al-runner itest layout")` before the first await; `runLayoutLegs()` (one-shot, `--server`, collected checks, D6's shape, then `assertGateBaseline` on the one-shot report last); sublegs gain `"layout-one-shot"`, `"layout-server"`. `baseline-guard.ts` registry entry; the two unit tests updated. Leave the wiring UNcommitted on the lane branch until T8, or commit it on the lane branch and do not merge before T8 (orchestrator's choice; see D4).
5. **Scratch driver (never committed).** `r353-layout-live.ts` in the scratchpad, like R-349's `r349-multibatch-live.ts`: imports `layout-fixture.ts`, runs ONE leg per invocation (`one-shot` or `server`) with `LETHAL_ALRUNNER_PATH`, prints the table, applies `assertLayoutRun`, and for `server` also compares with a saved one-shot table. Needs no baseline.
6. **Live runs, one al-runner session at a time, the orchestrator told BEFORE each and after.** (a) Driver `one-shot` on the fixed code: must match the spec's fixed table. (b) Driver `server`: must match it and equal (a) per `<batch>/<code>`. Sample the peak al-runner working set during (a). Print `al-runner --version` first each time. Any difference is a STOP and a finding.
7. **Live red-check.** Delete `this.resetLayoutState();` from `deploy()`. Driver `one-shot`: must fail naming 1/M0006 and 1/M0007 only (killed to survived, covering TwiceOfThree to GrowAboveTen). Driver `server`: must PASS its table check and fail its equality check against the unfixed one-shot table on the same two. Restore; `git diff packages/runner/src/al-runner-backend.ts` must be empty. Save both logs under `H:/lethal-coord/tasks/R-353/`. A different failure set is a finding.
8. **HARD GATE, then the baseline.** Report T6 and T7 to the orchestrator and STOP. Only after the orchestrator relays the owner's yes: `LETHAL_ITEST_ALRUNNER=1 LETHAL_ALRUNNER_PATH=<al-runner.exe> LETHAL_ITEST_RECORD_BASELINE=al-runner.layout.baseline.json bun run itest:alrunner` (exits 3, never a pass); review the file (10 rows, each matching the spec); re-run without the record variable: PASS, all legs. Then the gate-level red-check: delete the reset again, run `itest:alrunner`, it must fail only at the layout legs with the two names; restore, diff clean. Orchestrator told before each of these three runs.
9. **Roadmap.** `docs/roadmap/R353.md` status `done (<commit>)` with the evidence (logs, baseline, both red-checks); `bun scripts/roadmap-index.ts`; `bun test scripts/roadmap-index.test.ts`. Re-check the free roadmap ids in every worktree before filing anything new.
10. **CLAUDE.md proposal (text only, the owner applies).** For the `itest:alrunner` bullet, after the R321 paragraph:

> Since R353 it also runs `fixtures/sandbox-layout` + `-tests` at `maxGuardsPerBatch` 7, which splits it into TWO batches, through the one-shot and `--server` legs. Every other al-runner leg runs one batch, which is why R349 (the coverage index kept across `deploy()`) passed every gate before its fix. Frozen: killed **7** / survived **3** / no-coverage **0** over 10, per mutant and per covering test against `docs/superpowers/specs/2026-09-30-r353-stale-layout-precommitment.md`, keyed by `<batch>/<code>` because codes restart per batch; baseline `al-runner.layout.baseline.json`. RED-CHECKED: deleting `resetLayoutState()` from `deploy()` fails the one-shot leg on `1/M0006` and `1/M0007` (killed to survived, their covering test moved from `TwiceOfThree` to `GrowAboveTen`). The `--server` leg does NOT go red and must not: the daemon names a covered statement's procedure itself, so only the one-shot leg can see a stale layout live, and the `serverSuite` half of the reset is guarded by R349's unit test alone. `LayoutBeta`'s header comment sets the line spans the prediction rests on; do not edit it without a new pre-commitment.

## Open questions
1. **Server discrimination.** Making the `--server` leg go red would need an R318 renamed split member whose compiled arm's name is outside its `coverageArmNames`, built under a preprocessor symbol. That is a much larger fixture for a path (`renamedMemberAt` on a stale index) that R349 does not name. Recommended: no; the plan records the `--server` leg as a control. Owner's call.
2. **Resource leg.** Not added (D3). Add it only if the owner wants the resource selector's re-install over a replaced `active/` measured live at two batches; it would not discriminate R349.
3. **Wiring before the baseline.** D4's R332 window: commit the itest wiring together with the baseline, or commit it earlier on the lane branch and hold the merge. Orchestrator's choice.
