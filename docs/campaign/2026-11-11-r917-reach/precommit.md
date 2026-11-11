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
