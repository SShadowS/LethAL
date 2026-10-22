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

- C: the contract probe, 24 facts (`runV3ContractProbe`) of three kinds. Since r7
  (`docs/superpowers/specs/2026-10-22-r586-alrunner-v3-precommitment-r7-none-selected.md`, 16681485), 8 are
  defect facts (`V3_DEFECT_FACTS` in `al-runner-v3-gate.ts`, `none-selected-exit` included) and 15 contract facts.
  Since R612 (plan `docs/superpowers/plans/2026-10-22-r612-v3-serve-keep-rule.md`), 1 is a WARN fact
  (`V3_WARN_FACTS`): `serve-keep-reasons` runs one `alrunner serve` daemon over five invented tests and checks each
  row against its entry of `V3_SERVE_SAFE_REFUSALS`, the reasons after which the v3 serve rule keeps the daemon.
  It must read `matches` on alpha.2, but any other reading (`diverged`, `unmeasurable`) only prints
  `al-runner-v3-serve-keep-reason-moved` in the log and the receipt `lines`: it is never a `gate-fail` or a `held`,
  because a moved reason only makes the daemon close (slower, never wrong). It is gate-only: a session trusts
  the gated record, as for `timeout-is-cpu`.
- S1, S3: `fixtures/sandbox-app`, one-shot, per mutant equal to `itest:alrunner`'s table.
- N1: the names fixture (R557's tests are unselectable on v3, upstream #5572).
- X (a) to (f): the compile proof, the binding checks and the Sleep rule (§6) on `scripts/r586-probe`.
- D1, D1c: the Continia Document Output slice, compared per mutant with R594's BC oracle
  (`docs/measurements/r594/bc3-A.report.json`, `bc3-B.report.json`). No source text is committed.
  - `LETHAL_ITEST_V3_CDO` names the checkout. It is `/work/lethal-wt/cdo-r396`, the read-only measurement checkout,
    which has the `Test/.alpackages` the legs compile against. `/work/src/do-lethal` has none.
  - The pre-commitment binds the corpus by content, not by path. Each D leg refuses to start
    (`al-runner-v3-cdo-checkout-refused`) unless the checkout is at 5f2a71d, clean, and has corpus fingerprint
    `aa47c61c1fcbb7e3` (`scripts/corpus-fingerprint.ts`). The fingerprint excludes `.dependencies`, so the
    slice's mutated file there and every `Test/.alpackages` app are also pinned by sha256 (`CDO_SLICE_SHA256`,
    `CDO_ALPACKAGES` in `al-runner-v3-gate.ts`).
  - The oracle reports are redacted, so the per-mutant comparison checks the source text on only 24 of the 63
    mutants. Verdicts and killing tests are compared on all 63.
- T: `fixtures/sandbox-data`, frozen in `al-runner-v3.tables.baseline.json`, with the 52 known differences
  from `itest:tables` asserted by key AND transition (`TABLES_KNOWN_DIFFERENCES` in
  `al-runner-v3-tables-known.ts`), in the record run and in every confirm run.

## The pin and the update gate

- The binary is pinned at `/work/tools/al-runner-v3/3.0.0-alpha.2-91253f2d6/`, and `current` points at it. Its
  `.gated` file names the build, its sha256 and the LethAL commit that gated it. The backend refuses any build that
  `.gated` does not name (`AlRunnerV3UngatedBuildError`), unless `LETHAL_ALRUNNER_V3_CANDIDATE=1`.
- The pin is never moved by hand. `bun scripts/al-runner-v3-update.ts` gates newer `v3.0.0-alpha.N` releases, and
  `--edge` gates the daily `edge` release by download.
- The script passes `LETHAL_ITEST_V3_CDO` to the gate itself: the caller's value, or `V3_CDO_DEFAULT`
  (`/work/lethal-wt/cdo-r396`). Without it the gate runs no D leg, and a receipt that lacks legs is `infra-fail`,
  with `why` naming the missing legs ([[R633]]).
- The D legs make every gate a corpus job, so the alpha path, `--regate` and `--edge` are all skipped for the day,
  with the reason logged, when 2 or more heavy jobs run container-wide or `free -g` shows under 10 GB available. A
  skipped `--regate` exits 2, so a `&&` chain after it stops.
- The evidence is kept. The gate's stdout and stderr go to `gate.log` beside the receipt, on every exit. Both are
  copied beside the outcome they gave: `failed/<tag>@<commit>/`, `held/<tag>/`, `infra/<tag>.receipt.json` and
  `infra/<tag>.gate.log`, and `regate/<commit>.receipt.json` and `regate/<commit>.gate.log`, each file when it
  exists. A failed copy is logged and never blocks the verdict, `.gated` or the count. The log line carries the
  receipt's `lines`, and leg C's lines carry each non-passing fact's measured value. A `failed/` hit that skips the
  gate is logged too, with the `--regate` hint.
- In both, the checksum is checked before anything is extracted, and the gate runs at `.gated`'s commit, in a
  worktree it prepares first (`bun install --frozen-lockfile`, the native parser, the fixture `.alpackages` from
  the symbol tar pinned by sha256) or refuses by name (`al-runner-v3-gate-worktree-unprepared`,
  `al-runner-v3-gate-symbol-tar-mismatch`). Only a `pass` moves `current`.
- A leg's outcome comes from its error's TYPE, never its text:
  - `gate-fail`: a pre-committed figure differs, a contract fact or a defect fact reads `diverged`, or v3's
    coverage paths no longer join LethAL's (`AlRunnerV3CoverageJoinError`, a real behaviour change; in a user
    session the same error is a plain refusal);
  - `held`: every difference is a move toward BC (a defect fact `defect-present` -> `gone`; X (b) once v3 refuses
    the broken target with its parsed compile diagnostic, AL0118, while a crash, a signal or unparseable output
    stays `gate-fail`; a leg-T known row reaching its BC row). Kept under `held/` for re-pre-commitment, never
    blacklisted. A #5602 fix that refuses the broken target WITHOUT writing an `--output-json` document reads
    `gate-fail` (the safe direction: nothing is admitted); recover it with a LethAL change and `--regate`;
  - `infra-fail`: the environment (the CDO checkout guard, `al-runner-v3-itest-setup-does-not-compile`, an unset
    variable, an unmeasurable fact). Retried next run.
- A `gate-fail` goes to `failed/<tag>@<lethalCommit>`: final for that build at that LethAL commit only, so a
  LethAL fix and a re-pre-commitment can gate the same build again.
- The receipt must name the requested LethAL commit as the full, equal 40-character sha, record whether the gate
  worktree was dirty (a dirty `pass` is refused), and give its outcome from its legs over the exact leg set.
  Dirty means any tracked change, or any untracked file under `fixtures/` or `packages/` (it would compile into
  a leg); other untracked files are the gate's own outputs. `.gated`'s `lethalCommit` is also the full sha.
  Existing fixture `.alpackages` are not yet checked against the pinned tar ([[R614]]).
- `timeout-is-cpu` is GATE-ONLY: its burns are fixed iteration counts calibrated on one machine, so only leg C
  measures it, and a session trusts the gated build's record instead of re-burning (M1). That trust is per v3
  BUILD: a later LethAL change to how a call's timeout is sent (`v3CallArgv`, `stopSecondsOf`) is not covered by
  the old record and needs `bun scripts/al-runner-v3-update.ts --regate <commit>`.
- `.gated` names a commit on `lethal/r586`. The orchestrator merges with `--no-ff`, so that commit stays reachable
  from master.

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

- 2026-10-21: the gate head is 8a71e87d (master merged in, after three Opus build reviews and a merge review).
  All eight legs pass there (`/coord/handoff/R-586/gate/final/`), and `.gated` names alpha.2 (91253f2d6) at
  lethalCommit 8a71e87d. Earlier full passes are kept as history: 5eb544ef, 0c0d9f5b, d5bb7d2d and a6c189b6.
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
- 2026-10-22: the first daily update run gave two verdicts for the wrong reason, and it kept no receipt ([[R633]],
  `/coord/handoff/al-runner-v3-update/diagnosis-2026-10-22.md`).
  - alpha.3 was `infra-fail` because the script never passed `LETHAL_ITEST_V3_CDO`, so no D leg ran.
  - alpha.4 and edge-7739d8132 were `gate-fail`. The probe read upstream's fix of #5613 as a contract break.
  - r7 (16681485) made `none-selected-exit` a defect fact. The script now passes the CDO checkout, keeps receipts
    and `gate.log`, and guards the alpha path and `--regate`.
  - `edge.last-seen` was not cleared. edge-7739d8132 is the same upstream commit as alpha.4, so alpha.4's verdict
    stands for it.
