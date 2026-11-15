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

## Addendum 1 (after the baseline re-runs, before any mutant re-run)
The baseline re-runs (`rerun/1`-`23`, all with baseline rows) settle only causes with a refused TEST. Classified (`classify.tsv`):
21 SAME, 1 RUNS, 2 not observed. The rest:
- **Out of scope, 1:** the #8154 Confirm key. PR-28 settled it; its note quotes PR-05's only as history.
- **No standing sighting, 2:** they stay open with a note.
- **Cascades, 2** (a test refused because an earlier one failed): read the same way, in the fresh baselines, with the cascade
  rows counted as test rows.
- **Seen only on mutant runs, 31** (a mutated run reached code no baseline test does): a baseline re-run cannot see them. For
  each, up to 3 files holding its most-sighted mutants are re-run on the current build with `triage-baseline.ts --only <file>`
  on the same app's copy, one run per app. Each sighted mutant is joined back by file, procedure, operator and line.
  - **fixed:** every re-run sighted mutant is now scored (killed, survived, no-coverage) and none shows the cause;
  - **open (SAME):** one still shows it;
  - **not observed:** the mutant is not generated now, or shows another refusal.
  The cap of 3 files per cause is a cost limit, stated per cause.

**Predictions (addendum 1):** of the 31 mutant-only causes, about a third fixed, half SAME, the rest not observed.

## Predictions
Of the 59 with a sighting: about a fifth fixed, three fifths still open (SAME), a fifth not observed. No cause becomes by-design
(none of the 61 is a policy text today).
