# R-984 DO window t12 pre-commitment: head ca65306e (PR-88's VmHWM memory sensor), same build edge-847b1fa5a, resume dos3

Lane lethal-bugs, 2026-11-16, committed before the window starts. Head: master ca65306e (t11's 045a15cc + PR-88 10cfbfca + PR-92;
since 10cfbfca no file under `packages/` changed). **al-runner: edge-847b1fa5a, pinned by explicit path in
`/coord/handoff/R-984/v3.do-serve.json` as in t1-t11.** `--resume dos3.sqlite`, `--time-budget 12600` under
`timeout --foreground -k 900 15300`, triage first, run.sh's watchdog, peak RSS from `/usr/bin/time -v`. **Declared peak 9 GiB**
(was 12; tree peaks 6.5 GiB in t10 and t11). It starts only after lethal-code's PR-89 measurement (24 GiB) has ended.

**Amendment 1 (2026-11-16, before the window starts; orchestrator): head 4763e43d, which adds PR-93's 26 kept refusal texts**
(4605b385; they cover 154 of t10's and t11's 174 mutant-phase refusal closes; pinned by `pr93-measured-refusals.json`). The rest of
ca65306e..4763e43d is PR-91 and docs. Where this amendment and the predictions below disagree, the amendment wins.
- **Dry run on 4763e43d** (`t6prep/dry-t12b.txt`): identical to `dry-t12.txt` (apart from the contract-probe line): 43,518
  deployed. So prediction 3 (baseline reused from run 10, named) stands: the keep list is not in the tree hash, the test-app hash
  or the recorded runner build.
- **Prediction 5, amended:** 0 closes whose text is one of PR-93's kept texts (or PR-74's, or the SetFilter-1030 / GoToKey
  families). **Refusal closes at most 50** over the window (t11: 107, t10: 77 in a shorter window); those that remain are named
  by family.
- **New, the speed test:** fewer daemon restarts, so **fewer warm-ups than t11's 212** if the window runs its full budget, and
  the rate stays in prediction 6's 3-12 s band (PR-88's smaller requests and PR-93's fewer restarts pull in opposite directions,
  so no direction is predicted for the rate itself).

## Basis: t11 (`/coord/handoff/R-984/result.md`)
Full budget; baseline reused from run 10 (240 s); 2,001 covered mutants scored at 6.1 s each; entries cap about 67 test entries per
request (one `al-runner-v3-entries-cap-lowered` line, 61 MiB per entry); 118 closes (107 refusal, 5 timeout, 5 drift on two tests
red in the baseline, 1 request-failed); 2 `alone-confirm` (both timeouts, both unchanged against t9/t10); 0 differ vs t1-t10.

## Measured before the window (`/coord/handoff/R-984/t6prep/dry-t11.txt` vs `dry-t12.txt`, the latter on 10cfbfca)
Identical: 43,518 deployed.

## Agreement
Per-pair rule: t12 vs t9, t10 and t11 STRICT; vs t1-t8 relaxed.

## Predictions
1. **BLOCK line:** 0 differ against t1-t8 (relaxed) and t9, t10, t11 (strict). PR-88 changes packing only: no verdict moves.
   The killing test may differ (R197) and would then be listed, not counted as a differ (compare.ts joins verdict AND killing
   test, so any killing-test change shows as a differ there: each is named and checked to be a covering-order change).
2. **Mutation set:** 43,518 deployed.
3. **Baseline: REUSED from run 10's snapshot**, named `resume-baseline-reused`; no not-reused, no build-changed; phase <= 300 s.
4. **PR-88's sensor (code's spec 2026-11-16-pr88-entry-cost-per-codeunit.md):**
   - `serve-request-sized` events appear in the events file (one per serve request), and their peak source is `hwm`; if any
     window reading shows only `sampled`, it is reported to code.
   - The single `al-runner-v3-entries-cap-lowered` line is replaced by per-codeunit cap lines ("requests carrying codeunit <id>
     hold about N test entries"); CDOeDocPrePostValid's codeunit is among them.
   - **The entries cap is equal to or LOWER than t11's ~67 for every codeunit named**; requests are equal or smaller and there
     are at least as many serve requests per covered mutant as in t11 (t11: 212 warm-up + 357 prefetch + 446 live over 2,001).
   - Possibly one `al-runner-v3-peak-unverified` warning (counted, not predicted).
   - The events file is KEPT (R1091 is probed from it).
5. **Closes in the mutant phase:** 0 SetFilter GlobalLanguage 1030, 0 GoToKey, 0 in PR-74's kept forms; other refusal closes
   counted by family, not predicted; drift fires named with their tests; every timeout kill `v3-cpu-stop`; `alone-confirm` counted.
6. **Rate:** 3-12 s per covered mutant scored (t11 6.1 s; smaller requests may cost prefetch time), and at least 800 covered
   mutants scored if the window runs its full budget (6,681 covered remain); L4 widened 0, order broken 0.
