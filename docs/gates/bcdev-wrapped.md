# itest:bcdev-wrapped

`LETHAL_ITEST_BCDEV=1 bun run itest:bcdev-wrapped` runs `fixtures/sandbox-wrapped` +
`fixtures/sandbox-wrapped-tests` (objects wrapped in `#if`) on `itest:bcdev`'s container. Two legs,
one session each: `coverageMode: "fenced"` and `coverageMode: "procedure"` (the hub). Each must equal
the pre-committed table per mutant (`EXPECTED_WRAPPED_BC`), with strict twin parity and no refusal
of a fixture object; the hub leg must equal the fenced leg per mutant. The fenced leg is frozen.

## Frozen figures

```json gate-figures
{
  "gate": "itest:bcdev-wrapped",
  "baselines": {
    "bcdev.wrapped.baseline.json": { "killed": 60, "survived": 38 }
  }
}
```

## History

R497: recorded 2026-10-08 on Cronus28 (record exit 3, confirm PASS, fenced and hub per mutant
equal), per `docs/superpowers/specs/2026-10-08-r497-bcdev-wrapped-precommitment.md`. The al-runner
side of the same fixture is in [alrunner.md](alrunner.md) §"wrapped leg".
