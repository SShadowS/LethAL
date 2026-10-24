# R602 pre-commitment: `itest:alrunner-v3` legs MO and WR

Status: committed to master 2026-10-24 by lethal-code (coord task R-602), specs only, before any live run of legs MO
or WR. Built head `lethal/r602` 7b3dd27b; plan `/coord/handoff/R-602/plan.r2.md` (deep review and delta review
applied; build review `/coord/handoff/R-602/review-build.md` applied). Only fixture names; no corpus source. Source of every figure below: the admitted runs and the `none`
runs of `/coord/handoff/R-602/measure/out/{multi,wrapped}.{pin,edge}.*` (pin alpha.2 91253f2d6 and edge alpha.4
57f1e4f98 gave identical tables; identity scheme 42; BC 28.0.46665.47126). Built head: branch `lethal/r602`.

## What both legs are

- Both run exactly as the other v3 legs do: `runSession` with a hand-built `AlRunnerV3Backend` (one-shot, static
  selector), **coverage `"al-runner"` (ON)**, a packages folder of the Microsoft apps of
  `fixtures/sandbox-tests/.alpackages`, `sourceProjectDir` = the fixture's app folder. They do not go through the CLI
  guard. The leg asserts `capabilities().coverage === "al-runner"`.
- Each leg runs, in this order, and stops at the first difference (nothing is written then):
  1. the **durable killer check** (below), 2. the pre-committed counts, 3. `assertCleanLeg` (baseline green, no
  refused test, no refused-nearby note, no Sleep or runner refusal, Sleep index 0 + 0, every kill reproduced; and
  the `[v3-codeunit-state-possible]` notes: MO none, WR **exactly the 6 pre-committed state notes** (M0071, M0072,
  M0078, M0085, M0086, M0092; kills that stay kills; the note does not change a verdict), `V3_WR_STATE_NOTES`), 4. the per-mutant compare with the leg's own R332 baseline (`al-runner-v3.multiobject.baseline.json`,
  `al-runner-v3.wrapped.baseline.json`). A baseline never records itself: the gate refuses to start MO or WR while
  its file is missing (R332), and records only under `LETHAL_ITEST_RECORD_BASELINE=<file>`, exit 3.
- Recording: `LETHAL_ITEST_ALRUNNER_V3=1 LETHAL_ITEST_V3_LEGS=MO,WR LETHAL_ITEST_RECORD_BASELINE=al-runner-v3.multiobject.baseline.json,al-runner-v3.wrapped.baseline.json bun run itest:alrunner-v3`,
  then a confirm run without the variable, and a review of the diff against the tables below.
- **Durable killer check.** `V3_MO_KILLERS` (6) and `V3_WR_KILLERS` (58) are constants in
  `packages/runner/itest/alrunner-v3-legs.ts`, built from the `none` runs. Each is `[code, file, line, operator,
  killing test]`; the leg requires the mutant at that code, file, line and operator to be `killed` with that killing
  test. They are NOT in the baselines and record mode never writes them, so re-recording a baseline cannot absorb a
  lost kill.
- Both legs ARE in `V3_GATE_LEGS` (orchestrator ruling 2026-10-24: the update gate judges them, so a pin that breaks
  v3's per-object frame cannot move `current`). Inside MO and WR an `AlRunnerCoverageFrameError` is `gate-fail`;
  in any other leg it stays `infra-fail`. Both are default legs, so `V3_AGENTFLOW_LEGS` becomes
  `C, S1, S3, N1, X, L1, Y-A, Y-B, MO, WR, K`.
- Both legs are one-shot only: `LETHAL_ITEST_V3_TRANSPORT=serve-entries` fails them by name
  (`al-runner-v3-itest-leg-transport-refused`).
- The packages folder is the Microsoft apps of `fixtures/sandbox-tests/.alpackages` (as every other leg), where the
  measurement used each tests project's own `.alpackages`; the killer check and tables would show a difference.

## Leg MO: `fixtures/sandbox-multiobject` (+ `-tests`), selector ids 79849 / 79848 / 79847, no config symbol

Predicted: **6 killed / 1 survived / 5 no-coverage over 12**. The 5 `no-coverage` are in procedures no test calls
(`Never`, `Unreached`); `none` reads them `survived`. Zero lost kills against `none`.

| code | file:line | operator | verdict | killing test |
|---|---|---|---|---|
| M0001 | src/MultiControl.Codeunit.al:4 | lethal.empty-block | killed | ControlDoubles |
| M0002 | src/MultiControl.Codeunit.al:5 | lethal.return-value | killed | ControlDoubles |
| M0003 | src/MultiPair.Codeunit.al:4 | lethal.empty-block | no-coverage | - |
| M0004 | src/MultiPair.Codeunit.al:5 | lethal.return-value | no-coverage | - |
| M0005 | src/MultiPair.Codeunit.al:5 | lethal.swap-additive | no-coverage | - |
| M0006 | src/MultiPair.Codeunit.al:12 | lethal.empty-block | killed | ReachedBothWays |
| M0007 | src/MultiPair.Codeunit.al:13 | lethal.conditional-boundary | survived | - |
| M0008 | src/MultiPair.Codeunit.al:14 | lethal.return-value | killed | ReachedBothWays |
| M0009 | src/MultiPair.Codeunit.al:14 | lethal.swap-additive | killed | ReachedBothWays |
| M0010 | src/MultiPair.Codeunit.al:15 | lethal.return-value | killed | ReachedBothWays |
| M0011 | src/MultiPair.Codeunit.al:17 | lethal.empty-block | no-coverage | - |
| M0012 | src/MultiPair.Codeunit.al:18 | lethal.return-value | no-coverage | - |

(Test names are `Multi Tests.<method>`.) Covering sets of the admitted run: M0001 and M0002 `ControlDoubles`; M0006,
M0007, M0008, M0009, M0010 `ReachedBothWays`; the five `no-coverage` rows none. M0007 (Reached's
`conditional-boundary`, line 13) survives under `none` too: the tests do not tell `>` from `>=` at 10.

Killer constant `V3_MO_KILLERS` (the 6 `killed` rows above): M0001 M0002 M0006 M0008 M0009 M0010, each by the test
shown.

## Leg WR: `fixtures/sandbox-wrapped` (+ `-tests`), selector ids 78949 / 78948 / 78947, config symbol `WRAPDEF` (`app.json` defines `WRAPAPP`)

`preprocessorSymbols: ["WRAPDEF"]` is passed to the backend and to the session, as measured. Predicted: **58 killed /
37 survived / 3 no-coverage over 98**. 95 of 98 rows equal `--mode none`. The 3 that differ are the `WrappedArms`
rows (the two-arm `#if/#else` control, for which the coverage index has no rule), refused by name; that refusal costs
two kills `none` finds (M0001 and M0003 killed by `ArmsPick`) and turns M0002 from `survived` to `no-coverage`.

The refusal sentence, exactly as the built code emits it (`refusedUnmeasuredShapeReason`, note on each of the three
`WrappedArms` rows, no `[lethal] ` prefix there; the same text is printed with that prefix as a warning):

> coverage refused for Codeunit:78906 (src/WrappedArms.Codeunit.al): its file holds a #if object wrapper of a shape the al-runner coverage index has no rule for (two-arm, #elif, nested, or a multi-object file holding a wrapper; R602). Its mutants read no-coverage.

The leg requires exactly three `WrappedArms` rows, each `no-coverage` with that note, and no other row carrying it
(`judgeWrArms`).

| code | file:line | operator | verdict | killing test |
|---|---|---|---|---|
| M0001 | src/WrappedArms.Codeunit.al:7 | empty-block | no-coverage (refused) | - |
| M0002 | src/WrappedArms.Codeunit.al:8 | conditional-boundary | no-coverage (refused) | - |
| M0003 | src/WrappedArms.Codeunit.al:9 | return-value | no-coverage (refused) | - |
| M0004 | src/WrappedPairA.Codeunit.al:10 | empty-block | killed | PairPick |
| M0005 | src/WrappedPairA.Codeunit.al:11 | conditional-boundary | survived | - |
| M0006 | src/WrappedPairA.Codeunit.al:12 | return-value | killed | PairPick |
| M0007 | src/WrappedPre.Codeunit.al:9 | empty-block | killed | GrowPre |
| M0008 | src/WrappedPre.Codeunit.al:10 | conditional-boundary | survived | - |
| M0009 | src/WrappedPre.Codeunit.al:11 | return-value | killed | GrowPre |
| M0010 | src/WrappedPre.Codeunit.al:11 | swap-additive | killed | GrowPre |
| M0011 | src/WrappedPre.Codeunit.al:12 | return-value | survived | - |
| M0012 | src/WrappedPre.Codeunit.al:35 | empty-block | killed | TwicePre |
| M0013 | src/WrappedPre.Codeunit.al:36 | return-value | killed | TwicePre |
| M0014 | src/WrappedPreTwin.Codeunit.al:9 | empty-block | killed | GrowPreTwin |
| M0015 | src/WrappedPreTwin.Codeunit.al:10 | conditional-boundary | survived | - |
| M0016 | src/WrappedPreTwin.Codeunit.al:11 | return-value | killed | GrowPreTwin |
| M0017 | src/WrappedPreTwin.Codeunit.al:11 | swap-additive | killed | GrowPreTwin |
| M0018 | src/WrappedPreTwin.Codeunit.al:12 | return-value | survived | - |
| M0019 | src/WrappedPreTwin.Codeunit.al:35 | empty-block | killed | TwicePreTwin |
| M0020 | src/WrappedPreTwin.Codeunit.al:36 | return-value | killed | TwicePreTwin |
| M0021 | src/WrappedTop.Codeunit.al:7 | empty-block | killed | GrowTop |
| M0022 | src/WrappedTop.Codeunit.al:8 | conditional-boundary | survived | - |
| M0023 | src/WrappedTop.Codeunit.al:9 | return-value | killed | GrowTop |
| M0024 | src/WrappedTop.Codeunit.al:9 | swap-additive | killed | GrowTop |
| M0025 | src/WrappedTop.Codeunit.al:10 | return-value | survived | - |
| M0026 | src/WrappedTop.Codeunit.al:32 | empty-block | killed | TwiceTop |
| M0027 | src/WrappedTop.Codeunit.al:34 | remove-assignment | killed | TwiceTop |
| M0028 | src/WrappedTop.Codeunit.al:36 | return-value | killed | TwiceTop |
| M0029 | src/WrappedTopTwin.Codeunit.al:7 | empty-block | killed | GrowTopTwin |
| M0030 | src/WrappedTopTwin.Codeunit.al:8 | conditional-boundary | survived | - |
| M0031 | src/WrappedTopTwin.Codeunit.al:9 | return-value | killed | GrowTopTwin |
| M0032 | src/WrappedTopTwin.Codeunit.al:9 | swap-additive | killed | GrowTopTwin |
| M0033 | src/WrappedTopTwin.Codeunit.al:10 | return-value | survived | - |
| M0034 | src/WrappedTopTwin.Codeunit.al:32 | empty-block | killed | TwiceTopTwin |
| M0035 | src/WrappedTopTwin.Codeunit.al:34 | remove-assignment | killed | TwiceTopTwin |
| M0036 | src/WrappedTopTwin.Codeunit.al:36 | return-value | killed | TwiceTopTwin |
| M0037 | src/WrappedTrigger.Table.al:19 | empty-block | killed | ClampTrigger |
| M0038 | src/WrappedTrigger.Table.al:20 | conditional-boundary | survived | - |
| M0039 | src/WrappedTrigger.Table.al:21 | remove-assignment | killed | ClampTrigger |
| M0040 | src/WrappedTrigger.Table.al:21 | shift-integer | killed | ClampTrigger |
| M0041 | src/WrappedTrigger.Table.al:35 | empty-block | killed | DoubledTrigger |
| M0042 | src/WrappedTrigger.Table.al:36 | return-value | killed | DoubledTrigger |
| M0043 | src/WrappedTriggerTwin.Table.al:19 | empty-block | killed | ClampTriggerTwin |
| M0044 | src/WrappedTriggerTwin.Table.al:20 | conditional-boundary | survived | - |
| M0045 | src/WrappedTriggerTwin.Table.al:21 | remove-assignment | killed | ClampTriggerTwin |
| M0046 | src/WrappedTriggerTwin.Table.al:21 | shift-integer | killed | ClampTriggerTwin |
| M0047 | src/WrappedTriggerTwin.Table.al:35 | empty-block | killed | DoubledTriggerTwin |
| M0048 | src/WrappedTriggerTwin.Table.al:36 | return-value | killed | DoubledTriggerTwin |
| M0049 | src/WrappedView.Page.al:27 | empty-block | survived | - |
| M0050 | src/WrappedView.Page.al:28 | remove-assignment | survived | - |
| M0051 | src/WrappedView.Page.al:28 | flip-boolean-literal | survived | - |
| M0052 | src/WrappedView.Page.al:32 | empty-block | killed | LabelView |
| M0053 | src/WrappedView.Page.al:33 | conditional-boundary | survived | - |
| M0054 | src/WrappedViewTwin.Page.al:27 | empty-block | survived | - |
| M0055 | src/WrappedViewTwin.Page.al:28 | remove-assignment | survived | - |
| M0056 | src/WrappedViewTwin.Page.al:28 | flip-boolean-literal | survived | - |
| M0057 | src/WrappedViewTwin.Page.al:32 | empty-block | killed | LabelViewTwin |
| M0058 | src/WrappedViewTwin.Page.al:33 | conditional-boundary | survived | - |
| M0059 | src/WrappedXtra.PageExt.al:14 | empty-block | survived | - |
| M0060 | src/WrappedXtra.PageExt.al:15 | remove-assignment | survived | - |
| M0061 | src/WrappedXtra.PageExt.al:15 | flip-boolean-literal | survived | - |
| M0062 | src/WrappedXtra.PageExt.al:19 | empty-block | killed | ScaledXtra |
| M0063 | src/WrappedXtra.PageExt.al:20 | conditional-boundary | survived | - |
| M0064 | src/WrappedXtra.PageExt.al:21 | return-value | killed | ScaledXtra |
| M0065 | src/WrappedXtraTwin.PageExt.al:14 | empty-block | survived | - |
| M0066 | src/WrappedXtraTwin.PageExt.al:15 | remove-assignment | survived | - |
| M0067 | src/WrappedXtraTwin.PageExt.al:15 | flip-boolean-literal | survived | - |
| M0068 | src/WrappedXtraTwin.PageExt.al:19 | empty-block | killed | ScaledXtraTwin |
| M0069 | src/WrappedXtraTwin.PageExt.al:20 | conditional-boundary | survived | - |
| M0070 | src/WrappedXtraTwin.PageExt.al:21 | return-value | killed | ScaledXtraTwin |
| M0071 | src/WrappedYBand.Report.al:22 | empty-block | killed | BandYRun |
| M0072 | src/WrappedYBand.Report.al:23 | remove-assignment | killed | BandYRun |
| M0073 | src/WrappedYBand.Report.al:42 | empty-block | survived | - |
| M0074 | src/WrappedYBand.Report.al:43 | remove-assignment | survived | - |
| M0075 | src/WrappedYBand.Report.al:43 | flip-boolean-literal | survived | - |
| M0076 | src/WrappedYBand.Report.al:52 | empty-block | survived | - |
| M0077 | src/WrappedYBand.Report.al:53 | remove-assignment | survived | - |
| M0078 | src/WrappedYBand.Report.al:53 | shift-integer | killed | BandYRun |
| M0079 | src/WrappedYBand.Report.al:57 | empty-block | killed | BandYDirect |
| M0080 | src/WrappedYBand.Report.al:58 | conditional-boundary | killed | BandYDirect |
| M0081 | src/WrappedYBand.Report.al:59 | return-value | killed | BandYDirect |
| M0082 | src/WrappedYBand.Report.al:60 | return-value | killed | BandYDirect |
| M0083 | src/WrappedYBand.Report.al:64 | empty-block | killed | BandYRun |
| M0084 | src/WrappedYBand.Report.al:65 | return-value | killed | BandYRun |
| M0085 | src/WrappedYBandTwin.Report.al:22 | empty-block | killed | BandYRunTwin |
| M0086 | src/WrappedYBandTwin.Report.al:23 | remove-assignment | killed | BandYRunTwin |
| M0087 | src/WrappedYBandTwin.Report.al:42 | empty-block | survived | - |
| M0088 | src/WrappedYBandTwin.Report.al:43 | remove-assignment | survived | - |
| M0089 | src/WrappedYBandTwin.Report.al:43 | flip-boolean-literal | survived | - |
| M0090 | src/WrappedYBandTwin.Report.al:52 | empty-block | survived | - |
| M0091 | src/WrappedYBandTwin.Report.al:53 | remove-assignment | survived | - |
| M0092 | src/WrappedYBandTwin.Report.al:53 | shift-integer | killed | BandYRunTwin |
| M0093 | src/WrappedYBandTwin.Report.al:57 | empty-block | killed | BandYDirectTwin |
| M0094 | src/WrappedYBandTwin.Report.al:58 | conditional-boundary | killed | BandYDirectTwin |
| M0095 | src/WrappedYBandTwin.Report.al:59 | return-value | killed | BandYDirectTwin |
| M0096 | src/WrappedYBandTwin.Report.al:60 | return-value | killed | BandYDirectTwin |
| M0097 | src/WrappedYBandTwin.Report.al:64 | empty-block | killed | BandYRunTwin |
| M0098 | src/WrappedYBandTwin.Report.al:65 | return-value | killed | BandYRunTwin |

(Test names are `Wrapped Tests.<method>`.) The table above is the admitted run's, row for row; the 95 rows other than
the three `WrappedArms` rows are equal to the `--mode none` run in verdict and killing test.

Killer constant `V3_WR_KILLERS`: the 58 `killed` rows above, i.e. every mutant `none` kills (60) except M0001 and
M0003 (the two `WrappedArms` kills the by-name refusal costs): M0004 M0006 M0007 M0009 M0010 M0012 M0013 M0014 M0016
M0017 M0019 M0020 M0021 M0023 M0024 M0026 M0027 M0028 M0029 M0031 M0032 M0034 M0035 M0036 M0037 M0039 M0040 M0041
M0042 M0043 M0045 M0046 M0047 M0048 M0052 M0057 M0062 M0064 M0068 M0070 M0071 M0072 M0078 M0079 M0080 M0081 M0082
M0083 M0084 M0085 M0086 M0092 M0093 M0094 M0095 M0096 M0097 M0098, each by the test shown.

State notes (`V3_WR_STATE_NOTES`), measured on the pin and the edge admitted run alike: exactly six
`[v3-codeunit-state-possible]` notes, on `0/M0071`, `0/M0072`, `0/M0078`, `0/M0085`, `0/M0086`, `0/M0092`
(BandYRun and BandYRunTwin run after BandYDirect and BandYDirectTwin in one codeunit call, #5611). All six are
kills that stay kills; the note changes no verdict. The leg asserts this exact set, no more and no fewer. Leg MO has
no state note and asserts none. No refused-nearby note in either leg.

## Coverage mode, CLI level, and what does not move

- **Coverage is ON for both legs as run** (`runSession` with the v3 backend, `coverage: "al-runner"`): the legs
  measure the coverage index and selection, not the CLI guard.
- **CLI-level expectation (unit test `r602-admit.test.ts`, not a live leg):** `sandbox-multiobject` and a project of
  single-wrapper files keep coverage ON with no warning. `sandbox-wrapped` as a whole is **OFF** from the CLI,
  because it holds the two-arm file, and the warning names it:
  `[lethal] al-runner-v3-coverage-off: coverage is turned OFF for this run (coverage "none"): the coverage index has no rule for the #if wrapper shape (two-arm, #elif, nested, or a multi-object file holding a wrapper) in src/WrappedArms.Codeunit.al (R602).`
  (a project path in the list is the file as the project names it). That is why leg WR's 98-row table, which has the
  index placing the other files, is run through `runSession`, not the CLI.
- **No committed v3 figure moves.** No other v3 fixture holds a multi-object or `#if`-wrapped object file
  (`sandbox-app`, `-names`, `-layout`, `-symbols`, `-data`, CDO cdo-r396 slice; `ProbePair` is removed in X (d)'s
  scratch copy, and that `rm` stays). So S1, N1, L1, Y-A, Y-B, T, K, D1, D1c, X and C keep their pre-committed
  figures and baselines; `al-runner-v3.{tables,layout,symbols-lethala,symbols-lethalb}.baseline.json` are untouched.
- Not covered by these legs (stated limits): the `serve-entries` transport, `#elif`, a nested object wrapper, a
  wrapper with objects of different ids in its arms, an admitted wrapped file whose instrumented text re-parses
  undecided (refused by name), a key declared in two files (refused by name).
- A difference in any row, in the killer check, in the refusal sentence or in a count is a BLOCK, never "close enough".
