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

**OFF (the default operator set, code as committed): 0 added, 0 removed, 0 tuples moved, 0 ordinals moved on all five sets** (fixtures 27 projects, CDO 6, DO 7, DC 14, BC.History 519; every log ends `RESULT: identical`).

ON, specs added (each operator alone, then both together). Removed, tuples moved and ordinals moved are 0 in every cell: add-only, no `IDENTITY_SCHEME` bump.

| set | `condition-true` alone | `blank-argument` alone | both on | both = sum of the two? |
|---|---|---|---|---|
| fixtures | 273 | 10 | 283 | yes |
| CDO | 3,776 | 1,394 | 5,170 | yes |
| DO | 4,956 | 2,434 | 7,390 | yes |
| DC | 16,011 | 11,167 | 27,178 | yes |
| BC.History | 119,774 | 100,888 | 220,662 | yes |

(Round 2, after the build review: `blank-argument` alone and both were re-dumped on `lethal/r868` at e1df3b39; the `condition-true` column is both minus `blank-argument`, equal to round 1 except DC -4 and BC.History -7, the bare-`true` and own-type-variable refusals. The OFF dump was redone too: 0 added, 0 removed, 0 moved on all five sets.)

Hang-refused counts (before > after), and growth with both on:

| set | `condition-true` | `blank-argument` | both | specs, both on |
|---|---|---|---|---|
| fixtures | 2 > 2 | 0 > 0 | 2 > 2 | +283 |
| CDO | (round 1) 589 > 771 | 589 > 667 | 589 > 849 | +8.89% |
| DO | (round 1) 701 > 925 | 701 > 821 | 701 > 1,045 | +9.01% |
| DC | (round 1) 3,220 > 4,111 | 3,220 > 3,871 | 3,220 > 4,766 | +13.31% |
| BC.History | (round 1) 72,164 > 82,311 | 72,136 > 81,350 | 72,165 > 91,533 | +9.35% |

Refusal share of `blank-argument` candidates (refused / (claimed + refused)), after the review's narrowing (a `for` loop and a loop whose exit steps a record cursor no longer count): CDO 78 of 1,472 (5.3%), DO 120 of 2,554 (4.7%), DC 651 of 11,818 (5.5%), BC.History 9,214 of 110,102 (8.4%). Before it: DC 33%, BC.History 29%. The prototype refused about 12%. `condition-true` refuses about 5% on DC (round 1). These are safe-direction losses (R829).

**Round 3 (the skips made narrow, DC and BC.History only, at a43f50e9).** A `for` is skipped only if its body does not assign the control variable. A cursor loop is skipped only for exactly one plain `R.Next() = 0` (no argument, Record or RecordRef, alone or joined by `or`; a `while` only for `R.Next() <> 0`) with a body that does not restart or move the cursor. OFF: 0 added, 0 removed, 0 moved on both sets. `blank-argument` alone added 9,422 on DC and 94,749 on BC.History; both on added 25,433 and 214,521 (the sum of the two alone on both sets). Hang-refused: DC 3,220 > 5,616 (blank alone) and > 6,511 (both); BC.History 72,136 > 87,489 and 72,165 > 97,674. Refusal share of `blank-argument` candidates: DC 2,396 of 11,818 (20.3%), BC.History 15,353 of 110,102 (13.9%). The claimed set only went down against round 2 (DC 11,167 > 9,422, BC.History 100,888 > 94,749), so the round-2 compile checks still cover it.

No dedupe clash with both on: the sum equals the two alone on every set. R-862's prototype threw in `dedupeSpecs` here (`blank-argument` against `flip-boolean-literal`); `blank-argument` now returns at once for anything that is not an identifier or a field access, and `packages/runner/tests/r868-optin-operators.test.ts` goes red with the guard removed.

## Compile, with every mutant in

Real `alc` exit codes, both operators on (scratch worktree with the `optIn` flag off), against the R-862 symbol set. Control (the unmutated source) and instrumented build both exit 0, 0 errors, emit errors 0 (`/coord/handoff/R-868/real-compile.out`):

- DO/Cloud: 50,590 specs.
- DC/Cloud: 139,594 specs, on a scratch copy with the 28 missing JS resource files stubbed (as R-862; without them `alc` stops at AL0327 in both builds).
- Typed probe (`/coord/handoff/R-868/typed-probe`, R-862's, which holds every argument type and `#if` arm shapes): 215 specs.
- R402 `#if` sweep (`scripts/r402-shape-sweep.ts --repo <both-on worktree>`), all 54 shapes in every build: source compiles, the instrumented artifact compiles (208 `artifact=ok`, 0 `FAIL`). The 62 `PROBLEM` lines are all spec-count differences (`N specs, expected M`), which is the added opt-in sites against a table measured on master. Log: `/coord/handoff/R-868/r402-sweep.log`.
- `fixtures/sandbox-optin` and `-tests`: `bun run compile:fixtures` OK for both.

## Other expected changes

- No gate baseline moves: no gate names these operators, and a default run is byte-identical (the OFF dump shows 0 added, 0 removed, 0 moved on all five sets).
- `numberingDigest` changes on a run that names them (the CHANGELOG says so). No `IDENTITY_SCHEME` bump: add-only.
- `scripts/operator-tables.ts` prints per-tier default counts; the README says "plus 3 opt-in".
