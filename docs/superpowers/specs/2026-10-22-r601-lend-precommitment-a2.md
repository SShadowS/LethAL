# R-601 live pre-commitment, addendum 2: re-run on the head with R-631

This addendum amends `2026-10-22-r601-lend-precommitment.md` (13b45f39) and addendum 1 (2e86728b). Lane bugs
committed it to master before the re-run.

## Why there is a re-run

Run 1 used head d06d7553 and passed. Every leg matched its prediction, and all six live red checks went red at the
leg named for them. The logs are in `/coord/handoff/R-601/live/`, and they stay as run 1's record.

After run 1, master gained R-631 (e805bc5c), which is PRODUCT code on every run's path:
- the new `walk.ts`;
- `orchestrator.ts`, `report.ts`, `source-drift.ts`, `line-map.ts`, `testpage-scan.ts` and `verify.ts`.

R-601 merged master before its submit, so the gates run again on the head that will be submitted.

## The head under test

- **Head:** `lethal/r601` at **f1d0b2ad**. It is a merge of origin/master (e805bc5c) into a9e8b3c2.
  - The only conflict was the generated `ROADMAP.md`, which was regenerated.
  - verify gives 9589 pass / 8 skip / 0 fail.
- **Later commits:** any commit after this one may change only docs or roadmap files.

## What runs

Both gates run on bc1, under one lane-bugs lease, and both keep their full predictions from the base file:
1. `itest:lend` (all legs, including RN1d and RP);
2. `itest:bcdev`.

Logs go to `/coord/handoff/R-601/live/run2/`.

**The six live red checks are NOT repeated.** Each one proves that a guard is sensitive to its R-601 break. R-631
does not touch any of those guards:
- `resumableTestApp`;
- `assertSameTestApp`;
- the R496 recheck;
- the re-ask.

`git diff a9e8b3c2 f1d0b2ad` on `closed-world.ts` and on those functions is empty apart from the merge itself. The
re-run must confirm this: if any red-check guard shows a change in that diff, the red checks are re-run as well.

## Stop rule

The base file's stop rule applies unchanged. Any difference from a prediction is a BLOCK.
