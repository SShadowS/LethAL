# R-984 DO window t14 pre-commitment: head 3fe3bd1a, --workers 3 (PR-99), PR-102 kill-pair cut, PR-103 proof readings

Lane lethal-bugs, 2026-11-17, committed before the window starts. Head: master 3fe3bd1a (t13's e83e0e23 + PR-102 1f850eb0 + PR-99
a6c563a1 + PR-103 464726cf + docs). **al-runner: edge-847b1fa5a, pinned by explicit path in `/coord/handoff/R-984/v3.do-serve.json`
as in t1-t13.** `--resume dos3.sqlite` (the session fingerprint has no workers field, so the 1-lane run resumes), `--time-budget
12600` under `timeout --foreground -k 900 15300`, triage first. **First window at `--workers 3`.** Declared `--peak 15 baseapp`
(t13's 1-lane tree 6.7 GiB plus 2 lanes x about 3.5 GiB of daemon); run.sh's watchdog stops at a 17 GiB tree or under 4 GiB of
container headroom (orchestrator). The events file is kept (PR-103's readings, R1100/R1101).

## Basis: t13 (`/coord/handoff/R-984/result.md`)
1 lane; 3,018 covered mutants scored at 4.34 s each (TIMING); live 411 requests (3,413 s, 1.13 s per covered mutant), prefetch 443
(6,549 s); 65 restarts (36 refusal, 28 timeout); 0 differ vs t1-t12. **2,964 covered mutants remain.**

## Measured before the window (`t6prep/dry-t14.txt` on 1f850eb0, `dry-t14b.txt` on 3fe3bd1a)
Identical to t13's: 43,518 deployed.

## Agreement
Per-pair rule: t14 vs t9-t13 STRICT; vs t1-t8 relaxed.

## Predictions
1. **BLOCK line:** 0 differ against t1-t8 (relaxed) and t9-t13 (strict). Neither lanes (PR-99: per-mutant identical on the DO
   slice) nor PR-102's cut (R1097: rows after the killer are not read) moves a verdict or a killing test.
2. **Mutation set:** 43,518 deployed.
3. **Baseline: REUSED from run 10's snapshot**, named; phase <= 300 s.
4. **Lanes:** 3 lanes start (PR-103's `lane` field takes the values 0, 1 and 2; the TIMING section counts them).
5. **Speed:** mutant-phase wall per covered mutant scored **at most 3.3 s** (about 0.6 x t13's 4.34 s is 2.6 s; the bound allows
   0.75 x). PR-102: lane-summed live time per covered mutant below t13's 1.13 s.
6. **The covered set completes:** at that rate the 2,964 remaining covered mutants fit in the budget, so the session ends with
   none left out (no `TIME BUDGET REACHED`), and the report is the whole DO campaign's (carried + scored = every deployed mutant
   with coverage).
7. **Memory:** the tree stays at or under the declared 15 GiB (tree peak reported; above 15 is a missed prediction, re-declared
   next window); no watchdog stop.
8. **Closes:** 0 SetFilter-1030, 0 GoToKey refusal closes; refusal closes at most 50; drift fires named; every timeout kill
   `v3-cpu-stop`; `alone-confirm` counted.
9. **PR-103 (reported, not predicted):** per lane and daemon, `start - floor` against `daemonProveGrowth` (and `daemonProved`) at
   the same event, the share of retained memory the proofs explain, readings with a proof before them, p50/p90 of `proveGrowth`.
10. TIMING quoted as in t13; L4 widened 0, order broken 0.
