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

It runs three legs, in this order on purpose:

- ON (`--stop-hung-sessions`): the stop works, and BC's 408 answer confirms each hang. This leg
  leaves the tier clean.
- SINGLE (R-204b): the ON leg with `--no-group-runs`, so every covering test goes through
  `RunMutant` alone. This leg is frozen in `hang.single.baseline.json`.
- OFF: puts the tier in quarantine on purpose, and is torn down afterwards.

The ON and OFF legs guard against different faults. One fault is minting a kill from LethAL's own
abort. The other is recording a kill without BC's confirmation. Neither leg is redundant. See the
header of `hang.itest.ts`.

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
    "HANG_FIGURES.stoppedCallsOn": 6
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
  ids are 46 - 6 = 40. The re-runs add about ten 20-25 s stops, which takes the gate to about
  15 minutes.
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
