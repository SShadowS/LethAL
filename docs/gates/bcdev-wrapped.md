# itest:bcdev-wrapped

`LETHAL_ITEST_BCDEV=1 bun run itest:bcdev-wrapped` runs `fixtures/sandbox-wrapped` with
`fixtures/sandbox-wrapped-tests` on `itest:bcdev`'s connection: the config in
`fixtures/sandbox-app/` that `LETHAL_ITEST_CONFIG` names (`CONNECTION_DIR` in the itest; see
[servers.md](servers.md)). On 2026-10-21 it passed on `bc1` under R-583's runtime-17 fixtures,
fenced and hub legs equal (R-583). The fixture's objects are wrapped
in `#if` blocks. It runs two legs, one session each: `coverageMode: "fenced"` and
`coverageMode: "procedure"` (the hub).

- Each leg must equal the pre-committed table (`EXPECTED_WRAPPED_BC`) mutant by mutant.
- Each wrapped object must match its unwrapped twin, and no fixture object may be refused.
- The hub leg must equal the fenced leg mutant by mutant.
- The fenced leg is frozen.
- Since R582 each leg re-runs every one of its 60 kills once under the mutant (R577's rule), and
  checks that each carries `killReproduced` and has exactly 2 mutated rows for its killing test.

## Frozen figures

```json gate-figures
{
  "gate": "itest:bcdev-wrapped",
  "baselines": {
    "bcdev.wrapped.baseline.json": { "killed": 60, "survived": 38 }
  }
}
```

The fenced leg scores 60 killed and 38 survived.

## History

R497: recorded on 2026-10-08 on Cronus28 (record run exit 3, confirm run PASS, fenced and hub legs
equal mutant by mutant), per `docs/superpowers/specs/2026-10-08-r497-bcdev-wrapped-precommitment.md`.
The .NET al-runner's side of the same fixture is on [alrunner.md](alrunner.md), "Wrapped leg"; that
gate was retired by R654. The Rust al-runner turns coverage off for wrapped files and runs no wrapped
leg ([R602](../roadmap/R602.md)), so this gate is now the only live check of the fixture.
