# R254 probe: how a `reportextension`'s code shows up in coverage

Two questions, both about the coverage path a `reportextension` mutant would need (R40's rule:
measure the integers, never guess them).

- **(a) BC:** which `Code Coverage` "Object Type" integer, and which Object ID, does BC record for a
  report extension's code? **MEASURED 2026-10-05 on Cronus28: `22:91601`** (see "(a) results").
- **(b) al-runner:** what does `al-runner --coverage` report for it? **MEASURED 2026-10-05**, below.

## The probe pair

- `target/` (ids 91600-91609, platform only, no tables): `report 91600 "R254 Probe Report"`
  (processing-only, one `Integer` dataitem 1..3), `reportextension 91601 "R254 Probe RepExt"` (a
  `modify(IntItem)` `OnAfterAfterGetRecord` trigger, `OnPreReport`, `OnPostReport`, procedures
  `Classify` and `GetExtTotal`), and `codeunit 91602 "R254 Probe Sink"` (single instance).
  Expected sums: base 1+2+3 = 6, extension Classify(1..3) = 1+10+10 = 21.
- `tests/` (ids 91610-91619; depends on the target, Base Application and Test Runner):
  `codeunit 91610 "R254 Probe Tests"`
  - `MeasureReportExtCoverage` — EXPECTED TO FAIL, carrying the answer. Mirrors LethAL Control's
    `RunMutantWithCoverage`: `Code Coverage Mgt.`.Start/StopApplicationCoverage around one report
    run, then reads `Code Coverage` for Object ID 91600..91609 and reports every hit row as
    `type=<ordinal>(<name>) id= line= hits=` through `Error('MEASURED ...')`.
  - `ReachOnly` — passes when base = 6 and extension = 21. Run it with the hub's coverage on.
  - `CallExtProcedureDirectly` — passes: calls the extension's `Classify` through the BASE report's
    variable, with no report run.
  - `ReadGlobalsAfterRunModal` — EXPECTED TO FAIL with `MEASURED kept=21`: the report variable keeps
    the extension's globals after `RunModal` (so a fixture arm needs no sink codeunit).

Compiled offline, alc 18.0.43.1464 (linux), exit 0 both. Symbols: the target needs only System;
the tests need Base Application (`Code Coverage Mgt.` is codeunit 9990 in BASE APPLICATION, not in
Test Runner) and Test Runner. Used `fixtures/sandbox-data-tests/.alpackages` (System
28.0.47067.0, Base Application 28.0.46665.47126, Test Runner 28.0.46665.50383) plus the compiled
target. `alc` emits `SymbolReference.json` with the extension under the key **`ReportExtensions`**
(`Id`, `Name`, `Methods[{Id, Name}]`, `Target`), measured.

The `Code Coverage` table's `Object Type` option (System 28.0.47067.0 symbols) lists
`ReportExtension` at ordinal **22** (`,Table,,Report,,Codeunit,XMLport,,Page,Query,,,,,PageExtension,TableExtension,Enum,EnumExtension,Profile,ProfileExtension,PermissionSet,PermissionSetExtension,ReportExtension`).
That is the expectation for (a), not the measurement: the rows could still be recorded under the
base report (3:91600), which is what (a) settles.

## (b) al-runner, measured

`al-runner v2.12.0-main.c39ad5de`, BC 28.5.54151.55132, run from a scratch copy:

```bash
al-runner --output-json --isolation test --test Codeunit91610.Rea --auto-provision \
  --coverage --coverage-out cov.xml <copy>/target <copy>/tests --package-cache <symbols dir>
```

Both tests behave as expected (`ReachOnly` passes, `ReadGlobalsAfterRunModal` reports
`MEASURED kept=21`), so al-runner runs a report extension's triggers and procedures. Cobertura:

```xml
<class name="R254ProbeRepExt.ReportExt" filename="target/src/R254ProbeRepExt.ReportExt.al" line-rate="1.0000">
  <line number="12" hits="6" />   modify(IntItem) OnAfterAfterGetRecord body
  <line number="19" hits="2" />   OnPreReport
  <line number="26" hits="2" />   OnPostReport
  <line number="31" hits="6" />   Classify: if
  <line number="32" hits="4" />   exit(10)
  <line number="33" hits="2" />   exit(1)
  <line number="40" hits="1" />   GetExtTotal
```

- The extension is its OWN `<class>`, keyed by its own FILE, in the source line frame (every line
  number is the statement's own line; the hit counts are exactly right for two runs of 3 records).
- Nothing in it names an object type. LethAL's al-runner path takes the type from its own parse
  (`objectIdentityOf` in `line-map.ts`), so on this backend the line map's
  `OBJECT_KIND_TO_TYPE_NAME` entry is the whole requirement.
- `CallExtProcedureDirectly` alone: lines 31-32 hit 1, the trigger lines 0. Per-test coverage
  separates the direct call from a report run.

**al-runner quirk, not LethAL's:** `MeasureReportExtCoverage` fails under al-runner with
`NavALException: You tried to invoke the ReportExtension object with the ID 91601 from the object
R254 Probe Tests. An object with that ID does not exist ...`, and in a run of all four tests every
LATER test then fails the same way, even under `--isolation test`. Each passes alone. The trigger is
the test that calls Base Application's `Code Coverage Mgt.`; no LethAL fixture does that.

## (a) BC, phase-2 steps (Cronus28, under a coord lease)

1. Compile (from this repo, `S` = a scratch dir holding the symbol `.app`s):
   `$LETHAL_ALC_DIR/alc /project:scripts/r254-probe/target /packagecachepath:$S /out:$S/target.app`,
   copy `target.app` into `$S` as `LethAL_LethAL R254 RepExt Probe_1.0.0.0.app`, then
   `$LETHAL_ALC_DIR/alc /project:scripts/r254-probe/tests /packagecachepath:$S /out:$S/tests.app`.
2. Publish target, then tests:
   `bun scripts/r254-probe/publish.ts <config naming Cronus28> $S/target.app`, then the same with
   `$S/tests.app`. The script reads `bcdev.server/serverInstance/tenant/username/password` and hands
   the credentials to altool only as env vars. Do not open the config yourself.
3. `bcdev_test_run` (bc-dev MCP), codeunit 91610, method `MeasureReportExtCoverage`, coverage
   `none`. Expect `failed` with `MEASURED base=6 ext=21 allRows=.. hitRows: [...]`. Record every
   row. The answer is the `type=` of the rows with `id=91601`.
4. `bcdev_test_run`, codeunit 91610, methods `ReachOnly` and `CallExtProcedureDirectly`, coverage
   `procedure`. Record the objectType/objectId/method the hub reports for the extension: this is
   the path `AppMethodIndex.lookup` reads.
5. `bcdev_test_run`, method `ReadGlobalsAfterRunModal`: expect `MEASURED kept=21`.
6. Unpublish both (tests first) on the host: `UnPublish-BcContainerApp` is host-only, so ask the
   owner. No tables, so no schema ghost.

## (a) results: Cronus28, 2026-10-05

Dev endpoint: webApiVersion 7.0, runtimeVersion 17.0 (the build number is not shown by the tool).
Both apps published with `ForceSync`; symbols were the 28.0.46665.47126 set.

- `MeasureReportExtCoverage` (coverage none): failed, as designed. Raw text:
  `MEASURED base=6 ext=21 allRows=58 hitRows: [type=3(Report) id=91600 line=14 hits=3 kind=Code]
  [type=3(Report) id=91600 line=23 hits=1 kind=Code] [type=5(Codeunit) id=91602 line=12 hits=1 kind=Code]
  [type=5(Codeunit) id=91602 line=17 hits=1 kind=Code] [type=5(Codeunit) id=91602 line=32 hits=1 kind=Code]
  [type=5(Codeunit) id=91602 line=33 hits=1 kind=Code] [type=22(ReportExtension) id=91601 line=12 hits=3 kind=Code]
  [type=22(ReportExtension) id=91601 line=19 hits=1 kind=Code] [type=22(ReportExtension) id=91601 line=26 hits=1 kind=Code]
  [type=22(ReportExtension) id=91601 line=31 hits=3 kind=Code] [type=22(ReportExtension) id=91601 line=32 hits=2 kind=Code]
  [type=22(ReportExtension) id=91601 line=33 hits=1 kind=Code]`
  So BC records the extension under its OWN object: Object Type **22** (ReportExtension), Object ID
  **91601**, not folded into `3:91600`. Line numbers are source lines.
- `ReachOnly` and `CallExtProcedureDirectly` (coverage procedure): both passed. Hub coverage:
  - ReachOnly (testMethodId 651339170): `3:91600` x2 methods, `5:91602` x5, `5:91610` x1, and
    `22:91601` methodIds -1436085861, 1710736425, 2032681428, 2072836216.
  - CallExtProcedureDirectly (testMethodId 623772920): ONLY `22:91601` methodId 1710736425
    (presumably `Classify`). `coverageComplete: true`.
  So the procedure path reports objectType 22 / objectId 91601 with the method ids of the extension's
  own triggers and procedures, and separates a direct call from a report run per test.
- `ReadGlobalsAfterRunModal`: failed as designed: `MEASURED kept=21 (21 = globals survive RunModal)`.
