# R-586 pre-commitment r5: leg X (d) only, a delta against r4 (dcdd1489)

Written 2026-10-21 by the builder, BEFORE leg X has run on any build. Everything in r4 stands except the two
places below: leg X (d)'s section, and X (d)'s row of "Notes and refusals, summary". A differing verdict, note,
hit count or index size in X (d) is a BLOCK.

## Why r4's X (d) was false (found offline, by generation, before any run)

r4 said "at least one such mutant exists (the shift-integer mutant of `600000`)". That is false.
`lethal.shift-integer` targets an integer literal only where it is a comparison operand or an assigned value; it
never targets a call argument (`packages/builtin-tier1/src/shift-integer.ts`, its doc comment). On r4's target
(`Sleep(600000); exit(X * 2);`) generation made exactly three mutants, and none of them keeps the Sleep while
leaving the result intact:
- `empty-block` removes both;
- `void-method-call` removes the Sleep;
- `return-value` changes the result.

So r4's `error` set was EMPTY, and the live control could never show the rule firing. r4's test-side index
size, 4, was also wrong. The scratch test dir also holds `ProbeHang.Codeunit.al`, whose `SleepHang` sleeps,
so the size is 5.

## The target, changed (committed on lethal/r586 in f44ae8c6)

`scripts/r586-probe/extras/ProbeSleeper.Codeunit.al`:
```
procedure WaitThenDouble(X: Integer): Integer
var
    Waited: Integer;
begin
    Sleep(600000);
    Waited := 1;
    exit(X * 2);
end;
```
The test is unchanged: `extras/ProbeSleep.Codeunit.al`, where `SleeperDoubles` asserts only
`WaitThenDouble(21) = 42`. The new target compiles offline with alc 18.0.43.1464 (the scratch copy of
probe-app without ProbePair, against the Microsoft apps of sandbox-tests' `.alpackages`), exit 0. No
warning was printed for the unused `Waited`.

## Leg X (d), r5

**Setup.** `runSession` through `AlRunnerV3Backend`, coverage al-runner, selector ids 50649 / 50648 / 50647,
`--only src/ProbeSleeper.Codeunit.al` and `--tests-only src/ProbeSleep.Codeunit.al`. The run uses scratch copies:
- of `probe-app`, with `extras/ProbeSleeper.Codeunit.al` added and `ProbePair.Codeunit.al` removed;
- of `probe-tests`, with `extras/ProbeSleep.Codeunit.al` added and `ProbeCoverage.Codeunit.al` removed.

The two removed files are the multi-object file and its test; the v3 coverage index refuses a multi-object file
(R602). That removal was ruled ACCEPTED.

**Generation** (`generateMutationSet`, then instrumentation by `runSession` with a stub backend, no v3 run):
five mutants, one batch.

| Code | Operator | Its arm | The arm runs `Sleep(600000)` | `SleeperDoubles` | Line of the arm's Sleep in the instrumented `ProbeSleeper.Codeunit.al` |
|---|---|---|---|---|---|
| M0001 | empty-block | `begin end` | no | fails (returns 0) | none |
| M0002 | void-method-call | removes `Sleep(600000)`, keeps `Waited := 1` and `exit(X * 2)` | no | passes | none |
| M0003 | remove-assignment | removes `Waited := 1` | yes | passes | 25 |
| M0004 | shift-integer | `Waited := 2` | yes | passes | 37 |
| M0005 | return-value | `exit(0)` | yes | fails | 31 |

**Index size.** The instrumented `ProbeSleeper.Codeunit.al` holds 4 Sleep call lines:
- 25 (M0003's arm);
- 31 (M0005's arm);
- 37 (M0004's arm);
- 43 (the unmutated `else` arm).

The test dir holds 5:
- `ShortSleep`, `LongSleepA`, `LongSleepB` and `LongSleepThenAssert` in `ProbeSleep.Codeunit.al`;
- `SleepHang` in `ProbeHang.Codeunit.al`.

Predicted index: **4 + 5**. Any other size is a miss.

**Baseline.**
- `ShortSleep`, `LongSleepA`, `LongSleepB` and `SleeperDoubles` are green.
- `LongSleepThenAssert` fails (Sleep does nothing) and goes to `unsupportedTests`.
- The rule does not touch baseline calls.
- The only covering test of every mutant is `SleeperDoubles` (per-test coverage).

**Verdicts, by the committed rule** (`error` = the arm runs a Sleep and `SleeperDoubles` passes; `killed` = the test
fails; `survived` = no Sleep hit and the test passes):

| Code | Verdict | Killing test | Cause | `failureNote` |
|---|---|---|---|---|
| M0001 | killed | SleeperDoubles | - | no `[v3-sleep-noop]` |
| M0002 | survived | - | - | none (no `[v3-sleep-noop]`) |
| M0003 | error | - | runner-refused | begins `[v3-sleep-noop] covered Sleep at <active>/ProbeSleeper.Codeunit.al:25` |
| M0004 | error | - | runner-refused | begins `[v3-sleep-noop] covered Sleep at <active>/ProbeSleeper.Codeunit.al:37` |
| M0005 | killed | SleeperDoubles | - | no `[v3-sleep-noop]` |

`<active>` is the backend's `active/` folder. The **exact `error` set is {M0003, M0004}**, non-empty.

**What the leg asserts, per mutant (orchestrator condition):**
- (a) For each `error` mutant (M0003 and M0004), the raw `--coverage-json` of its covering call shows
  `SleeperDoubles`'s per-test hit count on the arm's Sleep line (`ProbeSleeper.Codeunit.al:25` for M0003, `:37`
  for M0004) as **> 0**.
- (b) The refusal recorded for each `error` mutant is the Sleep rule's, by name: cause `runner-refused`, and
  `failureNote` beginning `[v3-sleep-noop] covered Sleep at` and naming that file and line. It is not another
  refusal or error.
- **The negative twin.** M0002's covering call shows `SleeperDoubles` with NO hit on any indexed Sleep line (0 or
  absent), its `SleeperDoubles` row passes, and M0002 reads `survived` with no `[v3-sleep-noop]` note. The only
  difference from M0003 and M0004 is the Sleep hit.
- M0001 and M0005 read `killed` by `SleeperDoubles`. They are reproduced (R577), and neither carries a
  `[v3-sleep-noop]` note.

Legs X (e) and (f) are unchanged from r4. Their target is the new Probe Sleeper. Each fails closed with 0 survived.
M0001 and M0005 stay killed in each, because their row fails before any coverage is read.

## Notes and refusals, summary: the X (d) row, r5

| Leg | Sleep index (target + test) | `v3-codeunit-state-possible` | `v3-refused-test-nearby` | §6 Sleep refusals | `runner-refused` / `runner-test-error` mutants |
|---|---|---|---|---|---|
| X (d) | 4 + 5 | not asserted | not asserted | exactly {M0003, M0004} | exactly {M0003, M0004} |
