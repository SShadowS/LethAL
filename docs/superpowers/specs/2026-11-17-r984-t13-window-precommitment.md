# R-984 DO window t13 pre-commitment: head e83e0e23 (PR-94 runSelectedOnly on L4 cuts, PR-98, PR-100 TIMING), same build, resume dos3

Lane lethal-bugs, 2026-11-17, committed before the window starts. Head: master e83e0e23 (t12's 4763e43d + PR-94 3b0f7f49 + PR-98 +
PR-100 62217afa + PR-101's measurements; PR-102 is pre-committed only). **al-runner: edge-847b1fa5a, pinned by explicit path in
`/coord/handoff/R-984/v3.do-serve.json` as in t1-t12.** `--resume dos3.sqlite`, `--time-budget 12600` under
`timeout --foreground -k 900 15300`, triage first, run.sh's watchdog, `--peak 9`, `--workers` not passed (1) until PR-99 lands
(orchestrator). The events file is kept (code's PR-101 reads t12's and t13's).

## Basis: t12 (`/coord/handoff/R-984/result.md`)
Full budget; baseline reused from run 10 (229 s); 1,628 covered mutants scored at 7.6 s each; prefetch 551 requests (8,553 s),
live 439 (1,560 s), warm-ups 94 (2,055 s); 42 closes (35 refusal); 0 differ vs t1-t11. 5,498 covered mutants remain.

## Measured before the window (`/coord/handoff/R-984/t6prep/dry-t12b.txt` vs `dry-t13b.txt`)
Identical: 43,518 deployed.

## Agreement
Per-pair rule: t13 vs t9-t12 STRICT; vs t1-t8 relaxed.

## Predictions
1. **BLOCK line:** 0 differ against t1-t8 (relaxed) and t9-t12 (strict). PR-94 sends a cut entry's tail to `runSelectedOnly`, which
   only stops hidden tests from running (R1094, PR-95): no verdict and no killing test moves.
2. **Mutation set:** 43,518 deployed.
3. **Baseline: REUSED from run 10's snapshot**, named; no not-reused, no build-changed; phase <= 300 s.
4. **PR-94:** requests whose entries are prefix-cut carry `runSelectedOnly` (visible in the `serve-request-timed` events or the
   TIMING section; counted). **Time per covered mutant scored at most 6.8 s** (t12 7.6 s; the orchestrator's DO-slice figure is
   about 20% less mutant-phase wall), and prefetch wall per prefetch request lower than t12's 15.5 s.
5. **PR-100:** `serve-request-timed` events present; the end-of-run TIMING section printed; t13's entry quotes it (warm-ups by
   cause, prefetch, live, restarts by family and phase). Its totals agree with the R635 stats line within rounding.
6. **Closes:** 0 SetFilter-1030, 0 GoToKey refusal closes, 0 in a kept text (by construction); refusal closes at most 50; drift
   fires named; every timeout kill `v3-cpu-stop`; `alone-confirm` counted.
7. **Rate floor:** at least 1,600 covered mutants scored if the window runs its full budget; L4 widened 0, order broken 0.
