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

Filled in 2026-09-26 after the live runs (plan Task 1 step 10). Nothing above this heading was
edited. The evidence is the run's own output: the two `probe-r58-compare.ts` reports, the fenced
logs, the `LETHAL_FENCED_COVERAGE_DUMP` rows and the two itest logs.

### M.1 Publish (step 6a)

`sandbox-app` 1.0.0.1 and `sandbox-tests` 1.0.0.3 published on Cronus28 through the dev endpoint.
It needed the tests app unpublished first, then the target, then `Sync-NAVApp -Mode Clean` for the
resident instrumented record, before the republish (target, then tests) was accepted.

### M.2 Pre-fix client (step 6b, A.3): MET

A separate worktree at `a407344` (which is `3db4a00~1`), carrying the same fixture edit, with its
config paths pointed at its own `.alpackages`. `compile:fixtures` there names the alc from
`ms-dynamics-smb.al-18.0.2732683` and compiles both fixtures; the tests app is 1.0.0.3. Its dry run:

```
dry run: 2 file(s), 19 mutant site(s), 19 deployed mutant(s), 1 batch(es)
  src\SandboxLogic.Codeunit.al:6  lethal.empty-block
  src\SandboxLogic.Codeunit.al:7  lethal.return-value
  src\SandboxLogic.Codeunit.al:7  lethal.conditional-boundary
```

19 deployed, and the three `IsOverBudget` operators are present by name (lines 6 and 7 of the
namespaced source). A.3's stop condition did not fire, so §3.3 was run.

### M.3 Pre-fix fenced vs none (step 6c, §3.3, A.5): MET

```
## ATTRIBUTION LOST 3 MUTANT(S) (R175)
  M0001 src\SandboxLogic.Codeunit.al:6 lethal.empty-block: A said no-coverage, B scored it killed
  M0002 src\SandboxLogic.Codeunit.al:7 lethal.return-value: A said no-coverage, B scored it killed
  M0003 src\SandboxLogic.Codeunit.al:7 lethal.conditional-boundary: A said no-coverage, B scored it killed
  A fenced: {"killed":0,"survived":0,"noCoverage":19,...} baselineGreen=true
```

Exactly the three predicted mutants, by id and operator. The fenced side reported all 19 as
`no-coverage`: both tests' fenced coverage sets hold only `Codeunit:79199::Active`, the root-level
selector, so the declared set was not empty and nothing warned. The pre-fix fenced log has no
`fenced coverage for` line and no `declaredRows` warning, as §3.3 and A.5 predicted. The issue #9
comment therefore does NOT say "same failure": this fixture reproduces three lost kills with no
warning, not the reporter's warning.

One reading note: the compare report's last line is the tool's own PASS verdict, printed under
the ATTRIBUTION LOST block. The block is the result; the PASS line is recorded as printed.

### M.4 `itest:alrunner` (step 7, §3.2, A.4): MET

`al-runner build under test: al-runner v2.11.0`. All four legs print `killed=3 survived=12
noCoverage=4 baselineGreen=true` with the same per-mutant table; `platform apps pinned at:
...\28.1.49838.54368\platform-apps` on legs 1 and 2; `--server leg: 3 killed, verdicts identical`;
`resource-selector leg: 3 killed, verdicts identical`; `al-runner itest: PASS`. A.4's unmeasured
`scope` question did not bite: the server legs kept the three kills.

### M.5 Coverage differential on the lane head (step 8, §3.4): MET

No `ATTRIBUTION LOST` block. The fenced side carries member-level entries for `Sandbox Logic`
(`only A: Codeunit:79000::ApplyAudit`, `Codeunit:79000::ClampPercent`, `Codeunit:79000::LogAudit`
under `ClampPercentRuns`). The only verdict moves:

```
  verdict moves:
    4 x no-coverage -> survived
```

and those four are `M0016` to `M0019`, `Sandbox Pricing`. Fenced counts 3/12/4, none 3/16/0.
`ClampPercentRuns` is in no `IsOverBudget` mutant's covering set: M0001 to M0003 each read
`covering set changed (1 -> 2) | only B: Sandbox Tests.ClampPercentRuns`.

### M.6 H2 (step 8, §3.5, A.1): the pre-committed rule hit its STOP

The dump, `Codeunit 79000`, positive hits, `lineNo > 0`, read against the instrumented
`SandboxLogic.Codeunit.al` regenerated at HEAD `4916119` (byte-identical to the file A.2 quotes,
sha256 `07afac62dc7a9cdd4958bd31b2688e4e021d6c98cb72cab958620cbc877a2e00`):

- `OverBudgetDetected`: **10, 12, 16, 22**
- `ClampPercentRuns`: **29, 31, 37, 43, 49, 57, 59, 66, 68, 74, 81, 83, 87, 93, 99, 107, 108**

The lowest `ClampPercentRuns` row is **29**. A.1 names 29 as "stop and report". The rule was
wrong, not the data. BC emits a row only for a statement that EXECUTED; it never emits one for a
`procedure` declaration line, so neither §3.5's `D` (27) nor A.1's 26 or 25 could appear under any
frame. Both rules assumed a declaration row that does not exist. They decide nothing and are
recorded as failed rules, not as evidence either way.

### M.7 H2, POST-HOC criterion (chosen after seeing the dump)

**This criterion was chosen after the rows were seen.** It is not a pre-commitment and must not be
quoted as one. Orchestrator ruling q-20260926T141319 approved it with this label.

Criterion: under the right frame every positive row lands on a statement the test executed; a
wrong frame puts rows on lines that cannot execute in that test. "Shift k" means row R is file
line R + k. In the live run no mutant was active, so a line holding `MutationSelector.Reached`
(an inactive mutant's arm), a bare `begin` or `end`, or an `exit(0)` whose condition is false
never executes.

`OverBudgetDetected` (calls `IsOverBudget` three times):

| Row | Base 1 (file line = row) | Shift 1 (row + 1) | Shift 2 (row + 2) |
|---|---|---|---|
| 10 | `if MutationSelector.Active('M0001') then begin`: runs | 11, M0001's arm (`Reached`): never runs | 12, `end else if ...Active('M0002')`: runs |
| 12 | `end else if ...Active('M0002')`: runs | 13, `begin` | 14, M0002's arm (`Reached`): never runs |
| 16 | `end else if ...Active('M0003')`: runs | 17, `begin` | 18, M0003's arm (`Reached`): never runs |
| 22 | `exit(Amount > Budget);`: runs | 23, `end` | 24, `end` |

`ClampPercentRuns`, first rows (`ClampPercent(50)`):

| Row | Base 1 | Shift 1 | Shift 2 |
|---|---|---|---|
| 29 | `if ...Active('M0004') then begin`: runs | 30, M0004's arm (`Reached`): never runs | 31, `end else if ...Active('M0005')`: runs |
| 31 | `end else if ...Active('M0005')`: runs | 32, `begin` | 33, M0005's arm (`Reached`): never runs |
| 37 | `end else if ...Active('M0007')`: runs | 38, `begin` | 39, M0007's arm (`Reached`): never runs |
| 57 | `if (Value < 0) or (Value > 100) then`: runs | 58, `exit(0);`: not taken for 50 | 59, `exit(Value);`: runs |
| 59 | `exit(Value);`: runs | 60, `end` | 61, `end` |

Over all 21 rows: base 1 puts **21 of 21** on an executed statement. Shift 1 puts **1 of 21** there
(row 107 lands on 108, `Amount := Amount;`) and every other row on a `begin` or `end`, a `Reached`
arm or the untaken `exit(0)`. Shift 2 puts **5 of 21** there (rows 10, 29, 57, 66 and 81 land on
the next `else if` or `exit`) and the rest on lines that cannot run. So the ruling's wording, "a
non-executed line under both shifts", holds for most rows, not for every row: a shift moves a few
rows onto a neighbouring executed statement by coincidence. What holds without exception is the
other half: only base 1 puts EVERY row on an executed statement.

Member-level attribution cannot see any of this. Every measured row is at least two lines inside
its procedure's span, so all three frames name the same procedure for all 21 rows. That is why the
corroboration in M.8 is weaker than it looks, and why Task 2's test pins the statement-level fact
as well as the member names.

### M.8 H2, the corroboration that WAS pre-committed

- §3.4: head ATTRIBUTION LOST 0, with member-level entries for `Sandbox Logic` (M.5).
- §3.1: `itest:bcdev` per-mutant equal to the baseline (M.9).

A shifted frame misnames members on adjacent procedures (R29); neither check shows that. Both
agree with base 1. Per M.7's last paragraph, both would also pass under shift 1 or 2 on this
fixture, so they corroborate rather than decide.

**Verdict: H2 REFUTED (base 1), on M.7 plus M.8. Task 3 does not run.**

### M.9 `itest:bcdev` on the lane head (step 9, §3.1): MET

Both passes print `verdicts: killed=3 survived=12 noCoverage=4 baselineGreen=true` with the same
per-mutant table (M0001 to M0003 killed, M0004 to M0015 survived, M0016 to M0019 no-coverage), then
`bcdev itest: protocol-invariant probes PASS` and `bcdev itest: PASS`. The gate compares every row
to `bcdev.baseline.json`; it passed, and the baseline was not re-recorded (the tree was clean after
the run).
