# R-635 pre-commitment, addendum 1: the coverage file the v3 binary leaves in the worktree

Committed by lethal-code on 2026-10-22, after leg E0-S and before any later leg. It amends
`2026-10-22-r635-entries-precommitment.md` (fcdf21ca). Everything else stands.

## What happened
- E0-S ran and PASSED: 3 / 12 / 4 over 19, 0 differences from `bcdev.baseline.json`. Evidence:
  `/coord/handoff/R-635/live/results.md`.
- The next leg's clean-tree check then failed. An untracked `coverage.cobertura.xml` sat in the worktree root, and its
  mtime falls inside the E0-S run. The al-runner v3 binary writes that file into its working directory.
- The run stopped, as pre-committed. Nothing else changed: the tracked tree is still 7a8f63b3.
- This is a product defect too: a user's working directory would get the same stray file. It is filed separately as a
  roadmap item and is not fixed in R-635.
- **Also recorded:** the gitignored `fixtures/*/.alpackages` were missing from the r635 worktree (the first E0-S
  attempt ended in INFRA-FAIL with no measurement). They were copied from the lane-code worktree; the
  `sandbox-tests` copies match by sha256.

## The amendment
- **After each leg,** if `coverage.cobertura.xml` exists in the worktree root and is untracked, it is MOVED to
  `/coord/handoff/R-635/live/artifacts/<leg>.coverage.cobertura.xml` before the next leg's clean-tree check. That is
  the ONLY file treated this way.
- **Any other untracked or modified file** is still a STOP.
- **E0-S stands as run.** Its leaked file is moved under the same rule, to `E0-S.coverage.cobertura.xml`.
- The remaining legs run in the original order: E1, E0-T, E2, E0-D, E3a, E3b.
