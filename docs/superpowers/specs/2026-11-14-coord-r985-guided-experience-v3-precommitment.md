# Coord R-985 pre-commitment: Guided Experience on al-runner edge-847b1fa5a, now that #7853 is fixed

Committed before any run, 2026-11-14. Coord task R-985 (not roadmap item R985). Evidence goes to `/coord/handoff/R-985/`. Names and
counts only; no BC.History source text.

## What runs

Guided Experience (System Application) and its test app, from R-932's source copies (`/coord/handoff/R-932/src/guided`,
`guided-test`), selector ids as R-932 picked them. Its package pool was cleared; it is rebuilt as R-982 did: R-975's `pool-union` plus
System Permissions and Guided Experience Test Library, alc-built from BC.History source and cached
(`bch-r985-guided-libs@d9fad4a0933b+25661207`). Config `/coord/handoff/R-985/v3.guided.json` pins
`/work/tools/al-runner-v3/edge-847b1fa5a-847b1fa5a/al-runner`, environment `onprem`. One full `lethal run` (baseline and every
mutant) from a worktree at current master, `--time-budget 7200`, under `heavy-slot.sh --wait --peak serve baseapp`.

## What was measured before (R-932, edge-42af5d384)

Every one of the 2,593 mutants was `error`: the app did not compile on al-runner (AL0161, upstream #7853), so no baseline test ran.

## Predictions

1. **The app and its tests compile** on edge-847b1fa5a (#7853 is fixed; R-981 saw the module compile there with the library from
   source). The baseline lists the test app's tests: 104 in R-932's run and in R-981's one-shot run.
2. **The baseline is not refused wholesale.** R-981's one-shot run refused 102 of 104 for "outside the workspace" because its packages
   had no source; with source-built packages (the pool above) that refusal does not appear. Refused baseline tests, if any, name causes
   already filed upstream (#7854, #7934, #7819 families: permission denials, DotNet by policy, unanswered HTTP).
3. **The `error` count falls from 2,593 to under 260** (under 10% of the mutants), and every remaining `error` mutant's cause is one
   already filed upstream. Any cause that is not filed is a miss of this prediction: it gets an invented repro, an upstream issue and a
   roadmap item.
4. No prediction on killed, survived or no-coverage counts.

The report names the build it used; a run that does not finish in the budget reports the mutants it reached and says so.
