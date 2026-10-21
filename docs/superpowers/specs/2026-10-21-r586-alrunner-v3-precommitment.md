# R-586 pre-commitment r4: `itest:alrunner-v3` on al-runner v3 alpha.2

Written 2026-10-21, BEFORE any of the backend exists. Every figure below is a prediction for the gate legs of
`plan.md` r4 §11 and §12. A differing verdict, killing test, note set or refusal set in any leg is a BLOCK, never
"close enough". The lane commits this file to master `[skip ci]` before the first live run, and ONLY after the
three placeholders marked FILL are filled (S1's and N1's oracle citations from lethal-code, D1c's shim figure). All
three were filled on 2026-10-21.

## Changes from r3

1. **Sleep index size, pre-committed per leg (I-1 (5)):** S1 0, N1 0, T 0, D1/D1c 3 target lines + 0 test lines
   (counted in the instrumented `active/` of the measured D1c run and in the test dir). An index of any other size
   is a miss and a BLOCK. New section "Sleep index".
2. **Sleep positive control, live through the backend (I-1 (4)):** leg X gains (d), on codeunit 50660 and the
   sleeping target `Probe Sleeper` (`scripts/r586-probe/extras/`), plus the fail-closed controls (e) and (f).
3. **`sleep-is-noop` stated with its arguments (I-2, rejected as a re-measure, kept as `defect-present`):** probe
   codeunit 50660, which has NO CPU-bound sibling; argv and expected wall named in "Leg C". The probe's isolation
   from #5611 is load-bearing.
4. **Leg T `held` (I-3):** only a row of `precommitment-tables-52.txt` moving to the BC verdict recorded there is
   `held`; any other difference is `gate-fail`.
5. **Precondition before the lane commits (plan Q23):** the D predictions hold only if v3's top-level
   `--coverage-json` lists the two un-reached Sleep files (`Codeunit 6175274 CDO Continia Online PDF Mgt.al`,
   `Codeunit 6175335 CDO Send Mail Management.al`) with their 3 Sleep lines at 0 hits, OR omits both files whole. If it
   lists either file WITHOUT its Sleep line, §6 case 2 fails closed and D1's 12 / D1c's 8 survivors would read `error`.
   One light CDO read settles it (the Q20 coverage files were deleted). **Measured by the lane, 2026-10-21, before
   this commit:** one `--isolation test --codeunit 68933 --coverage-json` call on the D1c instrumented `active/`
   (exit 0). The top-level `coverage` lists 478 files, 477 with zero-hit statements. `6175274` lists all 251 of its
   statements at 0 hits, including Sleep lines 414 and 539; `6175335` lists all 120 at 0 hits, including Sleep line 260.
   No per-test entry names either file. So the first branch holds: case 2 does not fire, and the D predictions stand.
6. **m-3:** `plan-measure/state-notes.txt` now names its inputs; D1c's notes are computed from the ONE-SHOT D1c report
   (`/coord/handoff/R-586/cdo-alpha2-d1c/oneshot-cov.report.json`), the gate's mode. Same 51 codes.

## Delta for the reviewer

Changed sections only: "Changes from r3" (item 5 is a precondition on committing), "Leg C" (`sleep-is-noop`, `sleep-line-covered`), "Sleep index" (new),
"Legs D1 and D1c" (the notes' source line), "Leg X" ((d), (e), (f)), "Leg T" (`held`), "Notes and refusals, summary"
(index column). Everything else is r3 as the lane filled it.

## Changes from r2 (r3, kept as filled by the lane)

1. Oracles named per leg (F8): S1 on bc1 (filled), N1 on lethal-code's `itest:bcdev-names` result on bc1
   (filled), D legs on bc3's live R594 reports (the bc3 hook fired; see 8), with R546's frozen Cronus28 reports
   as the cross-check. The oracle server's BC build is recorded beside v3's `--bc-version`.
2. Note predictions COMPUTED from measured row orders (F7): `v3-codeunit-state-possible` S1 0, N1 0, D1 51,
   D1c 51 (codes listed). r2's "0 on every leg" is withdrawn.
3. Sleep (F1): the §6 refusal set is predicted EMPTY on every leg (no gate fixture's covered code holds a
   `Sleep(`); `sleep-is-noop` = `defect-present`.
4. Leg C: `sleep-is-noop`, `timeout-is-cpu`, `sleep-line-covered`, widened `predefined-symbols`.
5. Leg X gains c4 (selector id not the last activated) and c5 (`app.json` byte, `<deps>` file added).
6. Leg T: the BC cross-check is suspended (DK data); own-baseline only. The 52 rows stay recorded as explanation.
7. D1c: the one-shot shim run (M5) has NOT run (no heavy-job slot all session); the lane runs
   `scripts/r586-probe/cdo-d1c-and-cost.sh`, and its result fills the placeholder. Filled: 0 of 63 differ.
8. D oracles: the bc3 hook fired. R594 re-measured the slice live on bc3, and it equals R546's bc-A and bc-B per
   mutant, so `docs/measurements/r594/bc3-A` and `bc3-B` are the D oracles and R546's reports are the cross-check.
9. The Sleep rule's cost on the CDO slice (Q20), measured: 5 calls of codeunit 68933 each, mean 1,696 ms plain and
   2,045 ms with `--coverage-json` (+20.6%, a 5.5 MB coverage file). That is under the plan's +25% limit, so option
   (b)'s coverage rule stands and the static fallback is not built
   (`/coord/handoff/R-586/plan-measure/covjson-cost-cdo.txt`).

## Pinned build

| Field | Value |
|---|---|
| `--version` | `alrunner 3.0.0-alpha.2 (91253f2d6)` |
| Release | `v3.0.0-alpha.2`, `aldevtools/BusinessCentral.AL.Runner` |
| Tarball sha256 (linux-x64) | `46a6c7f36612383859da7a755033e0fc60c49606ef0bd67f1c164ef502311748` |
| Binary sha256 | `b23f831575f0a4f33346682766b6e06f8376ac2682861bc8fb91342592e15d45` |
| Installed as | `/work/tools/al-runner-v3/3.0.0-alpha.2-91253f2d6/al-runner`, `current` -> it, `.gated` with `lethalCommit` |
| Why this build | ruling 2026-10-21: defects identical to alpha.3; alpha.3 refuses every CDO-slice test (#5606) |
| alc | `Microsoft (R) AL Compiler version 18.0.43.1464` |
| v3 `--bc-version` (with `--no-download`) | sandbox-app, sandbox-names, sandbox-data: `28.0.46665.47126`; CDO slice: `28.4.53241.53758` |
| Transport | one-shot only, one `--codeunit` per call |

## Oracles (F8)

| Leg | Oracle | Oracle server and BC build (recorded beside v3's `--bc-version`) |
|---|---|---|
| S1 | `packages/runner/itest/bcdev.baseline.json`, as reproduced live | **bc1** (`192.168.2.157:7049`, BC 28.4.53241.56590 W1, Base Application build measured by itest:testapp, `/coord/handoff/R-583/gates/p1-testapp-bc1.log`). itest:bcdev PASS, 3/12/4 per mutant equal to the baseline: master f17a41d9 `/coord/handoff/R-589/runs/itest-bcdev-bc1-4.log`; R-583 code `/coord/handoff/R-583/gates/p2-bcdev-bc1.log` (bc2, bc3 also PASS: `itest-bcdev-bc2-2.log`, `itest-bcdev-bc3-2.log`). Run by lethal-code, cited, not re-run |
| N1 | lethal-code's `itest:bcdev-names` result, equal to `bcdev.names.baseline.json` | **bc1**, the same build. itest:bcdev-names PASS, 36/0/0 per mutant: master 209360d8 `/coord/handoff/R-583/gates/p1-bcdev-names-bc1.log`; R-583 code `/coord/handoff/R-583/gates/p2-bcdev-names-bc1.log`. Run by lethal-code, cited, not re-run |
| D1 | `docs/measurements/r594/bc3-A.report.json` (live) | **bc3**, BC 28.4 W1: Microsoft apps 28.4.53241.56646, System 28.0.54946.56477, control 1.0.0.22, Continia stack in Dev scope (R594, pre-commitment 2fa33241, done c9fc4573). It equals R546's `bc-A` (Cronus28: DK 28.4.53241.53758, Continia in Global scope) on all 63 mutants by verdict and killing test, so R546's report stays as the cross-check |
| D1c | `docs/measurements/r594/bc3-B.report.json` (live) | the same bc3 build; it equals R546's `bc-B` on all 63 mutants, covering tests included |
| T | `al-runner-v3.tables.baseline.json` (v3's own, recorded once on alpha.2) | not a BC oracle (the BC cross-check is suspended) |

bc3 hook (R594): if the lane's live re-measure of the slice on bc3 equals bc-A and bc-B per mutant, bc3's reports
replace them as the D oracles (`D_LEG_ORACLE`), with this table updated in the same commit. **Fired 2026-10-21:** R594
measured 63 of 63 equal on both legs, so the table above names bc3's reports.

## Leg C: contract probe

Every fact in `plan.md` r4 §8 (and r2 §8 for the unchanged ones) with its expected value. In particular:
- `compile-failure-not-scorable` = `matches` through the alc proof (v3 spawned 0 times);
- `sleep-is-noop` = `defect-present`. Probe: codeunit 50660 `Sleep Probe` (`scripts/r586-probe/extras/
  ProbeSleep.Codeunit.al`, with `ProbeSleeper.Codeunit.al` in the target), runner `sleep-noop-probe.sh`. Argv: `test
  --output-json --isolation test --codeunit 50660 --test-timeout-secs 3 --coverage-json <f>`, and once more with
  no `--test-timeout-secs`. Expected on both: the whole call under 1 s of wall (the lane measured 87 ms and 82 ms on
  the same shape, `plan-measure/sleep-noop-recheck.md`); `ShortSleep`, `LongSleepA`, `LongSleepB` and
  `SleeperDoubles` `pass` with `durationMs` 0; `LongSleepThenAssert` FAILS with `after sleep <n>`, n under 1000 (the
  code after `Sleep(600000)` ran at once). `gone` = `LongSleepThenAssert` passes, or a Sleep test comes back as a
  timeout. **The probe's isolation from #5611 is load-bearing:** 50660 holds no CPU-bound test; in 50651 the
  unselected `CpuHang` burns the stop and made `SleepHang` read "cut at N" (the r3 review's I-2, measured false by
  the lane). The cost of a covered Sleep under a mutant stays 0;
- `sleep-line-covered` = `matches`: in the 50660 run, `LongSleepA`'s per-test coverage hits its `Sleep(600000)` line,
  and `SleeperDoubles`'s hits `Probe Sleeper`'s `Sleep(600000)` line (the r3 measurement on `ProbeHang.Codeunit.al`
  line 27 stands);
- `timeout-is-cpu` = `matches` (contended under `taskset -c 0`: a 1.7 s CPU loop at N=3 passes with wall over 3 s;
  the reviewer measured 5.2 s);
- `predefined-symbols` = `matches` (no arm active over CLEAN, CLEANSCHEMA1..25, BC1..40);
- `upstream-compile-errors`, `duplicate-key-insert-raises`, `refusal-cascade`, `codeunit-runs-whole`,
  `quoted-name-unselectable`, `commit-under-test-isolation` = `defect-present`;
- `positional-target-wins`, `bc-build-pinned` = `matches`.

## Sleep index (I-1 (1), (5))

Built per `deploy()` from the instrumented `active/` text plus the test dir, under the absolute paths v3 reads, every
arm included, matched on raw `--coverage-json` lines. Predicted size per leg (indexed `(file, line)` pairs):

| Leg | Target (`active/`) | Test dir | Basis |
|---|---|---|---|
| S1 | 0 | 0 | no `Sleep(` in `fixtures/sandbox-app` or `sandbox-tests` (counted) |
| N1 | 0 | 0 | none in `sandbox-names` or `-tests` (counted) |
| T | 0 | 0 | none in `sandbox-data` or `-tests` (counted) |
| D1, D1c | 3 | 0 | 3 calls in 2 files of the measured D1c `active/` (`Codeunit 6175274 CDO Continia Online PDF Mgt.al`, `Codeunit 6175335 CDO Send Mail Management.al`); 0 in `Test` (counted). Neither file is mutated by the slice, so no extra arm |
| X (d) | at least 2: the original `WaitThenDouble` line plus every mutant arm that keeps a `Sleep(` call (the shift-integer arm on `600000` at least) | 4 (`ShortSleep`, `LongSleepA`, `LongSleepB`, `LongSleepThenAssert`) | `extras/` probe files |

An index of another size is a miss and a BLOCK: an empty index on D cannot read as a match.

## Leg S1: sandbox-app + sandbox-tests, coverage al-runner

Predicted **3 / 12 / 4, 0 of 19 differ** against the S1 oracle above.

| Code | Codeunit | Procedure | Operator | Verdict | Killing test |
|---|---|---|---|---|---|
| M0001 | Sandbox Logic | IsOverBudget | empty-block | killed | OverBudgetDetected |
| M0002 | Sandbox Logic | IsOverBudget | return-value | killed | OverBudgetDetected |
| M0003 | Sandbox Logic | IsOverBudget | conditional-boundary | killed | OverBudgetDetected |
| M0004 | Sandbox Logic | ClampPercent | empty-block | survived | - |
| M0005 | Sandbox Logic | ClampPercent | negate-conditional | survived | - |
| M0006 | Sandbox Logic | ClampPercent | conditional-boundary | survived | - |
| M0007 | Sandbox Logic | ClampPercent | conditional-boundary | survived | - |
| M0008 | Sandbox Logic | ClampPercent | return-value | survived | - |
| M0009 | Sandbox Logic | ApplyAudit | empty-block | survived | - |
| M0010 | Sandbox Logic | ApplyAudit | void-method-call | survived | - |
| M0011 | Sandbox Logic | LogAudit | empty-block | survived | - |
| M0012 | Sandbox Logic | LogAudit | negate-conditional | survived | - |
| M0013 | Sandbox Logic | LogAudit | shift-integer | survived | - |
| M0014 | Sandbox Logic | LogAudit | empty-block | survived | - |
| M0015 | Sandbox Logic | LogAudit | remove-assignment | survived | - |
| M0016 | Sandbox Pricing | DiscountedPrice | empty-block | no-coverage | - |
| M0017 | Sandbox Pricing | DiscountedPrice | conditional-boundary | no-coverage | - |
| M0018 | Sandbox Pricing | DiscountedPrice | return-value | no-coverage | - |
| M0019 | Sandbox Pricing | DiscountedPrice | swap-additive | no-coverage | - |

Baseline green, 0 refused tests. Notes: `v3-codeunit-state-possible` on NONE (each kill's only covering test is
`OverBudgetDetected`; `state-notes.txt`). `v3-refused-test-nearby` on none. §6 refusals: none. Each kill is
reproduced once (R-577).

## Leg S3: resource selector

Refused before any v3 call with `al-runner-v3-resource-selector-refused`.

## Leg N1: sandbox-names + sandbox-names-tests, coverage al-runner

Predicted **36 / 0 / 0, 0 of 36 differ** against the N1 oracle, every killing test by its AL name. Not measured
through LethAL; the basis is `plan-measure/plan-measure.txt` (one `--codeunit 78850` call reports all 12 tests by
AL name with per-test coverage; a mutated quoted-name procedure is killed in it).

| Procedure (Names Calc) | Operators (one mutant each) | Verdict | Killing test | Selectable by name on v3 |
|---|---|---|---|---|
| SpaceStep | empty-block, return-value, swap-additive | killed x3 | `Space Step` | no |
| DashStep | same three | killed x3 | `Dash-Step` | no |
| ParenStep | same three | killed x3 | `Paren(Step)` | no |
| DotStep | same three | killed x3 | `Dot.Step` | no |
| SlashStep | same three | killed x3 | `Slash/Step` | no |
| AmpStep | same three | killed x3 | `Amp&Step` | no |
| DigitStep | same three | killed x3 | `7Digit Step` | no |
| KeywordStep | same three | killed x3 | `Default` | yes |
| DanishStep | same three | killed x3 | `Blåbær Step` | no |
| TwinStep | same three | killed x3 | `Twin Pair` | no |
| TwinLongStep | same three | killed x3 | `Twin_PairLong` | yes |
| PlainStep | same three | killed x3 | `PlainControl` | yes |

Baseline green, 12 tests, 0 refused. Notes: none (each mutant has exactly one covering test, from the per-test
coverage, so no covering test precedes its killer). §6 refusals: none.

## Legs D1 (coverage none) and D1c (coverage al-runner): the R546 CDO slice

Continia Document Output at `5f2a71d`, target `Cloud`, `--only .dependencies/CDO/Codeunit/CDORecipientMgt.Codeunit.al`,
tests `Test`, `--tests-only Src/Recipients/CDORecipientMgtTests.Codeunit.al`, selector ids 6175460 / 6175459 /
6175458, packages `Test/.alpackages`. One batch, 63 mutants, one test codeunit (21 tests).

| Leg | Predicted | Basis |
|---|---|---|
| D1 | 51 / 12 / 0, 0 of 63 differ | measured one-shot through the shim on alpha.2 (per-test calls, 835 s) |
| D1c | 51 / 8 / 4, 0 of 63 differ | measured on `serve` with coverage (473 s), and one-shot through the shim on 2026-10-21: 51 / 8 / 4, baseline green, 0 of 63 differ from R546 `bc-B` (560 s; `/coord/handoff/R-586/cdo-alpha2-d1c/oneshot-cov.compare.txt`). bc-B and bc3-B are equal per mutant, so this holds against both |

| Codes | Procedure | Verdict | Killing test |
|---|---|---|---|
| M0001, M0002, M0006, M0007, M0008, M0009 | AddRecipient | killed | AddRecipient_WhenAddingMultipleRecipients_ShouldBuildSemicolonSeparatedList |
| M0003, M0004, M0005 | AddRecipient | killed | AddRecipient_WhenBothEmpty_ShouldReturnFalse |
| M0010, M0011 | AddRecipient | killed | AddRecipient_WhenRecipientWithSpecialCharacters_ShouldHandleCorrectly |
| M0012-M0015, M0019-M0022, M0028-M0030 | AddRecipientsFromTable | killed | AddRecipientsFromTable_WhenAnyRecipientHasDoNotAttach_ShouldSetFlag |
| M0016, M0017, M0018 | AddRecipientsFromTable | killed | AddRecipientsFromTable_WhenFirstToRecipientHasContactNo_ShouldSetFirstToContactNo |
| M0023, M0024 | AddRecipientsFromTable | killed | AddRecipientsFromTable_WhenCcRecipientExists_ShouldAddToCc |
| M0025, M0026 | AddRecipientsFromTable | killed | AddRecipientsFromTable_WhenBccRecipientExists_ShouldAddToBcc |
| M0027 | AddRecipientsFromTable | killed | AddRecipientsFromTable_WhenDoNotAttachOpenDocIsTrue_ShouldSetFlag |
| M0031, M0032, M0033, M0034 | ShowRecipientsSetup | survived (D1); no-coverage (D1c) | - |
| M0035, M0044, M0045, M0047, M0050-M0054, M0056, M0059-M0061 | MoveRecipientFromHeaderToTable | killed | MoveRecipientFromHeaderToTable_WhenBothFieldsSet_ShouldCreateTwoSetupRecords |
| M0036, M0039, M0042, M0043, M0046, M0058 | MoveRecipientFromHeaderToTable | killed | MoveRecipientFromHeaderToTable_WhenEMailAddressFieldSet_ShouldCreateSetupAndClearField |
| M0037, M0049 | MoveRecipientFromHeaderToTable | killed | MoveRecipientFromHeaderToTable_WhenEMailRecipientsFieldSet_ShouldCreateSetupAndClearField |
| M0038, M0040, M0041, M0048, M0055, M0057, M0062, M0063 | MoveRecipientFromHeaderToTable | survived | - |

Counts: killed 51; survived 12 (D1c: 8 survived, 4 no-coverage). 16 of 63 rows text-verified, 47 unverifiable
(redacted reports); all 63 keyed as R546.

**Notes (computed, F7, `plan-measure/state-notes.txt`):** `v3-codeunit-state-possible` on ALL 51 kills on D1 and on
D1c: `0/M0001`-`0/M0030`, `0/M0035`, `0/M0036`, `0/M0037`, `0/M0039`, `0/M0042`-`0/M0047`, `0/M0049`-`0/M0054`,
`0/M0056`, `0/M0058`-`0/M0061`. (Every killer has an earlier covering sibling in v3's row order, from
`cdo-alpha2/smoke.json`. Inputs, named in `state-notes.txt` (m-3): D1 from `cdo-alpha2/oneshot-covnone.report.json`;
D1c from the ONE-SHOT `cdo-alpha2-d1c/oneshot-cov.report.json`, the gate's mode; the serve+coverage report gives the
same 51 as a cross-check.) The note never
moves a verdict. `v3-refused-test-nearby`: none (0 refused tests). §6 refusals: none (the target's 3 Sleep lines are
in `CDO Continia Online PDF Mgt` and `CDO Send Mail Management`, predicted not covered by the slice's tests; if a
covering pass hits one, that is a miss of this pre-commitment and a BLOCK to investigate).

## Leg X: the compile proof and its binding

On a scratch copy of the sandbox-app batch with `begin NoSuchVar := 1;` in `SandboxLogic.Codeunit.al`:
(a) `deploy()` throws `AlcCompileError` naming AL0118, v3 spawned 0 times; (b) v3 alone on that folder exits 7 with
1 pass and 1 not run (measured). After a GOOD deploy and `activate("M0002")`, each of these makes the next `run()`
throw `AlRunnerV3UnprovenBatchError` with 0 spawns for that call: (c1) a byte appended to `SandboxLogic.Codeunit.al`
in `active/`; (c2) a byte appended to a test-dir `.al`; (c3) the selector rewritten to `M9999`; (c4) the selector
rewritten to `M0001` (in the manifest, not the last activated); (c5) a byte changed in `active/app.json`, or one file
added to `<deps>`.

**(d) Sleep positive control, live through the backend (I-1 (4)).** `runSession` on a scratch copy of `probe-app`
with `extras/ProbeSleeper.Codeunit.al` added, and `probe-tests` with `extras/ProbeSleep.Codeunit.al` added, `--only`
`ProbeSleeper.Codeunit.al`, coverage al-runner. Predicted:
- baseline: `ShortSleep`, `LongSleepA`, `LongSleepB`, `SleeperDoubles` green; `LongSleepThenAssert` fails (Sleep does
  nothing) and goes to `unsupportedTests`; the rule does not touch baseline calls;
- the only covering test of `WaitThenDouble`'s mutants is `SleeperDoubles` (per-test coverage);
- every mutant whose arm EXECUTES a `Sleep(` (an indexed line hit) and whose `SleeperDoubles` row is `pass` reads
  `error`, cause `runner-refused`, `failureNote` beginning `[v3-sleep-noop] covered Sleep at`; at least one such
  mutant exists (the shift-integer mutant of `600000`);
- every mutant whose `SleeperDoubles` row FAILS (a change to `X * 2`) reads `killed`, Sleep hit or not;
- a mutant that removes the Sleep statement (its arm hits no indexed line) reads `survived`, as on BC;
- the set of `error` mutants is exactly the set whose arm keeps a `Sleep(` and leaves `X * 2` intact. Mutant codes
  are fixed by the first run's generation and listed in the committed gate data; this file commits the rule, not the
  codes (the probe target has not been generated by LethAL yet; stated so).

**(e) Fail closed on a missing coverage document (I-1 (2)):** the same mutant call with the `--coverage-json` file
removed before the backend reads it (test hook) -> every covering `pass` of the call reads `error` /
`runner-refused`; 0 `survived`.

**(f) Fail closed on a missing per-test entry or an absent indexed line (I-1 (2), (3)):** a document whose
`perTestCoverage` lacks `SleeperDoubles` (test hook) -> its `pass` reads `error`; a document whose top-level `coverage`
lacks an indexed Sleep line -> every covering `pass` of the batch's calls reads `error`; a top-level hit on an indexed
Sleep line that no per-test entry owns (Q21) -> every covering `pass` of that call reads `error`.

## Leg T (UPDATE gate only): sandbox-data + sandbox-data-tests, coverage al-runner

- **Own baseline only:** `packages/runner/itest/al-runner-v3.tables.baseline.json`, recorded ONCE on alpha.2 after
  this file is committed. Predicted figure of that record run: **290 / 57 / 59 over 406** (measured through the
  shim, `tables-alpha2/oneshot.compare.txt`). Any other figure is a miss: BLOCK, do not record.
- **BC cross-check suspended** (F8): `tables.baseline.json` is DK data from Cronus28. The 52 rows in
  `precommitment-tables-52.txt` (41 Commit #5607, 7 duplicate key #5603, 4 TestPage) remain the recorded
  explanation of how v3 differs from BC there, to be compared on the full transition as committed JSON (M4) once a bc
  server re-proves `tables.baseline.json`.
- Baseline: 3 refused tests (the Commit tests) in `unsupportedTests`.
- Note and §6 sets: recorded by the first run and frozen in the baseline, NOT predicted here (unmeasured; stated so
  that a first recorded value is not mistaken for a prediction).
- Outcomes: `pass` / `gate-fail` / `held` / `infra-fail` (plan r4 §12). **`held` on leg T (I-3)** only when EVERY
  difference from the own baseline is a row listed in `precommitment-tables-52.txt` that moves to the BC verdict (and
  killing test) recorded there for that row, for example a #5603 fix turning one of the 7 duplicate-key survivors into
  BC's kill by `DoubleInsertWithoutKeyTriggerRaises`. Any other difference (a row not in the 52, or a listed row moving
  to anything but its BC verdict) is `gate-fail`.

## Notes and refusals, summary

| Leg | Sleep index (target + test) | `v3-codeunit-state-possible` | `v3-refused-test-nearby` | §6 Sleep refusals | `runner-refused` / `runner-test-error` mutants |
|---|---|---|---|---|---|
| S1 | 0 + 0 | 0 | 0 | 0 | 0 |
| N1 | 0 + 0 | 0 | 0 | 0 | 0 |
| D1 | 3 + 0 | 51 (all kills, listed above) | 0 | 0 | 0 |
| D1c | 3 + 0 | 51 (all kills, listed above) | 0 | 0 | 0 |
| T | 0 + 0 | recorded | recorded | recorded | recorded |
| X (d) | at least 2 + 4 | not asserted | not asserted | at least 1 (the rule in "Leg X") | equal to the §6 refusals |

## Red-check predictions

As r2 (R1-R8), with R7 covering c3 and c4, and R8: drop the §6 rule -> T12 red AND leg X (d) red (its `error`
mutants read `survived`). New R9: build the Sleep index from the ORIGINAL source instead of `active/` -> leg X (d) red
(the arm lines shift, the hits stop matching) and the D index size check red if the guard lines move a counted line.
New R10: treat a missing coverage document as "no hit" -> leg X (e) red.

## Known-difference rows

| Row id | Issue | Known to move | On S1 / N1 / D1 / D1c |
|---|---|---|---|
| `v3-duplicate-key-insert` | #5603 | 7 tables rows | 0 |
| `v3-commit-refused` | #5607 | 41 tables rows | 0 |
| `v3-testpage-runs` | none (a BC-side limit) | 4 tables rows | 0 |
| `v3-codeunit-state` | #5611 | 0 under `--isolation test` measured; noted on 51 CDO kills (verdicts equal BC) | noted only |
| `v3-sleep-noop` (project) | #5605 | fail-closed to `error` | 0 |
| `v3-sleep-noop-dependency` | #5605 | residual: Sleeps in dependency code pass on v3 | 0 measured |
| `v3-refusal-cascade` | #5610 | none at mutant time | 0 |
| `v3-no-cleanschema` | #5615 | none | 0 |
| `v3-alpha3-companyopen` | #5606 | all 63 CDO mutants `error` on alpha.3 | pinned away |

## Every existing itest figure unchanged

As r2: no v2 or bcdev code path changes; every existing gate's figures and committed baselines stay byte for byte.
The build re-runs `itest:alrunner` once on v2 f06ee78c to show it.
