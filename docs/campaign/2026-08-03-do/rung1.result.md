# Rung 1 — result

**Gate verdict: NOT PASSED.** The determinism gate was not achieved. What follows is what was
measured, including two errors in the pre-commitment that are mine rather than the tool's.

## What ran

Environment `f5f11bf2-4b02-48f1-9707-2bd49f81bf2b`, DO pinned at `5f2a71d3`, alc 17.0.29.44223,
selector ids 6175468/6175467/6175466.

| attempt | outcome | verdicts | notes |
|---|---|---|---|
| run 1 | stranded at M0092, quarantined | 92 | `--stop-hung-sessions` on |
| run 1 + `--resume` | completed | **148** | resume engaged, carried 63, skipped 2 stranded identities unscored |
| run 2 | stranded, quarantined | 113 | fresh run, same flags |
| run 2 + `--resume last` | **resume did NOT engage** | 86 | no `RESUMED:` banner; produced fresh verdicts and stranded again (3 errors) |

Run 1's completed result — the one real measurement of this campaign so far:

**148 deployed mutants — killed 22 / survived 108 / no-coverage 15 / timeout-killed 1 / error 2.**
Baseline **green**. Score 17.6%. Total 336.8 s (deploy 95.9 + baseline 45.4 + mutants 186.4).

Frozen per-mutant to `rung1.baseline.json`; report archived as `rung1.report.json`.

## The two pre-commitment errors, both mine

**1. Cardinality: 176 was the wrong quantity.** `--dry-run` reports mutation **sites** (raw specs);
`SessionReport.mutants[]` holds **deployed mutants** after §3.2 dedup drops a Tier-1 mutant where a
Tier-2 operator claims the same site. The real figure is **148**. This is the same distinction the
tables gate already states as "136 deployed mutants (148 raw specs)" — the plan simply conflated
them. Correcting it is a units fix, not a rationalisation of a result.

**2. Anchor 2 was stale and would have failed for the wrong reason.** It required every covered
mutant to lie inside `SendPeriodStatements` (lines 17–43) or carry object-level attribution, taken
from the 2026-07-28 record: *"its 13 covered mutants are exactly `SendPeriodStatements` (12) plus one
object-level entry"*, out of 105 with **92 no-coverage**.

Measured today: **15 no-coverage of 148**, with **133 covered across 14 procedures** — 35 of them
outside that range without object attribution. Coverage attribution was substantially fixed after
that record (R61, R62, R63). The anchor describes a superseded reality.

**It is recorded as FAILED rather than retuned.** Rewriting an expectation after seeing the data is
exactly the rationalisation the pre-commitment rule exists to prevent. A corrected anchor set must
be derived deliberately, from this measurement, and marked as second-generation.

The genuinely good news inside that failure: coverage on this codeunit went from 88% no-coverage to
10%. That is the largest single change from the 2026-07-28 baseline and it is in the safe direction.

## The blocking finding

**This codeunit cannot complete a clean run on the hosted topology.** Every fresh attempt stranded:
run 1 at M0092, run 2 twice. `--stop-hung-sessions` **helps but does not solve it** — one mutant
scored `timeout-killed` (the stop worked) while another stranded anyway (the stop did not). R53's
own caveat said the flag was unmeasured on hosted; it is now measured, and the answer is "partial".

`docs/measurements` says of 2026-07-28: *"a clean, COMPLETE fenced DO run does not exist"*. That is
still true today, with `--stop-hung-sessions` available and after a year of fixes. The difference is
that `--resume` can now carry a run to completion — when it engages.

**Recovery cost, measured:** ~10 minutes per strand (env stop/start ≈ 3.5 min, `force-reset-lease`,
`clear-quarantine`, then the resumed run). Every rung-2 module will pay this per strand.

## Unexplained, and not to be papered over

Run 2's `--resume last` printed **no `RESUMED:` banner** and produced 86 fresh verdicts instead of
continuing the 113 already recorded. Run 1's resume engaged correctly and said so. The difference
was not diagnosed. Candidate: `--resume last` selects the most recent **unfinished** run matching the
configuration fingerprint (R52), and run 2's stranded attempt may have been marked finished. Not
confirmed — stated as the open question it is.

## Cost figures that supersede the plan's

| quantity | plan assumed | measured here |
|---|---|---|
| per-mutant | ~19.5 s (R45, older scoping) | **~2.5 s mean, 2.9 s median, 3.7 s p95** |
| baseline (narrowed) | 25.0 s | 18.9–47.8 s |
| deploy | 36.8 s/batch | 36.0–95.9 s |
| recovery per strand | not budgeted | **~10 min** |

Rung 2 planning must use these. A 1,000-mutant module is roughly 45 minutes of mutant time plus
recovery, not the multi-hour figure the plan carried.
