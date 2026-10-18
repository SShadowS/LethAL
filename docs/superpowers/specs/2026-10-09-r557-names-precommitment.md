# R557 pre-commitment r3: `sandbox-names` + `sandbox-names-tests`

Written 2026-10-09 (r2), re-validated 2026-10-18 against master `0254e6d2` (r3), before any LethAL session on this
fixture and before any fix code exists. The lane commits it as
`docs/superpowers/specs/2026-10-09-r557-names-precommitment.md` (specs-only, `[skip ci]`, to master) BEFORE its first
live run. The lane may change this table only before that commit, and only to match the OFFLINE mutant listing
(section 0). After the commit, a difference in any live run is a finding and a stop. Never edit a row to match a run.
Upstream: al-runner #5572.

## Changes from r2

Evidence: `/coord/handoff/R-557/revalidate.md`. No row of table A or B moved, and no plan test changed.
- **Build.** Every al-runner leg, the RED check included, runs the pinned scratch copy of
  `v2.12.0-main.f06ee78c` (sha `f06ee78c3f81b3da51eaee6e662c974946735e42`, BC 28.5.54151.55132), passed as
  `LETHAL_ALRUNNER_PATH`, not `/work/tools/al-runner/current`. `current` points at the same build today, but it can
  move under the lane. The only upstream commit after `c5bbaf89` is `845eb74` (affected-test selection), which does not
  touch the naming rule or test selection. The lane re-measured that the row names are identical to `c5bbaf89`'s on
  p1 (20), u1 (30) and u2 (7).
- **Coverage is set explicitly on every leg (R394).** Since R394 the CLI's default is `coverage: "al-runner"`, but
  `AlRunnerBackend`'s own default is still `"none"`. So an omitted key means different things on the two paths. Legs
  A1 and A3 set `coverage: "al-runner"`, and legs A2 and A4 set `coverage: "none"`, both in the leg config. The B
  figures (6 / 30 / 0 with `none`, 6 / 0 / 30 with `al-runner`) are re-derived on master's code paths and still hold.
  A RED check run through `lethal run` with no coverage key gets `al-runner` and reads 6 / 0 / 30.
- **R558 selector checks.** If the names legs go through `runOnce`, R551's line check and R558's
  `reportTestSelectorFailures` apply to them. This pins the selector: on the one-shot legs it is `exact` (measured on
  f06ee78c: `--test-exact` on a full mangled name selects that one test, and a prefix selects nothing, exit 6). That
  means one `al-runner-test-selector` warning and `testSelector: "exact"` with no `testSelectorReason`. The `--server`
  legs have no selector line and no `testSelector`.
- **Baseline format (R556, R560).** The new baselines are written in the R556 format, `{identityScheme, coverageMode?,
  entries}` with `mutatedTextSha256`, under the current scheme **40**. The existing al-runner and bcdev baselines were
  re-recorded on 2026-10-09 at scheme 38, with their rows unchanged (cli-default is at 40, from R394). The existing legs
  print `identity scheme changed (38 -> 40): N mutant(s) checked by their mutated-text hash`. That line is information,
  not a difference.
- **Section D, figures named.** cli-default is now **3 / 12 / 4** (R394 re-froze it equal to leg A; it was 3 / 16 / 0
  when r2 was written). multiobject **6 / 1 / 5** over 12 and wrapped **58 / 37 / 3** over 98 are written out. The 161
  names were re-counted on `0254e6d2`, and 0 are affected: no `.al` under `fixtures/` or `examples/` changed after
  `cd1d76ef`.

## Changes from r1

- **M4.** Added `DanishStep` with test `"Blåbær Step"` as procedure 9 (M0025-M0027). Every later mutant moved by 3.
  The totals are now 36 / 0 / 0 after the fix, and on master 6 / 30 / 0 (coverage none) and 6 / 0 / 30 (coverage
  al-runner).
- **M1.** The contract fact is asserted on the one-shot legs, and no contract line on the `--server` legs.
- **M2.** The Twin trap is declared UNIT-ONLY. No live leg shows it. See section A's note.
- **M3.** Leg A2's expected cost is stated.
- **Section C.** Lists the I1 and I3 carve-outs and C1's history and resume refusals as directions proven by unit
  tests.
- **Section D.** 161 names in `fixtures/` + `examples/`, 0 affected (was 148, `fixtures/` only).
- The rule now deletes Cf units and makes an ASCII-only keyword check (I2). No fixture name touches either, so no
  row's predicted al-runner name changed.

## 0. Offline precondition (checked by the lane before committing)

- The target `src/NamesCalc.Codeunit.al` (`codeunit 78800 "Names Calc"`) yields exactly **36** mutants, `M0001`-`M0036`,
  in one batch. For procedure k (1-based, order below) the mutants are:
  - `M(3k-2)`: `lethal.empty-block`;
  - `M(3k-1)`: `lethal.return-value`;
  - `M(3k)`: `lethal.swap-additive`.

  That is the set and order measured for the identical `exit(x + 1)` body (R557 Q3, `Grow` M0001-M0003; review:
  "3 mutants per `exit(x + 1)`").
- All 12 test names round-trip through `discovery.ts`, and the R420 tree = regex corpus test stays green.
- `bun run compile:fixtures` compiles both projects (the tests file as UTF-8). If `alc` rejects unquoted `Default`,
  the source uses `"Default"`. The rule gives `_Default` either way, so no row changes.

## A. Table: every leg, AFTER the fix

| Mutants | Procedure | Only killer (AL name, as `killingTest` shows it) | al-runner row name (rule) | Rule step shown | Kill text contains |
|---|---|---|---|---|---|
| M0001-M0003 | `SpaceStep` | `Space Step` | `Codeunit78850.Space_Step` | space | `SpaceStep(5) must be 6` |
| M0004-M0006 | `DashStep` | `Dash-Step` | `Codeunit78850.Dasha45Step` | `-` | `DashStep(5) must be 6` |
| M0007-M0009 | `ParenStep` | `Paren(Step)` | `Codeunit78850.Parena40Stepa41` | `(` `)` | `ParenStep(5) must be 6` |
| M0010-M0012 | `DotStep` | `Dot.Step` | `Codeunit78850.Dota46Step` | `.` | `DotStep(5) must be 6` |
| M0013-M0015 | `SlashStep` | `Slash/Step` | `Codeunit78850.Slasha47Step` | `/` | `SlashStep(5) must be 6` |
| M0016-M0018 | `AmpStep` | `Amp&Step` | `Codeunit78850.Ampa38Step` | `&` | `AmpStep(5) must be 6` |
| M0019-M0021 | `DigitStep` | `7Digit Step` | `Codeunit78850._7Digit_Step` | leading digit, space | `DigitStep(5) must be 6` |
| M0022-M0024 | `KeywordStep` | `Default` | `Codeunit78850._Default` | reserved keyword, unquoted | `KeywordStep(5) must be 6` |
| M0025-M0027 | `DanishStep` | `Blåbær Step` | `Codeunit78850.Blåbær_Step` | non-ASCII letters kept, space | `DanishStep(5) must be 6` |
| M0028-M0030 | `TwinStep` | `Twin Pair` | `Codeunit78850.Twin_Pair` | space | `TwinStep(5) must be 6` |
| M0031-M0033 | `TwinLongStep` | `Twin_PairLong` | `Codeunit78850.Twin_PairLong` | none (control) | `TwinLongStep(5) must be 6` |
| M0034-M0036 | `PlainStep` | `PlainControl` | `Codeunit78850.PlainControl` | none (control) | `PlainStep(5) must be 6` |

**All 36 mutants are `killed`.** Each is killed by the test in its row, and that row's text is in
`killingTestFailure`. Counts: **killed 36 / survived 0 / no-coverage 0** over 36.

| Leg | Build | Transport | Coverage | Prediction |
|---|---|---|---|---|
| A1 | al-runner `v2.12.0-main.f06ee78c` (sha `f06ee78c3f81b3da51eaee6e662c974946735e42`, BC 28.5.54151.55132), the scratch copy `/tmp/claude-1000/-work-lethal-wt-lane-bugs/42bbe1d1-6c93-426d-bdfa-21fd7ce46008/scratchpad/r557f/f06ee78c/al-runner` via `LETHAL_ALRUNNER_PATH`. The gate's first line must print this build | one-shot, R551 **exact** path (measured accepted on this build) | `al-runner`, set explicitly | table A. Each mutant's `coveringTests` is exactly `["Names Tests.<its killer>"]`. `baselineGreen: true`, 12/12 baseline tests pass, no `baseline-red` caveat, no `al-runner-undecided-test-missing` warning. R123 `test-name-mangling` fact present and `matches`. One `al-runner-test-selector` line (exact), and `testSelector: "exact"` with no reason on every measured context (R558). Frozen as `al-runner.names.baseline.json` (R556 format, scheme 40) |
| A2 | same | one-shot, exact | `none`, set explicitly | table A, with verdict, killing test and kill text equal to A1 per mutant. `coveringTests` holds all 12 tests. The `test-name-mangling` fact is present and `matches`. Same selector line and `testSelector` as A1. **Cost: about 115 one-shot invocations, about 10-11 min** (12 baseline + 78 to find each procedure's killer in name order + 24 killer-first) |
| A3 | same | `--server` | `al-runner`, set explicitly | equal to A1 per mutant, including `coveringTests` (the leg that showed the false `no-coverage`). **No contract line** in its output. No selector line and no `testSelector` |
| A4 | same | `--server` | `none`, set explicitly | equal to A2 per mutant. **No contract line**. No selector line and no `testSelector` |
| B1 | Cronus28 (bcdev), `itest:bcdev-names` | fenced | fenced | table A: verdict and killing test equal to A1 per mutant, and kill text contains the row's text. Frozen as `bcdev.names.baseline.json`. The first live evidence for non-ASCII (`Blåbær Step`) and special-character test names in `Test Method Line` |

Every al-runner leg: no R557 refusal fires, and the session exits 0.

**The Twin trap is UNIT-ONLY.** `"Twin Pair"` (`Twin_Pair`) and `Twin_PairLong` exist so that the R488 path must
exclude by the MANGLED name. No live leg depends on that:
- the container's build takes R551's exact path, which sends no excludes;
- on the R488 path, a merged first result is discarded and re-sent anyway (R488), so the verdict comes out the same.

The proof is T5 in the plan: an argv assertion that the FIRST call for `Twin Pair` carries
`--exclude-test Codeunit78850.Twin_PairLong`. The Twin rows in table A predict verdicts only, not argv.

## B. The RED check: the same al-runner legs on origin/master's code (no fix)

Same build and the same explicit coverage per leg as section A. Re-validated on master `0254e6d2`: the four al-runner
modules and `discovery.ts` are byte-identical to `cd1d76ef`'s, so these rows still hold. On f06ee78c,
`--test "Codeunit61530.Stone Quoted"` returns exit 6 with `tests: []`, as on c5bbaf89. The one-shot legs still take
the exact selector on master.

On master, `qualifiedTestName` sends the AL name. Renamed: the 10 tests of procedures 1-10. Each selects nothing
(exit 6), or on `--server` has no row, so each reads `error` at baseline and leaves every covering set. Not renamed:
`Twin_PairLong` and `PlainControl`, which run and kill normally. `Codeunit78850.Default` is not a substring of
`Codeunit78850._Default`, so `Default` is renamed-and-missed too.

| Leg | Prediction |
|---|---|
| A1 (one-shot, `al-runner`) | baseline 2 of 12 green; the other 10 `error` (exit 6, "selected no test"). `baselineGreen: false`, caveat `baseline-red`. M0031-M0036 `killed` (6). M0001-M0030 **`no-coverage`** (30). Counts **6 / 0 / 30** |
| A2 (one-shot, `none`) | same baseline. M0031-M0036 `killed`. M0001-M0030 **`survived`**, `coveringTests` = the two green tests. Counts **6 / 30 / 0** |
| A3 (`--server`, `al-runner`) | as A1, **6 / 0 / 30**. Baseline errors read `reported no test named "Codeunit78850.<AL name>"` |
| A4 (`--server`, `none`) | as A2, **6 / 30 / 0** |
| B1 (bcdev) | not run on master for this check. bcdev does not use the al-runner name |

The names gate therefore fails on master on M0001-M0030 on every al-runner leg, and passes after the fix.

## C. Directions proven by unit tests, not live legs

No live leg breaks a name on purpose: a fixture that does not compile on al-runner would be refused before names
matter. These directions are pinned by the plan's unit tests, each with a red test:

| Direction | Expected | Plan test |
|---|---|---|
| one-shot exit 6, or no row equal to the sent name, for a session-suite test | session STOPS with `AlRunnerTestNameError` naming the AL name and the sent name, no retry | T3a, T3b |
| same, for an R403 undecided-kept test | `error` with `AL_RUNNER_UNDECIDED_ARM_MISSING`, no stop, one `al-runner-undecided-test-missing` warning | T3d, T11 |
| `--server` clean answer (exit 0/1, all pass/fail, all `Codeunit<id>.`) missing a session-suite test | STOP, listing only missing SESSION-SUITE tests (never a decided compiled-out test) | T4b |
| `--server` unclean answer: exit 3 with an emit-excluded `<AL object>.<method>` row, or a `<ctor>` row | `error` listing those rows, no stop (I1) | T4d, T4e |
| `--server` miss for an undecided-kept test | prefixed `error`, no stop | T4f |
| `--server` miss after a hung test | `runner-test-error` (R534), no stop | T4c |
| `--skip-known-survivors` with a latest finished al-runner run whose baseline has an affected test as `error` | no survivor skipped; `history-al-runner-test-names` names the run and tests | T8a |
| same with only a plain-name `error`, an affected test as `fail`, or a bcdev run | survivors skipped as before; no warning | T8b |
| `--resume` of a tainted unfinished al-runner run | nothing carried; `resume-al-runner-test-names` | T9a |
| `--resume` of a run whose only `error` is a plain name | carried as before | T9b |
| reuse of a tainted baseline snapshot | not reused, baseline re-runs, warning | T10a |
| reuse of a snapshot whose only `error` is a plain name | reused (`resume-baseline-reused`) | T10b |
| R123 `test-name-mangling` with drifted, missing or extra rows | session refused, both lists printed | T6b, T6c |

## D. Existing gates: unchanged

All **161** test names in `fixtures/` and `examples/` map to themselves under the r2 rule (**0 affected**, the
reviewer's count, re-counted on `0254e6d2` over 106 `.al` files). So every existing al-runner leg sends
byte-identical argv, and no stored key or committed baseline moves. The figures below are the committed baselines
on `0254e6d2`. They were last recorded at R560 and R394, and the comparison is per mutant against those files:
- `itest:alrunner`:
  - main 3 / 12 / 4, with all 19 per-mutant verdicts unchanged (`al-runner.baseline.json`, scheme 38);
  - symbols `[LETHALA]` and `[LETHALB]` 5 / 4 / 0 each (scheme 38);
  - layout 7 / 3 / 0 (scheme 38);
  - multiobject 6 / 1 / 5 over 12 and wrapped 58 / 37 / 3 over 98 (scheme 38);
  - cli-default **3 / 12 / 4**, equal to leg A per mutant (`al-runner.cli-default.baseline.json`, scheme 40). R394
    moved it from r2's 3 / 16 / 0.
  - Each scheme-38 baseline prints `identity scheme changed (38 -> 40)`. That line is not a difference.
  - Every R558 selector check on the existing legs still passes.
- `itest:bcdev`: 3 / 12 / 4, `groupedCalls` 15, `warmKills` 0, `assertionScreen.discrimination` `vacuous`
  (`bcdev.baseline.json`, re-recorded at R560b with its rows unchanged, scheme 38; `EXPECTED` in `bcdev.itest.ts`
  unchanged).
  `itest:bcdev-names` is a separate script and never touches these.
- The R123 contract probe adds one invocation and one fact. No existing fact changes its verdict.
- C1 cannot taint any existing gate's run: a run taints only through an affected name, and no existing fixture has
  one. So `--skip-known-survivors` and `--resume` behave as before on every existing gate.

Any difference above is a block, never "close enough".
