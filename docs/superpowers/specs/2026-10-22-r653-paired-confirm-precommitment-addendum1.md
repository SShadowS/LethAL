# R-653 pre-commitment, addendum 1: the head, and the corrected counter relations (before any leg ran)

Base: `docs/superpowers/specs/2026-10-22-r653-paired-confirm-precommitment.md` (master 2500dbd3). Source: build
review r1 (CHANGES, `/coord/reviews/R-653-build/review-r1.md`) and r2 (APPROVE, `review-r2.md`), and
`/coord/handoff/R-653/build.md`. Committed to master by lethal-code before any leg ran.

## 1. The head

- **First run: `lethal/r653` at 0dda9a84** (pushed, [skip ci]). It is master 2ee97fc3 plus the build, and R-654 S1 is
  not yet in it. This run is early evidence on the built code.
- **Final head:** R-653 merges after S1 (agreed with lethal-preproc). After merging the master that carries S1, all
  of §1's legs run again on that head under addendum 2, which names its sha. Only the final-head run closes R653.
  Both runs are judged by the same figures.

## 2. Corrected relations (they replace base §2's table and the definition of P)

Counters from each entries leg's `entries` line:
- P = `pairRequests`: kills whose pair was consumed at `activate(M)`, which means the cold confirm passed;
- F1 = `pairFallbacks1`: the M entry was cut (a cut AT the NONE codeunit entry is F1, since the cut entry stands);
- F2 = `pairFallbacks2`: the NONE entry did not stand;
- F1p and F2p = `pairFallbacks1Passed` and `pairFallbacks2Passed`: the fallbacks whose confirm passed.

A fail kill costs old = 1 + c requests, where c = 1 when its confirm passes.

| Leg | P expected | liveRequests | boundChecks |
|---|---|---|---|
| E1 | 3 | 6 − P + F1p + F2 + F2p | 8 − P + F1p + F2 + F2p + (warmups − 1) |
| E2 | 290 | 595 − P + F1p + F2 + F2p | 607 − P + F1p + F2 + F2p + (warmups − 8) |
| E3a | 51 | 102 − P + F1p + F2 + F2p | 141 − P + F1p + F2 + F2p + (warmups − 1) |
| E3b | 51 | 102 − P + F1p + F2 + F2p | 141 − P + F1p + F2 + F2p + (warmups − 1) |

- **Why the warm-up term:** a cut restarts the daemon, and the new daemon's warm-up makes its own bound check. With
  F1 = F2 = 0 there is no cut, so warm-ups equal R-652's and the term is 0.
- **What P must equal:** P must equal the count of the leg's FAIL kills (timeout kills excluded) whose cold confirm
  passed, read from the leg's own report. A P that differs from its expected value is a STOP, unless that count
  explains it exactly.
- **Expected values:** F1, F2, F1p and F2p are expected 0. Any other value must be named from the log.
- **Unchanged:** `boundChecks = warmups + prefetch + live + coverage` and every other base §2 figure.

## 3. Unchanged

Base §1 (legs and comparisons), §3 (gain ranges), §4 (STOP rules, with the relations above) and §5 (order).
