# itest:alrunner-v3

`LETHAL_ITEST_ALRUNNER_V3=1 bun run itest:alrunner-v3` is the gate of the `al-runner-v3` backend (R586), which
drives the Rust al-runner v3. It needs neither BC nor a lease. Every figure is pre-committed in
`docs/superpowers/specs/2026-10-21-r586-alrunner-v3-precommitment.md` (dcdd1489), with leg X (d) replaced by
`docs/superpowers/specs/2026-10-21-r586-alrunner-v3-precommitment-r5-xd.md` (abe76fa6), and leg C's two clock facts
and X (d)'s baseline by `docs/superpowers/specs/2026-10-21-r586-alrunner-v3-precommitment-r6.md` (c7c505e6). A differing verdict, killing test, note set, refusal set or Sleep index size in any leg is a BLOCK.
The leg-by-leg tables live in those pre-commitments and are asserted by the itest, not restated here.

The legs:

- C: the contract probe, 23 facts (`runV3ContractProbe`), contract versus known defect.
- S1, S3: `fixtures/sandbox-app`, one-shot, per mutant equal to `itest:alrunner`'s table.
- N1: the names fixture (R557's tests are unselectable on v3, upstream #5572).
- X (a) to (f): the compile proof, the binding checks and the Sleep rule (§6) on `scripts/r586-probe`.
- D1, D1c: the CDO slice at `/work/src/do-lethal` (5f2a71d), read-only, no source text committed.
- T: `fixtures/sandbox-data`, frozen in `al-runner-v3.tables.baseline.json`, with the 52 known differences
  from `itest:tables` asserted by key.

## The pin and the update gate

- The binary is pinned at `/work/tools/al-runner-v3/3.0.0-alpha.2-91253f2d6/`, and `current` points at it. Its
  `.gated` file names the build, its sha256 and the LethAL commit that gated it. The backend refuses any build that
  `.gated` does not name (`AlRunnerV3UngatedBuildError`), unless `LETHAL_ALRUNNER_V3_CANDIDATE=1`.
- The pin is never moved by hand. `bun scripts/al-runner-v3-update.ts` gates newer `v3.0.0-alpha.N` releases, and
  `--edge` gates the daily `edge` release by download.
- In both, the checksum is checked before anything is extracted, and the gate runs at `.gated`'s commit. Only a
  `pass` moves `current`. A `held` result (every difference a move toward BC) is kept for re-pre-commitment and
  never blacklisted.

## Frozen figures

```json gate-figures
{
  "gate": "itest:alrunner-v3",
  "baselines": {
    "al-runner-v3.tables.baseline.json": { "killed": 290, "survived": 57, "no-coverage": 59 }
  }
}
```

- Leg T, `al-runner-v3.tables.baseline.json`: 290 / 57 / 59 over 406. These are the pre-committed figures. The
  file is recorded once (`LETHAL_ITEST_RECORD_BASELINE=al-runner-v3.tables.baseline.json`, which exits 3) and only
  if the run gives exactly these figures. Until then it sits in `PENDING_FIRST_RECORD`, and this page's pin test
  checks that the file is absent.

## History

- 2026-10-21: leg C's first live run was BLOCKED. v3 alpha.2 runs a virtual AL clock, which made `sleep-is-noop`
  and the wall-clock `timeout-is-cpu` probe miss. The r6 delta restates both.
- r5 replaced leg X (d)'s target, because r4's control could produce no Sleep refusal at all.
