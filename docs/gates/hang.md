# itest:hang

`LETHAL_ITEST_HANG=1 bun run itest:hang` runs `fixtures/sandbox-hang` with its tests. Its mutants
never terminate, and the gate scores them instead of setting them aside (R53). It is the only
gate that exercises the control app's stop (`StopHungRunAt`). So an AL edit to
`extensions/lethal-control` is verified by an `alc` compile and by this gate. The connection comes
from the gitignored config in `fixtures/sandbox-hang/` that `LETHAL_ITEST_CONFIG` names (see
[servers.md](servers.md)). On 2026-10-21 it passed on `bc2` under R-583's code (R-583), and on
`bc3` twice. The first `bc3` pass was under master's code with the pre-runtime-17 fixtures. The
second, 18:25-18:35 UTC, was under R-389's code with the runtime-17 fixtures and LethAL Control
1.0.0.23 (log `/coord/handoff/R-389/bc-live/hang-bc3.log`).

It runs four legs, in this order on purpose:

- ON (`--stop-hung-sessions`): the stop works, and BC's 408 answer confirms each hang. This leg
  leaves the tier clean.
- SINGLE (R-204b): the ON leg with `--no-group-runs`, so every covering test goes through
  `RunMutant` alone. This leg is frozen in `hang.single.baseline.json`.
- BASELINE (R-658): stops an UNMUTATED test. It runs without `--stop-hung-sessions`, with a 10 s
  baseline budget, `--tests-only` on `HangBaselineTests.Codeunit.al` (codeunit 79451 "Hang Z
  Baseline Tests") and `--operator conditional-boundary`. `SleepsPastTheBaselineBudget` sleeps
  25 s, so LethAL stops it on the server at 10 s, on the coverage path. The gate then checks 20
  assertions: the stopped test is a `timeout` with BC's own stop words and is not green, the next
  test shows no leaked coverage, `ZZDrainsAfterTheStop` still covers and kills the `DrainQueue`
  mutant (the control that coverage did not silently return nothing), every other mutant is
  `no-coverage`, there is no quarantine and no baseline snapshot, and a fresh control-app lease is
  granted and released afterwards. Any failure in this leg is a STOP: exit 5, no further leg, no
  teardown force-reset, the evidence copied out, and the server's coord lease held until the
  owner restarts it. The rule and its wrapper are in
  `docs/superpowers/specs/2026-10-22-r658-hang-baseline-leg-precommitment.md`; the judgements are
  in `packages/runner/itest/hang-baseline-leg.ts`. A quarantine in ON or SINGLE is a STOP too.
- OFF: puts the tier in quarantine on purpose, and is torn down afterwards. Since R658 every
  baseline has the stop, even with the flag off: only the MUTANT runs depend on the flag. At the
  120 s default no baseline test of this leg runs near its budget, so nothing in it moves.

The three new tests also run in the ON, SINGLE and OFF legs, at the 120 s default, where all three
pass. Their names sort after codeunit 79450's, so the existing killers stay first and no new test
runs under a mutant (plan test F1 in `test-order.test.ts`). They add one baseline pass row each
per leg, and about 25 s per leg.

The BASELINE leg runs only on `bc2` or `bc3`, never on `bc1`, and only through the wrapper
`/coord/handoff/R-658/run-hang-gate.sh`, which holds the lease on a STOP.

The ON and OFF legs guard against different faults. One fault is minting a kill from LethAL's own
abort. The other is recording a kill without BC's confirmation. Neither leg is redundant. See the
header of `hang.itest.ts`.

## What no gate covers: loops in installed dependent apps

LethAL's hang refusals (R164) are decided over the session's own project. A loop in another installed
app that depends on the target and calls into it is in no hang context. R-634 measured the price on dc,
do and cdo: adding each same-corpus dependent's source to the target's hang context refused 0 more
deployed keys on all 25 pairs. A positive control on bch refused 16, so the method finds the shape where
it exists. The method undercounts a path that runs through a third app. See R634.

## Frozen figures

```json gate-figures
{
  "gate": "itest:hang",
  "baselines": {
    "hang.single.baseline.json": { "killed": 24, "survived": 9, "timeout-killed": 5 }
  },
  "constants": {
    "HANG_FIGURES.budgetMs": 20000,
    "HANG_FIGURES.warmKills": 4,
    "HANG_FIGURES.coldConfirmsOn": 4,
    "HANG_FIGURES.coldConfirmsSingle": 5,
    "HANG_FIGURES.stoppedCallsOn": 6,
    "HANG_FIGURES.baselineBudgetMs": 10000,
    "HANG_FIGURES.baselineSleepMs": 25000,
    "HANG_FIGURES.baselineLegMutants": 5,
    "HANG_FIGURES.baselineLegKilled": 1
  }
}
```

- The SINGLE leg scores 24 killed, 9 survived and 5 timeout-killed.
- Each mutant gets a 20 s budget. That is far above a terminating mutant's measured 66 to 141 ms,
  and far below anything that would make a slow but correct mutant look like a hang.
- The ON leg has 4 warm kills (R206), all in the `SpinUntil` arm: three warm failures and one warm
  timeout.
- Every timeout at position 1 is confirmed by one unmutated `RunMutant` call before it is scored
  (R516). There are 4 such confirms on the ON leg and 5 on the SINGLE leg
  (`docs/superpowers/specs/2026-10-08-r516-hang-confirm-every-timeout-precommitment.md`).
- Since R582 every kill is re-run once under the mutant after its confirm passed (R577's rule), a
  timeout kill at the budget its first run was sent. So BC stops every hanging mutant TWICE: the
  gate checks that each `timeout-killed` mutant has exactly 2 mutated `timeout` rows for its
  killing test, both carrying "stopped the session" and "StopSession" and both in
  [20 000, 50 000) ms. On the ON leg the re-run of line 145's warm timeout is a group call;
  the other four re-run as single calls.
- The ON leg's group calls are `scored + 2 x warmKills` (one replay and one re-run per warm kill),
  42 before R582 and 46 since. 6 of them are stopped and answer no session id
  (`stoppedCallsOn`): the 5 first timeouts and line 145's re-run. So the distinct grouped session
  ids are 46 - 6 = 40. The re-runs add about ten 20-25 s stops, which took the gate to about
  15 minutes.
- The BASELINE leg (R-658) uses a 10 s baseline budget (`baselineBudgetMs`) against a 25 s
  `Sleep` (`baselineSleepMs`). It has 5 `conditional-boundary` mutants (`baselineLegMutants`) and
  exactly one kill (`baselineLegKilled`), the line-103 `DrainQueue` mutant by
  `ZZDrainsAfterTheStop` at position 1. Both are pinned as numbers, never read back from the
  report. The leg must finish in under 5 minutes. With it, and the three new tests' 25 s in each
  of the other legs, the gate takes about 20 minutes, bounded at 25.
- The ON leg's per-mutant table (`EXPECTED_ON` in `hang.itest.ts`, keyed by line and operator,
  with `killPosition` where it was pre-committed) is asserted by the gate and not pinned here.

## History

R-204b's single-path leg was recorded on 2026-10-06 on Cronus28 (record run exit 3, confirm run
PASS), per `docs/superpowers/specs/2026-10-06-r204b-hang-single-path-precommitment.md`. R164 and
R179 added the `NextRow` and `DrainQueue` arms, which measure the loop cessions. R196 refuses
assignment sites that could hang. Their stories are in the comments on `EXPECTED_ON`.

R-389 (2026-10-21) published LethAL Control 1.0.0.23, which adds `DependentCount`, to `bc3`. The
gate then passed there with both the ON and SINGLE legs at 24 killed / 5 timeout-killed /
9 survived. As a fact: another lane's 8-worker local unit run overlapped it from 18:29:01 to
18:29:21 UTC (about 20 s), and another `itest:hang` ran beside it on `bc1`. No figure moved.

R582 (2026-10-22) switched R577's "a kill must reproduce" rule on for bcdev. No verdict moved;
the ON leg's group calls went from 42 to 46 and its distinct grouped session ids from 37 to 40,
and every timeout kill now carries two BC stops. This gate is the first live proof of R577's
timeout half (`docs/superpowers/specs/2026-10-22-r582-bcdev-kill-reproduction-precommitment.md`).

R658 (2026-10-22, built offline, not yet run live) stops every unmutated run at its budget. It
added the BASELINE leg, third, and codeunit 79451 to the tests app, which went from 1.0.0.3 to
1.0.0.4; the target is unchanged. The ON, SINGLE and OFF legs are predicted unchanged per mutant
(`docs/superpowers/specs/2026-10-22-r658-hang-baseline-leg-precommitment.md` §3). The receipt's
sublegs are now `stop-hung-sessions-on`, `stop-hung-sessions-single`, `stop-baseline` and
`stop-hung-sessions-off`. Until a run passes on a server at tests app 1.0.0.4, this gate is
unproven there (see [servers.md](servers.md)).
