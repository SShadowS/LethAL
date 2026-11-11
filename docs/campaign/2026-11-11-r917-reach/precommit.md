# R-917 pre-commitment: v3 survivors' reach decided from the baseline (R926), on R-913's sampled survivors

Committed before the runs, 2026-11-11. Coord task R-917. Evidence goes to `/coord/handoff/R-917/`. No BC.History source text is
committed. al-runner v3 is not authoritative (R586).

**Code:** lethal/r-917 (R926 at af5b3b8d, plus R925 when it lands). The v3 gate passed on af5b3b8d with all 19 legs: no gate figure and
no gate artifact moved, so nothing there is pre-committed.

**Runs:** for each of R-913's seven apps, `lethal run --backend al-runner-v3` with R-913's config, sources and packages, the same
al-runner build (edge-3138effad), and `--lines` set to the file:line of each of that app's 20 survivors sampled by R-916 (`sample-<key>.json`,
seed 916). The runs take every mutant touching those lines. One slot, one app at a time. Mutants are joined with R-913's by identity
(start, end, operator, AST hash).

## Predicted

1. **No verdict changes** against R-913's report, by identity, for any mutant in these runs. R926 sets only reach fields.
2. **The unreached ones read `covered-but-unreached`** (`guardReached: false`):
   - Audit File Export M0344 (line 173), M0359 (188), M0441 (297);
   - Data Search M0727 (212), M0730 (214);
   - Enforced Digital Vouchers M0171 (`DigitalVoucherEntry` line 59: R-916 measured 0 hits; the reader was wrong).
3. **Data Search M0722 stays `not-decided`:** its grain is `enclosing`, which R926 does not decide.
4. **Audit File Export M0430 (line 286, 3 hits) reads `reached-unnoticed`.**
5. **Edv M0468 (line 406, 1 hit) reads `reached-unnoticed`.**
6. **No other sampled survivor reads `covered-but-unreached`**, except one whose covering tests' baseline has no hit on its line. Each such
   one is named and its line checked against `--coverage-json` (as in R-916) before it is accepted. The 87 reader-classed test gaps
   are expected `reached-unnoticed` or `not-decided`.
7. **`not-decided` is reported with its reason class:** a block statement, a mutant inside or after a `#if` wrapper, an `enclosing` grain,
   a covering test not green at baseline, or an isolation-mode mismatch. Counts per class, per app.

A prediction that fails is a finding, and the build does not go to submit until it is explained.

## Amendment 1 (2026-11-11, after the first runs, before the re-runs)

**Run 1 on 6f699b87 decided no reach at all** (all seven apps: no row had `guardReached`). Cause, found from the code: the
missing-coverage guard also excluded a baseline pass that al-runner FLAGGED (it rests on an unprobed assumption, R907). A flagged pass
still ran to its end, so its coverage is complete; nearly every pass of Microsoft's apps is flagged (Data Search 11 of 11), so every
covering test was excluded. Fixed at 8c96d9a4 (a flagged pass counts; a test, red when the exclusion is restored). Run 1's reports are
kept as evidence, not results.

**Run 2 (8c96d9a4), Audit File Export and Data Search:**
- Prediction 1 HELD: 0 verdict changes in 92 mutants.
- Prediction 2 HELD: afe M0344, M0359, M0441 and ds M0727, M0730 read UNREACHED. (edv M0171: in the re-run.)
- Prediction 3 HELD: ds M0722 (enclosing grain) is undecided.
- Prediction 4 FAILED: afe M0430 is undecided, not reached. It is an `empty-block` mutant, whose statement is a block; the build
  decides no block statement (no `reachLine`), by design. The prediction missed that rule.
- Prediction 6, the exception clause: 10 more sampled survivors read UNREACHED: afe M0846, M0833, M0223, M0358, M0892, M0856, M0816;
  ds M0084, M0100, M0051. Each was checked as required: every covering test, run alone unmodified with al-runner's
  `--coverage-json` (`/coord/handoff/R-916/cov/`), has 0 hits on that statement line. All 10 are accepted as unreached; none is
  a false "unreached".
- R925, measured: every kill in both apps (5 of 5, 7 of 7, both on serve) carries a stack in its failure text, so serve's rows carry
  `stackTrace` too.

**Unchanged:** the remaining apps (edv, emr, ext, pyp, peppol) re-run on 8c96d9a4 under the same predictions.
