# R85 — the rate at which a real suite notices a real argument swap

**Pre-commitment. Written and committed BEFORE the run, before any verdict is seen.**
Campaign id `2026-08-07-r85-swap-rate`. Instrument **(b)** of R85: a LethAL run against Continia
Document Output, which measures the pipeline at scale and yields the swap rate as a by-product.

R85's own warning is the reason this file exists: *"pre-commit the bar BEFORE any rate is seen and
pre-commit the sampling rule with its seed, or the sample becomes the argument."*

---

## The population changed since R85 was written, and the row is now stale

R85 records the population as **390** sites, from `swapCallArguments.targets` over `do-rel2/Cloud`.
That figure was measured before **R87** (`ac9ce94`), which fixed `resolveIdentifierType` answering
from the wrong object. Re-measured on the same corpus with the same instrument, set-diffed rather
than counted:

| | sites claimed |
| --- | --- |
| before R87 | 390 |
| **after R87** | **437** |
| lost | 0 |
| gained | 47 |

**The sampling frame for this campaign is the 437, not the 390.** Anyone comparing this run to
R85's text must know the frame moved.

## The scope rule, fixed here

No operator filter exists — `--only` selects FILES, so a run over swap-bearing files necessarily
executes every other operator's mutants in those files too. The scope is therefore chosen by budget
on **deployed** mutants, not on swap mutants.

1. Take the files holding at least one `lethal.swap-call-arguments` site: **91 of 554**.
2. Sort by path, then shuffle with `mulberry32` seeded **20260807**. Sorting first makes the shuffle
   the only source of randomness.
3. Walk the shuffled order. Admit a file if it keeps cumulative **deployed** mutants at or below
   **900**; otherwise skip it and continue.

Deployed, never sites: **R92** exists because the previous campaign pre-committed a site count as a
mutant count and `assertCardinality` correctly refused every anchor. The 900 budget sits under the
1000 pre-flight limit so the run needs no `--allow-large-run`.

Selecting the densest files instead would have been a convenience sample. It was tempting — the
three densest hold 95 swap mutants against this rule's 30 — and that is exactly why the rule was
fixed first.

**Result of the rule: 12 files, 894 deployed mutants, 30 of them swaps.** Reproduce with
`scripts/`-free `r85-select.py` logic recorded above; the chosen list is in `rung1.scope.md`.

## The precision limit, stated before the fact

30 swap observations give a 95% confidence interval of roughly **±18 percentage points**. This run
produces an *indicative* rate, not a point estimate, and no wording in the result may imply
otherwise. Recording it here so it cannot be quietly dropped once a number exists.

Instrument (b) is inefficient for this question by construction: 894 mutants are executed to observe
30 swaps (3.4%). That inefficiency is itself a finding about the instrument, and it is the reason
R85 lists the hand-swap instrument (a) as the cheap one for the RATE.

## The bar, fixed before the rate is seen

Primary measure: **swap kill rate** = killed / (killed + survived) over mutants whose
`operatorName` is `lethal.swap-call-arguments`. `no-coverage` and `error` are excluded from the
denominator and reported separately.

| observed rate | pre-committed reading |
| --- | --- |
| **≥ 90%** | DO's suite already catches argument swaps. The operator is mechanically sound (R82) but low-yield on this project; that is a reason to keep it off by default, not to withdraw it. |
| **40–89%** | The operator finds real assertion gaps at a useful rate. Ships as a default Tier-1 operator. |
| **< 40%** | A large gap. Before celebrating, the survivors must be checked for EQUIVALENT mutants — a commutative callee (`Max(a,b)`) survives a swap because the swap changed nothing, and R82 deliberately sets no `equivalenceHint`. An unexamined sub-40% rate is not a finding. |

## The false-kill rule, and why it is mandatory here

R85 measured that **12 of 233 resolvable call sites (5.2%) declare different parameter types at the
two swapped positions**, 6 of them same-base-different-length — the arm E shape, where BC rejects
the mutated data and the kill is credited to a suite that asserted nothing. At 5.2%, roughly one to
two of these 30 swaps is expected to be one.

**R86 (`4f3496b`) is what makes this checkable**, and it landed after R85 was written: every killed
mutant now records `killingTestFailure`, the failing run's own text. So:

- Both a **raw** kill rate and a **false-kill-adjusted** kill rate are reported.
- Every killed swap's `killingTestFailure` is read and quoted in the result.
- A kill whose text is a BC platform rejection (overflow, length, type-conversion) rather than an
  assertion failure is counted separately. **Nothing classifies this automatically** — R121 is open
  precisely because the only proposed discriminator was measured wrong at a 75% false-positive rate
  — so this is a reader's judgement, performed by hand and shown.

## What this run does NOT establish

- **Not a project score.** The scope is 12 of 554 files, chosen by a budget rule.
- **Not a per-operator comparison.** Other operators' mutants are executed because they cannot be
  excluded, and their verdicts are incidental to this question.
- **Not equivalence.** No mutant here is tagged equivalent; a survivor may be one.

## Environment

Continia hosted environment `f5f11bf2-4b02-48f1-9707-2bd49f81bf2b` ("lethal-do-campaign"), BC
28.0.0.0, expires 2026-08-18. Status at pre-commit time: **Stopped** — it is started for this run.
Config `U:/Git/do-lethal/lethal.config.envtool.json`. Billed; the run was explicitly authorised.

Expected cost at the campaign's measured ~19.5 s/mutant (p95 43 s): **~5 hours** for 894 mutants,
plus baseline. `--mutant-timeout-ms` is left at R91's 180 s floor, which eliminated every strand on
the previous campaign.
