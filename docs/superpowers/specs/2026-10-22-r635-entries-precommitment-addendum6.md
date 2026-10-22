# R-635 pre-commitment, addendum 6: the merged head after R-646b

Committed by lethal-code on 2026-10-22, before any run it names. It amends addenda 4 and 5. Everything not restated
stands.

## Why
- **R-646b merged on master (c8c6e47d)** after R-635's final head (c913385a). It changes `orchestrator.ts`'s
  lend-replay path (+54) and `resume.ts` (+4).
- **R-635 also changed `orchestrator.ts`** (the `baselinePhase` bracket and `prefetchMutants`).
- The orchestrator ruled to apply the final-head rule strictly.

## The amendment
- **The code under test is lethal/r635 after merging c8c6e47d.** The merge is f50a2127, with no conflict; the
  checkpoint commit on top of it is the head every run below checks.
  - verify: FULL PASS, 9956 / 0.
- **On that head, each run must be UNCHANGED** against the figures already pre-committed for it:
  - **`itest:bcdev`** on a free bc server: per mutant equal to `bcdev.baseline.json` (3 / 12 / 4), with the pinned
    extras of `docs/gates/bcdev.md`.
  - **`itest:lend`** on a free bc server: PASS against its own frozen expectations (`docs/gates/lend.md`).
  - **v3 leg E1** (sandbox-app, entries): 0 per-mutant differences against its edge one-shot control (E0-S's report
    from run 5) and `bcdev.baseline.json`, 1 daemon, prefetch drops 0, echo mismatches 0.
  - **v3 leg E3a** (CDO, entries, secondEcho on): 0 per-mutant differences against its edge one-shot control (E0-D's
    report from run 5) and bc3-A, 1 daemon, prefetch drops 0, echo and second-echo mismatches 0.
- **Concurrency:** one gate per server, under leases taken only when a slot is free and released at once. E1 and E3a
  are local heavy jobs (the limit is 3).
- **Any difference is a BLOCK,** recorded per mutant and never re-recorded.
- **What stands without re-running, per the orchestrator's ruling:** `itest:tables`, `itest:alrunner` and the other v3
  legs.
