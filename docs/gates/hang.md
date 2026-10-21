# itest:hang

`LETHAL_ITEST_HANG=1 bun run itest:hang` runs `fixtures/sandbox-hang` with its tests. Its mutants
never terminate, and the gate scores them instead of setting them aside (R53). It is the only
gate that exercises the control app's stop (`StopHungRunAt`). So an AL edit to
`extensions/lethal-control` is verified by an `alc` compile and by this gate. The connection comes
from the gitignored config in `fixtures/sandbox-hang/` that `LETHAL_ITEST_CONFIG` names (see
[servers.md](servers.md)). On 2026-10-21 it passed on `bc3` under master's code (the
pre-runtime-17 fixtures, so `bc3` is not proven for it now) and on `bc2` under R-583's code
(R-583).

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
    "HANG_FIGURES.coldConfirmsSingle": 5
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
- The ON leg's per-mutant table (`EXPECTED_ON` in `hang.itest.ts`, keyed by line and operator,
  with `killPosition` where it was pre-committed) is asserted by the gate and not pinned here.

## History

R-204b's single-path leg was recorded on 2026-10-06 on Cronus28 (record run exit 3, confirm run
PASS), per `docs/superpowers/specs/2026-10-06-r204b-hang-single-path-precommitment.md`. R164 and
R179 added the `NextRow` and `DrainQueue` arms, which measure the loop cessions. R196 refuses
assignment sites that could hang. Their stories are in the comments on `EXPECTED_ON`.
