# itest:hang

`LETHAL_ITEST_HANG=1 bun run itest:hang` runs `fixtures/sandbox-hang` + `-tests`: mutants that
never terminate, scored rather than quarantined (R53). It is the **only gate that exercises the
control app's stop** (`StopHungRunAt`), so an AL edit to `extensions/lethal-control` is verified by
an `alc` compile AND by this gate. Connection: the gitignored
`fixtures/sandbox-hang/lethal.config.local.json`.

Three legs, in this order on purpose:

- **ON** (`--stop-hung-sessions`): the stop works and BC's 408 confirms each hang. It leaves the
  tier clean.
- **SINGLE** (R-204b): the ON leg with `--no-group-runs`, so every covering test goes through
  `RunMutant` alone. Frozen in `hang.single.baseline.json`.
- **OFF**: quarantines by design and is torn down afterwards.

The ON and OFF legs guard different failure modes (minting a kill from our own abort; recording a
kill without BC's confirmation); neither is redundant. See the header of `hang.itest.ts`.

## Frozen figures

```json gate-figures
{
  "gate": "itest:hang",
  "baselines": {
    "hang.single.baseline.json": { "killed": 24, "survived": 9, "timeout-killed": 5 }
  },
  "notPinned": {
    "EXPECTED_WARM_KILLS": 4,
    "EXPECTED_COLD_CONFIRMS_ON": 4,
    "EXPECTED_COLD_CONFIRMS_SINGLE": 5,
    "budgetMs": 20000
  }
}
```

- The ON leg's per-mutant table (`EXPECTED_ON`, keyed by line and operator, with `killPosition`
  where pre-committed) is asserted by the gate and not pinned here.
- R206: the ON leg's 4 warm kills are all in the `SpinUntil` arm: three warm fails and one warm
  timeout.
- R516: every position-1 timeout is confirmed by one unmutated `RunMutant` call before it is scored:
  4 cold confirms on ON, 5 on SINGLE (`docs/superpowers/specs/2026-10-08-r516-hang-confirm-every-timeout-precommitment.md`).

## History

R-204b's single-path leg was recorded 2026-10-06 on Cronus28 (record exit 3, confirm PASS), per
`docs/superpowers/specs/2026-10-06-r204b-hang-single-path-precommitment.md`. R164 and R179 added the
`NextRow` and `DrainQueue` arms that measure the loop cessions; R196 refuses hang-capable
assignment sites. Their stories are in the comments on `EXPECTED_ON` in `hang.itest.ts`.
