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

- C: the contract probe, 26 facts (`runV3ContractProbe`, `V3_LEG_C_FACTS`) of three kinds: 9 defect, 16 contract
  and 1 warn (r9, below). Since r7
  (`docs/superpowers/specs/2026-10-22-r586-alrunner-v3-precommitment-r7-none-selected.md`, 16681485), 8 are
  defect facts (`V3_DEFECT_FACTS` in `al-runner-v3-gate.ts`, `none-selected-exit` included). Since r8
  (`docs/superpowers/specs/2026-10-22-r586-alrunner-v3-precommitment-r8-dependent-notrun.md`, 848371cb), 16 are
  contract facts, `dependent-fail-after-timeout-is-notrun` included. That fact pins v3's own guard against R637's
  false kill. A failure caused by a timed-out sibling's state must come back as v3's not-trusted `notRun` row,
  never as a plain `fail`.
  Since R612 (plan `docs/superpowers/plans/2026-10-22-r612-v3-serve-keep-rule.md`), 1 is a WARN fact
  (`V3_WARN_FACTS`): `serve-keep-reasons` runs one `alrunner serve` daemon over five invented tests and checks each
  row against its entry of `V3_SERVE_SAFE_REFUSALS`, the reasons after which the v3 serve rule keeps the daemon.
  It must read `matches` on alpha.2, but any other reading (`diverged`, `unmeasurable`) only prints
  `al-runner-v3-serve-keep-reason-moved` in the log and the receipt `lines`: it is never a `gate-fail` or a `held`,
  because a moved reason only makes the daemon close (slower, never wrong). It is gate-only, as `timeout-is-cpu`
  is: the receipt's `warnFacts` carries the reading, the update script copies it into `.gated`, and a session
  shows that reading (`unmeasurable` when `.gated` predates R612), never a `matches` it did not see.
  Since r9 (`docs/superpowers/specs/2026-10-22-r586-alrunner-v3-precommitment-r9-bc-readings.md`, 4995b8f6, R639),
  two texts measured on bc1 (`docs/measurements/r639/`) are pinned byte for byte, `BC_HTTP_INTERNAL_TEXT` and
  `BC_END_OF_TEST_TEXT`, and `r639-bc-readings.test.ts` binds them to that file:
  - `refusal-row-shape` (#5608) is a DEFECT fact (9 in all). `gone` is exactly bc1's reading. A plain fail with
    any other text reads `unlike-bc`: `gate-fail` in leg C ("#5700"), a refusal by name in a normal session, and
    only a warning (`al-runner-v3-defect-unlike-bc`) in the update gate's own candidate legs, printed in every
    leg's receipt lines that ran under it.
  - The refusal row shape is now probed by the contract fact `refusal-row-shape-public` (codeunit 50654,
    `http://example.com/x`, refused by host string with no network), and `refusal-cascade` reads that call.
  - `commit-under-test-isolation` is `gone` only for a row that is not a refusal written as a fail.
  - `duplicate-key-insert-raises` (50655, `TestPermissions = Disabled`) is `gone` only for bc1's end-of-test text.
    v3's #5623 refusal reads `refused`: `held` in leg C (on a contract or warn fact it is `gate-fail`), a warning
    in a session, and never counted as gone.
  - In every session, a row whose message starts `NotRun: out-of-scope:` but has no `notRun` scores `error`
    (`runner-test-error`), never a kill, survive or pass (K1(a)).
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
  `al-runner-v3-tables-known.ts`), in the record run and in every confirm run. r9 §7 adds one narrow `held`: a
  known row whose VERDICT disagreed with BC's, now `error` through a named refusal (`runner-refused`, no killing
  test). An `error` of any other class, or a known row that differs from BC only in its killing test, is
  `gate-fail`.

## The pin and the update gate

- The binary is pinned at `/work/tools/al-runner-v3/3.0.0-alpha.2-91253f2d6/`, and `current` points at it. Its
  `.gated` file names the build, its sha256 and the LethAL commit that gated it. The backend refuses any build that
  `.gated` does not name (`AlRunnerV3UngatedBuildError`), unless `LETHAL_ALRUNNER_V3_CANDIDATE=1`.
- The pin is never moved by hand. `bun scripts/al-runner-v3-update.ts` gates newer `v3.0.0-alpha.N` releases, and
  `--edge` gates the daily `edge` release by download. The version check accepts SemVer build metadata
  (`al-runner 3.0.0-alpha.4+edge.20261022 (57f1e4f98)`, R639 F1).
- `--edge-rejudge <edge sha>` (R639) re-gates a KEPT edge binary at `.gated`'s current commit, never a new
  download, and never reads or writes `edge.last-seen`.
  - It refuses by name (`al-runner-v3-edge-rejudge-refused`) when `failed/edge-<sha>@<commit>` exists at all, or a
    `rejudge/` or `held/` receipt names this commit with an outcome other than `infra-fail`: `--regate` to a new
    commit first.
  - The binary comes from `failed/edge-<sha>@*/` or `held/edge-<sha>/`: each copy must be the bytes its receipt
    names, all copies one build, and its `--version` commit the argument. `gateOne` re-hashes it against that sha.
  - Outcomes are `--edge`'s at this commit, under new keys only: nothing that already exists under `failed/` or
    `held/` is moved or rewritten. The receipt and `gate.log` are also kept in `rejudge/edge-<sha>@<commit>/`. A
    pass writes `.gated` with `rejudgedFrom` and no `tarballSha256`.
- Every gate path (the alpha path, `--regate`, `--edge`, `--edge-rejudge`) holds `<root>/.gate.lock`. A holder is
  live only when its `/proc/<pid>/cmdline` names `al-runner-v3-update`; a dead, reused, empty or unreadable lock is
  taken over unless a process still runs under the gate worktree. A skip is logged with the lock, its holder and
  the manual clear step.
- The script passes `LETHAL_ITEST_V3_CDO` to the gate itself: the caller's value, or `V3_CDO_DEFAULT`
  (`/work/lethal-wt/cdo-r396`). Without it the gate runs no D leg, and a receipt that lacks legs is `infra-fail`,
  with `why` naming the missing legs ([[R633]]).
- The D legs make every gate a corpus job, so the alpha path, `--regate` and `--edge` are all skipped for the day,
  with the reason logged, when 3 or more other heavy-job PROCESSES run container-wide (the guard counts matching
  processes, not jobs: one job can match more than once, which errs toward skipping; at most 3 heavy jobs, the
  gate included, since 2026-10-22) or `free -g` shows under 10 GB available. A
  skipped `--regate` or `--edge-rejudge` exits 2, so a `&&` chain after it stops.
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
- The fixture `.alpackages` are prepared by ONE function, `prepareFixtureSymbols`
  (`packages/runner/itest/fixture-symbols.ts`, R614). The gate calls it, and so does the itest itself at start,
  so a manual `itest:alrunner-v3` in a fresh worktree extracts them too. It extracts only the tar's members
  under `fixtures/sandbox-tests/.alpackages` and `fixtures/sandbox-data-tests/.alpackages` (no other fixture
  folder is written), then writes the tar's sha256 to `.fixture-symbols.sha256` at the worktree's root
  (gitignored). Folders already there are used when both exist and that marker equals the pinned sha
  (`FIXTURE_SYMBOLS_TAR_SHA256`). Both there with NO marker (extracted before R614): they are compared with the
  tar, file set and each file's sha256; equal, the marker is written and the run goes on. Anything else (a
  difference, a symlink, a wrong marker, one folder only) refuses by name, `al-runner-v3-gate-symbols-unverified`,
  naming the marker found, the sha expected and the one-time fix: delete both folders and the marker, and the
  next run extracts them from the pinned tar (with no tar there, the fix named is to supply the pinned tar, or
  to write the marker by hand after checking the folders). In the gate that is an infra-fail, retried next run.
  Nothing is deleted automatically, because the folders may have been put there by hand. The update log names
  the outcome on each gate run: `<time> <tag>: fixture .alpackages: extracted|verified|marked`.
- Every leg selection needs the two fixture folders or the tar, CDO-only legs (`D1`, `D1c`) included: the itest
  prepares them before any leg.
- Re-pinning the symbol tar (a new `FIXTURE_SYMBOLS_TAR_SHA256`) refuses the gate worktree once, because its
  marker names the old pin. Before the `--regate`, delete `/work/lethal-wt/al-runner-v3-gate`'s two folders and
  its `.fixture-symbols.sha256`; the run then extracts them from the new tar.
- A leg's outcome comes from its error's TYPE, never its text:
  - `gate-fail`: a pre-committed figure differs, a contract fact or a defect fact reads `diverged`, or v3's
    coverage paths no longer join LethAL's (`AlRunnerV3CoverageJoinError`, a real behaviour change; in a user
    session the same error is a plain refusal);
  - `held`: every difference is a move toward BC or a named refusal; read the receipt's lines (a defect fact
    `defect-present` -> `gone` or `refused`; a leg-T known row to `error`/`runner-refused`; X (b) once v3 refuses
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
- 2026-10-22: r8 (848371cb, R637) added the contract fact `dependent-fail-after-timeout-is-notrun`.
  - R612's warn fact merged first, so leg C has 25 facts: 8 defect, 16 contract and 1 warn. That is the count r8
    pre-commits for this order.
  - It costs about 3 s per leg C and per v3 session: one `--test-timeout-secs 3` call.
  - On alpha.2 it read `matches` in a standalone run of the same AL, ids moved (`/coord/handoff/R-637/r8-measure/`).
  - It then read `matches` inside leg C, on 53d06b01, before R612 merged (24 facts there; all eight legs PASS,
    `/coord/handoff/R-637/live/alrunner-v3-run2.log`). The 25-fact head is not yet run live.
  - R637 was closed by ruling: v3 already marks such a failure not trusted.
- 2026-10-22: edge-57f1e4f98 was gated by hand at de8f43e2 and gate-failed ([[R641]]): `refusal-row-shape` read
  `diverged` (#5608 fixed, with a text that is not BC's), `duplicate-key-insert-raises` read `unmeasurable` (#5623
  refuses a test that ends on a deferred duplicate key, which BC fails), and no session leg ran (the version
  pattern refused `+edge.20261022`). bc1 then measured BC's own texts (`docs/measurements/r639/`, two runs). r9
  (4995b8f6) restates the facts, and R639 adds `--edge-rejudge` and the gate lock. Leg C has 26 facts: 9 defect,
  16 contract and 1 warn. The 26-fact head is not yet run live.
