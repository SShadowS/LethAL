# Rung 1 — result

**Gate verdict: PASSED**, after a diagnosis that changed how the run is invoked. The first version of
this file recorded NOT PASSED; that was correct at the time and the history is kept below, because
the reason it failed turned out to be the campaign's most useful finding.

## The passing result

Two clean runs, single-pass, no strands, no quarantines:

| | run 3 | run 4 |
|---|---|---|
| killed | 25 | 25 |
| survived | 107 | 107 |
| no-coverage | 15 | 15 |
| timeout-killed | 1 | 1 |
| **error** | **0** | **0** |
| total | 148 | 148 |
| wall clock | 668.6 s | 565.7 s |

**Per-mutant verdict-identical** — `assertMatchesBaseline` compared run 4 against run 3's frozen
baseline on semantic identity (`astHash` / `codeunitName` / `operatorName` / `operatorMajor`, never
`mutantCode` or `file:line`) and returned clean. Score 19.5%.

Independently verified on the frozen report:

- **Baseline green** — anchor 1. ✅
- **Cardinality 148** — asserted before anything else reads the report. ✅
- **All 107 survivors have `guardObserved === true`** — R46's tripwire. Not one survivor sits behind
  a guard that never fired. ✅

`docs/measurements` says of 2026-07-28: *"a clean, COMPLETE fenced DO run does not exist."* One
exists now, twice.

## What actually blocked it — the finding

Three earlier attempts each stranded and quarantined the tier. The cause was **not** a
non-terminating mutant, and the evidence that settles it is a contrast within one run:

| mutant | operator | site | duration | verdict |
|---|---|---|---|---|
| M0013 @41 | `negate-conditional` on `until … Next() = 0` | genuine infinite loop | 30172 ms | **`timeout-killed`** — handled correctly |
| M0079 @227 | `void-method-call` on `SetCurrentKey` | slow query | 0 ms | stranded |
| M0092 @255 | `void-method-call` on `SetCurrentKey` | slow query | 0 ms | stranded |

Deleting a `SetCurrentKey` does not hang anything — it makes the following filtered query pick a
worse plan and scan. Those mutants are **slow, not hung**. They exceeded R47's hardcoded 30 s floor,
and on the fenced path a budget overrun is indistinguishable from a genuine strand, so the tier
quarantined instead of scoring them.

**`--mutant-timeout-ms 180000` eliminated both strands entirely**, while M0013 still scored
`timeout-killed` — the control proving the distinction is real. Errors went 2 → 0 and the run
completed in a single pass.

So: `--stop-hung-sessions` was never the missing piece for these two. It correctly handles the
genuinely non-terminating mutant. The missing piece was a budget floor appropriate to a codeunit
whose mutants can make a query scan.

## Two errors in the pre-commitment, both mine

**1. Cardinality — 176 was the wrong quantity.** `--dry-run` reports mutation **sites** (raw specs);
`SessionReport.mutants[]` holds **deployed mutants** after §3.2 dedup drops a Tier-1 mutant where a
Tier-2 operator claims the same site. Correct figure **148** — the same distinction the tables gate
already states as "136 deployed mutants (148 raw specs)". A units fix, not a rationalisation.

The gate caught it exactly as designed: `assertCardinality` refused to evaluate any anchor —
*"expected 176, got 148. A gate comparing against a report of the wrong size is not measuring what it
claims."*

**2. Anchor 2 was stale, and it is RETIRED rather than retuned.** It required every covered mutant to
lie inside `SendPeriodStatements` (17–43) or carry object attribution, taken from the 2026-07-28
record — 105 mutants, **92 no-coverage**, covered = `SendPeriodStatements` (12) + 1 object-level.

Measured now: **15 no-coverage of 148**, **133 covered across 14 procedures**. Coverage attribution
was substantially fixed after that record (R61, R62, R63), so the anchor describes a superseded
reality.

It is retired, not rewritten, and not replaced by a whitelist derived from this run — that would be
tautological here and is strictly weaker than what now exists. **The per-mutant frozen baseline
supersedes it**: it pins every verdict, not merely a set of locations. The surviving
false-survivor tripwire is the `guardObserved` check above, which is not tied to any coverage map.

## Corrected record: the `--resume` defect

The first version of this file guessed that run 2's stranded attempt "may have been marked
finished". **The store disproves that.** Queried directly:

| run | `finished_at` | rows |
|---|---|---|
| 1 | NULL (unfinished) | 92 |
| 2 | finished | 148 |
| 3 | **NULL (unfinished)** | 113 |
| 4 | NULL (unfinished) | 86 |

Run 3 was unfinished, with 113 verdicts recorded, when `--resume` ran. It was a valid target.
`--resume` created run 4 fresh anyway, printed no `RESUMED:` banner, and re-measured from scratch —
where the earlier resume of run 1 engaged correctly and said so. **A resume that cannot use its
target should throw, not silently start over**; that is this project's own fail-loudly rule. Cause
undiagnosed; the reproduction is precise and the store rows above are the evidence. Filed under R89.

## Why the earlier baseline was retired

`rung1.resumed-run.baseline.json` / `.report.json` are kept for the record but are **not** the gate's
reference. That run was resumed, carrying 63 verdicts measured by a different published artifact, and
`docs/measurements` bars resumed runs as differential inputs. Comparing a clean run against it showed
three verdict differences that are resume-vs-clean artifacts rather than nondeterminism — a
real-looking signal read off an invalid reference.

## Cost figures that supersede the plan's

| quantity | plan assumed | measured |
|---|---|---|
| per-mutant | ~19.5 s (R45, older scoping) | **~2.5 s mean, 2.9 s median, 3.7 s p95** |
| baseline (narrowed, 56 tests) | 25.0 s | 19.3–47.8 s |
| deploy | 36.8 s/batch | 36.0–97.0 s |
| clean full run (148 mutants) | — | **565–669 s** |
| recovery per strand (now avoidable) | not budgeted | ~10 min |

## Carried to rung 2

- **Use `--mutant-timeout-ms 180000`.** Without it this codeunit cannot finish; other modules with
  `remove-setrange` / `void-method-call` on query-shaping calls will behave the same way.
- **88 of 133 covered mutants are `object`-attributed, 45 `exact`.** Object attribution runs every
  green test for the object rather than a precise covering set — weaker precision, and worth watching
  where rung 2's survivors come from.
- Prefer `--resume-run <id>` over bare `--resume` until R89's selection defect is understood.
