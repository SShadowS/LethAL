# R-984 cross-build window x1 pre-commitment: a fresh store on al-runner edge-4ebfe7913, compared per mutant with t1-t14 (847b1fa5a)

Lane lethal-bugs, 2026-11-17, committed before the window starts. The DO campaign on edge-847b1fa5a is complete (t14: 16,685
covered mutants, all scored). By the orchestrator's ruling (2026-11-16, after the t10 build-move question), one fresh-store window now
runs on the then-current build, as a per-mutant cross-build comparison. It starts after preproc's PR-107 run on 847b1fa5a ends.

**Amendment 1 (orchestrator, 2026-11-17, before the window starts):** a fresh store has no kill history, so R197's covering order
starts from scratch and the killing test can move for that reason alone. **A killing-test-only change (same verdict, another
killing test) is its own allowed class (D)**, counted and named, not a BLOCK. (C) keeps killed <-> survived and every class change
outside the walk cap and the PR-51/PR-108 rules. #8028's no-client move: predicted 0 (confirmed). Where this amendment and the text
below disagree, the amendment wins.

**Setup.** Head: master 42c84fbe or later (contains PR-108 2b2bddaf, PR-109 5711fe12, PR-105, PR-99, PR-102, PR-103). al-runner:
**edge-4ebfe7913** (`current`), pinned by path in `/coord/handoff/R-984/v3.do-serve-xb.json` (v3.do-serve.json with only the path
changed). Driver `/coord/handoff/R-984/run-xb.sh 1`: a fresh store `dos4.sqlite` (dos3.sqlite, the 847b1fa5a campaign, is never
touched), triage first, `--workers 3`, `--peak 15 baseapp`, watchdog at a 17 GiB tree or under 4 GiB of headroom, `--time-budget
12600` under `timeout --foreground -k 900 15300`. Files `x1.*`; run.log line `x1 start ... head <sha>`.

## Measured before the window (`/coord/handoff/R-984/t6prep/dry-xb.txt`, on 42c84fbe with the xb config)
45,014 sites, **43,511 deployed** (t14: 45,021 and 43,518), 747 hang-refused (t14: 740). The 7 sites PR-109 refuses (lethal-code,
R1104's P4): M25582, M25600, M25618, M25636, M25653 (CDOEMailLog), M36508 (CDOStringFunctions), M36641 (CDOTempBlob).

## What PR-65 measured, and what of it applies here
PR-65 (2026-11-16) compared edge-5a58a0f16 with edge-4ebfe7913 under `noClient`: its only moves (29 Payment Practices survivors to
no-coverage) came from the new `TestPage.OpenEdit` refusal without a client (#8028); #8154's fix freed nothing. DO's config sets
no `noClient`, so **#8028's move is predicted absent here (0)**. The builds between 847b1fa5a and 4ebfe7913 carry upstream fixes
named in the daily scan (#7996's narrowing among them); which DO tests they touch is not known in advance.

## Agreement and classification (compare.ts and verdict-rule.ts as of amendment 2)
x1 vs t9-t14: strict (both on PR-51), with the walk-cap clause ON (x1 contains PR-108, they do not). x1 vs t1-t8: relaxed + walk
cap. The 7 PR-109 sites are ABSENT in x1, so they leave "both" (named, not moved). Every remaining `differ` row is classified:
- **(A) freed:** `error` (a refusal) on 847b1fa5a -> a verdict on 4ebfe7913 (killed, survived, timeout-killed). Allowed; each named
  with the old refusal text, and attributed to the upstream fix if the scan names one.
- **(B) newly refused:** a verdict on 847b1fa5a -> `error` (a refusal) or no-coverage on 4ebfe7913. Allowed; each named with the new
  refusal text, and filed upstream under the owner's rule (duplicate search first).
- **(C) unexplained:** any other move (killed <-> survived, a killing-test change, a timeout class change outside the walk cap, an
  error text change with no refusal on either side). **Each one is a BLOCK.**

## Predictions
1. **(C) = 0.** (A) and (B) are counted and named, not predicted in number; #8028's move (B, TestPage without a client) = 0.
2. **Mutation set:** 43,511 deployed; the 7 PR-109 sites absent; 0 timeout closes from them (R1104 P4).
3. **Baseline:** NOT reused (a fresh store), so a full serve baseline: phase 1,400-3,000 s. Its green count is reported against
   847b1fa5a's 1,681/1,979, and every baseline row that differs is listed (each an (A) or (B) at the test level).
4. **Lanes:** 3 of 3 start (`al-runner-v3-lanes-started`).
5. **Speed:** at most 3.6 s per covered mutant scored over the mutant phase (t14 3.00 s), and at least 2,500 covered mutants scored if
   the window runs its full budget.
6. **PR-108:** 0 class moves from the cap against t9-t14 beyond the walk-cap clause; the capped-walk TIMING line printed; no budget
   overrun (session <= 12,600 s + one request).
7. **Closes:** 0 GoToKey and 0 SetFilter-1030 refusal closes; 0 closes on PR-105's 12 kept texts (R1103 P3) or any other kept text
   (by construction); refusal closes counted by family (t14: 71 with 3 lanes); every timeout kill `v3-cpu-stop`.
8. **Memory:** tree <= 15 GiB (t14 14.6); no watchdog stop.
9. TIMING quoted (warm-ups by cause, prefetch, live, restarts by family and phase); events kept.
