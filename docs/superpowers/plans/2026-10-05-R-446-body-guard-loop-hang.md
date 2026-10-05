# R-446 plan: refuse writes that a body-exit guard reads, when the loop condition reads no name and calls nothing

Evidence: `/coord/handoff/R-446/survey.md`. Base: master `477b23bc`, worktree `/work/lethal-wt/r446`.
The main text below was rewritten by the builder to match the "Changes since" sections (r3).

## The rule (a scoped heuristic, not "never emit a hang-capable mutant")
A "hang refusal" stops the four value operators (`remove-assignment`, `shift-integer`,
`swap-additive`, `flip-boolean-literal`) from emitting a mutant that can make a loop run forever.
Today it reads only the loop's CONDITION. Extend it:
1. When a loop's condition reads no name and calls nothing (`while true`, `until false`; `#if` tails
   included, inactive arms skipped; `conditionIsNameAndCallFree`), the guards of its body exits
   count as part of its exit test.
   - Exits: `exit`; `Error(...)` outside `asserterror`; `CurrReport.Quit`/`Break` (and the
     `CurrXMLport` twins), with or without `()`; `break` only if its nearest enclosing
     `while`/`repeat`/`for`/`foreach` is this loop.
   - Guards: every condition between the exit and the loop: `if` (then OR else branch), `case`
     selector and branch pattern, inner loop condition, `for` bounds, `foreach` iterable, plus tails.
2. Refuse a write to a variable ANY guard reads (sol r1 s1: an "all guards" or "only update" rule
   would need value reasoning and is unsound).
3. Loops whose own condition reads a name are untouched (R446's 433-site over-count is excluded).
4. Exclusions, filed as one measure-first item (R480), each pinned as NOT refused by a witness test:
   a body-exit flag under a condition that reads a name; an indirect guard; a call-based condition;
   an outer `for`/`foreach`; `asserterror` as the only exit; `CurrReport.Skip` (its docs say only
   that report processing continues with the next record, not that the AL loop is interrupted). Not
   counted either: an `exit` in a callee, `Commit()`, `Codeunit.Run` returning false.

## Code (one file, plus the scheme)
- `packages/builtin-tier1/src/loop-hazard.ts`: `loopExitParts`, `conditionIsNameAndCallFree`,
  `exitsLoop`, `bodyExitGuards`. `loopExitParts` is used in `conditionIdentifiers`,
  `conditionReadsMember`, `loopConditionReadsByName`. `shift-integer` keeps `loopConditionParts`
  for its own literal refusal. The header names the exclusions.
- Refusals flow through the existing `refusesHangCapable`, so they are counted as hang-refused (R447).
- `IDENTITY_SCHEME` 21 -> 23 (R-464 holds 22) in `packages/schemata/src/project.ts`. Landed as 25:
  the merge of R475 (scheme 24) renumbered it, and 23 is unused.

## Measured diff (all operators, identity-keyed, complete dumps; re-measured on the build)
- fixtures 17 (incl. `sandbox-hang`), examples 4, CDO 6 projects: identical.
- BC.History: 74 specs move from emitted to hang-refused (remove-assignment 55, flip 11, shift 6,
  swap-additive 2), all in BaseApp Source (70) and Tests-Misc (4). No spec changes, none appears.
  The report exits and the `asserterror` rule leave the count where the prototype had it.
- 16 identity keys move (flip 11, shift 3, remove-assignment 1, swap-additive 1), all in
  `ItemJnlPostLine.Codeunit.al`.
- Real hangs among them: 4 established (`OptionValue += 1` x2, `OptionNo += 1`,
  `Expected := Expected.NextSibling`); 70 are over-refusals or data-dependent, accepted as R454 did.

## Gates
`itest:hang`: `sandbox-hang` has no constant-condition loop and its dump is identical, so no pinned
figure moves; no pre-commitment. No other fixture changes, so no other gate can move. Run
`bun scripts/verify.ts` (typecheck, clean dist, unit suite).

## Tests (in `loop-exit-refusal.test.ts`, positional, each with a same-loop control)
Each must go red under its named revert:
1. Refused: `while true` + `if I > 3 then exit` refuses `I += 1` for remove-assignment and
   shift-integer, `Other += 1` claimed. Also `Done := true` (flip, remove), `repeat ... break ...
   until false` (swap-additive `I := I + 1`), an `Error` guard, a `case` guard, an `else exit`.
   Revert: `loopExitParts` returns `loopConditionParts(loop)` only.
2. Not over-refused: `while I < 10 do begin I += 1; J += 1; if J > 3 then exit; end` claims
   `J += 1`. Revert: drop the `conditionIsNameAndCallFree` check (always add guards).
3. Inner break: outer `while true` (exit guard on `I`) holding `repeat ... if K > 2 then break;
   until false`, with `K := 0` written in the OUTER body: that write is claimed, `I += 1` refused.
   Revert: `exitsLoop` accepts any `break`.
4. `Error` exit alone: revert by dropping the `Error` branch of `exitsLoop`.
5. Counted: `refuses-hang-capable.test.ts`, the body-guard write returns `refusesHangCapable`
   true for all four operators. Revert: as test 1.

## Roadmap
Mark R446 `done (<commit>)` with the figures above, and regenerate `ROADMAP.md`. File ONE new item (see below).

## Changes since r1 (sol r1, /coord/reviews/R-446-plan/sol-plan-r1.md)
- s1: KEEP `ANY`. The 70 non-certain refusals are accepted. R196/R454 refuse on relevance, not on proven hangs, and an
  "only update" narrowing is unsound (sol's `if I = 0 then I := 1` counterexample).
- s2 (HIGH): count the report exits too: `CurrReport.Quit()` and `CurrReport.Break()` (qualified built-ins, distinct
  from AL `break`), plus `CurrReport.Skip()` if it ends the current trigger iteration (check the AL docs). Then
  re-measure; the BC.History count may grow. Explicitly NOT counted:
  - an `exit` inside a callee, since it exits that procedure, not the caller's loop;
  - `Commit()`;
  - `Codeunit.Run` returning false (an explicit `exit` is already covered);
  - an `Error` inside `asserterror`, which is not treated as an exit.
- s3: this is a SCOPED heuristic, not "never emit a hang-capable mutant". The plan, R446's closing text and the code
  comment say so, and name the exclusions:
  - a body-exit flag separate from a non-constant loop condition (`while Continue` with `if Done then exit`);
  - indirect guards (`I += 1; Done := I >= 3; if Done then exit`, where removing `I += 1` hangs);
  - call-based conditions;
  - outer `for`/`foreach` with modified bounds or iterables.
  These go into ONE new roadmap item (measure-first), replacing "file nothing new". Rename `conditionCannotEnd` to a
  truthful name, e.g. `conditionIsConstantOrNameFree`.
- s4: scheme 23, coordinated with the orchestrator; update `project.ts`'s scheme comment (it still says R464 holds 20,
  but 22 is right) and the pins.
- s5: tests added, each red-checked with its revert named:
  - ANY versus ALL (two exits reading different variables);
  - an independent revert for each of the three readers (resolved member, name fallback, the third);
  - inner-loop, `for` and `foreach` guards, and active/inactive condition tails;
  - the report exits;
  - one test pinning a documented exclusion as NOT refused.
  Counted tests assert `targets=false`, `generate=[]`, the refusal count, and sibling emission. All offline, outside
  scored gates.

## Changes since r2 (sol r2, /coord/reviews/R-446-plan/sol-plan-r2.md)
- s2-1 (HIGH): an `asserterror` statement can be the loop's ONLY exit. When NO error occurs, the assertion fails and
  ends execution, so deleting the write that makes the error happen hangs (sol's `asserterror if not Done then Error`
  shape). This shape goes to the EXCLUSIONS, filed in the same new measure-first item, with an offline witness test
  pinning it as not refused today. It is not handled in R-446.
- s2-2: `CurrReport.Skip()` counts only if it interrupts the AL loop itself, not just report-record processing. If
  the docs cannot settle that, leave it out and list it in the exclusions.
- s2-3: these "Changes since" sections OVERRIDE the main text above: the rename (no `conditionCannotEnd`), no "cannot
  terminate" claim, and the 74/16 figures. The builder rewrites the main text to match, re-measures after the
  report-exit additions, and freezes the revised exact set (sites and keys) before closing.
