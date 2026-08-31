# Pre-commitment: `toggle-blank-temporal`'s fixture arm on `itest:tables`

Written and committed BEFORE the live run. Nothing above the OUTCOME line is edited afterwards.

Operator: `docs/superpowers/specs/2026-08-31-toggle-blank-temporal-spike.md` (`e81cc97`).
Arm: `fixtures/sandbox-data/src/DataTemporalOps.Codeunit.al`, `codeunit 79333 "Data Temporal Ops"`.
Covering tests: five `[Test]` procedures appended to `codeunit 79310 "Data Tests"`.

## 1. Why this arm exists at all

The operator claims **zero** sites on every fixture and example this repo owns. Landing it alone
would be a change no live gate exercises, which is R56's shape: a docs-only commit once deleted a
procedure body and `itest:tables` stayed green for days. [[R171]] hit the same situation and answered
it the same way.

## 2. Counts, read from `tables.itest.ts` rather than from any summary

`CLAUDE.md` currently says 267/63/15 over 345. **That is stale** — the gate's own `EXPECTED` block
says 280/63/15 over 378, and concurrent work moved it. Every figure below is read from the itest.

| | before | predicted after |
| --- | ---: | ---: |
| `totalMutantSites` (raw specs) | 378 | **397** |
| `killed` | 280 | **299** |
| `survived` | 63 | **63** (unchanged) |
| `noCoverage` | 15 | **15** (unchanged) |
| `notInstrumented` | 1 file / 5 sites | unchanged |
| `declarativeSites` | 1 site / 1 file | unchanged |

Measured offline: `generateMutationSet` returns 397 raw specs with the arm and 378 without, and 378
equals the pinned `totalMutantSites` exactly. So the arm contributes **19** and nothing else moved.

## 3. Every one of the 19, pre-committed by verdict AND killing test

All nineteen are predicted **killed**. Four are the operator's own; fifteen are collateral from
operators that already ship, which is expected and is why they are listed rather than summarised.

| # | line | operator | mutation | predicted | killing test |
| --- | ---: | --- | --- | --- | --- |
| 1 | 35 | `empty-block` | body emptied | killed | `IsDueDateSetSeparatesBlankFromSet` |
| 2 | 36 | `negate-conditional` | `= 0D` -> `<> 0D` | killed | `IsDueDateSetSeparatesBlankFromSet` |
| 3 | 36 | **`toggle-blank-temporal`** | `0D` -> `17530101D` | killed | `IsDueDateSetSeparatesBlankFromSet` |
| 4 | 38 | `return-value` | `exit(1)` -> `exit(0)` | killed | `IsDueDateSetSeparatesBlankFromSet` |
| 5 | 45 | `empty-block` | body emptied | killed | `StampFixedDateReturnsTheNonBlankDate` |
| 6 | 46 | `remove-assignment` | assignment deleted | killed | `StampFixedDateReturnsTheNonBlankDate` |
| 7 | 46 | **`toggle-blank-temporal`** | `20240402D` -> `0D` | killed | `StampFixedDateReturnsTheNonBlankDate` |
| 8 | 52 | `empty-block` | body emptied | killed | `IsTimestampSetSeparatesBlankFromSet` |
| 9 | 53 | `negate-conditional` | `= 0DT` -> `<> 0DT` | killed | `IsTimestampSetSeparatesBlankFromSet` |
| 10 | 53 | **`toggle-blank-temporal`** | `0DT` -> `CREATEDATETIME(17530101D, 000001T)` | killed | `IsTimestampSetSeparatesBlankFromSet` |
| 11 | 55 | `return-value` | `exit(1)` -> `exit(0)` | killed | `IsTimestampSetSeparatesBlankFromSet` |
| 12 | 60 | `empty-block` | body emptied | killed | `IsCutoffSetSeparatesBlankFromSet` |
| 13 | 61 | `negate-conditional` | `= 0T` -> `<> 0T` | killed | `IsCutoffSetSeparatesBlankFromSet` |
| 14 | 61 | **`toggle-blank-temporal`** | `0T` -> `000001T` | killed | `IsCutoffSetSeparatesBlankFromSet` |
| 15 | 63 | `return-value` | `exit(1)` -> `exit(0)` | killed | `IsCutoffSetSeparatesBlankFromSet` |
| 16 | 68 | `empty-block` | body emptied | killed | `PassThroughIgnoresItsDateArgument` |
| 17 | 69 | `return-value` | `exit(Consume(0D))` -> `exit(0)` | killed | `PassThroughIgnoresItsDateArgument` |
| 18 | 73 | `empty-block` | `Consume` body emptied | killed | `PassThroughIgnoresItsDateArgument` |
| 19 | 74 | `return-value` | `exit(7)` -> `exit(0)` | killed | `PassThroughIgnoresItsDateArgument` |

Killing tests are named `Data Tests.<procedure>` in the report.

**Nineteen of nineteen killed is a strong claim and is deliberate.** Every test drives BOTH sides of
its blank check, so a toggled literal cannot pass by accident on the one input a test happened to
pick. An arm designed to produce survivors would have been a different arm; this one exists to prove
the operator's mutants are reachable and observable, and a survivor here would mean a test that does
not actually separate the two states.

## 4. The refusal control, which is the assertion a count cannot make

`PassThrough` contains `Consume(0D)` — a temporal literal in an `argument_list`. **The operator must
emit NO mutant there**, because a literal's meaning in an argument list depends on a callee this
layer cannot resolve.

Verified offline already: lines 68 and 69 carry only `empty-block` and `return-value`, and no
`toggle-blank-temporal`. The live run must reproduce that absence. Without this control, "the
operator claims temporal literals" would be satisfied by an over-broad operator that also mutates
`Consume`'s argument and reports it as a date-is-set finding.

Its covering test asserts the result is 7, so an over-broad claim would show up as a SURVIVOR rather
than silently — `Consume` ignores its date entirely.

## 5. What would refuse this build

- Any of the 19 coming back with a verdict other than `killed`.
- A twentieth mutant in `DataTemporalOps.Codeunit.al`, which would mean the operator claimed the
  argument-list literal after all.
- `toggle-blank-temporal` emitting anything other than exactly 4 mutants in this arm.
- Any of the 378 pre-existing mutants moving. The arm is a new file and changes nothing else, so a
  moved verdict elsewhere means the operator claimed a site on a file it should not have.
- `survived` or `noCoverage` moving off 63 and 15.
- `notInstrumented` or `declarativeSites` moving.
- The instrumented artifact failing to compile. The DateTime arm is the one to look at first: its
  replacement is a CALL and the only mutant text longer than its original. `alc` proved the
  expression legal standalone; only this run proves it legal after the schemata compiler wraps it.

## 6. Fixture republish, done before the run

`fixtures/sandbox-data` `app.json` bumped 1.0.0.8 -> 1.0.0.9; the target recompiled into
`fixtures/sandbox-data-tests/.alpackages/` as `LethAL_LethAL Sandbox Data_1.0.0.9.app` with the stale
`1.0.0.8` deleted; both projects then compile clean, and `bun run compile:fixtures` reports all
fixture projects compiling. Skipping that step is what produces `AL0185: Codeunit 'Data Temporal Ops'
is missing`, which is exactly what happened on the first attempt here.

---

## OUTCOME
