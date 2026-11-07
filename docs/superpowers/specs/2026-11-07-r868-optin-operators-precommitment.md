# R868: pre-commitment for the opt-in operators `condition-true` (#36) and `blank-argument` (#34)

Written from reading the fixture's source and the operators' rules, before any run of the fixture on a server or on al-runner v3. Branch `lethal/r868`. The expected claimed and refused sites were checked offline against the generator (`generateMutationSet`, no test run, no server): the generator gave exactly the four claimed sites below and the refused counts below.

## What is built

Two operators, each `1.0.0`, `optIn: true`, **Tier 1** (`lethal.condition-true`, `lethal.blank-argument`). They run only when `--operator` names them. A default run, and a run under `--exclude-operator`, never walks them: same specs, same hang counts, same ordinals, same `numberingDigest`. A run that names them gains sites, so its `numberingDigest` changes.

Tier 1 and not Tier 2: both operators ask the loop analysis in `builtin-tier1/src/loop-hazard.ts` (`inLoopExitParts`, `deletedOperandHangs`, `exitEffect`, `procEffect`), which Tier 2 cannot reach (the one Tier 2 opt-in, #33, has its hang rule at the dispatch for that reason). The known bug (`operator-tables` counted opt-ins in Tier 2 only, so a Tier 1 opt-in inflated the README totals) is fixed in `scripts/operator-tables.ts` and its test: each tier's default count leaves out its own opt-ins.

## The fixture: `fixtures/sandbox-optin` and `fixtures/sandbox-optin-tests`

Target codeunit 77200 `Optin Logic` and table 77201 `Optin Row`; tests 77250 to 77253, one codeunit per verdict, asserting via `Error()`. Run with:

`lethal run ... --operator condition-true,blank-argument`

Expected: **4 mutants, no more.** Nothing is `not covered`: each site has one covering test. BC (one test method per call) and al-runner v3 (the codeunit per call) must give the same verdict and the same killing test, because no test sets state that outlives it.

| # | operator | procedure | site | mutated to | covering test | predicted verdict | predicted killer, BC and v3 |
|---|---|---|---|---|---|---|---|
| 1 | `lethal.condition-true` | `KilledGuard` | `Amount > 0` | `true` | `Optin Kill Guard Test.GuardBelowZeroIsZero` | killed | `Optin Kill Guard Test.GuardBelowZeroIsZero`: with `true`, `KilledGuard(-5)` returns -10, the test expects 0 |
| 2 | `lethal.condition-true` | `SurvivingGuard` | `Amount > 0` | `true` | `Optin Survive Guard Test.GuardPositiveDoubles` | survived | none: the test only passes 3, and `true` and `3 > 0` give 6 both ways |
| 3 | `lethal.blank-argument` | `Welcome` | `User` in `Greet(User)` | `''` | `Optin Kill Greet Test.WelcomeNamesTheUser` | killed | `Optin Kill Greet Test.WelcomeNamesTheUser`: the greeting becomes `Hello ` and the test expects `Hello Bob` |
| 4 | `lethal.blank-argument` | `Remember` | `Note` in `Store(Note)` | `''` | `Optin Survive Note Test.RememberCountsNotes` | survived | none: the test reads the note count, never the note |

Totals expected: 4 mutants, 2 killed, 2 survived, 0 timed out, 0 errors, 0 not covered. Score 50%.

### Refused sites, from the same reading

Each of these makes no mutant. None of the procedures is called by a test (some would not end if their guard were forced). The generator counts them as hang-refused:

- `condition-true`: **12** `if` statements. A then-arm holding a loop (`RefusedArmLoop`); a write to a name the loop's exit reads (`RefusedLocalWrite`, `RefusedFlag`); a helper that resets one (`RefusedHelperReset`); a cursor restart and a step back (`RefusedRestart`, `RefusedBack`); a cursor step in the condition (`RefusedStepInCondition`); a `continue` (`RefusedContinue`); a self-call and a one-hop mutual recursion (`RefusedSelfCall`, `RefusedPing`); the guard of a self-call and of a mutual recursion in `Depth` and `PingB`.
- `blank-argument`: **9** arguments. A copy a loop reads (`CallSpin`); a global a loop reads (`ConfigureHeld`); a procedure the value is handed to (`UseDelta`, and `OuterDelta`'s own call); caller progress (`DrainAll`, `Consume(Remaining)`); the depth argument of a self-call (`Depth`) and of a mutual recursion (`PingB`, `PongB`, and `RefusedPong`'s call back into `RefusedPing`).

If a live run shows a fifth mutant, or a refused site as a mutant, that is a BLOCK: a refusal rule stopped holding, or a site entered that the reading did not predict.

## What a run must show on the default operators

A run of this fixture **without** `--operator` must hold no `condition-true` and no `blank-argument` mutant. `packages/runner/tests/r868-optin-operators.test.ts` pins that offline; it is not a live check.

## The whole-set dump, 2026-11-07

Production dump of five sets (`scripts/corpus-snapshot.ts diff`, master `481bd0c4`, branch `lethal/r868`), each operator off and on. Logs: `/coord/handoff/R-868/diff-<off|cond|blank|both>-<set>.log`. The tables are in the build report of coord R-868 and are repeated below.

DUMP_TABLES_PLACEHOLDER

## Compile, with every mutant in

COMPILE_PLACEHOLDER

## Other expected changes

- No gate baseline moves: no gate names these operators, and a default run is byte-identical (the OFF dump shows 0 added, 0 removed, 0 moved on all five sets).
- `numberingDigest` changes on a run that names them (the CHANGELOG says so). No `IDENTITY_SCHEME` bump: add-only.
- `scripts/operator-tables.ts` prints per-tier default counts; the README says "plus 3 opt-in".
