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

The baseline is written only after both legs pass. The connection comes from the gitignored
config in `fixtures/sandbox-harden/` that `LETHAL_ITEST_CONFIG` names (see
[servers.md](servers.md)). Both test apps must be published to that server; the setup script does
it on `bc1` to `bc3`. On 2026-10-21 the gate passed on `bc2` (R-583).

## Frozen figures

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
