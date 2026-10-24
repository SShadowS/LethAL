# R-308 (roadmap R308): pre-commitment for the gates (2026-10-23)

Written BEFORE any live run of the R-308 head (`lethal/r308`), from `/coord/handoff/R-308/measure.md`. Any difference
is a BLOCK.

## What changes
- `describeObjectKinds` (`packages/schemata/src/compile-plan.ts`) replaces a `preproc_conditional_object` child with
  `objectDeclarationsOf(child)`. So an object inside `#if` is named in the free-text `kinds` string of report rows.
- `kinds` is display-only: nothing parses it. No schema field, count, verdict or mutant changes.

## The gates: every per-mutant verdict unchanged
The legs come from `selectLegs` on the diff:
`{"legs":["bcdev","tables","chunked","alrunner-v3","hang"],"park":[],"unmatched":[]}`. They are copied literally.
- Every gate passes, with every per-mutant verdict and killing test unchanged against its committed baseline (all at
  scheme 42 since R-690), and every gate-page figure unchanged.
- No scheme-change line, because the baselines already record 42.
- `itest:alrunner-v3` runs all 12 legs, with `LETHAL_ITEST_V3_CDO` and `LETHAL_ITEST_V3_TABLES` set.
- BC legs run on a server proven for them (hang on bc3), one gate per server, each under a lease. Parallel gates run
  in separate worktrees.
