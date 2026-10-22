# R-654 S2 (coord R-654b) pre-commitment: four new `itest:alrunner-v3` legs (L1, Y-A, Y-B, K), and their baselines

Written 2026-10-22 by the R-654 lane, on branch `lethal/r654-s2`. Its base is origin/master 7a0d4f96, which is S1
(5255bef8) plus R-649.
- Plan: `docs/superpowers/plans/2026-10-22-r654-retire-dotnet-alrunner.md` (r0-r2), §S2.
- Nothing in this file has run against al-runner v3 yet. It is committed to master (specs only) BEFORE any live run
  of the new legs.
- K staying out of `V3_GATE_LEGS` (§1, K) is a deviation from plan r0 that the orchestrator rules on. If the ruling
  differs, this file gets an addendum before any live run.

**The binary:** the pinned `/work/tools/al-runner-v3/current`, which is `alrunner 3.0.0-alpha.2 (91253f2d6)` with a `.gated` file. Not a candidate.

**What the gate must show:** every figure below holds per mutant. **A difference from any prediction below is NOT recorded.** Neither the record run nor the confirm run may write or accept a baseline that differs. The lane stops, writes the difference down, and reports it to the orchestrator. A row is never edited to match a run.

## 1. The new legs

All four legs run one-shot through `AlRunnerV3Backend`, with the static selector, coverage `"al-runner"` and no serve transport. Each gets a packages folder that holds only the Microsoft apps of `fixtures/sandbox-tests/.alpackages`, which are in the pinned symbol tar. This is the same `microsoftDeps` helper N1 uses. The tar is not re-pinned.

**Every leg also asserts all of these.** If any one fails, it is a BLOCK.
- The baseline is green, and no test is refused (`unsupportedTests` is empty).
- Every kill is reproduced (R577). No mutant is `kill-not-reproduced`.
- There are 0 state notes, 0 refused-nearby notes, 0 §6 Sleep notes, and 0 `runner-refused` or `runner-test-error` causes.
- The Sleep index is 0 + 0, because these fixtures have no `Sleep`.

### L1: layout (R349, R353)

- **Fixture and settings:** `fixtures/sandbox-layout` with `fixtures/sandbox-layout-tests`, selector ids 79749/79748/79747, `maxGuardsPerBatch` 7 (`LAYOUT_MAX_GUARDS`).
- **The assertion:** `assertLayoutRun` (`layout-fixture.ts`). There must be exactly 2 batches: batch 0 holds only `src/LayoutAlpha.Codeunit.al` and batch 1 only `src/LayoutBeta.Codeunit.al`. The baseline must be green. Every row is keyed `<batch>/<code>` and must be equal on every field below.
- **Predicted: 7 killed / 3 survived / 0 no-coverage, over 10.** This is the R353 table (`docs/superpowers/specs/2026-09-30-r353-stale-layout-precommitment.md`), unchanged, copied here from `EXPECTED_LAYOUT`:

| ref | file:line | operator | procedure | verdict | killing test | covering tests | attribution |
|---|---|---|---|---|---|---|---|
| 0/M0001 | LayoutAlpha:4 | empty-block | IsBig | killed | AlphaIsBig | Layout Tests.AlphaIsBig | exact |
| 0/M0002 | LayoutAlpha:5 | return-value | IsBig | killed | AlphaIsBig | Layout Tests.AlphaIsBig | exact |
| 0/M0003 | LayoutAlpha:5 | conditional-boundary | IsBig | survived | - | Layout Tests.AlphaIsBig | exact |
| 1/M0001 | LayoutBeta:4 | empty-block | Grow | killed | GrowAboveTen | Layout Tests.GrowAboveTen | exact |
| 1/M0002 | LayoutBeta:5 | conditional-boundary | Grow | survived | - | Layout Tests.GrowAboveTen | exact |
| 1/M0003 | LayoutBeta:6 | return-value | Grow | killed | GrowAboveTen | Layout Tests.GrowAboveTen | exact |
| 1/M0004 | LayoutBeta:6 | swap-additive | Grow | killed | GrowAboveTen | Layout Tests.GrowAboveTen | exact |
| 1/M0005 | LayoutBeta:7 | return-value | Grow | survived | - | Layout Tests.GrowAboveTen | exact |
| 1/M0006 | LayoutBeta:37 | empty-block | Twice | killed | TwiceOfThree | Layout Tests.TwiceOfThree | exact |
| 1/M0007 | LayoutBeta:38 | return-value | Twice | killed | TwiceOfThree | Layout Tests.TwiceOfThree | exact |

(The operator names all carry the `lethal.` prefix, and both files are under `src/`.)

- **Baseline:** `al-runner-v3.layout.baseline.json`, recorded once (§3). Every later run compares against it per mutant.
- **Basis for the prediction:** R-586's `measure.md`, row "sandbox-layout": 0 of 10 differ on alpha.2. That run used the pipeline from before the v3 backend existed, so through `AlRunnerV3Backend` this result is unmeasured.

### Y-A and Y-B: symbol sets (R321)

- **Fixture and settings:** `fixtures/sandbox-symbols` with `fixtures/sandbox-symbols-tests`, selector ids 79649/79648/79647. The symbols go to both the backend (`AlRunnerV3Config.preprocessorSymbols`, which v3 receives as `--define`) and `runSession` (`preprocessorSymbols`): `["LETHALA"]` for Y-A and `["LETHALB"]` for Y-B.
- **The assertion:** `assertSymbolBuild` (`symbol-fixture.ts`). The baseline must be green. The report must record exactly the leg's symbols. Every mutant must be in `SymbolLogic.Codeunit.al`. Line, operator, verdict and killing test must equal the table.
- **Predicted: 5 / 4 / 0 over 9 each.** Copied from `EXPECTED_BY_SET`; a killing test is always `RateSmall`:

| line | operator | Y-A `[LETHALA]` | Y-B `[LETHALB]` |
|---|---|---|---|
| 8 | empty-block | killed (RateSmall) | killed (RateSmall) |
| 9 | remove-assignment | killed (RateSmall) | survived |
| 9 | shift-integer | killed (RateSmall) | survived |
| 10 | remove-assignment | survived | killed (RateSmall) |
| 10 | shift-integer | survived | killed (RateSmall) |
| 11 | remove-assignment | survived | survived |
| 11 | shift-integer | survived | survived |
| 13 | return-value | killed (RateSmall) | (not in this build) |
| 13 | swap-additive | killed (RateSmall) | (not in this build) |
| 15 | return-value | (not in this build) | killed (RateSmall) |
| 15 | swap-additive | (not in this build) | killed (RateSmall) |

- **Baselines:** `al-runner-v3.symbols-lethala.baseline.json` and `al-runner-v3.symbols-lethalb.baseline.json`, recorded once (§3).
- **Basis for the prediction:** R-586's `measure.md` row 10: one-shot and serve on alpha.2 both read 5 / 4 / 0, identical per mutant, but through the old pipeline. Unmeasured through `AlRunnerV3Backend`.

### K: the CLI's own defaults (R387, R394)

- **How it builds:** through `cli.ts`'s `buildBackend`, with `backendKind: "al-runner-v3"` and an `alRunnerV3` section of only `path`, `packagesDir`, `bcVersion`, `alcPath` and `cacheDir`. There is no `coverage` key and no `transport` key.
- **Fixture:** `fixtures/sandbox-app` with `fixtures/sandbox-tests` and their `.alpackages`, selector ids 79199/79198/79197.
- **It asserts:**
  - coverage is on by default: the backend's capabilities read coverage `"al-runner"`, and SandboxPricing's 4 mutants read `no-coverage`;
  - the transport is one-shot: the leg wraps `alRunnerServerSpawn` and records 0 serve spawns, and the one-shot spawn wrapper records at least one `test` call;
  - `AL_RUNNER_V3_NOT_AUTHORITATIVE` is printed while the backend is built.
- **Predicted: 3 / 12 / 4 over 19**, equal per mutant to `bcdev.baseline.json` in verdict and killing test. This is the same table as S1. **K records no baseline.**
- **Not in `V3_GATE_LEGS` (a deviation from plan r0, for the orchestrator to rule on).** The CLI's v3 config has no `candidate` key. So under the update gate (`LETHAL_ALRUNNER_V3_CANDIDATE=1`), K's backend would refuse every ungated build (`AlRunnerV3UngatedBuildError`). That would make every candidate gate infra-fail. K checks LethAL's CLI wiring, not the binary.
  - K therefore runs in the itest's default leg set whenever the build is gated, and a K failure fails the itest.
  - On a candidate it does not run, and it prints `K: not run on a candidate build (the CLI path runs gated builds only)`.
  - It is outside the update-gate receipt's required set.

### The update-gate leg set

`V3_GATE_LEGS` becomes `C, S1, S3, N1, X, L1, Y-A, Y-B, D1, D1c, T`, so a candidate build is also judged on layout and symbols. **S2 must not merge before the three baselines are recorded.** Until then, `itest:alrunner-v3` refuses to start any of L1, Y-A or Y-B (the R332 preflight).

## 2. Existing legs: unchanged, per mutant

- **`itest:alrunner-v3`:**
  - C: 26 facts (9 defect, 16 contract, 1 warn), each reading as pre-committed (dcdd1489 through r9/r10).
  - S1: 3 / 12 / 4 over 19, equal to `bcdev.baseline.json`.
  - S3: `al-runner-v3-resource-selector-refused`.
  - N1: 36 / 0 / 0 over 36, equal to `bcdev.names.baseline.json`.
  - X (a) to (f): as pre-committed, including R-649's X (d) change, which is on master.
  - D1: 51 / 12 / 0 over 63. D1c: 51 / 8 / 4 over 63. Both equal to the R594 oracle. These run only when `LETHAL_ITEST_V3_CDO` is set.
  - T: 290 / 57 / 59 over 406, with the 52 known differences and 3 refused tests. Runs when `LETHAL_ITEST_V3_TABLES=1`.
- **`itest:alrunner` (v2):** unchanged, all 23 legs, as in S1's pre-commitment (4e8d9f38).
- **Any agentflow-selected BC leg for the S2 diff:** unchanged per mutant. Agentflow selects them from the diff, which touches only `scripts/agentflow` and `packages/runner/itest`.

## 3. Recording (R332): one record run, then one confirm run

1. **Record**, legs L1, Y-A and Y-B only. It must exit 3 (a failed receipt by design):

   ```
   LETHAL_ITEST_ALRUNNER_V3=1 LETHAL_ITEST_V3_LEGS=L1,Y-A,Y-B \
   LETHAL_ITEST_RECORD_BASELINE=al-runner-v3.layout.baseline.json,al-runner-v3.symbols-lethala.baseline.json,al-runner-v3.symbols-lethalb.baseline.json \
   bun run itest:alrunner-v3
   ```

   - Each leg first asserts its pre-committed table (`assertLayoutRun` or `assertSymbolBuild`) and the shared checks in §1. Only then does `main` call `assertGateBaseline`, which writes the file.
   - A table mismatch writes nothing. The leg is gate-fail and the run exits 1, not 3.
2. **Confirm**, with every leg and no record variable: `LETHAL_ITEST_ALRUNNER_V3=1 bun run itest:alrunner-v3`. It must PASS, with every figure in §1 and §2.
3. **Diff each new baseline against its v2 twin**, keyed by mutant key: verdict and killing test must be identical. The twins are `al-runner.layout.baseline.json`, `al-runner.symbols-lethala.baseline.json` and `al-runner.symbols-lethalb.baseline.json`.
4. **Finish the paperwork:**
   - Remove the three names from `PENDING_FIRST_RECORD` (`baseline-guard.ts`).
   - Add the figures to `docs/gates/alrunner-v3.md`'s `gate-figures` block.
   - Add the v3 pins to `gate-pages.test.ts`. The v2 pins stay until S3 (plan r1 M5).
   - Commit.

## 4. Red checks

**Offline, in the lane, recorded in `s2-redcheck.md`:**
- The agentflow path rule for `alrunner-v3`.
- K's coverage default, at unit level through `buildBackend`.

**Live, on a scratch copy of the worktree, run by the lane.** Never in a worktree with a running itest. The exact steps are in `/coord/handoff/R-654/s2-redcheck-live.md`.

| # | Revert, in the scratch copy | Leg | Predicted |
|---|---|---|---|
| L-R1 | delete the `this.resetLayoutState()` call in `AlRunnerV3Backend.deploy` | L1 | red on `1/M0006` and `1/M0007`: killed becomes survived, and the covering test moves from `TwiceOfThree` to `GrowAboveTen`, as on v2. **If it does not go red, that is a finding:** the leg cannot see a stale layout on v3. It is filed, and the leg's purpose is restated before any record. |
| Y-R1 | drop the `...a.symbols.flatMap((s) => ["--define", s])` line from `v3CallArgv` | Y-A and Y-B | both fail `R321 … per-mutant verdicts differ from the pre-committed table`. **If they do not go red:** the alc proof compiled the defines while v3 ran without them. That is a finding: the compile proof should have refused. It is filed. |
| K-R1 | change `validateAlRunnerV3Config`'s coverage default from `"al-runner"` to `"none"` | K | red. The 4 SandboxPricing mutants become `survived` instead of `no-coverage`, and the coverage-default assertion fails. |

## 5. Legs ruled out, each with its reason (plan §S2, r1 M6)

- **Server and resource variants.** v3 one-shot uses the STATIC selector. `installResourceSelector` runs only under the serve-entries transport (R635), which is opt-in (`LETHAL_ITEST_V3_TRANSPORT=serve-entries`) and re-runs the gate's legs under its own runs. The existing leg S3 pins that `selectorMode: "resource"` is refused on one-shot.
- **Multi-object and wrapped.** v3 turns coverage off for such files by design (`alRunnerCoverageSupport`, R602), so a leg would pin a refusal, not a measurement. The unit tests in `r586-cli-v3.test.ts` pin the warning. R602 stays open.
- **Names.** v3 cannot select quoted names (upstream #5572), and N1 already runs the names fixture.

None of these needs a new upstream issue.
