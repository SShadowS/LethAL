# R-984 cross-build window x2 pre-commitment: resume dos4 on edge-4ebfe7913, head 7c6bba1c (PR-115/117 batching on, PR-116)

Lane lethal-bugs, 2026-11-17, committed before the window starts. Second window of the cross-build store `dos4.sqlite` (x1:
4ac7a4a2 + 2fc7612b). Head: master 7c6bba1c (x1's c996629b + PR-107, PR-115, PR-116, PR-118, PR-117, PR-122). al-runner:
edge-4ebfe7913 (`v3.do-serve-xb.json`), whose gate record now allows baseline batching (regate 18:10:51Z at 7c6bba1c: "gate record
allows baseline batching", 8 batchFacts `matches`). Driver `run-xb.sh 2`: `--resume`, `--workers 3`, `--peak 15`, watchdog 17 GiB
or under 4 GiB of headroom, `--time-budget 12600`. The config keeps `isolation: "test"` (PR-107's isolation auto is not used).

## Basis: x1 (`/coord/handoff/R-984/result.md`)
Fresh baseline 1,697.7 s; 6,251 covered mutants scored at 1.74 s; 12 restarts; per mutant vs t1-t14: 14 (A) freed (untouched handle),
0 (B), 0 (C), 0 (D). 10,431 covered mutants remain.

## Measured before the window (`t6prep/dry-x2.txt` on 7c6bba1c)
Identical to x1's (`dry-xb2.txt`): 43,511 deployed, 747 hang-refused.

## Agreement
x2 vs x1: same build, both on PR-51 and PR-108: STRICT (no timeout rule, no walk-cap side). x2 vs t9-t14: strict with the walk-cap
clause on; vs t1-t8: relaxed + walk cap. Every difference is classified as in x1's pre-commitment (A freed, B newly refused, D
killing-test-only, C anything else = BLOCK).

## Predictions
1. **vs x1: 0 differ** (same build, same store). **vs t1-t14:** (C) = 0; (A), (B) and (D) counted and named.
2. **Mutation set:** 43,511 deployed.
3. **Baseline: REUSED from x1's snapshot**, named `resume-baseline-reused`, phase <= 300 s. **PR-115: no batching line** (the reuse
   re-check `recheckReusedBaseline` never batches; code, 2026-11-17). Only if the re-check fails (`resume-baseline-not-reused`)
   does a fresh, batched baseline run; it would then print "baseline batching (PR-115): ..." and be counted against x1's 1,697.7 s.
4. **Lanes:** 3 of 3.
5. **Speed:** at most 3.0 s per covered mutant scored (x1 1.74 s; later mutants can cost more), at least 3,000 covered mutants scored if
   the window runs its full budget; if the 10,431 remaining fit, the window ends with none left (rc not a budget stop).
6. **PR-116:** the report may carry the `withheld-kills` caveat and name withheld kills; counted, not predicted.
7. **Closes:** 0 GoToKey and 0 SetFilter-1030 refusal closes; refusal closes counted by family; every timeout kill `v3-cpu-stop`;
   capped walks counted if any (TIMING prints the line only then).
8. **Memory:** tree <= 15 GiB; no watchdog stop. No budget overrun.
9. TIMING quoted; events kept.
