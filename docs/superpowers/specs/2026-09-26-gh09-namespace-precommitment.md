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

## Addendum 2026-09-26 (before any live run): H2 decision rule, pre-fix dry run, al-runner note

Written after review and before any live run. Sections 1 to 4 above are unchanged; where this
addendum and an earlier section disagree, this addendum wins.

### A.1 The H2 decision rule (supersedes §3.5's D / D-2 rule and the plan's step 8 wording)

Decide H2 by the LOWEST positive-hit `ClampPercentRuns` row for `Codeunit 79000` with `lineNo > 0`
in **24..30**:

- **27**, with 25 and 26 absent: base 1, H2 **refuted**;
- **26**: shift 1, H2 **confirmed**;
- **25**: shift 2, H2 **confirmed**;
- anything else (no row in 24..30, or a lowest row of 24, 28, 29 or 30): **stop and report**.

"Shift k" means a statement on instrumented file line L arrives as row L - k. Rows for any OTHER
object, including the selector codeunits 79197 to 79199, are outside the rule because it filters
`Codeunit 79000`.

### A.2 Proof that only ClampPercent can put a row in 24..30

Source: the instrumented project regenerated exactly as a run builds it, `generateMutationSet`
over `fixtures/sandbox-app` then `writeInstrumentedProject` (selector ids 79197 to 79199), on the
lane head 4ab1604, so WITH GH-24's reach markers and `LethALReachLatch` declarations. 19 mutants.
The regenerated `SandboxLogic.Codeunit.al` is byte-identical to the one §3.5 was read from.

Instrumented lines 20 to 32, verbatim:

```al
end else begin
  begin
        exit(Amount > Budget);                          // ConditionalBoundary + ReturnValue
    end
end
end;

    procedure ClampPercent(Value: Integer): Integer
    var LethALReachLatch: Boolean; begin
if MutationSelector.Active('M0004') then begin
  if not LethALReachLatch then begin MutationSelector.Reached('M0004'); LethALReachLatch := true; end; begin end
end else if MutationSelector.Active('M0005') then begin
  begin
```

Every procedure and trigger of `Codeunit 79000`, with its instrumented span (procedure line
through `end;`, which is how BC's rows cover a procedure, measured, and how `spansOf` reads it):

| Member | Span (file lines) | Executed by `ClampPercentRuns`? |
|---|---|---|
| `IsOverBudget` | 8..25 | **no**: only `OverBudgetDetected` calls it |
| `ClampPercent` | 27..62 | **yes**: called directly |
| `ApplyAudit` | 64..77 | **yes**: called directly |
| `LogAudit` (local) | 79..112 | **yes**: called by `ApplyAudit`'s original arm (line 74) |

The codeunit has no triggers. Lines 1 to 7 are the namespace, the header and the global `var`
holding `MutationSelector`; line 113 is the closing `}`. `ClampPercent` itself calls nothing in
79000: its only calls are `MutationSelector.Active` and `MutationSelector.Reached`, which run in
`Codeunit 79199` and are excluded by the rule's object filter. `ClampPercentRuns` is the test
body `SandboxLogic.ClampPercent(50); SandboxLogic.ApplyAudit(10);` and nothing else.

Rows the executed members can occupy under each frame:

| Frame | ClampPercent | ApplyAudit | LogAudit | In 24..30 |
|---|---|---|---|---|
| base 1 | 27..62 | 64..77 | 79..112 | ClampPercent only (27..30) |
| shift 1 | 26..61 | 63..76 | 78..111 | ClampPercent only (26..30) |
| shift 2 | 25..60 | 62..75 | 77..110 | ClampPercent only (25..30) |

The nearest executed neighbour, `ApplyAudit`, starts at row 62 at the lowest, so no other executed
procedure reaches 24..30 under any of the three frames. **The proof holds**: the lowest row in
24..30 can only be ClampPercent's, and its value names the frame. For completeness, the one member
that COULD reach the window, `IsOverBudget` (row 24 under shift 1, its `end;`), is not executed by
this test, and the rule counts positive-hit rows only.

### A.3 Pre-fix dry run (plan step 6b): a stop condition

Step 6b must also show, on the pre-fix client `3db4a00~1`, **19 deployed mutants**, including the
three `IsOverBudget` operators by name (`lethal.conditional-boundary`, `lethal.empty-block`,
`lethal.return-value`). That client's tree-sitter-al predates `7b1e344`, so it may parse the
namespaced file differently. If the three are missing, "kills not lost" in §3.3 could mean the
mutants never existed rather than that attribution worked. **Fewer than 19, or any of the three
absent: stop and report**; the §3.3 comparison is not run on it.

### A.4 al-runner note, and the four legs of §3.2 named

The `--server` leg (and the resource leg, which also runs through the server) takes each coverage
statement's procedure name from al-runner's own `scope` field. What `scope` holds for a codeunit
inside a namespace is **UNMEASURED**. A mismatch fails safe: the covering set comes back empty,
the three kills fall to `no-coverage`, the per-mutant comparison against the one-shot leg fails,
and the gate blocks. It cannot turn into a false kill.

§3.2 says "all four legs" but names three. The four, as `packages/runner/itest/al-runner.itest.ts`
runs them:

1. **one-shot**: compared per mutant to `al-runner.baseline.json`, and the R147 platform-apps pin
   asserted;
2. **one-shot rerun**: the pin asserted again, and its per-mutant table must equal leg 1's
   (determinism);
3. **`--server`**: per-mutant equal to leg 1;
4. **`--server` + `selectorMode: "resource"`**: per-mutant equal to leg 1.

The pin is asserted on legs 1 and 2 only; the server legs never receive it (R235).

### A.5 The issue #9 comment

Record whether the pre-fix run prints the `declaredRows === 0` warning. Write "same failure as
issue #9" ONLY if it does. §3.3 predicts it does not, because the root-level selector rows stay
declared; in that case the comment says what the fixture reproduces instead: the three
`IsOverBudget` kills lost to `no-coverage`, with nothing warning about it.

### A.6 Task 2's red-check

Task 2's red-check will force shift 1 and shift 2, so both confirming outcomes of A.1 are exercised
offline, not only the one the live run happens to show.

## Measured

(Filled in after the live runs, plan Task 1 step 10.)
