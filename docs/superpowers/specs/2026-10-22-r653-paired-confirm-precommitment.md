# R-653 pre-commitment: one request [NONE, M] confirms a fail kill, live legs (nothing run yet)

Source: the adopted plan (`docs/superpowers/plans/2026-10-22-r653-paired-confirm-r2.md`, with `-r3.md` overriding
r2 where they differ) and the reviews (`/coord/reviews/R-653-plan/adversary-r1..r3.md`). It reuses R-652's legs,
commands and STOP rules (`docs/superpowers/specs/2026-10-22-r652-bound-per-send-precommitment.md` and addendum 1).
Everything there that is not restated here stands.

Committed to master by lethal-code on 2026-10-22, before the build was finished and before any leg below ran.

## 0. What is under test

- **Code:** `lethal/r653`. The build is not finished yet, so the head sha is not known. **Addendum 1 names it**, after
  the build review approves and before any leg runs. R-653 merges AFTER R-654 S1 (agreed with lethal-preproc), so the
  final head is lethal/r653 rebased or merged onto the master that carries S1. Every leg checks that sha (the
  final-head rule).
- **Worktree, binary, CDO pin:** as R-652 §0 and §1. The worktree is `/work/lethal-wt/r653`, on the same edge build
  `0642f9b27f0e55912d434fe231543b1bedcf98a14fc38a8b7f08788b11ac8720`. R-635 addendum 1's `coverage.cobertura.xml`
  is moved aside after each leg.
- **No BC server** is used. bc2 is off-limits (orchestrator, 2026-10-22).
- **The claim:**
  - No verdict, killing test or `killReproduced` moves in any leg.
  - On serve-entries, each cold fail kill whose confirm passes costs ONE live request, not two.
  - The one-shot legs are unchanged, because the pair is a no-op there (G1).

## 1. Legs, in run order (R-652 §1's commands, with `r652` → `r653`; outputs under `/coord/handoff/R-653/live/`)

`C=/coord/handoff/R-653/live/control`, `E=/coord/handoff/R-653/live/entries`, `Q=/coord/handoff/R-652/live`.

| # | Id | Compared with |
|---|---|---|
| 1 | E0-S | `bcdev.baseline.json`; `report-diff $Q/control/S1.report.json $C/S1.report.json` IDENTICAL |
| 2 | E1 | `$C/S1.report.json`, then `bcdev.baseline.json`; `report-diff $Q/entries/S1.report.json $E/S1.report.json` IDENTICAL |
| 3 | E0-T | the v3 tables record (`judgeLegT`); `report-diff $Q/control/T.report.json $C/T.report.json` IDENTICAL |
| 4 | E2 | `$C/T.report.json`, then the tables record; `report-diff $Q/entries/T.report.json $E/T.report.json` IDENTICAL |
| 5 | E0-D | `docs/measurements/r594/bc3-A.report.json`; `report-diff $Q/control/D1.report.json $C/D1.report.json` IDENTICAL |
| 6 | E3a | `$C/D1.report.json`, then bc3-A; `report-diff $Q/entries/D1.report.json $E/D1.report.json` IDENTICAL |
| 7 | E3b | `$C/D1.report.json`, then bc3-A; `report-diff $Q/entries/b/D1.report.json $E/b/D1.report.json` IDENTICAL |
| 8 | V2 | `LETHAL_ITEST_ALRUNNER=1 bun run itest:alrunner -- --parallel=3`: its frozen baselines. It is required because backend.ts and orchestrator.ts are shared. |

- **The `report-diff` against R-652's entries reports is new.** It pins verdict and killing test per mutant against
  the last accepted serve-entries run on the same binary. `report-diff` does not compare `killReproduced`. That stays
  pinned by each leg's own R577 assertion ("kills reproduced: all", R-635 §3).
- If S1 is on the final head and v2 is retired by then, V2 runs as that head's `itest:alrunner` defines it, and its
  verdict is PASS.

## 2. Pre-committed figures (any miss is a STOP)

Unchanged from R-652 §2:
- the killed / survived / no-coverage counts;
- the per-mutant differences (0, beyond E0-T/E2's 7 pre-named held rows M0157-M0159 and M0161-M0164);
- daemons and cachedFalse (E1 1/1, E2 8/8, E3a 1/1, E3b 1/1);
- warm-ups, prefetch, coverage and echo (E1 1/1/0/0, E2 8/4/0/0, E3a 1/1/37/74, E3b 1/1/37/37);
- echo and second-echo mismatches, and prefetch drops (all 0).

**New counters** (printed in each entries leg's `entries` line):
- P = `pairRequests` that the build counts as pairs whose confirm PASSED;
- F1 = `pairFallbacks1` (the M entry was cut; +1 request);
- F2 = `pairFallbacks2` (the NONE entry was cut; +2 requests).

| Leg | P expected | liveRequests | boundChecks |
|---|---|---|---|
| E1 | 3 | 6 − P + F1 + 2·F2 | 8 − P + F1 + 2·F2 |
| E2 | 290 | 595 − P + F1 + 2·F2 | 607 − P + F1 + 2·F2 |
| E3a | 51 | 102 − P + F1 + 2·F2 | 141 − P + F1 + 2·F2 |
| E3b | 51 | 102 − P + F1 + 2·F2 | 141 − P + F1 + 2·F2 |

- F1 and F2 are expected to be 0. Any other value is allowed only if the relations hold exactly, and every fallback
  is named from the log.
- **P must equal the number of the leg's kills whose cold confirm passed** (`killReproduced` true or
  `kill-not-reproduced`). The leg's own report counts these, and that count is checked by name. A P different from
  its expected value is a STOP unless the report's own count explains it exactly.
- `boundChecks = warmups + prefetch + live + coverage` holds exactly on every leg.
- `entriesSent` is reported, not pre-committed.

## 3. The CDO gain (a prediction: it decides the speed claim, not the correctness gate)

Measured against R-652's E3a (bound 25 268 ms over 141 checks, live 22 650 ms over 102 requests, loop 83 481 ms) and
E3b (loop 76 080 ms):

| Figure | Predicted | The range that CONFIRMS the gain |
|---|---|---|
| E3a `boundChecks` | 90 | exactly 90 (a STOP otherwise, §2) |
| E3a `bound` | about 16 s | 11 to 20 s |
| E3a `live` | about 12.6 s | 8 to 17 s |
| E3a mutant loop | about 64-74 s | at most 76 s (at least 7.5 s faster than R-652) |
| E3b mutant loop | about 57-67 s | at most 69 s |

A miss with every verdict equal means the gain is NOT CONFIRMED, by R-652 §3's rule: one re-run of E3a alone, and
both runs reported. E3a and E3b run with no other heavy job.

## 4. STOP rules

R-652 §4, plus:
- any `report-diff` against R-652's entries reports that is not IDENTICAL;
- a P, F1 or F2 that breaks the §2 relations;
- any `pairRequests > 0` on a one-shot leg (G1).

## 5. Heavy jobs and order

As R-652 §5: one leg at a time, in §1's order, V2 last and alone. Results go to `/coord/handoff/R-653/live/results.md`.
