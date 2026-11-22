# PR-341 part 3 pre-commitment (R1179): a resumed run seeds R197's kill ledger from its carried kills

Status: pre-commitment (coord PR-341 part 3, lethal-preproc, 2026-11-22), on its own branch, before the build. Ruling
(orchestrator): seed the ledger from the carried kills; a resumed run must score like a fresh one, pinned by a fresh-against-
resumed per-mutant test. Names and numbers only.

## The gap (R1179, read in the code)
- `recordKill` (`test-order.ts`) is called only at the three live kill sites in `orchestrator.ts`.
- The session's ledger starts from `newKillLedger()`.
- A mutant carried on `--resume` never feeds it. So, for a procedure whose earlier mutants were carried, the remaining
  mutants' covering tests are read in a different order than a fresh run would use (R197's kills-first key is missing). That
  can move `killingTest`, and PR-144's recheck eligibility (R1178).

## The ledger
`killsByProcedure`: a COUNT per (procedure scope, test key `codeunitId::method`). Order does not matter, only the counts at
the moment a mutant is walked.

## The change
- When a mutant is carried with verdict `killed` or `timeout-killed`, call `recordKill(ledger, mutant, killerRef)` before
  any remaining mutant is walked. That covers the carried mutants of every batch, since carried rows are recorded at the
  batch's start.
- **`killerRef`:** the session's own discovered `TestMethodRef` whose qualified name is the one covering test of the carried
  row whose method is `killingTest`.
  - If none, or more than one, matches, there is no seed. That is today's behaviour; it fails closed, and it is counted.
- **No new field.** A count of seeded kills is shown in the resume line (`resume-reusing-run` or the existing resume
  notice) only when it is above 0.

## Why it equals a fresh run, and when it does not
- **On one lane,** the carried mutants are exactly the fresh run's earlier-scored mutants, so after seeding, the ledger at
  the first remaining mutant equals the fresh run's.
- **With several lanes,** a fresh run's order across lanes is not deterministic either. Seeding is the closest state, not an
  identity; this is a named limit.

## Tests (red before the build)
1. **Fresh against resumed, one lane, per mutant.** A fixture where a procedure has three mutants and the killing test of
   the third depends on the ledger:
   - (a) fresh;
   - (b) stopped after the second mutant, then `--resume`.
   - The per-mutant tables are equal: verdict and `killingTest`.
   - Red today: (b)'s third mutant has another `killingTest`.
2. A carried kill whose killer method is ambiguous across two codeunits: no seed, counted, and nothing thrown.
3. A carried `survived` or `error` seeds nothing.
4. Flag-independent; it runs on al-runner-v3 and bcdev alike (the ledger is the orchestrator's).

## Predictions
- **Gates:** `itest:lend`'s resume legs (R1, R2, RP, RL, R3) are the only gate legs that resume. They may show a
  `killingTest` move on a fixture with ledger-sensitive procedures.
  - Before any gate, an amendment records a scan of lend's frozen baselines for resumed mutants whose `killingTest` depends
    on the ledger, with the prediction per leg.
  - Any other gate is untouched (no resume).
- **No verdict moves** (the ledger orders the walk; it never makes a pass fail).
