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

## Amendment 1 (2026-11-22, the build and the lend scan, before any gate)
- **Build:** `lethal/pr-341-part3` ba4c4a327.
  - `carriedKillerRef(carried, tests)`: the one covering test whose method is `killingTest`, then the one session test with
    that qualified name, by `testKeyOf`. Otherwise `undefined`, never a throw.
  - After each carried `killed` or `timeout-killed` is recorded, `recordKill` runs on the session's one ledger (the
    `BatchScope` `killLedger`), before any remaining mutant is walked.
- **The count's line (a departure):** not a second `resume-reusing-run` line. `itest:lend`'s `assertCodes` compares the exact
  list of resume codes without removing repeats, so a second line would block R1, R2, RP, RL and R3.
  - Instead, two clauses in the existing line, each only when above 0: "N carried kill(s) may seed R197's kill ledger" and
    "M carried kill(s) will not seed it: their killing test names no single covering test of this session".
  - The line is printed before any batch, so it is a forecast ("may seed").
  - No new event, code or SessionReport field.
- **The lend scan:**
  - No resumed leg has its own frozen baseline: R1, R2, RP, RL and R3 compare per mutant with `bcdev.baseline.json`.
  - lend's 3 kills (M0001-M0003) are all in `Sandbox Logic|IsOverBudget`, all by `OverBudgetDetected`.
  - Only R2 and RP re-run a mutant that shares a procedure with a carried kill: M0003, with M0001 and M0002 carried, so 2
    seeded kills. But `IsOverBudget` has ONE covering test, so the order cannot change its killer.
  - R1, RL and R3 carry every kill and only re-derive no-coverage rows.
- **Prediction:**
  - every lend leg passes with no verdict, `killingTest` or code-list change; the `resume-reusing-run` message gains the
    clause in R2 and RP (message text is not compared, codes only);
  - every other gate is unchanged.
- **Tests:**
  - fresh against stopped-then-resumed, one lane, per mutant: red on master (M0003's killer `AOne` instead of `CKill`),
    green with the seed;
  - the ambiguous killer: no seed, the clause shown;
  - carried survivors: no seed.
  - The red check: removing `recordKill` turns test 1 red.

## Amendment 2 (2026-11-22, the Opus build review, before any gate)
- **A re-walk kill is not seeded (review S1, a fix).** A kill found by R1174's no-ledger re-walk never calls `recordKill`
  in a fresh run, and it carries the tag `[ledger-order-survived]` in its `failureNote`. The seed and the forecast count
  now both skip such a row (`isSeedableCarriedKill`), so it is in neither clause of the line.
  - Test: the tagged kill (`killed` and `timeout-killed`) is not seedable; an untagged kill is; a survivor is not. The red
    check: making the tag check never match turns it red (expected false, received true).
- **A second named limit (review S2).** "On one lane equals a fresh run" holds only when the carried kills come first in
  their procedure's walk. A resume re-runs some earlier rows (an `error`, a kill that did not reproduce, a
  `timeout-killed` without `--stop-hung-sessions`, an ambiguous key, a carry-disabled row) while every carried kill of the
  batch is already seeded. Such a re-run row can get a different `killingTest` than in a fresh run, where it was walked
  before the later kill. Seeding is still the closer state; this is a named limit, like the several-lanes one.
- **Wording (review nit).** Amendment 1's "message text is not compared, codes only" is wrong: lend checks parts of the
  message with `includes`. Those parts sit before the new clauses ("... without re-executing."), so the prediction holds.
- **A build change (`snapshot-backend-build-changed`).** The carried verdict itself comes from the other build, so seeding
  from it is consistent with what is carried.
- **The prediction is unchanged.**

