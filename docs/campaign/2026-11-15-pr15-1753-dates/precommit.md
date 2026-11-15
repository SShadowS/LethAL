# PR-15: the #8006 wrong-verdict class (1753 dates) in BC.History — pre-commitment

Written before any measured run. Coord task PR-15. Evidence: `/coord/handoff/PR-15/`.

## What #8006 was
BC 28.4 refuses to write every non-zero date in 1753, as a Date or a DateTime, by Insert and by Modify ("Cannot write the value
..."; measured on `bc2`, R985). al-runner builds before edge-5a58a0f16 stored most of those values. So a test that wrote one passed
on al-runner where BC fails it, and a mutant verdict that rested on such a test could be wrong. edge-5a58a0f16 fixed this: the
regression entry `u8006-date-1753` now gives BC's answer.

## Step 1, done: the sites, by parse
`sites.ts` parses every `.al` file of the 83 projects in R-975's `projects.tsv` plus Guided Experience: 84 projects, 3,697
files, app and test sides. It looks for a Date or DateTime literal in 1753, `DMY2Date(.., .., 1753)`, and a string literal
holding a 1753 date (an `Evaluate` source).
- **It found none.** Its only two hits are object ids (codeunit 1753 and page 1753 in Data Classification), not dates.
- **The R985 stand-ins.** The shipped stand-ins are `17530101D` (operator major 1, until 2026-11-14) and then `17540102D`. The
  interim `17530103D` reached master only in the same merge as `17540102D` (44787b74). On the pre-fix builds, al-runner did not
  store `17530101D`: a Date `Insert` failed with BC's text, a Date `Modify` was refused, and the DateTime was refused (R-971's
  probe, `p/v3.txt`). So the stand-ins gave no wrong verdict of this class. Current runs use `17540102D`, which BC stores.

What parsing cannot see: a 1753 value **computed** at run time, for example date arithmetic or `CalcDate` on a blank date.
Only a run shows those.

## Step 2: re-run every baseline on 5a58a0f16 and compare per test
For each of the 82 R-975 sweep projects:
- **Run** `scripts/triage-baseline.ts` (the whole baseline) with its config pinned to
  `/work/tools/al-runner-v3/edge-5a58a0f16-5a58a0f16` (`plan.py`, `cfg/`).
- **Compare** each test with the latest pre-fix baseline: PR-05's a184cfc79 triage (40 projects), else the R-975 sweep store on
  736fc7677 (42).
- **The class** is a test that passed in the reference and fails or errors now with BC's "Cannot write the value" text naming a
  1753 date. Any other test that moves is reported with its message, as another cause, and not counted.

Guided Experience is not re-run: PR-10 measured it on 5a58a0f16 today, and none of its failures carries that text.

## Predictions
1. **No test of the class**, in any of the 82 projects. So no mutant is re-scored, and nothing goes upstream.
2. Tests move for other reasons between the reference builds and 5a58a0f16 (the #7586, #8036, #8038 and #7760 flips free some
   tests). All of these are attributed by message and are not the class.

If a test of the class appears, prediction 1 is missed. Then its project's mutants in the files that test covers are re-scored by
PR-06's method (restricted run, compare by identity key). The allowed moves are survived or no-coverage to killed, and any other
move is a BLOCK that must be explained. Any wrong result that is not LethAL's goes upstream.
