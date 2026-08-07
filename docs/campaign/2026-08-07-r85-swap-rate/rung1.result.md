# Rung 1 — result

**The run did NOT produce a usable rate. It produced something more useful: every scored swap was a
FALSE KILL, and without R86 all three would have been reported as the suite catching them.**

Run 2026-08-07 against Continia environment `f5f11bf2`, DO `do-lethal/Cloud`, full 1,311-test
baseline. Report: `rung1.report.json`.

## The bar is NOT applied, and that is the honest reading

`rung0.precommit.md` fixed three readings of the kill rate. **None of them is applied here**, because
the run scored **3** swap mutants and a bar written for ~30 cannot be honestly read at n=3. The
pre-commitment recorded a ±18-point limit at 30 observations; at 3 the Wilson interval is
**43.9% – 100.0%**, which excludes nothing.

Saying "100%, so DO's suite already catches argument swaps" would be the exact failure this campaign
was built to avoid. It is not stated, and the number below is reported only so the sample size is
visible beside it.

| | |
| --- | --- |
| swap mutants deployed | 20 (of 30 planned — the run was truncated, see below) |
| killed | 3 |
| survived | 0 |
| no-coverage (excluded) | 17 |
| **raw kill rate** | **3/3 = 100%**, Wilson 95% CI **43.9% – 100.0%** |
| **false-kill-adjusted rate** | **0/3 = 0%** — see below |

## All three kills are the arm E shape. None is a test noticing anything.

R86 (`4f3496b`) records the failing run's own text on every kill. Here is what it shows — all three
kills, all in `Codeunit 6175287 CDO Essential Module License.al`, all the same call:

```
AddFeature(ProductCode, <featureCode>, <NameLbl>, <DescriptionLbl>, GetModuleCode())
                                        ^^^^^^^^^^^^^^^^^^^^^^^^^ swapped
```

| mutant | BC's own words |
| --- | --- |
| M0013 | `The length of the string is 87, but it must be less than or equal to 80 characters.` |
| M0015 | `The length of the string is 102, but it must be less than or equal to 80 characters.` |
| M0017 | `The length of the string is 86, but it must be less than or equal to 80 characters.` |

The two arguments are same-typed, so the operator claimed the site correctly (R84). But the
DESCRIPTION is longer than the 80-character field the NAME is assigned to, so **BC's field-length
validation rejects the data before any assertion runs**.

The killing test is the same one in all three cases —
`CheckFeatureIsEnabled_WhenFeatureEnabledAndCheckNotEnabled_ShouldShowMessage` — and it is a test
about feature-enabled messaging. It asserts nothing whatsoever about feature names or descriptions.
The callstacks confirm it: the failure is raised inside `RegisterModuleFeatures`, four frames below
the test body.

**So the suite noticed none of these three. The platform did.** R85 predicted this shape at 5.2% of
resolvable sites; in this sample it is 100% of the scored swaps.

### This is the measured case for R86, in the wild

Before R86, a killed mutant recorded no reason. All three of these would have read as ordinary kills,
and the reported result would have been *"DO's suite catches 100% of argument swaps"* — a confident,
flattering, and entirely wrong claim, produced by machinery working exactly as designed. R86 landed
this session; this is the first real project it has been used on, and it changed the conclusion from
100% to 0% on the only evidence available.

## Why the run is truncated, and why that does not rescue the rate

Two independent problems, both worth recording:

1. **80% of the scope had no covering test.** `coverage split (batch 0): 181 covered, 713
   no-coverage (80%)`. The seeded rule selected files by swap density and deployed budget,
   deliberately blind to coverage — a legitimate consequence of a rule fixed in advance, and a real
   finding about instrument (b): a coverage-blind file-budget rule spends 894 mutants to score 3
   swaps.
2. **The environment failed mid-run.** `RunMutant failed: HTTP 502`, then
   `LethALControl_GetOperationStatus failed: HTTP 502` — so the lost ack could not be reconciled and
   the tier was **quarantined** at mutant M0487. ~142 mutants never ran. The mutant phase had
   completed 416 s of work by then.

Neither is fixed by resuming: `--resume` would add roughly ten more swap mutants, most of which the
coverage split says would be `no-coverage` too.

**A second run under the same rule is not worth it.** A tighter rate needs a NEW pre-commitment with
a coverage-aware selection rule, written openly as its own campaign, with this result left standing.
Re-tuning this one after seeing its coverage would be selecting on a variable correlated with the
outcome, which is what `rung0.precommit.md` exists to prevent.

## Other caveats, stated rather than buried

- **Baseline red**: 1240 of 1311 tests passed. The 71 failures are excluded from the green set, so a
  swap whose killing test is among them reports as `survived` — this understates the kill rate. It
  did not bite here (there were no survivors) but it would in a larger sample.
- **Coverage attribution warnings**: 7 tests emitted coverage rows where no line fell inside a known
  procedure, degrading them to object level.
- **8 untargeted triggers** in the batch.
- One `error` verdict — the quarantined mutant M0487, recorded `cause: "stranded"` by R114/R122,
  which is itself the first live exercise of that work.

## What this establishes, narrowly

- **Not a rate.** n=3.
- **That false kills are real on a real project, not just in a fixture.** Arm E was built to model
  this shape; here are three instances of it in shipped third-party code, with BC's own text.
- **That R86 changes the answer.** Without it the same run reports 100% instead of 0%.
- **That R121 is the blocking work.** Classifying these is currently a human reading a callstack.
  Three worked examples with full stacks now exist for whoever builds that rule — and note all three
  have the TARGET app on top, the discriminator R86 measured as wrong at 75% false positives, so
  they are also three more counterexamples to it.
