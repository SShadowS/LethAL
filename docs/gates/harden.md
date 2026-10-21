# itest:harden

`LETHAL_ITEST_HARDEN=1 bun run itest:harden` runs `fixtures/sandbox-harden`, which has five planted
survivors, one of them a true equivalent (S5). Two legs, each a full session with the fixture's
committed `lethal.equivalent.json` loaded:

- A. the base suite `fixtures/sandbox-harden-tests`: every verdict and killer against the
  pre-committed table (`EXPECTED` in `harden-expected.ts`), the S5 mark, and the baseline;
- B. the answer key `fixtures/sandbox-harden-answers`: S1 to S4 killed by name, S5 still survives.

The baseline is written only after both legs pass. Connection: the gitignored
`fixtures/sandbox-harden/lethal.config.local.json`; both test apps must be published to that
container.

## Frozen figures

```json gate-figures
{
  "gate": "itest:harden",
  "baselines": {
    "harden.baseline.json": { "killed": 16, "survived": 5 }
  }
}
```

Pre-commitment: `docs/superpowers/specs/2026-09-25-c02-03-harden-precommitment.md`.
