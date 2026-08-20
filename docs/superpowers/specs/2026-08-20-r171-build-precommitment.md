# R171 build: per-mutant pre-commitment

Written before the gate was run against the built state. Every verdict below was fixed first; the
outcome is appended and nothing above it is edited.

What lands: `lethal.negate-guard` registered (Tier 1, 1.0.0), `remove-not`'s cession seam corrected,
and `codeunit 79319 "Data Set Ops"` plus three covering tests added to `fixtures/sandbox-data` so the
seam has a site a live gate actually runs.

## Site accounting

`itest:tables` moves from **246 deployed** to **259**: 13 new mutants.

- **4** from `negate-guard` on code that was already there
- **9** from the new arm, one of which is `negate-guard`'s and one of which is the seam's

The arm's nine were enumerated statically before any prediction was written, so the SET is measured
and only the VERDICTS are predicted.

A note on the raw-site number, because two counts disagree by one and both are right. A straight sum
of `generate()` output over the fixture gives 280; the gate's `totalMutantSites` will read one lower,
because R144's declarative site (`src/DataMainList.Page.al`, an `Enabled = …` page property) is
matched and then dropped as not-executable. The gate's own number is the one its constant is set
from, and it is read from the run rather than predicted here.

## The four on existing code

These were MEASURED in the spike (`2026-08-20-r171-negate-guard-spike.md` §5b) before this build, and
are restated rather than re-predicted:

| # | site | verdict | killing test |
| --- | --- | --- | --- |
| 1 | `Data Find Ops.FirstLevelInRange`, `if Probe.FindFirst() then` | killed | `FindFirstPicksTheLowestKeyInRange` |
| 2 | `Data Find Ops.LastLevelInRange`, `if Probe.FindLast() then` | killed | `FindLastPicksTheHighestKeyInRange` |
| 3 | `DataMainListExt.PageExt` `OnOpenPage`, `if Main.Get('P-EXT') then` | no-coverage | — |
| 4 | `Data Ops.InsertWithoutTrigger`, `if DataMain.Get(MainNo) then` | killed | `InsertWithoutTriggerKeepsAmount` |

## The nine in the new arm

All three procedures are covered, and every test asserts BOTH directions (inside and outside the
set, equal and unequal), so no mutant here can survive on a one-sided assertion.

`RegionRank` — covered by `RegionRankSeparatesInsideAndOutsideTheSet` (`'DK'` -> 1, `'DE'` -> 0):

| # | line | operator | mutation | predicted | why |
| --- | --- | --- | --- | --- | --- |
| 5 | 29 | `empty-block` | body -> `begin end` | **killed** | returns 0 for both inputs; the `Inside <> 1` check fires |
| 6 | 30 | `remove-not` | `not (C in [set])` -> `(C in [set])` | **killed** | THE SEAM MUTANT. For `'DK'` the guard becomes true, so it exits 0 and `Inside` is 0 |
| 7 | 32 | `return-value` | `exit(1)` -> `exit(0)` | **killed** | `Inside` becomes 0 |

`BothOutsideRange` — covered by `BothOutsideRangeSeparatesEqualAndUnequal` (`(7,7)` -> 1, `(7,9)` -> 0):

| # | line | operator | mutation | predicted | why |
| --- | --- | --- | --- | --- | --- |
| 8 | 37 | `empty-block` | body -> `begin end` | **killed** | returns 0 for both; the `Equal <> 1` check fires |
| 9 | 38 | `negate-conditional` | `First = Second` -> `First <> Second` | **killed** | CONTROL. This mutant existing is the proof `remove-not` correctly did NOT claim the outer `not` here |
| 10 | 40 | `return-value` | `exit(1)` -> `exit(0)` | **killed** | `Equal` becomes 0 |

`PlainMembership` — covered by `PlainMembershipSeparatesInsideAndOutsideTheSet` (`'SE'` -> 1, `'DE'` -> 0):

| # | line | operator | mutation | predicted | why |
| --- | --- | --- | --- | --- | --- |
| 11 | 45 | `empty-block` | body -> `begin end` | **killed** | returns 0 for both |
| 12 | 46 | `negate-guard` | `C in [set]` -> `not (C in [set])` | **killed** | for `'SE'` the guard goes false, so `exit(1)` is skipped |
| 13 | 47 | `return-value` | `exit(1)` -> `exit(0)` | **killed** | `Inside` becomes 0 |

**The arm's load-bearing assertion is an ABSENCE, not a count.** `remove-not` must claim mutant 6 and
must NOT claim `BothOutsideRange`'s `not (First = Second)`; `negate-guard` must claim mutant 12 and
must NOT claim either `not (...)` guard. If the seam fix were over-broad — taking every parenthesized
operand rather than only the inner kinds `negate-conditional` never claimed — mutant 9 would be
replaced by a `remove-not` mutant at line 38 and the operator NAME at that line would change. The
per-mutant baseline catches that; a matching total would not.

## Derived totals

| | frozen | predicted |
| --- | ---: | ---: |
| deployed mutants | 246 | **259** |
| killed | 201 | **213** |
| survived | 34 | **34** |
| no-coverage | 11 | **12** |
| `untargetedTriggerCount` | 0 | 0 |
| `declarativeSites` | 1 site in 1 file | unchanged |
| expected baseline failures | 1 (`PageActionComputesNonZero`) | unchanged |

Twelve of the thirteen are killed and one is `no-coverage`; survivors do not move. That is a
deliberate property of the arm rather than a happy accident: it exists to prove the seam is REACHED,
so its tests assert both directions and leave nothing surviving. A survivor here would mean a test
that fails to separate, not a finding about the operator.

`itest:bcdev`, `itest:alrunner` and `itest:hang` cannot move: `negate-guard` claims **0** sites in
`sandbox-app` and `sandbox-hang`, measured. The gift-card demo moves from 43 to 45, already measured
in the spike at killed 26 / survived 11 / no-coverage 8, score 70.3%.

---

## OUTCOME, appended after the run. Nothing above is edited.

**All thirteen matched.** `itest:tables` cleared every aggregate assertion on the first run and
stopped only at the per-mutant baseline, which is the expected place for thirteen new mutants to
surface:

```
verdicts: killed=213 survived=34 noCoverage=12 baselineGreen=false
          score=0.8623481781376519 untargetedTriggers=0 declarativeSites=1
```

`totalMutantSites` came in at **279**, the number this document declined to predict and read from the
run instead. Killed 213, survived 34, no-coverage 12 and the score are exactly as derived above.

Per mutant, in the order the run reported them: `negate-guard` killed at `DataFindOps:22` and
`:36`, no-coverage at `DataMainListExt.PageExt:39`, killed at `DataOps:91`; then the arm, all nine
killed — `empty-block` at 29/37/45, `remove-not` at 30, `return-value` at 32/40/47,
`negate-conditional` at 38, `negate-guard` at 46.

**The control held.** Line 38 is still `negate-conditional`, not `remove-not`. An over-broad seam fix
— one that took every parenthesized operand instead of only the inner kinds `negate-conditional`
never claimed — would have replaced that mutant, and the change would have been an operator NAME at a
line whose verdict did not move. The per-mutant baseline catches that; the totals would not.

**The re-recorded baseline gained ELEVEN rows for THIRTEEN mutants, and that is correct.** The
identity key is `(astSubtreeHash, objectName, operatorName, operatorMajorVersion)`, and the three
`return-value` mutants rewrite an identical `exit(1)` subtree inside one codeunit, so they share a
hash and collapse to one row. The fixture already collapses this way at scale (225 baseline rows for
259 mutants). A reader comparing "13 new mutants" against "11 new rows" should not read the
difference as two missing mutants: the verdict COUNTS above account for all thirteen.

No pre-existing mutant changed verdict, and none was removed. The demo re-froze at 45 with the two
predicted verdicts, and `itest:bcdev`, `itest:alrunner` and `itest:hang` were not re-run because
`negate-guard` claims zero sites in their fixtures, which was measured rather than assumed.
