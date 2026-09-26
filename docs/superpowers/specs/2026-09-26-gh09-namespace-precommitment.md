# Pre-commitment: GH-09, the namespaced `sandbox-app`

Written and committed BEFORE any live run and BEFORE the fixture change itself is committed, from
the offline compile, the offline dry run and the offline instrumented source. Nothing above the
"Measured" section is edited afterwards.

Plan: `docs/superpowers/plans/2026-09-26-GH-09-fenced-coverage-declared-rows.md`, Task 1.
Issue: GitHub #9. Roadmap: R212 (no namespaced fixture pins the pipeline).

## 1. The fixture change

`Sandbox Logic` moves into a dotted, multi-segment namespace. `Sandbox Pricing` stays at the root,
so the app is MIXED. The test app stays a separate extension and gains a `using`.

```diff
--- a/fixtures/sandbox-app/src/SandboxLogic.Codeunit.al
+++ b/fixtures/sandbox-app/src/SandboxLogic.Codeunit.al
@@ -1,3 +1,5 @@
+namespace LethAL.Sandbox.Logic;
+
 codeunit 79000 "Sandbox Logic"
 {
     procedure IsOverBudget(Amount: Decimal; Budget: Decimal): Boolean
--- a/fixtures/sandbox-tests/src/SandboxTests.Codeunit.al
+++ b/fixtures/sandbox-tests/src/SandboxTests.Codeunit.al
@@ -1,3 +1,5 @@
+using LethAL.Sandbox.Logic;
+
 codeunit 79100 "Sandbox Tests"
 {
     Subtype = Test;
```

Versions: `sandbox-app` 1.0.0.0 to **1.0.0.1**; `sandbox-tests` 1.0.0.2 to **1.0.0.3**, its
`sandbox-app` dependency 1.0.0.0 to **1.0.0.1**.

Compiled offline in the order the plan's Global Constraints give, with
`alc 18.0.41.45789` (extension `ms-dynamics-smb.al-18.0.2732683`):

1. the namespaced target, output INTO `fixtures/sandbox-tests/.alpackages` as
   `LethAL_Sandbox App_1.0.0.1.app` (no stale 1.0.0.0 symbol was left there): exit 0;
2. the tests app against it: exit 0, with ONE warning,
   `SandboxTests.Codeunit.al(1,1): warning AL0789: Using directives are ignored if a namespace is
   not specified.` The tests file declares no namespace of its own, so alc ignores the `using`, and
   the unqualified `Codeunit "Sandbox Logic"` still resolves. The line is kept because the plan
   asks for it; it changes nothing that compiles;
3. `bun run compile:fixtures`: `OK fixtures/sandbox-app` and `OK fixtures/sandbox-tests`, both
   compiled, neither skipped.

`alc` writes the namespaced object into a nested `Namespaces` tree, one level per segment
(`LethAL` > `Sandbox` > `Logic` > `Codeunits` holds 79000), while 79001 stays in the root
`Codeunits` array. That is the shape `3db4a00` reads and the pre-fix client does not.

## 2. Offline evidence: the mutant set does not move

`bun packages/runner/src/cli.ts run --project fixtures/sandbox-app --dry-run`, before and after:
`2 file(s), 19 mutant site(s), 19 deployed mutant(s), 1 batch(es)` both times. Every
`SandboxLogic` line moves by exactly +2 and the operator list per line is unchanged;
`SandboxPricing` is byte-identical.

Stronger: `generateMutationSet` then `writeInstrumentedProject` over both sources, sorted
`codeunitName|procedure|operator|astHash` tuples diffed: **IDENTICAL, 19 of 19.** The namespace
enters neither `codeunitName` nor any `astSubtreeHash`, so every identity key in
`bcdev.baseline.json` and `al-runner.baseline.json` is unchanged.

The instrumented namespaced project, with the control dependency injected as `stageForCompile`
does, also compiles offline (exit 0), so the root-level `Mutation Selector` resolves from inside
the namespace.

## 3. Predictions

### 3.1 `itest:bcdev` on the lane head (plan Task 1 step 9)

Killed **3** / survived **12** / no-coverage **4**, `groupedCalls` **15**, `warmKills` **0** with
every kill at `killPosition` 1, zero `session-reused`, `assertionScreen.discrimination`
**`vacuous`**, and EVERY per-mutant row equal to `packages/runner/itest/bcdev.baseline.json`,
`killingTest` included. No baseline is re-recorded. Any verdict difference is a BLOCK.

### 3.2 `itest:alrunner`, all four legs (plan Task 1 step 7)

Killed **3** / survived **12** / no-coverage **4**, with every per-mutant verdict equal to
`packages/runner/itest/al-runner.baseline.json` on the one-shot, `--server`, and
`--server` + `selectorMode: "resource"` legs, and `executionContexts[].platformAppsDir` pinned.
Any difference is a BLOCK and a roadmap item, never a pin to an older al-runner (R125).

### 3.3 The pre-fix client, `3db4a00~1` (plan Task 1 step 6c)

The three kills are all in `Sandbox Logic.IsOverBudget`, all killed by `OverBudgetDetected`:

| Procedure | Operator | astHash (prefix) | Lane head | Pre-fix, fenced |
|---|---|---|---|---|
| IsOverBudget | lethal.conditional-boundary | 82a8a37831dd | killed | **no-coverage** |
| IsOverBudget | lethal.empty-block | 5c9b5c3e0234 | killed | **no-coverage** |
| IsOverBudget | lethal.return-value | 4004a181f8c0 | killed | **no-coverage** |

and `probe-r58-compare.ts` lists exactly these three under ATTRIBUTION LOST. Reason: the pre-fix
`AppMethodIndex` reads object arrays only at the root, so `declaredObjects()` holds 79001 and the
selector triple 79197 to 79199 but not 79000, and `LineMap` drops every `Codeunit 79000` row.
**No prediction is made about a `declaredRows === 0` warning:** the root-level selector rows stay
declared, so its absence is not a failure. If those three kills are NOT lost, the fixture pins
nothing and the plan stops.

### 3.4 The coverage differential on the lane head (plan Task 1 step 8)

ATTRIBUTION LOST **0**; the fenced side carries member-level entries for `Sandbox Logic`'s
procedures; the only verdict moves between fenced and `none` are `Sandbox Pricing.DiscountedPrice`'s
four mutants, `no-coverage` to `survived`.

### 3.5 The H2 witness (plan Task 1 steps 4 and 8)

From the offline instrumented `SandboxLogic.Codeunit.al` (`writeInstrumentedProject`, selector ids
79197 to 79199; mutant ids and guard layout do not depend on the artifact id):

| What | Instrumented file line |
|---|---|
| `namespace LethAL.Sandbox.Logic;` | **1** |
| `codeunit 79000 "Sandbox Logic"` | 3 |
| `IsOverBudget`'s `procedure` line | 8 |
| `IsOverBudget`'s closing `end;` | **25** |
| blank | 26 |
| `ClampPercent`'s `procedure` line, **D** | **27** |
| `ClampPercent`'s closing `end;` | 62 |

`D - 2` = 25 is `IsOverBudget`'s `end;`, OUTSIDE `ClampPercent`'s span, so the witness
discriminates and the contingency (`procedure Touch()`) was NOT needed and did not run.

Resolved offline with the real `buildLineMap` over the instrumented source and the declared set of
its own compiled `.app` (base 1): line 27 resolves to **ClampPercent**, line 25 to
**IsOverBudget**, line 26 to nothing.

Prediction: `ClampPercentRuns`'s positive-hit, `lineNo > 0` rows for `Codeunit 79000` include a
row at **27** and none at **25** (BC's frame is base 1, H2 REFUTED). A row at 25 and none at 27
confirms H2. Neither or both is a stop. `ClampPercentRuns` is in no `IsOverBudget` mutant's
covering set.

## 4. Side hypotheses, measured offline

- **H4 (report extensions): REFUTED as a silent `no-coverage` path.** A scratch copy of
  `sandbox-data` with `report 79391` and `reportextension 79390` (inside `namespace LethAL.Probe`,
  one procedure with an `if` and two `exit`s) compiles, and its `SymbolReference.json` DOES carry
  the extension under `Namespaces[LethAL > Probe].ReportExtensions`, which the index ignores. But
  the dry run emits NO mutant there: `generateMutationSet` skips the file loudly (`skipped ...
  src\DataProbeReportExt.ReportExt.al (namespace_declaration, reportextension_declaration, 4
  site(s))`), because `reportextension` is not in `CARRIER_KINDS`. The same scratch app with a
  global `var Probe: Codeunit "Data Ops";` in the report extension also compiles (exit 0), so the
  skip's stated reason (AL0118) does not hold for this kind. Filed as a product gap, not built.
- **H5 (object outside `idRanges`): REFUTED.** A scratch `sandbox-app` with `Sandbox Pricing` at
  79250 fails `alc`: `error AL0297: The application object identifier '79250' is not valid. It
  must be within the allowed ranges '[79000..79199]'.` Not filed.

## Measured

(Filled in after the live runs, plan Task 1 step 10.)
