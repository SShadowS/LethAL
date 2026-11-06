# itest:harden

`LETHAL_ITEST_HARDEN=1 bun run itest:harden` runs `fixtures/sandbox-harden`. The fixture has five
planted survivors, and one of them (S5) is a true equivalent mutant. The gate runs two legs, one
after the other. Each is a full session with the fixture's committed `lethal.equivalent.json`
loaded.

- Leg A uses the base suite, `fixtures/sandbox-harden-tests`. It checks every mutant's verdict and
  killer against the pre-committed table (`EXPECTED` in `harden-expected.ts`), the S5 mark, and
  the baseline.
- Leg B uses the answer key, `fixtures/sandbox-harden-answers`. S1 to S4 must be killed by name,
  and S5 must still survive.
- Since R582 both legs re-run every kill once under the mutant (R577's rule): leg A's 16 and leg
  B's 18 must each carry `killReproduced` and exactly 2 mutated rows for the killing test
  (pre-commitment 39eaf536, corrected for leg B in r3a, 8cbae6d1).

The baseline is written only after both legs pass. The connection comes from the gitignored
config in `fixtures/sandbox-harden/` that `LETHAL_ITEST_CONFIG` names (see
[servers.md](servers.md)). Both test apps must be published to that server; the setup script does
it on `bc1` to `bc3`. On 2026-10-21 the gate passed on `bc2` (R-583).

## Frozen figures

2026-11-06 (R836, coord task R-848): `harden.baseline.json` moved from identity scheme 44 to 45, on `bc2`, by R332's procedure. One line changed, the scheme,
and the confirm run passed. No figure below moved. Logs: `/coord/handoff/R-848/bc2/`.

2026-11-06 (R810, coord task R-827): `harden.baseline.json` moved from identity scheme 42 to 44, on `bc2`, by R332's procedure.
One line changed, the scheme, and the confirm run passed. No figure below moved. Logs: `/coord/handoff/R-827/bc2/`.

```json gate-figures
{
  "gate": "itest:harden",
  "baselines": {
    "harden.baseline.json": { "killed": 16, "survived": 5 }
  }
}
```

Leg A scores 16 killed and 5 survived. The pre-commitment is
`docs/superpowers/specs/2026-09-25-c02-03-harden-precommitment.md`.
