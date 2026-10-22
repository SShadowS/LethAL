# R-653 plan r3: r2 with the delta review r2's fixes

Base: `plan.r2.md`. Everything there stands except what this file changes. Review: `adversary-r2.md` (CHANGES).
Probe fact: `/coord/handoff/R-653/order-probe/result.md` (no leak of WorkDate, GlobalLanguage, rows or a
SingleInstance global between entries or across requests; per-test reset).

## C1. Order: confirm (NONE) FIRST, reproduction (M) SECOND. Replaces r2 §1.

The request is `[echo NONE, codeunit cu under NONE, echo M, codeunit cu under M]`.

**Why (the sandwich).** The three runs are then: the kill under M, the confirm under NONE, the reproduction under M,
as today. A change of the killer's outcome over time (F1, the clock) can then never give a kill:
- a fail→pass flip before the confirm makes the reproduction pass too: `kill-not-reproduced`;
- a flip after the confirm: the confirm already failed: `unstable`.
Reproduce-first lost this: kill and M fail before midnight, NONE passes after it → `killed`.

**Leftover state between the two entries.** Either order relies on per-test isolation for state that passes from
the first entry to the second (r2's "a confirm can only fail" was wrong: leftover state could also make it pass).
Confirm-first relies on the same isolation today's flow already relies on across requests, and the probe measured
it for the four kinds above. Kinds not probed are a named residual, the same as today's across requests.

**R612 cut.** `request()` keeps entries up to the first unkept one.
- NONE absent (cut at or before it): nothing stored; today's two live calls. +2 requests. Counter
  `pairFallbacks2 += 1`.
- NONE present, M absent: keep the NONE answer for the confirm; the reproduction goes live as today. +1 request.
  Counter `pairFallbacks1 += 1`.
The pair's M rows are only ever consumed by `activate(p.mutantId)` after the confirm was consumed (r2 §2 order).

## C2. A stored pair never outlives its kill. Adds to r2 §2.

- Drop `pair` and `pairVerdict` at the start of every public method except the `activate` that consumes them:
  `run` (when it is not reading the consumed pair's ref), `prefetchMutants`, the baseline bracket
  (`baselinePhase`), `deploy`, `closeDaemon`, and in `resetLayoutState`.
- `activate` with anything other than the expected next id drops the pair (r2).
- `pairVerdict` is read at most once.

## C3. Tests: changes to r2 §5.

- **P2** body order is echo NONE, cu NONE, echo M, cu M. Red if flipped.
- **P5** split: P5a NONE absent → `pairFallbacks2 1`, confirm and reproduction both live; P5b M absent →
  `pairFallbacks1 1`, confirm served from the pair, reproduction live, M rows from the pair never scored.
- **P9 stale pair dropped**: after `sendKillPair` with no consuming `activate(null)`, each of the baseline bracket,
  `prefetchMutants`, `deploy`, and a Decision 11 `activate(null)` that follows another public call serves nothing
  from the pair (live send counted). Red when the drop is removed.
- **P10** a stored `noneVerdict` is returned by one `run` only; a second `run` goes live.
- **P8** both directions: a 2-group prefetch refusal still latches; a 1-group prefetch refusal does not; a pair
  refusal does not.

## C4. Pre-commitment counters. Replaces r2 §8's table.

P = `pairRequests`, F1 = `pairFallbacks1` (M cut, +1 request), F2 = `pairFallbacks2` (NONE cut, +2 requests). F1
and F2 are expected 0; any other value must hold the formulas exactly and be named from the log.

| Leg | P expected | liveRequests | boundChecks |
|---|---|---|---|
| E1 | 3 | 6 − P + F1 + 2·F2 | 8 − P + F1 + 2·F2 |
| E3a | 51 | 102 − P + F1 + 2·F2 | 141 − P + F1 + 2·F2 |
| E3b | 51 | 102 − P + F1 + 2·F2 | 141 − P + F1 + 2·F2 |
| E2 | 290 (any other P explained by name from the log) | 595 − P + F1 + 2·F2 | 607 − P + F1 + 2·F2 |

- P equals the number of position-1 fail kills on the cold-confirm branch; the build prints it per leg, and a P
  other than expected is a STOP only if it cannot be named from the log.
- `entriesSent` is reported, not pre-committed (R612 cuts and fallbacks change it).
- Unchanged from R-652: coverageRequests, echoRequests, daemons, cachedFalse; `boundChecks = warmups + prefetch +
  live + coverage`; per-mutant `verdict`, `killingTest`, `killReproduced` identical to R-652's.
- CDO timing bounds as r2 §8.

## C5. Folded in from delta review r3 (APPROVE)

- Store the pair only after `request()` returns (it may call `closeDaemon` on a cut or a dirty daemon).
- C2's rule is "every public method drops the pair", except: the consuming `activate`, and `run` only when
  `pair.next === "mutant"` and the ref matches. `closeDaemon` (private) also drops it; at most a lost kill.
- Tests: **P11** the reproduction is served from the pair with no extra live send (red if `run` drops a pair it
  should keep); **P12** a `run` of a different ref drops the pair.
- C4: P counts pairs whose confirm PASSED (a failing or refused confirm costs one request either way). The build
  prints P under that definition.
