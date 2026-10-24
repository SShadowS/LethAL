# R-600 (roadmap R600): pre-commitment for the gates (2026-10-24)

Written BEFORE any live run of the R-600 head (`lethal/r600`), from `/coord/handoff/R-600/plan.md` (with its deep
review). Any difference is a BLOCK.

## What changes
- `planVerify` (`packages/runner/src/verify.ts`): when the source run's recorded digest parts carry the closed-world
  tag `none`, verify digests open-world and does not ask the closed-world guard. A recorded closed tag (`public`,
  `public+internal`) and a run with no recorded parts work as before. Any other tag throws.
- Only `lethal verify` reads this. `lethal run`, its verdicts and its recorded digests do not change.

## The gates: every per-mutant verdict unchanged
The legs come from `selectLegs` on the diff: `bcdev`, `lease`, `tables`, `chunked`, `alrunner-v3` (copied literally;
the final diff's output is quoted in the submit note). The gate table has no verify row and none of those legs runs
`runVerify`, so `itest:verify` (`LETHAL_ITEST_VERIFY=1 bun run itest:verify`) runs too, by name.
- Every gate passes, with every per-mutant verdict and killing test unchanged against its committed baseline (scheme
  42), and every gate-page figure unchanged.
- `itest:verify`'s figures are unchanged: within one run the source run and verify ask the same server, so their
  closed-world answers agree, and the fix moves no comparison there.
- No scheme-change line.
- `itest:alrunner-v3` runs all 12 legs, with `LETHAL_ITEST_V3_CDO` and `LETHAL_ITEST_V3_TABLES` set.
- BC legs run on servers proven for them (docs/gates/servers.md), one gate per server, each under a lease. Parallel
  gates run in separate worktrees.
