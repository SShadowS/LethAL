# itest:alrunner-v3

`LETHAL_ITEST_ALRUNNER_V3=1 bun run itest:alrunner-v3` is the gate of the `al-runner-v3` backend (R586), which
drives the Rust al-runner v3. It needs neither BC nor a lease. Every figure is pre-committed in
`docs/superpowers/specs/2026-10-21-r586-alrunner-v3-precommitment.md` (dcdd1489), with leg X (d) replaced by
`docs/superpowers/specs/2026-10-21-r586-alrunner-v3-precommitment-r5-xd.md` (abe76fa6), and leg C's two clock facts
and X (d)'s baseline by `docs/superpowers/specs/2026-10-21-r586-alrunner-v3-precommitment-r6.md` (c7c505e6).
X (d)'s scratch setup is amended by `docs/superpowers/specs/2026-10-21-r586-alrunner-v3-precommitment-r5a-xd-setup.md`
(f32aa92a), and the leg compiles that setup with alc before any session starts
(`al-runner-v3-itest-setup-does-not-compile`). A differing verdict, killing test, note set, refusal set or Sleep
index size in any leg is a BLOCK.
The leg-by-leg tables live in those pre-commitments and are asserted by the itest, not restated here.

The legs:

- C: the contract probe, 23 facts (`runV3ContractProbe`), contract versus known defect.
- S1, S3: `fixtures/sandbox-app`, one-shot, per mutant equal to `itest:alrunner`'s table.
- N1: the names fixture (R557's tests are unselectable on v3, upstream #5572).
- X (a) to (f): the compile proof, the binding checks and the Sleep rule (§6) on `scripts/r586-probe`.
- D1, D1c: the Continia Document Output slice, compared per mutant with R594's BC oracle
  (`docs/measurements/r594/bc3-A.report.json`, `bc3-B.report.json`). No source text is committed.
  - `LETHAL_ITEST_V3_CDO` names the checkout. It is `/work/lethal-wt/cdo-r396`, the read-only measurement checkout,
    which has the `Test/.alpackages` the legs compile against. `/work/src/do-lethal` has none.
  - The pre-commitment binds the corpus by content, not by path. Each D leg refuses to start
    (`al-runner-v3-cdo-checkout-refused`) unless the checkout is at 5f2a71d, clean, and has corpus fingerprint
    `aa47c61c1fcbb7e3` (`scripts/corpus-fingerprint.ts`).
  - The oracle reports are redacted, so the per-mutant comparison checks the source text on only 24 of the 63
    mutants. Verdicts and killing tests are compared on all 63.
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

- Leg T, `al-runner-v3.tables.baseline.json`: 290 / 57 / 59 over 406, as pre-committed. Its rows differ from
  `itest:tables`' baseline on exactly the 52 keys and transitions of the pre-commitment's list (41 Commit, 7
  duplicate key, 4 TestPage).

## History

- 2026-10-21: leg C's first live run was BLOCKED. v3 alpha.2 runs a virtual AL clock, which made `sleep-is-noop`
  and the wall-clock `timeout-is-cpu` probe miss. The r6 delta restates both.
- r5 replaced leg X (d)'s target, because r4's control could produce no Sleep refusal at all.
- 2026-10-21: leg T's baseline was recorded on alpha.2 (91253f2d6), LethAL 0043dda1: record exit 3 at the
  pre-committed figures, with its 52 differences from BC's equal to the pre-committed list by key and by
  transition.
- 2026-10-21: D1's first attempt under r6 was an infra-fail before any mutant ran. It pointed at
  `/work/src/do-lethal`, which has no `Test/.alpackages`, so the contract probe's alc compile failed
  (`/coord/handoff/R-586/gate/r6/D1.infra-fail-no-alpackages.log`). It re-ran on `/work/lethal-wt/cdo-r396`, the
  same commit, and passed. The checkout guard above was then added, so that another checkout cannot slip in.
