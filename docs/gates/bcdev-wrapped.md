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
- Since R582 each leg re-runs every one of its 64 kills once under the mutant (R577's rule), and
  checks that each carries `killReproduced` and has exactly 2 mutated rows for its killing test.

## Frozen figures

```json gate-figures
{
  "gate": "itest:bcdev-wrapped",
  "baselines": {
    "bcdev.wrapped.baseline.json": { "killed": 64, "survived": 38 }
  }
}
```

The fenced leg scores 64 killed and 38 survived.

R855 added four `delete-additive-right` rows (M0010, M0018, M0026, M0035), all killed as pre-committed, recorded on bc3 on 2026-11-07.

## History

2026-11-06 (R827, coord task R-836): `Grow` in the four wrapped files gained a `#pragma` line, which keeps it a chain as long as this gate needs, and a comment line went, so no mutant's line moved. Its
`empty-block` row re-keyed in each of the four: recorded on `bc2` by R332, no verdict, killing test or other row moved, and the confirm run passed. Pre-commitment: the spec's Addenda 3, 4 and 7. Logs: `/coord/handoff/R-836/bc2/`.

2026-11-06 (R836, coord task R-848): `bcdev.wrapped.baseline.json` moved from identity scheme 44 to 45, on `bc2`, by R332's procedure. One line changed, the
scheme, and the confirm run passed. Logs: `/coord/handoff/R-848/bc2/`.

2026-11-06 (R810, coord task R-827): `bcdev.wrapped.baseline.json` moved from identity scheme 42 to 44, on `bc2`, by R332's
procedure. One line changed, the scheme, and the confirm run passed. Logs: `/coord/handoff/R-827/bc2/`.

R497: recorded on 2026-10-08 on Cronus28 (record run exit 3, confirm run PASS, fenced and hub legs
equal mutant by mutant), per `docs/superpowers/specs/2026-10-08-r497-bcdev-wrapped-precommitment.md`.
The .NET al-runner's side of the same fixture is on [alrunner.md](alrunner.md), "Wrapped leg"; that
gate was retired by R654. The Rust al-runner turns coverage off for wrapped files and runs no wrapped
leg ([R602](../roadmap/R602.md)), so this gate is now the only live check of the fixture.
