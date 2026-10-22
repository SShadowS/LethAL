# R-300b pre-commitment: the `sandbox-wrapped` legs of `itest:alrunner`

Written 2026-10-06, BEFORE any al-runner session on the fixture (no live leg has run). Branch
`lethal/r300b`. Derived OFFLINE: the mutant list from the real `runSession` generation path with a
fake backend that executes nothing, the instrumented layout from `writeInstrumentedProject`, the
verdicts by reading each mutant against the ten tests. `packages/runner/tests/wrapped-fixture.test.ts`
re-derives the mutant list and the layout offline; `packages/runner/itest/wrapped-fixture.ts` holds
this table as code. A difference in a live run is a finding and a stop: never edit a row to match a
run.

## 1. What runs

- Target `fixtures/sandbox-wrapped` (codeunits 78901-78906, selector ids 78947-78949, app.json
  `preprocessorSymbols: ["WRAPAPP"]`), tests `fixtures/sandbox-wrapped-tests` (codeunit 78950).
- Config symbol `WRAPDEF`, sent to al-runner as `--define WRAPDEF` (one-shot argv and the daemon's
  start argv). LethAL's effective set: `WRAPAPP`, `WRAPDEF` and al-runner's 25 predefined
  `CLEANSCHEMA*` symbols.
- Three legs, one batch each: one-shot (static selector), `--server` (static), `--server` + resource
  selector. Coverage `"al-runner"`.
- `bun run compile:fixtures`: `OK fixtures/sandbox-wrapped [WRAPDEF]`, `OK fixtures/sandbox-wrapped-tests`
  (alc 18.0.43, 2026-10-06).

| file | shape | LethAL's reading |
|---|---|---|
| `WrappedTop` | `#if WRAPDEF` first line, namespace inside, statement-level `#if WRAPDEF` in `Twice` | admitted |
| `WrappedTopTwin` | same text, the two wrapper lines replaced by comments | plain file |
| `WrappedPre` | namespace, using and a comment BEFORE `#if WRAPDEF` | admitted |
| `WrappedPreTwin` | same text, the two wrapper lines replaced by comments | plain file |
| `WrappedPairA` | `#if WRAPDEF and WRAPAPP`, codeunit 78905 | admitted, compiled |
| `WrappedPairB` | `#if not WRAPDEF or not WRAPAPP`, codeunit 78905 | compiled out: no mutant, not indexed, skipped |
| `WrappedArms` | two-arm `#if WRAPDEF ... #else ... #endif` | refused by name |

## 2. The layout (why a frame misread changes verdicts)

In each admitted file, `Twice`'s statements sit, in the ORIGINAL text, on lines the INSTRUMENTED
`Grow` occupies (measured offline from the emitted batch):

| file | instrumented `Grow` | `Twice`'s original lines | read in the instrumented frame |
|---|---|---|---|
| `WrappedTop` | 9-38 | 32, 34, 36 | `Grow`, `Grow`, `Grow` |
| `WrappedPre` | 11-40 | 35, 36 | `Grow`, `Grow` |

So if al-runner reported a wrapped object's lines in the original frame, `Twice`'s mutants would
lose `TwiceTop`/`TwicePre` and read `no-coverage`, and `Grow`'s would gain them as covering tests.
The twins are plain files, which R383 measured as right, so the wrapped files must equal them.

Limit, stated: a ONE-line misread (H2, the `#if` line not counted) moves no line across a
procedure boundary in this layout, so no verdict here detects it. The probe measured H1 against H2
and H3 directly on exact line numbers (`alrunner-results.md`); this leg pins the frame, not the
single line.

## 3. Tests

`GrowTop`, `TwiceTop`, `GrowTopTwin`, `TwiceTopTwin`, `GrowPre`, `TwicePre`, `GrowPreTwin`,
`TwicePreTwin`: `Grow(20)` must be 21, `Twice(3)` must be 6. `PairPick`, `ArmsPick`: `Pick(5)` must be
1. All raise through `Error(...)`. Every test passes at baseline under both readings of section 5.

## 4. The table ("adds" reading)

Covering tests are `Wrapped Tests.<name>`; a survivor's covering test is its procedure's test.

| code | file | line | operator | procedure | verdict | killing / covering test |
|---|---|---|---|---|---|---|
| M0001 | WrappedArms | 7 | empty-block | Pick | no-coverage | (refused by name) |
| M0002 | WrappedArms | 8 | conditional-boundary | Pick | no-coverage | (refused by name) |
| M0003 | WrappedArms | 9 | return-value | Pick | no-coverage | (refused by name) |
| M0004 | WrappedPairA | 10 | empty-block | Pick | killed | PairPick |
| M0005 | WrappedPairA | 11 | conditional-boundary | Pick | survived | PairPick |
| M0006 | WrappedPairA | 12 | return-value | Pick | killed | PairPick |
| M0007 | WrappedPre | 9 | empty-block | Grow | killed | GrowPre |
| M0008 | WrappedPre | 10 | conditional-boundary | Grow | survived | GrowPre |
| M0009 | WrappedPre | 11 | return-value | Grow | killed | GrowPre |
| M0010 | WrappedPre | 12 | return-value | Grow | survived | GrowPre |
| M0011 | WrappedPre | 35 | empty-block | Twice | killed | TwicePre |
| M0012 | WrappedPre | 36 | return-value | Twice | killed | TwicePre |
| M0013 | WrappedPreTwin | 9 | empty-block | Grow | killed | GrowPreTwin |
| M0014 | WrappedPreTwin | 10 | conditional-boundary | Grow | survived | GrowPreTwin |
| M0015 | WrappedPreTwin | 11 | return-value | Grow | killed | GrowPreTwin |
| M0016 | WrappedPreTwin | 11 | swap-additive | Grow | killed | GrowPreTwin (twin-only, R343) |
| M0017 | WrappedPreTwin | 12 | return-value | Grow | survived | GrowPreTwin |
| M0018 | WrappedPreTwin | 35 | empty-block | Twice | killed | TwicePreTwin |
| M0019 | WrappedPreTwin | 36 | return-value | Twice | killed | TwicePreTwin |
| M0020 | WrappedTop | 7 | empty-block | Grow | killed | GrowTop |
| M0021 | WrappedTop | 8 | conditional-boundary | Grow | survived | GrowTop |
| M0022 | WrappedTop | 9 | return-value | Grow | killed | GrowTop |
| M0023 | WrappedTop | 10 | return-value | Grow | survived | GrowTop |
| M0024 | WrappedTop | 32 | empty-block | Twice | killed | TwiceTop |
| M0025 | WrappedTop | 34 | remove-assignment | Twice | killed | TwiceTop |
| M0026 | WrappedTop | 36 | return-value | Twice | killed | TwiceTop |
| M0027 | WrappedTopTwin | 7 | empty-block | Grow | killed | GrowTopTwin |
| M0028 | WrappedTopTwin | 8 | conditional-boundary | Grow | survived | GrowTopTwin |
| M0029 | WrappedTopTwin | 9 | return-value | Grow | killed | GrowTopTwin |
| M0030 | WrappedTopTwin | 9 | swap-additive | Grow | killed | GrowTopTwin (twin-only, R343) |
| M0031 | WrappedTopTwin | 10 | return-value | Grow | survived | GrowTopTwin |
| M0032 | WrappedTopTwin | 32 | empty-block | Twice | killed | TwiceTopTwin |
| M0033 | WrappedTopTwin | 34 | remove-assignment | Twice | killed | TwiceTopTwin |
| M0034 | WrappedTopTwin | 36 | return-value | Twice | killed | TwiceTopTwin |

Why each: `empty-block` returns 0 (killed); `conditional-boundary` `>= 10` / `>= 0` keeps 21 / 1 for
the tested input (survived); `return-value` on the taken `exit` returns 0 (killed), on the untaken
`exit(X)` / `exit(0)` changes nothing reached (survived, covered); `remove-assignment` makes
`Twice(3)` 3 (killed); `swap-additive` makes `Grow(20)` 19 (killed).

Totals: 34 mutants, killed 22, survived 9, no-coverage 3. The two-arm rows' `failureNote` is exactly
`coverage refused for Codeunit:78906 (src/WrappedArms.Codeunit.al): its file holds a #if object
wrapper of a shape not measured on al-runner (R300). Its mutants read no-coverage.`

## 5. The `--define` pair under both readings

Whether al-runner's `--define` ADDS to the bundle's `app.json` symbols or REPLACES them is
unmeasured (R321 measured that it reads `app.json` symbols with no `--define`, and that `--define`
reaches the build).

- **Adds:** al-runner has `WRAPAPP` and `WRAPDEF`, compiles `WrappedPairA`, and M0004-M0006 score
  as in section 4.
- **Replaces:** al-runner has `WRAPDEF` only, compiles `WrappedPairB` (identical behaviour, so
  `PairPick` still passes), and reports its hits under `WrappedPairB`'s path, which LethAL's index
  skips (compiled out). M0004, M0005 and M0006 all read `no-coverage`, with NO covering test. Totals
  then: killed 20, survived 8, no-coverage 6.

The gate accepts either reading, prints which one it saw, and refuses any mix (some pair rows
scored, others not) and any pair row with another file's coverage. Every other row is the same
under both readings: no other wrapper depends on `WRAPAPP`.

## 6. What the gate asserts (each leg)

1. One batch, a green baseline.
2. Every row of section 4 (pair rows under the reading seen), per mutant: verdict, killing test and
   the complete covering-test set.
3. `WrappedArms`'s three rows carry the refusal sentence above.
4. Each admitted wrapped file equals its twin per (procedure, line, operator): verdict, killing test
   and covering tests, with the twin's test names being the wrapped ones plus `Twin`. The twins'
   only extra rows are M0016 and M0030.
5. Zero R383 "the position wins" warnings and zero R-300b "the line is dropped (R300)" warnings.
6. `--server` and resource equal the one-shot leg per mutant.
7. The one-shot leg against `al-runner.wrapped.baseline.json` (pending its first record, R332).

## 7. What would mean what

- `Twice`'s rows `no-coverage` and `Grow`'s covering set gaining `TwiceTop`/`TwicePre` in the
  wrapped file only: al-runner numbers a wrapped object in another frame; R-300b's admission is
  wrong for that leg.
- A wrapped row differing from its twin in any other way: same conclusion, by row.
- A position-wins or dropped-line warning: the `--server` scope disagrees with the position in a
  wrapped (or twin) file.
- Pair rows `no-coverage`: the "replaces" reading, a measurement, not a failure. Pair rows with a
  covering test from `WrappedPairB`: impossible by construction; a defect.
