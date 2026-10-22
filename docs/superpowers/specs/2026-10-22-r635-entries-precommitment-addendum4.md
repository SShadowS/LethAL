# R-635 pre-commitment, addendum 4: gates on the final merged head

Committed by lethal-code on 2026-10-22, before any run below. It amends the R-635 pre-commitment (fcdf21ca) and
addenda 1–3. Everything not restated stands.

## Why
- **Run 3** (addendum 3, 61d5b29d; `/coord/handoff/R-635/live/run3/results.md`) passed on 5159e50e:
  - all seven v3 legs, with 0 per-mutant differences against the controls and the baselines;
  - E3a and E3b at 1 daemon each;
  - itest:alrunner (v2).
- **The final head is lethal/r635 at 9c78ca0c.** Merging master brought R-644 and R-648's source changes to
  `orchestrator.ts` (R644's faced-tests lend candidates inside `runSession`), `selection.ts` and `store.ts`. These sit on
  every gate's path.
- **R-635 itself also changed `orchestrator.ts`:** the `baselinePhase` bracket and `prefetchMutants`. No BC gate has run
  on R-635's code yet. On bcdev both hooks are optional no-ops.

## The amendment: everything on 9c78ca0c
All of the following run on lethal/r635 at **9c78ca0c**. Each run checks HEAD, a clean tree, and the edge binary's sha
where it applies.
- **A. The seven v3 legs** (E0-S, E1, E0-T, E2, E0-D, E3a, E3b), with the pre-committed figures of addenda 2 and 3
  unchanged: 0 per-mutant differences against control and baseline, E3a and E3b at 1 daemon, prefetch drops 0, and
  E0-T's 7 pre-named errors. Outputs go to `/coord/handoff/R-635/live/run4/`.
  - The wall times are recorded but are NOT the headline (run 3's is). B runs at the same time and adds noise.
- **B. `LETHAL_ITEST_ALRUNNER=1 bun run itest:alrunner -- --parallel=3`:** PASS, every leg equal to its frozen baselines.
- **C. `itest:bcdev`** on a free bc server: per mutant equal to `bcdev.baseline.json` (3 / 12 / 4), with the pinned extras
  of `docs/gates/bcdev.md`.
- **D. `itest:tables`** on a second free bc server: per mutant equal to `tables.baseline.json`, with exactly one expected
  baseline failure, `Data Tests.PageActionComputesNonZero`, by name.
- **Concurrency:** A and B are local heavy jobs (the limit is 3). C and D are BC gates, one per server, each under a coord
  lease taken only when its slot is free and released at once.
- **Any difference is a BLOCK** for the run where it shows, recorded per mutant and never re-recorded.
