# R-631 live gate: pre-commitment

Committed by lethal-code on 2026-10-22, before any live gate ran on `lethal/r631` (build 0908a3d2, status commit
b79e8547).

## The change
Every recursive directory walk in product code now goes through one walker (`packages/runner/src/walk.ts`). The
walker never descends into a symlinked directory. Target and test roots REFUSE a link by name before any compile.
Real files under `node_modules` and `.git` are walked as before. Only links there are excused.

## Prediction
`itest:bcdev` on a bc server gives the SAME verdict for every mutant as `bcdev.baseline.json`, with the pinned
extras on `docs/gates/bcdev.md`. The project-scan path is the one this change touches. No fixture under `fixtures/`
contains a symlink (inventory, `/coord/handoff/R-631/inventory.md`), so the walker yields the same files and nothing
refuses.

## Stop rules
- **A differing verdict** is a BLOCK, recorded per mutant.
- **A `project-symlink-skipped` warning or a symlink refusal on this fixture** is a STOP. It contradicts the
  inventory, and is reported before anything else.
- The gate's first line (`[itest target]`) is recorded with its log.
