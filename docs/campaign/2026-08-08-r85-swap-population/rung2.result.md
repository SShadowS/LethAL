# Rung 2 — result

**The rate exists now.** Continia Document Output's own suite kills **40.9%** of argument swaps in
its first-party code (63 of 154 scored, Wilson 95% **33.5% – 48.8%**), falling to **37.0%** once the
false kills are removed. The pre-committed bar puts the boundary at 40%, and **the interval straddles
it** — so the bar does not resolve, and saying which side it lands on would be reading a point
estimate the pre-commitment explicitly forbids reading alone.

Run 2026-08-08 against Continia environment `f5f11bf2`, DO `do-lethal/Cloud` at `5f2a71d3`, full
1,311-test baseline. Report `rung2.report.json`, analysis `rung2.analysis.txt`, frozen per-mutant
baseline `rung2.baseline.json`.

## The whole population ran, and nothing was truncated

| | |
| --- | --- |
| swap mutants deployed | **523** — exactly the pre-committed cardinality |
| of those, first-party (`Al/**`) | 437 |
| of those, vendored (`.dependencies/CDO/**`) | 86 |
| non-swap mutants in the report | **0** |
| baseline | 1,311 discovered, 71 failing (pre-committed band: 1,250–1,400, at most 100) |
| coverage split | 177 covered / 346 no-coverage (66%) |
| quarantine, 502, resume needed | **none** |
| wall clock | 2,695.6 s = generate 3.2 + deploy 52.3 + baseline 741.8 + mutants 1,852.9 + overhead 48.6 |
| per mutant (n=177) | mean 10,468 ms, median 1,415 ms, p95 75,750 ms, max 128,507 ms |

**R127 is what made this possible and the contrast is the measurement of it.** Rung 1 deployed 894
mutants to score 3 swaps. This deployed 523 to score 177 — the whole population, fewer mutants than
the truncated run spent, and 59 times the scored observations.

## The rate, three readings, all pre-committed

The bar applies to the **first-party** partition, fixed before the run.

| reading | first-party | Wilson 95% |
| --- | --- | --- |
| **raw kill rate** | **63/154 = 40.9%** | 33.5% – 48.8% |
| **false-kill-adjusted** (arm-E length kills removed) | **57/154 = 37.0%** | 29.8% – 44.9% |
| assertion kills only | 41/154 = 26.6% | 20.3% – 34.1% |

Whole project (reported, bar does not apply): 73/177 = 41.2%, 34.3% – 48.6%.
Vendored alone: 10/23 = 43.5% — **n < 30, so the bar is not applied to it**, as pre-committed.

**Against the bar.** The raw point estimate lands one percentage point inside the `40–89%` band
("the operator finds real assertion gaps at a useful rate; ships as a default Tier-1 operator"). The
false-kill-adjusted one lands in `< 40%` ("a large gap; the survivors must be checked for
EQUIVALENT mutants first"). The 95% interval covers both bands in every reading. `rung2.precommit.md`
says what matters is "whether the interval clears a band edge, not the point estimate", so the
honest result is that **this run does not decide the band** — it locates the rate around 40% with
±7 points, which is a genuine measurement of the quantity R85 asked for and not a verdict on the
operator's default.

## Every kill was classified by hand, and 6 of 63 are false

All 73 kills recorded a `killingTestFailure` (R86). **None was unclassifiable.** Classified by
reading the text, first-party:

| class | n | what it means |
| --- | --- | --- |
| **assertion** — a test's own `Assert.*` failed | **41** | the suite noticed |
| **runtime-detected** — the mutated program errored on its own wrong behaviour | **16** | the RUN failed, but no assertion fired |
| **length-constraint** — BC rejected the mutated DATA on a field width | **6** | arm E exactly: a FALSE kill |

**The 6 false kills, and why they are false.** All six swap a description into a name field:

```
M0133/M0134/M0135  AddFeature(ProductCode, <code>, <NameLbl>, <DescriptionLbl>, ...)   -> 80-char field
M0136              AddFeature(ProductCode, GetESealFeatureCode(), <Name>, <Desc>, ...) -> 80-char field
M0143/M0145        CreateMergeField(<UrlLbl>, <DescLbl>, MergeField)                   -> 50-char field
```

BC answers "The length of the string is 87, but it must be less than or equal to 80 characters."
before any assertion runs. The same swap into a field one character wider would survive, so the
kill is a property of the data, not of the swap's semantics or of the suite's assertions. **Rung 1
found this shape at 3 of 3 scored kills; at population scale it is 6 of 63 = 9.5%.** R85 predicted
it at 5.2% of resolvable sites.

**The 16 runtime-detected kills are counted as real, and that is a judgement worth stating.** Under
mutation testing's standard definition a mutant is killed when the suite FAILS, and these failed:
`StartDate`/`EndDate` swapped and the report engine refused ("Start date must be earlier than End
date", 4 of them), a dictionary key and value swapped ("The given key was not present in the
dictionary", 3), an XML element name and its inner text swapped, a field number swapped, a
`StrPos(String, Find)` reversed. In each case the swap made the program genuinely wrong and the
program said so. They are counted separately anyway, because they say nothing about ASSERTION
quality — which is the number the `assertion kills only` row above reports.

## The `< 40%` band's obligation, discharged as far as it honestly can be

The pre-commitment says an unexamined sub-40% rate is not a finding, because a commutative callee
survives a swap that changed nothing.

**The machine-checkable half is clean: 0 of 91 first-party survivors are textually identical after
the swap**, which is the only equivalence a tool can settle without callee semantics.

**Reading the distinct call shapes**, the survivors are real behaviour changes rather than no-ops.
`CopyField(FromFieldRef, ToFieldRef)` reversed copies the wrong way. `CTSSYSAzureBlob.Put(File,
ContainerName, Filename)` reversed uploads to a container named after the file. `StrSubstNo` swaps
put the wrong values in a message. One callee dominates — `MoveEmailLog` accounts for 11 of the 91 —
and its two swapped parameters are distinct record references.

**Not performed, and named:** a per-callee equivalence review of all 91. What is above is a screen
plus a reading of the distinct shapes, not an exhaustive adjudication.

## What went wrong with the campaign's own machinery

**`campaign anchors` could not run: `rung2.anchors.json` was never written.** The pre-commitment
states its gate list as PROSE and never encoded the three machine-checkable anchors
(`baseline-green`, `coverage-location`, `killed-at-least-one`) into the file the verb reads, so the
verb refused — correctly, and with the right message ("a pre-commitment that does not exist cannot
have been committed before the run"). Writing one now and claiming it was pre-committed is exactly
what the git-history check exists to prevent, so it was not written.

Recorded as a **plan defect found by running the plan**, the same way the 2026-08-03 campaign
recorded its dropped gate. `campaign freeze` DID run and pass, including `--expect-mutants 523`, so
Rule 2's cardinality assertion held. The prose gate list was then checked by hand against the
report:

| gate | result |
| --- | --- |
| 1. exactly 523 mutants | PASS (freeze, `--expect-mutants 523`) |
| 2. every mutant is `lethal.swap-call-arguments` | PASS (0 non-swap in the report) |
| 3. 1,250–1,400 baseline tests, at most 100 failing, no `stale-test-app` | PASS (1,311 / 71 / caveats are `baseline-red`, `operator-narrowed`, `tests-testpage-unsupported`) |
| 4. caveats contain `operator-narrowed`, not `tests-narrowed` | PASS |
| 5. every kill has a `killingTestFailure` | PASS (73 of 73) |
| 6. bar applied to first-party only, and only at n >= 30 | PASS (n = 154) |

**The next stage in this campaign must ship `rung<n>.anchors.json` with its pre-commitment.**

## Caveats, stated rather than buried

- **Baseline red**: 71 of 1,311 tests failed before any mutant ran. R55: those tests drop out of the
  green set, so a swap covered only by them reads `no-coverage`, not `survived`. That **understates**
  the survivor count and therefore **overstates** the kill rate. The true rate is at or below what is
  reported here.
- **66% of the population had no covering test** (346 of 523). Better than rung 1's 80%, and now a
  measured property of the whole population rather than a consequence of a scope rule.
- **2 mutants recorded `error`** (M0119, M0120): covered only by `CDO Email Editor Page
  Tests.EMailLogViewMode_PageOpensWithoutError`, which did not pass at baseline. Score-excluded, not
  silently counted.
- **`tests-testpage-unsupported`**: some baseline tests open a TestPage, which the fenced session
  refuses (R69, closed as named-not-recovered). Their mutants land as `no-coverage`.
- **Non-GUI execution**: all 523 verdicts describe the app's non-interactive branch
  (`GuiAllowed=No`, `ClientType=ODataV4`).
- **One project, one suite.** This is Document Output's rate, not "the" rate.
