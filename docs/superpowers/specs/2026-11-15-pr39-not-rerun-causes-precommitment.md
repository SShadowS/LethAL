# PR-39 pre-commitment: the 61 open ledger causes PR-05 could not re-run (2026-11-15)

Written before any re-run for this task.

## Scope
The refusal ledger's open entries whose note says "not re-run on edge-a184cfc79 (its projects are outside the PR-05 re-run:
sources cleaned or not a BC.History sweep project)": 61 causes.
- **Sightings** (`/coord/handoff/PR-39/where.ts`, R1036's reader over every store): 59 have a standing sighting, in 48
  projects; 2 have none. Those two stay open with a note.
- **Run plan** (`plan.py` → `plan.tsv`): 23 runs reach all 59, by greedy cover.
  - Cleaned projects map to R-986's recreated copies of the same BC.History apps: Bank Deposits, Service Declaration, E-Document
    Core, Subscription Billing, Image, PDF.
  - R-915's Quality Management and Shopify, cleaned and never recreated, are rebuilt the way R-986's `fixsrc.py` did it. Quality
    Management's test library is built the R-982 way against R-975's pool-union, and is cached (`corpus-build-cache.ts`).

## Method (PR-05's, unchanged)
- A fresh baseline of each planned project on the current build (edge-5a58a0f16), with `scripts/triage-baseline.ts` under the
  heavy slot.
- Per cause, its previously refused tests (from every older store of the same app) are read again in the fresh baseline:
  - RUNS (pass or fail: the refusal is gone for that test);
  - SAME (still that cause);
  - OTHER (another refusal);
  - ABSENT (not in the fresh baseline).
- **States, PR-05's rules:**
  - **fixed:** the cause's refused tests run and none still shows it. It names the projects whose tests it frees, for a later
    re-score.
  - **by-design:** only where al-runner's own text says "refused by policy", cited.
  - **open:** everything else, with its issue. "not observed" (OTHER or ABSENT only) is a note on an open cause, never "fixed".
- The ledger is updated with a script that changes only these 61 entries; the round trip is otherwise byte-identical.

## Predictions
Of the 59 with a sighting: about a fifth fixed, three fifths still open (SAME), a fifth not observed. No cause becomes by-design
(none of the 61 is a policy text today).
