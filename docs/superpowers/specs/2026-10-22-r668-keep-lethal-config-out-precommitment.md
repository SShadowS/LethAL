# R-668 pre-commitment: lethal.config files never become batch resources (nothing run yet)

Source: the adopted plan, `docs/superpowers/plans/2026-10-22-r668-keep-lethal-config-out-of-batches.md` (r2). The
plan review is `/coord/reviews/R-668-plan/adversary-r1.md`, and the build review is
`/coord/reviews/R-668-build/review-r1.md` (APPROVE, with the inode-0 guard and the note fix closed in 0dcc8338).
Committed to master by lethal-code before any live run.

## 0. Under test

- **Code:** `lethal/r668` at **268f7fe5**: the build, the follow-ups, and master merged in. If master moves
  before the runs, an addendum names the final head, and every leg checks that sha.
- **The claim:** nothing moves in any gate. No fixture or example has `resourceFolders`, so alc packs the same
  files, every per-mutant verdict is unchanged, and the new warning (`lethal-config-resource`) never fires.

## 1. Gates, in order (each on the final head)

1. **`bun scripts/r668-batch-app-check.ts`** (offline alc, invented dummy project). Two things must hold:
   - the batch `.app` holds no `lethal.config*` entry, and the dummy marker is absent;
   - the control (the user's own build) DOES pack both dummy configs.
2. **The v3 legs** E0-S, E1, E0-T, E2, E0-D, E3a and E3b, through `/coord/handoff/R-653/live/chain.sh` with
   `FULL=1`, `W=/work/lethal-wt/r668`, `Q=/coord/handoff/R-653/live/final` and `OUT=/coord/handoff/R-668/live`.
   - Pass: every `report-diff` against R-653's final reports is IDENTICAL (0 differences), and every leg ends as it
     did there: PASS, or HELD on exactly the 7 pre-named T rows.
   - The chain ends with **V2**, `itest:alrunner --parallel=3`, which must PASS against its frozen baselines.
3. **`itest:bcdev` on bc1** (`LETHAL_ITEST_BCDEV=1 LETHAL_ITEST_CONFIG=lethal.config.bc1.json`), under a coord
   lease taken only when bc1 is free and released at once.
   - Its first line must name bc1.
   - Pass: per-mutant equality with its committed baseline (`docs/gates/bcdev.md`), with no
     `lethal-config-resource` warning in its output.

## 2. STOP rules

- Any per-mutant difference in any gate.
- Any `lethal-config-resource` warning in any gate. No fixture has `resourceFolders`, so a warning would mean
  the rule matched something it should not.
- The alc check failing either half.
- A wrong head, a dirty tree, or a server other than bc1 for the bcdev gate.
- A leg that ends by a signal or a timeout is recorded as such, never stopped by hand.

## 3. Heavy jobs

The v3 legs run one at a time, each waiting until no other itest is running. V2 runs last. bcdev on bc1 does not
count toward the container's heavy limit, and it runs when bc1 is free.
