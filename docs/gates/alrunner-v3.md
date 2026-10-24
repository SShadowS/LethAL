# itest:alrunner-v3

`LETHAL_ITEST_ALRUNNER_V3=1 bun run itest:alrunner-v3` is the gate of the `al-runner-v3` backend (R586), which
drives the Rust al-runner v3. It needs neither BC nor a lease. Every figure is pre-committed in
`docs/superpowers/specs/2026-10-21-r586-alrunner-v3-precommitment.md` (dcdd1489), with leg X (d) replaced by
`docs/superpowers/specs/2026-10-21-r586-alrunner-v3-precommitment-r5-xd.md` (abe76fa6), and leg C's two clock facts
and X (d)'s baseline by `docs/superpowers/specs/2026-10-21-r586-alrunner-v3-precommitment-r6.md` (c7c505e6).
X (d)'s scratch setup is amended by `docs/superpowers/specs/2026-10-21-r586-alrunner-v3-precommitment-r5a-xd-setup.md`
(f32aa92a), and its Sleeper's Sleep by `docs/superpowers/specs/2026-10-22-r586-alrunner-v3-precommitment-r11-xd-sleep5000.md`
(338af789). The leg compiles that setup with alc before any session starts
(`al-runner-v3-itest-setup-does-not-compile`). A differing verdict, killing test, note set, refusal set or Sleep
index size in any leg is a BLOCK.
The leg-by-leg tables live in those pre-commitments and are asserted by the itest, not restated here.

The legs:

- C: the contract probe, 28 facts (`runV3ContractProbe`, `V3_LEG_C_FACTS`) of three kinds: 9 defect, 18 contract
  and 1 warn (r9, below). Since r13
  (`docs/superpowers/specs/2026-10-23-r586-alrunner-v3-precommitment-r13-dependency-skip.md`, [[R590]]), the 18th
  contract fact is `dependency-skip-line`: a tests app that declares a dependency no package holds must make v3
  write a stderr line starting `dependency skipped:` that names it. The backend refuses a session on that line
  (`AlRunnerV3DependencySkippedError`), so a build that stops writing it, or writes it only with `--verbose`, reads
  `diverged`: `gate-fail` in leg C, a refused update gate, and a refusal in a session. Since r12
  (`docs/superpowers/specs/2026-10-23-r586-alrunner-v3-precommitment-r12-message-prefix.md`, [[R667]]), the 17th
  contract fact is `message-has-no-type-prefix`: the `message` of a plain `Error()` (`Fails`, on the main call)
  and of an `Assert.AreEqual` failure (codeunit 50661, its own tests app, Microsoft's Library Assert passed as
  `--dep` from `fixtures/sandbox-data-tests/.alpackages`) must be plain fails whose messages start exactly with
  `boom 5` and `Assert.AreEqual failed.` (since [[R675]]; `startsWith`, so an appended call stack is fine). Any
  text before, or in place of, that start reads `diverged` (its `measured` says `prefix "<text>"` or `reworded`):
  `gate-fail` in leg C, and a refusal in a session, by name (`MESSAGE_PREFIX_REASON`): it would turn v3's timeouts
  into errors, close the serve daemon on every refusal and skew the R553 assertion screen. It no longer guards
  verdicts: since R675, K1(a) in `v3RowVerdict`, the v3 serve-keep rule and two defect facts read v3's refusal
  marker `NotRun: out-of-scope:` ANYWHERE in a `pass`/`fail` message (`isV3RefusalText` in `al-runner-rows.ts`),
  so no prefix shape can turn a refusal into a kill. The Assert half is gate-only, as `timeout-is-cpu` is: a session reads
  `Fails` alone (any text before `boom 5` still refuses it). Since r7
  (`docs/superpowers/specs/2026-10-22-r586-alrunner-v3-precommitment-r7-none-selected.md`, 16681485), 8 are
  defect facts (`V3_DEFECT_FACTS` in `al-runner-v3-gate.ts`, `none-selected-exit` included). Since r8
  (`docs/superpowers/specs/2026-10-22-r586-alrunner-v3-precommitment-r8-dependent-notrun.md`, 848371cb), 16 are
  contract facts, `dependent-fail-after-timeout-is-notrun` included. That fact pins v3's own guard against R637's
  false kill. A failure caused by a timed-out sibling's state must come back as v3's not-trusted `notRun` row,
  never as a plain `fail`.
  Since R612 (plan `docs/superpowers/plans/2026-10-22-r612-v3-serve-keep-rule.md`), 1 is a WARN fact
  (`V3_WARN_FACTS`): `serve-keep-reasons` runs one `alrunner serve` daemon over four codeunits (five tests) and checks each
  row against its entry of `V3_SERVE_SAFE_REFUSALS` (four entries: http, commit, cascade, onrun-failed), the reasons
  after which the v3 serve rule keeps the daemon. Since R705, http and cascade (cascade only for the message
  `later`) are also accepted as a plain trusted fail (a #5602-fixed build), and `measured` says which. no-callee
  left with R705: a fixed build runs nothing in a request that does not compile. In serve-entries, a warm-up whose
  every entry refuses with one identical no-callee text now throws `al-runner-v3-entries-batch-refused`: the safe
  direction, opt-in and rare.
  It must read `matches` on alpha.2, but any other reading (`diverged`, `unmeasurable`) only prints
  `al-runner-v3-serve-keep-reason-moved` in the log and the receipt `lines`: it is never a `gate-fail` or a `held`,
  because a moved reason only makes the daemon close (slower, never wrong). It is gate-only, as `timeout-is-cpu`
  is: the receipt's `warnFacts` carries the reading, the update script copies it into `.gated`, and a session
  shows that reading (`unmeasurable` when `.gated` predates R612), never a `matches` it did not see.
  Since r9 (`docs/superpowers/specs/2026-10-22-r586-alrunner-v3-precommitment-r9-bc-readings.md`, 4995b8f6, R639),
  two texts measured on bc1 (`docs/measurements/r639/`) are pinned byte for byte, `BC_HTTP_INTERNAL_TEXT` and
  `BC_END_OF_TEST_TEXT`, and `r639-bc-readings.test.ts` binds them to that file. R705 adds `BC_HTTP_HUB_TEXT`:
  - `refusal-row-shape` (#5608) is a DEFECT fact (9 in all). `gone` is exactly the test runner HUB's reading
    (`BC_HTTP_HUB_TEXT`, "...the connecting endpoint violates security requirements...", code `HttpRequest:Security`;
    owner ruling 2026-10-24, R712, measured by R706 in `docs/measurements/r706/`). BC's web-service-path text
    (`BC_HTTP_INTERNAL_TEXT`, "...blocked by the runtime...") is not the oracle. A plain fail with
    any other text, that one included, reads `unlike-bc`: `gate-fail` in leg C ("#5700"), a refusal by name in a normal session, and
    only a warning (`al-runner-v3-defect-unlike-bc`) in the update gate's own candidate legs, printed in every
    leg's receipt lines that ran under it.
  - The refusal row shape is now probed by the contract fact `refusal-row-shape-public` (codeunit 50654,
    `http://example.com/x`, refused by host string with no network), and `refusal-cascade` reads that call.
  - `commit-under-test-isolation` is `gone` only for a row that is not a pass/fail row that holds v3's refusal
    marker (R675).
  - `duplicate-key-insert-raises` (50655, `TestPermissions = Disabled`) is `gone` only for bc1's end-of-test text.
    v3's #5623 refusal reads `refused`: `held` in leg C (on a contract or warn fact it is `gate-fail`), a warning
    in a session, and never counted as gone.
  - In every session, a row whose message holds `NotRun: out-of-scope:` anywhere (R675) but has no `notRun`
    scores `error` (`runner-test-error`), never a kill, survive or pass (K1(a)).
- S1: `fixtures/sandbox-app`, one-shot, per mutant equal to `bcdev.baseline.json` (`itest:bcdev`'s table).
- S3: runs no session. It checks that `selectorMode: "resource"` is refused by name
  (`al-runner-v3-resource-selector-refused`).
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
  - Since r10 (`docs/superpowers/specs/2026-10-22-r586-alrunner-v3-precommitment-r10-legt-order.md`, 7bc0a1a5,
    R647), the leg first classifies its rows and compares them with its own baseline (`compareMutants`), and prints
    every differing row as one receipt line, `T: <held|gate-fail>: <mutantCode> <key>: <old> -> <new> (<reason>)`.
    Only then does `judgeLegT` (`al-runner-v3-gate.ts`) judge, in order: Sleep index 0 + 0, 3 refused tests, the
    pinned 52, then the classification. `held` needs the compare's differing keys to equal the held keys, and has
    no count check. Since [[R650]], `held` also meets R556's bare-hash refusal (`bareHashRows`, the predicate
    `assertGateBaseline` uses): a run with a row missing its mutated-text hash, against an own baseline that has
    hashes, is `gate-fail`. `pass` needs 0 compare differences, then 290 / 57 / 59 over 406, then the baseline compare.
    The record branch still checks the counts first. A build that changes the 3 refused tests (the Commit tests)
    is `gate-fail` by design.
  - X (d), since r10: right after its session, the leg prints `SleeperDoubles`'s `baseline-batch-finished`
    verdict (or `absent`), `baselineGreen`, each mutant's `coveringTests`, and the 120 s stop (computed from
    `BASELINE_TIMEOUT_DEFAULT`). When a per-mutant check fails and that verdict is present and not `pass`, the
    failure ends "SleeperDoubles is not green at baseline …: the Sleep rule was not exercised; gate-fail". No
    verdict rule changes: a timed-out baseline is still `gate-fail`. X (b)'s held line goes into the receipt as
    soon as it is known.
  - X (d), since r11 ([[R649]]): `Probe Sleeper` sleeps 5 s, not 600 s. BC waits out a Sleep (bc2, R649 case 2: a
    5 s Sleep is green in 5095 ms), and a 600 s one never finishes under the 120 s baseline budget on BC or on a
    v3 build that counts Sleep. r5's table is the one pass on alpha.2 and on edge (edge: predicted by r11 (d3));
    on edge the leg reads `held` only through X (b). The three 600 s sibling tests stay; on edge they are
    baseline `timeout` rows, not refusals.

### Legs L1, Y-A, Y-B and K (R654 S2)

These legs were ported from `itest:alrunner` before the .NET al-runner was retired (R654 S3, 2026-10-22). They are pre-committed in `docs/superpowers/specs/2026-10-22-r654-v3-gate-legs-precommitment.md` (43115c78). Each runs one-shot, with coverage `"al-runner"` and a packages folder that holds only the Microsoft apps of `fixtures/sandbox-tests/.alpackages`.

Each leg first checks its pre-committed table. A difference is `gate-fail`, and no baseline is written. Only then does it compare against its own baseline.

- **L1** (R353's table): multi-batch layout, with figures equal to v2's. `fixtures/sandbox-layout` runs at `maxGuardsPerBatch` 7, which gives two batches.
  - It checks `EXPECTED_LAYOUT` (`layout-fixture.ts`) per `<batch>/<code>`: verdict, killing test, covering tests and attribution.
  - Predicted 7 / 3 / 0 over 10. Baseline: `al-runner-v3.layout.baseline.json`, identical per mutant to `al-runner.layout.baseline.json` (the .NET gate's, deleted in R654 S3).
  - It is the v3 gate's only multi-batch leg.
  - **It is R349's stale-layout check on v3** ([[R666]]). v3 labels a target file's coverage by the deployed flat path (`active/LayoutBeta.Codeunit.al`) in the EMITTED line numbers of that batch's text: in batch 1, TwiceOfThree hits lines 71, 73 and 79 of the 83-line instrumented file (measured on alpha.2, `/coord/handoff/R-666/measure.md`). So batch 1's lines must be read through batch 1's coverage index.
  - **The guard L1 proves is both coverage-index guards together:** `resetLayoutState()` sets `coverageIndex` to `undefined`, AND `deploy()` then assigns the new index unconditionally (`this.coverageIndex = index`). Either one alone keeps the index fresh.
  - **Its live red check is L-R3**, which removes both: delete `this.coverageIndex = undefined;` from `resetLayoutState` and change the assignment to `this.coverageIndex ??= index`. L1 then goes red as R353 predicts: 5 / 5 / 0, with 1/M0006 and 1/M0007 survived and `Layout Tests.GrowAboveTen` as their covering test (`/coord/handoff/R-666/live-LR3.log`; pre-committed in `docs/superpowers/specs/2026-10-23-r666-l1-stale-layout-precommitment.md`, 51d76b74).
  - **Two single-guard reverts stay green, by design** (2026-10-22, R-654 S2): L-R1 deleted `resetLayoutState()` (`/coord/handoff/R-654/s2-live-LR1.log`), and `deploy()`'s assignment still replaced the index. L-R2 changed the assignment to `??=` (`s2-live-LR2.log`), and the reset had just cleared the field, so `??=` still assigned.
  - **Offline guards** of the same property and of the reset's other fields: "R666: batch 1's coverage is read through batch 1's layout (one-shot)" in `tests/al-runner-v3-backend.test.ts` (red only with both guards removed); "R654 S2: a batch's latched blind note does not cross into the next batch" (`batchBlind`) and "R666: serve-entries state does not cross a deploy" (`baselineRows`, `union`) in `tests/al-runner-v3-entries.test.ts`, red when the reset is deleted. L1 cannot see those three fields: it has no Sleep and runs one-shot.
- **Y-A and Y-B** (R321): `fixtures/sandbox-symbols` under `[LETHALA]` and `[LETHALB]`. The symbols go to the backend, which passes them to v3 as `--define`, and to the session.
  - Each checks `EXPECTED_BY_SET` (`symbol-fixture.ts`).
  - Predicted 5 / 4 / 0 over 9 each. Baselines: `al-runner-v3.symbols-lethala.baseline.json` and `-lethalb`.
- **K** (R387, R394): the backend that `cli.ts`'s `buildBackend` builds from an `alRunnerV3` section with no `coverage` and no `transport` key.
  - It asserts coverage on by default, a one-shot transport (0 serve spawns), and the `AL_RUNNER_V3_NOT_AUTHORITATIVE` warning.
  - Its result is 3 / 12 / 4 over 19, equal per mutant to `bcdev.baseline.json`. It records no baseline of its own.
  - **K is outside `V3_GATE_LEGS`, by the orchestrator's ruling**, because the CLI's config cannot name a candidate build. Two conditions hold it, both pinned in `tests/r654-v3-legs.test.ts`:
    1. On a candidate (`LETHAL_ALRUNNER_V3_CANDIDATE=1`), K does not run. Its value in the itest's leg summary is `"K":"skipped (candidate build)"`, and its reason goes into the log and the receipt lines. It is never silent.
    2. On a gated build, a K that is anything but a pass FAILS the itest, a skip included (`v3ItestFailures`). So K can never become an always-skipped leg.

  The update gate's receipt outcome reads only `V3_GATE_LEGS` (which now holds MO and WR, below).

### Legs MO and WR (R602)

Pre-committed on master (`docs/superpowers/specs/2026-10-24-r602-alrunner-v3-mo-wr-precommitment.md`, c2f67f0a) and recorded once under R332 on 2026-10-24 on the pin (alpha.2 91253f2d6), equal to the pre-commitment per mutant (MO 12/12 rows, WR 98/98). The gate REFUSES to start MO or WR without their baselines (R332). Both are default legs AND in `V3_GATE_LEGS` (orchestrator ruling 2026-10-24): they are the only measurement of v3's per-object frame, so a build that breaks it must not move `current`. Inside these two legs an `AlRunnerCoverageFrameError` is `gate-fail` (`legOutcomeOfError(err, leg)`); in every other leg it stays `infra-fail`. `scripts/al-runner-v3-update.ts` needs no change: it judges the receipt by `gateOutcome` over `V3_GATE_LEGS`, so an older receipt without MO and WR reads `infra-fail` ("missing legs MO,WR").

Both legs are one-shot only (the measurement was one-shot): `LETHAL_ITEST_V3_TRANSPORT=serve-entries` makes them fail by name, `al-runner-v3-itest-leg-transport-refused`.

Both run as the other legs do (`runSession`, the v3 backend, one-shot, coverage `"al-runner"`, a packages folder of the Microsoft apps), not through the CLI guard. Each makes a **durable killer check** before it compares with its baseline: every mutant that `--mode none` kills (a constant in `alrunner-v3-legs.ts`, `V3_MO_KILLERS` and `V3_WR_KILLERS`, built from the measured `none` runs) must be killed by the same test. The constants are code, so a re-record of a baseline cannot absorb a lost kill.

- **MO** (R383's fixture): `fixtures/sandbox-multiobject`. `MultiPair.Codeunit.al` holds two codeunits, so the index places the second object's lines by position.
  - 6 / 1 / 5 over 12, as pre-committed (`al-runner-v3.multiobject.baseline.json`): the 5 `no-coverage` are in procedures no test calls (`Never`, `Unreached`).
  - Killer constant: 6 kills.
- **WR** (R-300b's fixture): `fixtures/sandbox-wrapped` whole, config symbol `WRAPDEF`, so the two-arm control `WrappedArms` is in it.
  - 58 / 37 / 3 over 98, as pre-committed (`al-runner-v3.wrapped.baseline.json`). The 3 `no-coverage` are the `WrappedArms` rows, each with the refusal sentence (`ARMS_REFUSAL`); that by-name refusal costs two kills `none` finds (M0001, M0003), named, not hidden.
  - Killer constant: 58 kills (`none` kills 60, minus those two).
  - Six `[v3-codeunit-state-possible]` notes are pre-committed (`V3_WR_STATE_NOTES`: M0071, M0072, M0078, M0085, M0086, M0092; BandYRun and BandYRunTwin after BandYDirect and BandYDirectTwin in one codeunit call, #5611). They are kills that stay kills. The leg asserts that exact set; MO and every other leg assert none.
  - As a whole the project is OFF from the CLI (the two-arm file), with the warning naming `WrappedArms`' file; the leg measures the index, which the CLI guard does not reach.

**Legs ruled out:**
- **The server and resource variants.** v3 one-shot uses the static selector, and serve-entries (R635) is opt-in. S3 pins that the resource selector is refused on one-shot.
- **Names.** Quoted test names are unselectable on v3 (#5572), and N1 covers the fixture.

**Recording (R332).** Run `LETHAL_ITEST_ALRUNNER_V3=1 LETHAL_ITEST_V3_LEGS=L1,Y-A,Y-B LETHAL_ITEST_RECORD_BASELINE=al-runner-v3.layout.baseline.json,al-runner-v3.symbols-lethala.baseline.json,al-runner-v3.symbols-lethalb.baseline.json bun run itest:alrunner-v3`. It exits 3 by design. Then confirm with every leg.
- **MO and WR (R602)** are recorded the same way, once, after their pre-commitment is on master: `LETHAL_ITEST_ALRUNNER_V3=1 LETHAL_ITEST_V3_LEGS=MO,WR LETHAL_ITEST_RECORD_BASELINE=al-runner-v3.multiobject.baseline.json,al-runner-v3.wrapped.baseline.json bun run itest:alrunner-v3`. The killer check and the counts run before anything is written.
- **Recorded 2026-10-22** on alpha.2 (91253f2d6), once, by that command (`/coord/handoff/R-654/s2-record.log`, exit 3). The figures are 7 / 3 / 0, 5 / 4 / 0 and 5 / 4 / 0 as pre-committed. Each file is identical per mutant to its .NET al-runner twin (`al-runner.layout`, `-symbols-lethala`, `-symbols-lethalb`; 0 differences).
- **When a file is missing,** `preflightGateBaseline` refuses the WHOLE run, before any leg starts, and names the record command. This happens whenever the run selects the leg whose baseline is missing (L1, Y-A or Y-B; by default all three are selected). It does not skip just that leg.
- **A record run never exits 3 when a leg that it did not record failed.** It exits 1 and names the leg (`v3RecordRunFailures`). A table mismatch writes no file.

**agentflow.** `scripts/agentflow/gate-table.ts` selects the `alrunner-v3` leg wherever it selected the retired `alrunner` leg (R654). A challenged run (the four `LETHAL_GATE_*` variables) writes a receipt whose sublegs must equal the default legs, with no corpus and no tables leg (`V3_AGENTFLOW_LEGS`).

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
- `timeout-is-cpu` is GATE-ONLY: since r14b it runs one huge burn (2,000,000,000 steps) at the 2 s limit, pinned to
  core 0: alone it must be stopped, and beside seven busy loops it must ALSO be stopped, with a durationMs over
  3000 ms AND over twice A's (a CPU-time stop is late in wall time; a wall-time limit with slack stops both calls
  together). It takes about 20 s and loads a core, so only leg C measures it, and a session trusts the gated build's record instead of re-burning (M1). That trust is per v3
  BUILD: a later LethAL change to how a call's timeout is sent (`v3CallArgv`, `stopSecondsOf`) is not covered by
  the old record and needs `bun scripts/al-runner-v3-update.ts --regate <commit>`.
- `.gated` names a commit on `lethal/r586`. The orchestrator merges with `--no-ff`, so that commit stays reachable
  from master.

## Frozen figures

```json gate-figures
{
  "gate": "itest:alrunner-v3",
  "baselines": {
    "al-runner-v3.tables.baseline.json": { "killed": 290, "survived": 57, "no-coverage": 59 },
    "al-runner-v3.layout.baseline.json": { "killed": 7, "survived": 3 },
    "al-runner-v3.symbols-lethala.baseline.json": { "killed": 5, "survived": 4 },
    "al-runner-v3.symbols-lethalb.baseline.json": { "killed": 5, "survived": 4 },
    "al-runner-v3.multiobject.baseline.json": { "killed": 6, "survived": 1, "no-coverage": 5 },
    "al-runner-v3.wrapped.baseline.json": { "killed": 58, "survived": 37, "no-coverage": 3 }
  }
}
```

- Leg L1, `al-runner-v3.layout.baseline.json`: 7 / 3 / 0 over 10, as pre-committed (43115c78).
- Leg Y-A, `al-runner-v3.symbols-lethala.baseline.json`: 5 / 4 / 0 over 9, as pre-committed.
- Leg Y-B, `al-runner-v3.symbols-lethalb.baseline.json`: 5 / 4 / 0 over 9, as pre-committed. All three were recorded once under R332 on 2026-10-22, and each is identical per mutant to its .NET al-runner twin.

- Leg MO, `al-runner-v3.multiobject.baseline.json`: 6 / 1 / 5 over 12, as pre-committed (c2f67f0a), recorded once under R332 on 2026-10-24.
- Leg WR, `al-runner-v3.wrapped.baseline.json`: 58 / 37 / 3 over 98, as pre-committed (c2f67f0a), recorded once under R332 on 2026-10-24.

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
- 2026-10-22: the edge rejudge of `57f1e4f98` at 711c94d9 gate-failed leg T on its counts (290 / 50 / 59, errors 7)
  before it classified any row, and X (d) read all five mutants `no-coverage` with no baseline verdict printed
  ([[R647]]). r10 (7bc0a1a5) moves leg T's judgement into `judgeLegT`, after the rows are printed, and makes X (d)
  print its baseline. No figure or baseline moves. The post-merge `--regate` and `--edge-rejudge` results are
  recorded in R647 after the merge.
- 2026-10-22: on edge, X (d)'s `SleeperDoubles` timed out at baseline, because edge counts its `Sleep(600000)`.
  bc2 measured BC's own Sleep under LethAL's baseline call ([[R649]], `docs/measurements/r649/`): 5 s passes,
  600 s gets no answer within the budget. r11 (338af789) changes that one literal to 5000. No figure, index size
  or baseline moves.
- 2026-10-23: r12 ([[R667]]) adds the contract fact `message-has-no-type-prefix`, so leg C has 27 facts: 9 defect,
  17 contract and 1 warn. Expected `matches` on alpha.2 (91253f2d6) and edge (57f1e4f98), INFERRED from R657's
  measurement (`/coord/handoff/R-657/measure.md`: no `<Type>: ` prefix on any of seven shapes, both builds). R657
  measured its own `PlainError`, not the probe's `Fails`, and the new Assert codeunit ran offline on alpha.2 only.
  It costs one extra one-shot call in leg C and none in a session. No other figure or baseline moves. The 27-fact
  head is not yet run live.
- 2026-10-23: [[R672]] (plan `docs/superpowers/plans/2026-10-23-r672-v3-refusal-prefix.md`) makes
  `message-has-no-type-prefix` read `V3_TYPE_PREFIX` instead of `AL_RUNNER_EXCEPTION_PREFIX` (deleted), the same
  prefix K1(a) and the v3 serve-keep rule read. Both probe texts have no `<word>: ` at the start, so the fact is
  predicted `matches` on alpha.2 and edge; still 27 facts. No figure or baseline moves.
- 2026-10-23: [[R675]] (plan `docs/superpowers/plans/2026-10-23-r675-v3-refusal-marker-anywhere.md`) deletes
  `V3_TYPE_PREFIX`. `message-has-no-type-prefix` now requires the exact starts `boom 5` and
  `Assert.AreEqual failed.`, which both builds write in all six logs (`/coord/handoff/R-675/measure.md` §3), so it
  is predicted `matches` on alpha.2 and edge; still 27 facts. K1(a), serve-keep and the two defect facts read the
  refusal marker anywhere: 0 of 13,773 stored kills and 0 stored v3 `pass`/`fail` rows hold it, so no verdict,
  fact reading or daemon count is predicted to move. No figure or baseline moves.
- 2026-10-23: [[R666]] restores L1's purpose as R349's stale-layout check on v3. R-654 S2's two red checks had each
  removed only one of the two coverage-index guards; L-R3 removes both and turns L1 red. No figure, baseline or leg
  code moves.
- 2026-10-23: r13 ([[R590]], coord task R-537) adds the contract fact `dependency-skip-line`, so leg C has 28 facts:
  9 defect, 18 contract and 1 warn. v3 leaves out a dependency it finds no source package for, and a call into it
  by id then fails with BC's missing-object text, which would score a kill BC never gives (measured on alpha.2 and
  edge, `/coord/handoff/R-537/plan.r1.md`). The backend now refuses the session on v3's skip line (one-shot calls,
  and the serve daemon's stderr after every request), and the fact pins that the gated build writes it. **The
  daily update gate (`al-runner-v3-update.ts`, `--edge`) now refuses a build that does not write that line.**
  Predicted `matches` on alpha.2 and edge; no other figure or baseline moves.
- 2026-10-23: r14b ([[R693]], coord task R-693) replaces `timeout-is-cpu`'s fixed burns. r6's counts stopped
  working that day: 55M steps now cost 1.6-3.8 s of CPU pinned to core 0 (r6 measured 1.5 s), so the short burn
  flipped between a pass and a stop with core-0 conditions, and every leg C and the daily update gate read
  gate-fail. A calibrated design (r14) also flipped in measured runs, because the burn's speed moved about 2x
  between the calibration and the burn. r14b needs no calibration: one huge burn (2,000,000,000 steps, never
  finishes), two calls pinned to core 0 at a 2 s limit. A (alone) must be a "Test exceeded 2s timeout." row. B
  (beside seven busy loops, killed in a `finally`) must be that row too, with durationMs over 3000 ms (1.5 times
  the limit; the burn gets about 1/8 of the core, so a CPU-time stop is late, a wall-time stop is at about 2000).
  Each call has a 60 s process timeout: a killed A reads `diverged` (no limit), a killed B `unmeasurable`. A
  missing row is `unmeasurable`; B not stopped, stopped at 3000 ms or less, or stopped at no more than twice A's
  durationMs (build review B1: a wall-time limit with slack, A and B both near 4000 ms), is `diverged`. Each busy
  loop is `taskset -c 0 timeout -s KILL 150 sh -c ...`, so a killed bun cannot orphan it. Measured offline on
  alpha.2 in five back-to-back leg C runs: A 2.0-2.05 s, B 16.0-16.1 s (about 8x A), all `matches`. Fact count unchanged (28).
  Predicted `matches` on alpha.2 and edge.
