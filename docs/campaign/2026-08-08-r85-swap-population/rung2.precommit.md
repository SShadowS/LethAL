# Rung 2 — pre-commitment

**Written and COMMITTED before the run, before any verdict is seen.** Campaign
`2026-08-08-r85-swap-population`. R85 instrument (b), second attempt, using R127's `--operator`.

Rung 1 (`docs/campaign/2026-08-07-r85-swap-rate/`) stands unchanged. Nothing here retunes it.

---

## The population, and a correction to R85's own frame

R85 records the swap population as **437 sites across 91 files** on `do-rel2/Cloud`, measured by a
census script running `swapCallArguments.targets` over the corpus. Measured again on 2026-08-08
through the REAL pipeline (`lethal run --dry-run --operator swap-call-arguments`), on both
`do-lethal/Cloud` and `do-rel2/Cloud`, which are the same AL source at commit `5f2a71d3`:

| | files | deployed swap mutants |
| --- | --- | --- |
| first-party (`Al/**`) | **91** | **437** |
| vendored (`.dependencies/CDO/**`) | 20 | 86 |
| **whole project** | **111** | **523** |

Both corpora return byte-identical totals, so the two checkouts are confirmed to be the same source
for this purpose. **The 437 is exactly right and the census was exactly right** — it is the
first-party figure. What R85 does not say is that LethAL also mutates the 137 vendored `.al` files
under `Cloud/.dependencies/CDO`, which the census skipped, and those hold 86 more swap mutants.

**This run deploys all 523.** Excluding the vendored files would mean reintroducing `--only`, and
the split is better made in the ANALYSIS, where it is a pre-committed partition on a variable
(is this path under `.dependencies/`) that is fixed before the run and cannot be influenced by any
verdict.

## Cardinality, pre-committed (rule 2)

**523 deployed mutants**, read off `--dry-run`'s `deployed mutant(s)` figure, never off its site
count. `campaign freeze --expect-mutants 523` refuses first and independently if the report is a
different size, because a gate comparing against a report of the wrong size is not measuring what
it claims.

The dry run also reports `523 mutant site(s), 523 deployed mutant(s)` — sites and deployed are equal
here, which is expected rather than lucky: `swap-call-arguments` replaces a call's argument list, so
it emits text no Tier-2 operator emits at the same node, and §3.2 dedup has nothing to collapse.
That equality is itself a pre-committed expectation: if the report holds fewer than 523, something
displaced a swap mutant and that must be explained before any rate is read.

## Scope, fixed here

`--project U:/Git/do-lethal/Cloud --tests U:/Git/do-lethal/Test --backend bcdev`
`--operator swap-call-arguments`

- **No `--only`.** The whole project contributes.
- **No `--tests-only`.** The baseline is the whole suite. It is the expensive phase (rung 1: 745 s
  of a 954 s run) and `--tests-only` is the real cost lever, but it CAN CHANGE A VERDICT: exclude a
  killing test and its mutant reports `survived`, which would bias the exact quantity being
  measured, in the direction that flatters the operator. Refused on those grounds, not overlooked.
- **No `--allow-large-run`.** 523 is under the 1,000 pre-flight limit.
- **No `--skip-known-survivors`.** Rung 1's verdicts must not leak into this run's denominator.
- `--mutant-timeout-ms` left at R91's 180 s default floor.
- `--max-guards-per-batch` NOT set. 523 guards in one artifact is expected to publish: 163 guards
  published in 28 s on a hosted environment and 11,777 were severed at 362 s, so 523 sits well
  inside the measured bracket. If the publish is severed, that is a recorded finding and the run is
  retried once with `--max-guards-per-batch 300`, which costs a second whole baseline. Stated here
  so the retry is not a decision made under time pressure after a failure.

## The bar, carried forward from `2026-08-07-r85-swap-rate/rung0.precommit.md`, unchanged

Rung 1 scored 3 swaps and could not honestly apply the bar at that n, so the bar has never been
read against data. It is carried VERBATIM rather than restated, which is what keeps it a
pre-commitment rather than a fresh guess made after seeing rung 1.

Primary measure: **swap kill rate** = killed / (killed + survived) over mutants whose
`operatorName` is `lethal.swap-call-arguments`. `no-coverage` and `error` are excluded from the
denominator and reported separately.

| observed rate | pre-committed reading |
| --- | --- |
| **>= 90%** | DO's suite already catches argument swaps. The operator is mechanically sound (R82) but low-yield on this project; that is a reason to keep it off by default, not to withdraw it. |
| **40-89%** | The operator finds real assertion gaps at a useful rate. Ships as a default Tier-1 operator. |
| **< 40%** | A large gap. Before celebrating, the survivors must be checked for EQUIVALENT mutants — a commutative callee (`Max(a,b)`) survives a swap because the swap changed nothing, and R82 deliberately sets no `equivalenceHint`. An unexamined sub-40% rate is not a finding. |

**The rate is read on the FIRST-PARTY partition** (the 437). The whole-project rate over all 523 is
reported beside it, and so is the vendored partition on its own. Fixing which one the bar applies to
before the run is the point of writing this down: choosing afterwards would mean choosing the
partition whose number reads better.

### Precision, stated before the fact

The bar's bands are 50 and 10 points wide, so what matters is whether the interval clears a band
edge, not the point estimate. A Wilson 95% interval is printed beside every rate by `analyse.ts` and
no wording in the result may quote a rate without it. Rung 0 fixed ±18 points at 30 observations;
this run's n is not knowable in advance because it depends on the coverage split, which is decided
by the run. **If fewer than 30 swaps score, the bar is NOT applied**, exactly as rung 1 declined to
apply it at 3.

## The false-kill rule, carried forward and still mandatory

R85 measured that 12 of 233 resolvable call sites (5.2%) declare different parameter types at the
two swapped positions, 6 of them same-base-different-length — the arm E shape, where BC rejects the
mutated data and the kill is credited to a suite that asserted nothing. Rung 1 found this shape at
**100% of its 3 scored kills**.

- Both a **raw** and a **false-kill-adjusted** kill rate are reported.
- Every killed swap's `killingTestFailure` (R86) is quoted in full in the analysis output.
- A kill whose text is a BC platform rejection (overflow, length, type conversion) rather than an
  assertion failure is counted separately. **Nothing classifies this automatically** — R121 is open
  because the only proposed discriminator was measured wrong at a 75% false-positive rate — so the
  split is a reader's judgement, performed by hand and SHOWN, mutant by mutant.
- A kill with NO recorded failure text cannot be classified and is reported as unclassifiable, never
  silently counted as a real kill.

## Baseline expectation, added here (a new gate, not a retune)

Rung 1 measured **1,240 of 1,311 baseline tests passing — 71 failures** on this app and environment.
A blanket "baseline green" gate would refuse this project outright, so the expectation is bounded
instead:

- **Expect 1,250–1,400 discovered baseline tests, with no more than 100 failing.**
- More than 100 failing, or a `stale-test-app` caveat, means the environment or the deployed test
  app moved since rung 1. That is a finding to record BEFORE any rate is read, not a caveat to
  bury: R55 measured that tests failing at baseline drop out of the green set, so a mutant covered
  only by them is recorded `no-coverage` rather than `survived` — a real survivor turned into a
  non-finding, which biases the rate UPWARD.

## The resume plan, written before the run (R85 requirement 3)

Rung 1 lost roughly 142 mutants to an HTTP 502 that quarantined the tier at M0487. This is the plan
for that happening again, fixed now so it is not improvised afterwards.

1. **Do not re-run from scratch.** A fresh run would re-publish, re-baseline and re-measure, and its
   verdicts would not be comparable to the partial one.
2. **Clear the quarantine explicitly**: `lethal clear-quarantine` against the same config. A tier a
   prior session marked stranded refuses the next session before even a readiness probe, so this is
   a required step and not an optional one.
3. **Resume by run id, never bare `--resume`**: `--resume-run <id>`, with the id read from the
   partial run's own output. Measured (R89's second defect): bare `--resume` found a valid
   unfinished run with 113 verdicts and created a fresh run anyway, printing no `RESUMED:` banner.
4. **A resumed run IS admissible for this rate**, and that is decided here rather than after seeing
   it. The rate is over scored swap mutants, and a verdict carried by identity from the partial run
   was measured the same way by the same configuration against the same environment. The composite
   report carries the `resumed` caveat and `validity.executionContexts` separates carried verdicts
   from freshly measured ones; both are quoted in the result.
5. **At most two resumes.** A third failure is recorded as an environment finding and the rate is
   read on whatever scored, with the shortfall stated.
6. **If the environment is unrecoverable**, the run is abandoned and this file plus the partial
   report are committed as a negative result. An unreproduced finding is a finding (rule 5).

## What this run does NOT establish

- **Not a project mutation score.** The scope is one operator; the report flags itself
  `operator-narrowed` and says so.
- **Not a per-operator comparison.** No other operator's mutants run, so nothing here ranks
  `swap-call-arguments` against `empty-block` or any other.
- **Not equivalence.** No mutant is tagged equivalent; a survivor may be one, and the `< 40%` band
  above is the only place that obligation is written down.
- **Not a classifier for false kills.** It produces the corpus R121 needs; it does not close R121.

## The gate list, in one place (rule 3 — this is what a later stage must carry)

1. Cardinality: the report holds exactly 523 mutants.
2. Every one of them has `operatorName === "lethal.swap-call-arguments"`.
3. Baseline: 1,250–1,400 tests discovered, at most 100 failing, no `stale-test-app` caveat.
4. `validity.caveats` contains `operator-narrowed` and does NOT contain `tests-narrowed`.
5. Every killed swap has a non-empty `killingTestFailure`, or is reported unclassifiable by name.
6. The bar is applied to the first-party partition only, and only if it scored >= 30.

Items 3 and 5 are not derivable by `campaign anchors`, which evaluates `baseline-green`,
`coverage-location` and `killed-at-least-one`. They are checked by reading the report and are named
here so a clean `campaign anchors` exit cannot be read as "all of my expectations passed".
