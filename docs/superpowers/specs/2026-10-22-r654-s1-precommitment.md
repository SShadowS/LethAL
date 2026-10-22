# R-654 S1 (roadmap R654): pre-commitment for the move-only stage (2026-10-22)

Written BEFORE the S1 build and before any live run, from the adopted plan
(`docs/superpowers/plans/2026-10-22-r654-retire-dotnet-alrunner.md`, r0 to r2). Any difference is a BLOCK, recorded
and not reinterpreted.

## What S1 changes
- **Moves.** What v3 imports from the v2 modules moves to neutral or v3 modules: the row verdict and its regexes,
  the serve rule, server spawn, the resource selector, `baseAppJson` and the coverage-index pieces.
- **The wrapped-file rule** (`WrappedRule`, `wrappedRuleFor`) is keyed separately from the backend kind, and maps
  exactly to today's behaviour. `carryBarredFiles` is extracted from `runSession`, move-only.
- **Tests.** The v3 tests are split out of the v2 test files, and a new import guard is added.
- **No behaviour change.** `CoverageMode "al-runner"` is kept. Nothing is deleted from v2 in S1.

## Every gate unchanged, per mutant, against its committed baseline

**itest:alrunner (v2, all 23 legs):**

| leg | expected |
|---|---|
| base | 3 / 12 / 4 over 19 |
| cli-default | 3 / 12 / 4; 23 activations, 22 suite runs |
| layout | 7 / 3 |
| multiobject | 6 / 1 / 5 |
| wrapped | 58 / 37 / 3 |
| names | 36 |
| LETHALA | 5 / 4 |
| LETHALB | 5 / 4 |

It also keeps 2 killer rows per kill, groupedCalls 0 and warmKills 0.

**itest:alrunner-v3:**

| leg | expected |
|---|---|
| C | 26 facts (9 defect, 16 contract, 1 warn) |
| S1 | 3 / 12 / 4, equal to bcdev |
| S3 | refused by name |
| N1 | 36 |
| X | as pre-committed |
| D1 | 51 / 12 / 0 over 63 |
| D1c | 51 / 8 / 4 over 63 |
| T | 290 / 57 / 59 over 406 |

**Every leg that agentflow's `selectLegs` picks for the S1 diff** (`git diff --name-only` against master, in
`LEG_ORDER`) passes, unchanged against its committed baseline:
- itest:bcdev: 3 / 12 / 4, groupedCalls 15, probes PASS;
- the lease, stale-publish, tables, chunked and hang legs: their frozen figures, if selected.

**coverage-differential** (selected by the `line-map.ts` row): sandbox-app run twice, identical except the coverage
mode. The two runs are equal per mutant, with the same verdicts as today.

## How the run is judged
- BC gates run on bc1 and bc3 only (bc2 is off-limits), one gate per server, each leased only when a slot is free.
- The al-runner gates run under the container's heavy-job limit.
- Each gate's first line names its target and build, and is read before any figure.
- Any moved figure, any differing verdict, or any new mechanism failure is a BLOCK.
