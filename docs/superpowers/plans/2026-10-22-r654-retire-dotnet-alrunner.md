# R-654 plan, r1: retire the .NET al-runner (v2)

**Basis.** This plan follows the inventory, `/coord/handoff/R-654/inventory.md`, which was accepted. Repo master is `3938da62`. The plan is read-only: it changes no code.

**The orchestrator's rulings, which this plan follows:**
- The work lands as four stages, S1 to S4, each submitted separately.
- Each stage must be green on its own, and gated on its own.
- `CoverageMode "al-runner"` stays: v3 uses it too.
- CLAUDE.md and `.kraken/project.yaml` change only after the owner confirms the text in §6.

**Words used in this plan.**
- **v2** is the .NET al-runner. In the code it is backend kind `"al-runner"` and config section `alRunner`.
- **v3** is the Rust al-runner. In the code it is backend kind `"al-runner-v3"` and config section `alRunnerV3`.
- A **leg** is one LethAL session inside a gate.
- A **red check** works like this: undo one guard on purpose, confirm the named test fails, then put the guard back.

**What every stage must run.** Each stage runs `bun scripts/verify.ts`, plus every gate that `scripts/agentflow/gate-table.ts` names for the stage's diff. All of them run on the stage's final head.

**CI.** No CI job runs `itest:alrunner`. `.github/workflows/ci.yml` runs `bun test` and typecheck only, and `release.yml` has no itest. So removing the gate in S3 needs no CI edit.

---

## S1: move only (no behaviour change)

**When it can start.**
- Only after R-652 merges, because R-652 edits `al-runner-v3-backend.ts`.
- S1 touches only that file's import lines, so it rebases cleanly onto R-652.
- R-649 edits the v3 gate's leg X (d). S1 does not edit the gate at all. Tell R-649's lane which files S1 touches, so the two never clash.

### What moves

Each symbol moves to a new home. v2 then imports it from that home. There are no re-export shims: every import site is changed to point at the new module.

| Symbol(s) | From | To |
|---|---|---|
| `verdictFromRunnerTest`, `RUNNER_REFUSAL`, `RUNNER_TIMEOUT_MESSAGE`, `RUNNER_ONRUN_TIMEOUT_MESSAGE`, `parseReportedStopMs`, `timeoutLocation` (stays unexported), `AL_RUNNER_UNCLASSIFIED_ERROR` | `al-runner-backend.ts` | new `al-runner-rows.ts` |
| `V3_SERVE_SAFE_REFUSALS`, `serveDaemonReusable`, `ServeDaemonRule`, `AlRunnerServeDuplicateRowError`, `defaultServerSpawn` | `al-runner-backend.ts` | `al-runner-server.ts` (which is kept) |
| `compileEntriesOf`, `AlRunnerCompileEntry` | `al-runner-transport.ts` | `al-runner-server.ts` |
| `installResourceSelector`, `assertResourceSelectorRuntime`, `runtimeBelow14`, `ResourceSelectorRuntimeError` | `al-runner-backend.ts` | new `resource-selector.ts` |
| `baseAppJson` | `al-runner-canary.ts` | `al-runner-v3-probe.ts` (`al-runner-v3-contract.ts` already imports from it) |

**What stays where it is:**
- `al-runner-coverage.ts` stays put. v3 uses six of its exports.
- `AlRunnerServer` keeps its `subcommand` default of `"--server"` in S1. It changes in S3.

**After S1, v3's imports from v2 modules.** The v3 files and `buildAlRunnerV3Backend` import nothing from the v2 modules, except two that stay:
- `al-runner-coverage.ts`, which S3 trims but keeps;
- `al-runner-server.ts`, which is kept.

The guard that proves it: a new unit test, `tests/r654-v3-imports.test.ts`. It parses the import lines of `al-runner-v3-*.ts`, and fails if any of them names `al-runner-backend`, `al-runner-transport`, `al-runner-canary`, `al-runner-contract`, `al-runner-frame-probe`, `al-runner-predefined-probe` or `al-runner-cache`.

### Tests

**Tests that move, unchanged:**

| Tests | From | To |
|---|---|---|
| `parseReportedStopMs (R517)` describe; the `verdictFromRunnerTest` cases (R534 refusal rows, the `skipped` row, the unknown-timeout row) | `al-runner-backend.test.ts` | new `tests/al-runner-rows.test.ts` |
| `serveDaemonReusable, the rule alone` (6 tests) | `al-runner-backend.test.ts` | new `tests/al-runner-serve-rule.test.ts` |
| `AlRunnerServer.start`, `runTests`, `close` | `al-runner-server.test.ts` | stay in that file |

**Tests rewritten on purpose:** R612's T2–T6.
- Today they run the v3 serve rule through `AlRunnerBackend`, with `serveDaemonRule: "v3"` set on it.
- They are rewritten against `AlRunnerV3Backend`'s serve-entries transport, using `fakeServe` in `al-runner-v3-entries.test.ts`.
- The original T2–T6 stay in place until S3, so v2's own path keeps its tests.

**Red checks.** Each must go red in its NEW file, then go green again after the restore.

| # | Revert | Must go red |
|---|---|---|
| R1 | In `serveDaemonReusable`'s v3 arm, remove the duplicate-name throw | the M-3 test, and the ported T6 |
| R2 | Delete the `commit` entry from `V3_SERVE_SAFE_REFUSALS` | the ported T2 (Commit). The ported T3 stays green (the closing direction) |
| R3 | Make the v3 arm return `true` for a timeout row | the ported T3. T2 stays green |
| R4 | Make `RUNNER_REFUSAL` never match | the refusal row is scored a kill, so the "refusal is `runner-refused`" test goes red |
| R5 | Make `RUNNER_REFUSAL` match everything | the "plain `fail` is a kill" test goes red |
| R6 | Re-add `import … from "./al-runner-backend"` in `al-runner-v3-backend.ts` | `r654-v3-imports.test.ts` |

### Gate prediction (pre-commit before any live run)

- `itest:alrunner`: all 23 legs PASS, every frozen figure unchanged, per mutant:
  - `al-runner.baseline.json` 3/12/4;
  - cli-default 3/12/4;
  - layout 7/3/0;
  - multiobject 6/1/5;
  - wrapped 58/37/3;
  - names 36/0/0;
  - symbols-lethala 5/4/0;
  - symbols-lethalb 5/4/0;
  - kill reproduction: 2 killer rows per kill, cli-default 23 activations and 22 `runTests`.
- `itest:alrunner-v3`: every leg configured on the gate host is unchanged. That is C (26 facts), S1 (3/12/4 equal to bcdev), S3 (refused by name), N1 (36/0/0), X, and T (290/57/59 over 406) when enabled. D1 and D1c run only if the CDO checkout is set.
- A difference anywhere is a BLOCK.

**Size.** About 600 source lines moved and about 900 test lines moved or rewritten. About 15 import sites change: cli, orchestrator, report, the v3 files, the `scripts/r5xx-probe/*` probes, and the tests.

**Risks.**
- R-652 may conflict on `al-runner-v3-backend.ts`. Rebase after it merges.
- Some symbol may be missed. Typecheck catches that, and R6 guards it.

---

## S2: the gate

### S2a: agentflow

- `scripts/agentflow/gate-table.ts`:
  - add the leg `"alrunner-v3"` to the `Leg` union;
  - map `LEG_LEGS["alrunner-v3"]` to `V3_GATE_LEGS` (plus the new legs);
  - set `LEG_CONTAINER` to `"agent-app"`;
  - add it to every path rule that names `"alrunner"`, so both legs run until S3;
  - add a rule for `packages/runner/src/al-runner-v3-*` and the v3 itest files.
- `scripts/agentflow/tick.ts`: `EXPECTED_SUBLEGS` gets the v3 leg ids.
- Tests in `scripts/agentflow/*.test.ts`:
  - **a new test:** a change to `al-runner-v3-backend.ts` selects `alrunner-v3`;
  - **a red check:** remove the path rule, and that test goes red.

### S2b: three legs ported to `al-runner-v3.itest.ts`

All three legs run on `V3_GATE_LEGS`. Each runs one-shot, through `AlRunnerV3Backend`.

**L1, layout (R349, R353).**
- Project: `fixtures/sandbox-layout` with its tests.
- Settings: `maxGuardsPerBatch` = `LAYOUT_MAX_GUARDS` (7), which gives 2 batches. Coverage `"al-runner"`.
- It asserts against `EXPECTED_LAYOUT` (`layout-fixture.ts`): verdict AND covering test, keyed `<batch>/<code>`.
- Predicted figures: **7 / 3 / 0 over 10**, equal per mutant to `al-runner.layout.baseline.json`.
- Basis for the prediction: R-586's `measure.md`, row "sandbox-layout": 0 of 10 differ, on alpha.2. That run used the pre-v3-backend pipeline, so through `AlRunnerV3Backend` the result is **unmeasured**.
- Red check: delete `resetLayoutState()` from `AlRunnerV3Backend.deploy`. The leg must go red on `1/M0006` and `1/M0007`, as on v2. This red check runs live on a scratch copy. If it does NOT go red, that is a finding: the leg cannot see a stale layout on v3, and it is filed as such.

**Y-A and Y-B, symbols (R321).**
- Project: `fixtures/sandbox-symbols` with its tests.
- Settings: `preprocessorSymbols` `["LETHALA"]`, then `["LETHALB"]`.
- They assert against `EXPECTED_BY_SET` (`symbol-fixture.ts`): verdict and killing test.
- Predicted figures: **5 / 4 / 0 over 9 each**, equal per mutant to the v2 symbol baselines.
- Basis for the prediction: R-586's `measure.md` row 10 (one-shot and serve on alpha.2, through the old pipeline). Also unmeasured through `AlRunnerV3Backend`.
- Red check, live, on a scratch copy: drop `--define` from `v3CallArgv` (the `symbols.flatMap(["--define", s])` line). The prediction is that both legs then fail `per-mutant verdicts differ from the pre-committed table`.

**K, cli-default (R387, R394).**
- It builds the backend through the CLI's own `buildBackend`, from an `alRunnerV3` section that has no `coverage` and no `transport` key.
- It asserts:
  - coverage is on by default, so SandboxPricing's 4 mutants read `no-coverage`;
  - the transport is one-shot: no `serve` spawn is recorded, using a spawn wrapper as `cli-default-leg.ts` does;
  - the `AL_RUNNER_V3_NOT_AUTHORITATIVE` warning is printed.
- Predicted figures: **3 / 12 / 4 over 19**, equal per mutant to `bcdev.baseline.json` in verdict and killing test, the same table as S1. So K needs **no new baseline**.
- Red check: change `validateAlRunnerV3Config`'s coverage default to `"none"`. K must then fail on the 4 SandboxPricing mutants (they turn `survived`).

**Packages folder for L1 and Y.**
- Both tests apps depend only on their target app.
- The leg copies the Microsoft apps out of `fixtures/sandbox-tests/.alpackages` (the pinned symbol tar) into a scratch packages folder. It does not re-pin the tar.
- If v3 refuses that folder, the leg stops by name. The plan is then amended; nothing is recorded.

### Legs ruled out, each with its reason

- **Server and resource variants.**
  - On one-shot, v3 refuses the resource selector, and S3 already pins that refusal.
  - Serve-entries (R635) is opt-in. It already re-runs the gate legs under `LETHAL_ITEST_V3_TRANSPORT=serve-entries`, and R652 and R653 are still changing it.
  - So: not in the default gate.
- **Multi-object and wrapped.**
  - v3 turns coverage off for those files by design (`alRunnerCoverageSupport`, R602), so a leg would pin a refusal, not a measurement.
  - The unit tests in `r586-cli-v3.test.ts` already pin the coverage-off warning.
  - R602 stays open, as the place to measure v3's frame.
- **Names.**
  - v3 cannot select quoted names (upstream issue #5572, already filed).
  - N1 already runs the names fixture on v3.

None of the ruled-out legs needs a new upstream issue.

### How S2 records baselines (R332)

**Order:**
1. `al-runner-v3.layout.baseline.json`
2. `al-runner-v3.symbols-lethala.baseline.json`
3. `al-runner-v3.symbols-lethalb.baseline.json`

K uses `bcdev.baseline.json`, which already exists.

**Steps:**
1. Add the three files to `baseline-guard.ts` `gateHow` (`LETHAL_ITEST_ALRUNNER_V3=1 ...`). The itest then refuses to start when a file is missing.
2. Pre-commit on master, specs only, with `[skip ci]`: `docs/superpowers/specs/2026-10-xx-r654-v3-gate-legs-precommitment.md`.
   - It holds the per-mutant tables. These are copied from `EXPECTED_LAYOUT` and `EXPECTED_BY_SET`, plus the predicted figures and red checks above.
   - It states that a difference from the prediction is NOT recorded: the lane stops and reports to the orchestrator.
3. Run once in record mode: `LETHAL_ITEST_RECORD_BASELINE=al-runner-v3.layout.baseline.json,al-runner-v3.symbols-lethala.baseline.json,al-runner-v3.symbols-lethalb.baseline.json`, with legs L1 and Y only. It exits 3 by design.
4. Re-run without the variable, all legs. It must PASS.
5. Diff each new baseline against its v2 twin, keyed by mutant key (the `repo-scripts` report-diff script, or `mutant-equality.ts`'s compare). Verdict, killing test and mutated-text hash must all be identical.
6. Update `docs/gates/alrunner-v3.md`'s `gate-figures`, and point `gate-pages.test.ts`'s pins for `EXPECTED_LAYOUT` and `EXPECTED_BY_SET` at the new files.
7. Commit.

### S2 gate prediction

- `itest:alrunner`: unchanged, as in S1.
- `itest:alrunner-v3`: every existing leg unchanged. L1 7/3/0, Y-A 5/4/0, Y-B 5/4/0 and K 3/12/4, each per mutant as stated above.
- Red checks for the agentflow rule and the new legs, as above.

**Size.** About 350 lines of itest, plus about 60 lines of agentflow, 3 baselines and 1 spec.

**Risks.**
- The v3 runtime may differ on the layout or symbol fixtures. That is a BLOCK. Investigate it, and file it upstream if it is v3's fault.
- The packages folder may be refused.
- R-649 also edits the v3 itest. Land S2 after R-649 merges, or rebase onto it.

---

## S3: the delete, and the three refusals

### Deleted

**Source** (`packages/runner/src`):
- whole modules: `al-runner-backend.ts`, `al-runner-transport.ts`, `al-runner-contract.ts`, `al-runner-canary.ts`, `al-runner-frame-probe.ts`, `al-runner-predefined-probe.ts`, `al-runner-cache.ts`;
- from `al-runner-coverage.ts`: `parseCobertura`, `alRunnerCoverageFrom`, `ExactResolution`, `CoberturaLine`.

**`al-runner-server.ts`.** Drop the `"--server"` subcommand and the `"v2"` arm of `ServeDaemonRule`. `subcommand` becomes `"serve"`, with no default.

**`cli.ts`:**
- the `alRunner` section: `AlRunnerConfigSection`, `AL_RUNNER_KEYS`, `validateAlRunnerConfig`, `effectiveAlRunnerTransport`, the settings notes;
- `prepareAlRunnerSession`, `applyAlRunnerCoverageGuard`, `withAlRunnerCanary`, and the contract and canary runners;
- `buildBackend`'s `"al-runner"` branch;
- the v2 dry-run R392 probe and the R583 dry-run refusal;
- doctor's `alRunnerStatusFor`, `alRunnerCache`, and the "al-runner-only" message;
- the `instanceof AlRunnerBackend` close.

**`orchestrator.ts`:**
- `provisionOnce` and the R149 re-probe;
- the `isAlRunnerV2` predefined-symbols path;
- R557's `alRunnerNames` stamp and `historyAlRunnerNamesWarned`;
- `alRunnerRenamed`;
- `observedBcBuild`;
- `AL_RUNNER_UNDECIDED_ARM_MISSING`;
- `carryBarredFiles`' v2 arm.

**`backend.ts`:**
- `BackendKind` becomes `"bcdev" | "al-runner-v3"`;
- `isAlRunnerV2` is deleted;
- `isLocalRunner` stays, and now means v3 only.

**`preprocessor-symbols.ts`:** `BuildBackend`'s `{kind:"al-runner"}` variant, the predefined branch, and the R377 note.

**`report.ts`:**
- the `ExecutionContext` fields `bcBuild`, `bcBuildAnnouncement`, `platformAppsDir`, `testSelector`;
- the `alRunnerCanary` field;
- the end-banner canary repeat;
- the R553 screen's `"al-runner"` arm.

**`events.ts` and `report-fold.ts`:** the events `al-runner-bc-build`, `al-runner-platform-apps`, `al-runner-test-selector`, and the warnings `-unpinned` and `-predefined-symbols-changed`.

**`assertion-screen.ts`:** the al-runner arm and `AL_RUNNER_EXCEPTION_PREFIX`.

**`store.ts`:** `runLendsAlRunnerNames`, `runMayLend` steps 2 and 3, and the `LendRefusal` kinds `al-runner-unmarked` and `al-runner-renamed`. The `al_runner_names` column is left in the schema, unread. Dropping it is not worth a migration.

**`line-map.ts`.** Keep `refusedObjectsOfFile`'s `"al-runner"` arm: the v3 coverage index calls it. Change its parameter type to name `"al-runner-v3"`. The plan adds no behaviour change here.

**Tests (deleted):**
- the ≈31 v2-only files listed in inventory §4;
- the v2 halves of `al-runner-backend.test.ts`, which is then deleted, because S1 already moved the v3 half;
- the cobertura half of `al-runner-coverage.test.ts`.

**Tests (re-pointed on purpose to `kind: "al-runner-v3"` or a neutral fake).** These are every `kind: "al-runner"` fake, flagged by typecheck: orchestrator, resume, cli, cli-envtool, cli-selector-ids, changed-since-git, r389, r445, the filter tests, r381, r558, r585, r629, r644, r646c, report, assertion-screen.
- A test that asserted v2-only behaviour is deleted, not re-pointed.
- The lend tests r586-run-may-lend, r618 and r619 lose their R557 cases and keep the cross-backend cases.

**Itest and fixtures (deleted):**
- `itest/al-runner.itest.ts`, `alrunner-legs.ts`(+test), `alrunner-supervisor.ts`(+test), `cli-default-leg.ts`, `multiobject-fixture.ts`;
- the 8 `al-runner.*.baseline.json` files;
- `fixtures/sandbox-multiobject` and its `-tests`.

**Kept:**
- `sandbox-layout`, `sandbox-symbols`, `layout-fixture.ts` and `symbol-fixture.ts` (the S2 legs use them);
- `sandbox-wrapped` and `sandbox-names` (bcdev uses them).

**Scripts (deleted, because typecheck covers `scripts/`):**
- `alrunner-legs-diff.ts`(+test), `probe-alrunner-canary.ts`, `probe-alrunner-tables.ts`;
- the historical probes `r300b-probe/`, `r517-probe/`, `r518-probe/`, `r534-probe/`;
- the v2 parts of `r586-probe/lethal-probes.ts` and `run-fixture.ts`;
- `package.json` `itest:alrunner`.

**Agentflow:** `gate-table.ts` loses the `alrunner` leg. `baseline-guard.ts` loses the v2 `gateHow` entries and `LETHAL_ITEST_RECORD_SYMBOL_BASELINES`.

### Added: three refusals by name

Each refusal is its own error class, and each extends `Error` directly.

| # | Where | Refusal |
|---|---|---|
| F1 | `parseBackend` | `--backend al-runner` → `al-runner-v2-retired: the .NET al-runner backend was retired (R654); use --backend al-runner-v3` (not "unknown") |
| F2 | Config load (`loadConfig` for run, dry-run and doctor) | an `alRunner` section → `al-runner-v2-retired: lethal.config.json has an "alRunner" section ...; move it to "alRunnerV3"`. It is never silently ignored |
| F3 | `store.ts` | `backendBuildRefusal` (all four lend sites) and the `--resume-run` backend check: a run with `backend === "al-runner"` → `al-runner-v2-retired: run N ran on the retired .NET al-runner (R654); nothing of it is lent` |

The same name also covers SessionReport readers (`explain`, `campaign compare`/`freeze`, `verify --report`), which refuse a report with `backend: "al-runner"`.

**Tests, one per direction, each red-checked.** For each of F1, F2 and F3:
- the v2 input is refused by that name;
- the v3 or bcdev input still passes.

Red check: delete each refusal.
- For F1, the error goes back to the generic "unknown --backend", and the name test goes red.
- For F2, the run goes through, and the test goes red.
- For F3, the lend message goes back to the R592 generic mismatch, and the test goes red. The rows still lend nothing, so only the name test catches it.

### Schema ripple (CLAUDE.md's list, in reverse)

1. `events.ts`, then the `report-fold.ts` accumulator, then `report.ts`'s type, builder and banner.
2. `bun scripts/generate-schemas.ts`. This drops `alRunnerCanary` from report-v3, and the 3 events and 2 warnings from stream-v1. Doctor drops `al-runner-only`.
   - The plan's choice: the change narrows the schema, so bump report to **v4** and stream to **v2**, and keep the old files, as the repo does for older versions.
3. `tests/schemas.test.ts`: the pinned root-required list, and the older-reports expectation.
4. `bun test tests/report-equality... --update-snapshots`, then review the diff.
5. Regenerate the committed gift-card sample report live on bcdev, because `schemas.test.ts` validates it.
6. No new `Caveat` is added. If a caveat interpretation names al-runner v2, update its counts in `interpretation.test.ts` and `report.test.ts`.

### S3 gate prediction

- `itest:alrunner` is gone. Its receipt is no longer asked for.
- `itest:alrunner-v3`: every leg unchanged per mutant: C, S1, S3, N1, X, L1, Y-A, Y-B, K, and T when enabled.
- `itest:bcdev`: unchanged per mutant, 3/12/4.
- S3 touches orchestrator, store and report, so `gate-table` will name the full set. Predict every one of those gates unchanged per mutant against its committed baseline. That includes `itest:lend`: its R557 snapshot check goes, and the lend page says the v2 legs covered it.

**Size.** About −9,000 source lines and about −16,000 test and itest lines. About 40 files are re-pointed. It is the largest stage.

**Risks.**
- A shared-behaviour test may be deleted instead of re-pointed. In review, list every deleted `test(` whose title does not name v2.
- Schema bump fallout.
- `.kraken/project.yaml` still runs `al-runner-bootstrap.sh`, which is harmless until the owner edits it (§6).

---

## S4: docs and roadmap

**Docs to sweep.** These are the 17 files in inventory §7, plus `.claude/skills/live-gate/SKILL.md` and `.claude/agents/roadmap-auditor.md`.
- `docs/gates/alrunner.md` becomes a short "retired by R654" stub, with its history kept. The README gate row is removed.
- `docs/measurements/README.md` §"al-runner v2", §2.1.0.0 and §2.1.2.0 get a "retired (R654)" header and are kept as history.
- `bcdev.md`, `bcdev-names.md`, `bcdev-wrapped.md`, `lend.md` and `servers.md` drop or reword their al-runner cross-references.
- `alrunner-v3.md`'s S1 line says "bcdev's table".
- `using-lethal-from-an-agent.md`: update `agent-contract.test.ts` along with it.
- Add a CHANGELOG entry.
- The CLAUDE.md edits land here once the owner confirms them.

**Roadmap.** Re-check the next free id first.
- **Closed** as `closed <date> — retired with v2 (R654)`, each with evidence:
  - R541, by its own text;
  - R344, R395, R538, R544, R519, R581, R241, R207, R539, R559;
  - R435, but only after the plan checks that v3 fingerprints `packagesDir` by bytes. Otherwise it is re-worded.
- **Stay open with a note** ("measured on v2 only; re-measure on v3"): R537, R540, R542, R543, R578, R590, R471.
- **Edited:**
  - R602, R580 and R579 (the coverage-guard items);
  - R611 (the backend union);
  - R560 (minus the 8 v2 baselines);
  - R271 and R223 (`alrunner` becomes `alrunner-v3`);
  - R584.
- R654 becomes `done (<S4 commit>)`.
- Run `bun scripts/roadmap-index.ts` and `bun test scripts/line-citations.test.ts`.

**Gate.** S4 is docs only. It needs `gate-pages.test.ts`, `roadmap-index.test.ts` and `agent-contract.test.ts` green. No live gate.

---

## 5. The owner's tooling (listed only; nothing is deleted)

- `/work/tools/al-runner/`: `c5bbaf89`, `f06ee78c`, `failed`, `current -> f06ee78c`.
- `scripts/al-runner-update.sh` (+test). Its daily run is already suspended (R586).
- `scripts/al-runner-bootstrap.sh`, run by `.kraken/project.yaml` setup.
- The Windows host's `H:/al-runner-builds/c39ad5de` and the dotnet global tool.

The plan keeps the two scripts in the repo until the owner rules, because removing `al-runner-bootstrap.sh` would break the setup step. After the ruling, S3 or S4 deletes them, and the owner archives the directories.

## 6. Owner confirmation: drafted text (old, then new)

### CLAUDE.md

L22, L40, L41, L43, L44, L45, L46 and L47 are drafted in `inventory.md` §8, old text then new text. L39 and L42 stay unchanged.

L46 takes variant (a): S2 keeps `sandbox-symbols`. The new text is:

> - `compile:fixtures --require-symbol-sets` compiles all three builds of the symbol pair (`fixtures/sandbox-symbols`) and refuses a skip. The pair's `app.json` files must never define a symbol: the build's symbol set includes `app.json`'s own symbols, and the pre-committed tables assume there are none.

L47 keeps `LayoutBeta`, because S2 ports the layout leg. The new text is:

> - `LayoutBeta`'s header comment, and the load-bearing comment inside `Twice` in `fixtures/sandbox-wrapped`, set the line spans the v3 layout leg's and `itest:bcdev-wrapped`'s predictions rest on: do not edit them without a new pre-commitment.

The R332 paragraph also mentions the symbol-baseline record variable. Old text:

> R321's symbol baselines keep `LETHAL_ITEST_RECORD_SYMBOL_BASELINES=1`, now also exclusive.

New text: delete the sentence. The v3 symbol baselines use `LETHAL_ITEST_RECORD_BASELINE`.

### .kraken/project.yaml

1. The setup step.
   - Old: `  - bash scripts/al-runner-bootstrap.sh`
   - New: delete the line. The v3 pin is `/work/tools/al-runner-v3/current`, managed by `scripts/al-runner-v3-update.ts`.
2. The env.
   - Old: `  LETHAL_ALRUNNER_PATH: /work/tools/al-runner/current/al-runner`
   - New: delete the line. v3 defaults to `AL_RUNNER_V3_DEFAULT_PATH`, and `LETHAL_ALRUNNER_V3_PATH` overrides it.
3. The reaper.
   - Old:
     ```
         - exe: al-runner
           args_contain: --server
     ```
   - New:
     ```
         - exe: alrunner
           args_contain: serve
         - exe: al-runner
           args_contain: serve
     ```
   - Two entries are needed because alpha.2's binary is named `alrunner`, and alpha.3 and later rename it to `al-runner`.

---

## r1 (answers `/coord/handoff/R-654/review-plan-opus.md`)

Where r1 and the sections above disagree, r1 wins.

### I1: the wrapped-file rule gets its own parameter, and moves into S1

**What happens today.**
- `refusedObjectsOfFile` and `coverageRefusedObjects` take `BuildBackend["kind"]`.
- The coverage index passes `"al-runner"`, so an R-300b admitted wrapped file refuses nothing there.
- The orchestrator passes the session's kind. A v3 session gets neither the bcdev arm nor the al-runner arm, so it refuses every object of a wrapped file (`refusedWholeFileReason`).
- `carryBarredFiles` is `alRunnerAdmitsWrappedFile` for v2, and `admittedOnBc` otherwise. For v3 it is empty, because `bcArms` is empty.

**The fix.** It moves into S1, because it is a pure rename that keeps today's mapping exactly.
- `line-map.ts` gets `export type WrappedRule = "bc-shape" | "al-runner-index" | "refuse-wrapped"`.
- `refusedObjectsOfFile` and `coverageRefusedObjects` take a `WrappedRule` instead of a kind.
- A new mapping function, `wrappedRuleFor(kind: BackendKind): WrappedRule`, gives:
  - `bcdev` → `"bc-shape"`;
  - `al-runner` → `"al-runner-index"`;
  - `al-runner-v3` → `"refuse-wrapped"`.
- Call sites:
  - The coverage index (`al-runner-coverage.ts`) passes `"al-runner-index"` literally.
  - `coverageRefusedFromSources` and `verify.ts` pass `"bc-shape"`.
  - The orchestrator passes `wrappedRuleFor(backendName)`.
- `carryBarredFiles` is keyed on the same rule:
  - `"al-runner-index"` → `alRunnerAdmitsWrappedFile`;
  - `"bc-shape"` → `admittedOnBc`;
  - `"refuse-wrapped"` → none, because nothing is admitted.
- The `"al-runner-index"` arm stays in S3. S3 deletes only the `al-runner` row of `wrappedRuleFor`.

**New tests** in `tests/r654-wrapped-rule.test.ts`, parsing the `sandbox-wrapped` fixture.

| Test | Asserts |
|---|---|
| (a) | Under `wrappedRuleFor("al-runner-v3")`, an R-300b admitted wrapped file's objects are ALL refused, with `refusedWholeFileReason`. |
| (b) | Under `"al-runner-index"`, the same file refuses nothing. |
| (c) | `carryBarredFiles` for a v3 session is empty, and for the index rule it holds the admitted file. |

**Red checks.**
- Map v3 to `"al-runner-index"`: (a) goes red, and (b) stays green.
- Make the index arm refuse everything: (b) goes red, and (a) stays green.
- Make `carryBarredFiles` ignore the rule: (c) goes red.

### I2: re-pointed lend and resume fakes

**The rule.**
- A fake that tests a guard OTHER than the backend/build step is re-pointed to `bcdev`.
- A fake that tests v3's own build matching is re-pointed to `al-runner-v3`, with `runnerBuild` equal to the session's (B1).
- Each file is red-checked by disabling its OWN guard. The test must go red while the backend/build step still passes. That shows step 1 is not what keeps it green.
- `"al-runner"` used as a COVERAGE MODE is not a backend fake, and it stays. Those uses are resume.test's mode list, baseline-snapshot's `other` list, and r618's `coverageMode`.

| File | Fake today | Re-point to | Red-check against |
|---|---|---|---|
| `r445-nested-run.test.ts` | `backendKind: "al-runner"` | `bcdev` | R445's nested-project refusal |
| `resume.test.ts` (fake classes at `kind: this.authoritative ? "bcdev" : "al-runner"` and the subclass returning `kind: "al-runner"`) | v2 | `bcdev`. The non-authoritative case becomes `al-runner-v3` + B1 in the fake run row | the resume checks each describe names (identity scheme, coverage mode, test-app hash, batch invalidation) |
| `r585-test-scope-lend.test.ts` | `kind: "al-runner"` | `bcdev` | R585's `testScope` check in `runMayLend` siteChecks |
| `r644-source-baseline-lend.test.ts` | `kind: "al-runner"` | `bcdev` | R644's source-baseline check |
| `r646c-whole-replay-reach.test.ts` | `kind: "al-runner"` | `bcdev` | R646c's whole-replay reach rule |
| `r586-run-may-lend.test.ts` | `run("al-runner", ...)` pairs | Cross-backend cases become `bcdev`↔`al-runner-v3`. Cases that are only about v2 go (R557) | `backendBuildRefusal`: drop the v3 build compare (the B1≠B2 case goes red); drop the R592 cross-backend arm (the bcdev-vs-v3 case still refuses through the v3 arm, so pair it with a bcdev-vs-bcdev control) |
| `r618-lend-order.test.ts` | `AL_RUNNER` session | `bcdev` session. The R557 N1o case goes with R557 | `priorSurvivorKeys`' coverage-mode-before-test-app order |
| `r619-one-lend.test.ts` | `Kind = "al-runner" \| "al-runner-v3"` | `Kind = "bcdev" \| "al-runner-v3"`, with v3 rows given `runnerBuild` B1 | each site's call of `runMayLend` (history, resume, resume-run, snapshot). Remove the call at one site and that site's case goes red |
| `store.test.ts` `runLendsAlRunnerNames` cases | v2 | deleted with R557 | none needed (code deleted) |
| `itest/lend-seed.test.ts` | v3 seeds | unchanged | none |

### I3: no schema version bump

S3 narrows `report-v3` and `stream-v1` in place, and keeps `REPORT_SCHEMA_VERSION = 3`. `explain`'s `EXPLAINABLE_REPORT_VERSIONS = [2, 3]` is untouched. This replaces S3's "bump report to v4 and stream to v2".

**What is removed.**
- From report-v3:
  - the optional root `alRunnerCanary`;
  - the optional `ExecutionContext` fields `bcBuild`, `bcBuildAnnouncement`, `platformAppsDir`, `testSelector`.
  - None of them is in the root-required list, so `schemas.test.ts`' pinned list does not change.
- From stream-v1: the three event variants (`al-runner-bc-build`, `al-runner-platform-apps`, `al-runner-test-selector`) and the two warning codes.
- From doctor-v1: `al-runner-only`.

**The committed reports.**
- `docs/campaign/2026-08-16-gift-card/rehearsal.report.json` is schema 3, `backend: "bcdev"`, with none of the removed fields. **It still validates, so no regeneration is needed.**
- `docs/campaign/2026-08-03-do/rung2.report.json` (schema 2, bcdev) is unaffected.
- The five v2 reports are r396's `run-{i-old,ii-new,iii-cov}` and r546's `ar-{A,B}`.
  - They carry `alRunnerCanary`, and the root has `additionalProperties: false`, so they would no longer validate.
  - No test or gate reads them.
  - `explain`, `campaign compare` and `campaign freeze` refuse them by name (F3's report arm, `al-runner-v2-retired`) before any schema check.
  - They stay in the repo as history, and a note in each folder's README says so.

**Snapshots.** `report-equality` is predicted to be unchanged, because the banner change is v2-only. Run it without `--update-snapshots`. If it changes, stop and review.

**Tests (S3).**
- New: `explain` refuses a schema-3 report with `backend: "al-runner"` by name.
- New: the narrowed schema accepts the gift-card report and rejects an injected `alRunnerCanary`.
- Red checks: remove the refusal, and the first test goes red. Re-add `alRunnerCanary` to the type and regenerate, and the second goes red.

### I4: owner item for the secret templates, and when F2 can land

**Exact owner text.** For each of these four templates that `.kraken/project.yaml` copies in:
- `sandbox-app.local.json` → `fixtures/sandbox-app/lethal.config.local.json`
- `sandbox-data.local.json` → `fixtures/sandbox-data/lethal.config.local.json`
- `sandbox-app.agent.json` → `fixtures/sandbox-app/lethal.config.agent.json`
- `sandbox-data.agent.json` → `fixtures/sandbox-data/lethal.config.agent.json`

> Delete the whole `"alRunner": { ... }` member (the key and its object) and nothing else. Then re-copy the templates into every worktree, or run the kraken secret sync.

The lane does not read these files, because they hold logins. The owner applies the edit.

**F2 cannot land before this.**
- F2 would refuse `lethal run`, `doctor` and the probes in every provisioned worktree.
- The gates are not affected: they call `validateBcDevConfig` only.
- Landing S3 without F2 is also wrong: the section would then be silently ignored, which is a forbidden plausible default.

**The order:**
1. S1 and S2 land.
2. The owner strips the four templates and re-syncs.
3. The lane confirms, without reading the contents, that `lethal doctor --config <each>` no longer names an `alRunner` check.
4. S3 lands with F1, F2 and F3 together.

If the owner is not ready, S3 waits. There is no interim build that half-supports the section.

### Minor fixes

**M1: the import guard.**
- `r654-v3-imports.test.ts` reads the WHOLE file text of every `al-runner-v3-*.ts`, plus `al-runner-server.ts`, `al-runner-coverage.ts`, `al-runner-rows.ts` and `resource-selector.ts`.
- It fails on `/(?:from\s+|import\s*\(\s*)["']\.\/al-runner-(?:backend|transport|canary|contract|frame-probe|predefined-probe|cache)(?:\.js|\.ts)?["']/`. That covers multi-line imports, where the module is on the `} from` line, and dynamic imports.
- `al-runner-server.ts`' import of `al-runner-transport` goes in S1, when `compileEntriesOf` moves. The guard's red check R6 is extended: re-add that import in `al-runner-server.ts`, and the guard goes red.

**M2: the move table and the R534 claim.**
- Four symbols are added to the S1 move table:
  - `V3_TAIL_UNSAFE_WORDS`, `SAFE_TAIL` and `anyCase` go to `al-runner-server.ts`, beside `V3_SERVE_SAFE_REFUSALS`, which is built from them;
  - `isTimeoutRow` goes to `al-runner-rows.ts`. `al-runner-contract.ts` imports it from there until S3.
- The S1 claim that "the R534 verdictFromRunnerTest cases move unchanged" was wrong.
  - Only the DIRECT calls of `verdictFromRunnerTest` and `parseReportedStopMs` move unchanged: the `parseReportedStopMs (R517)` describe, and the direct call in the R534 describe.
  - The R534 tests that run through `AlRunnerBackend` (T5 and its siblings, which are async) stay in `al-runner-backend.test.ts` until S3 deletes them.
  - Their verdict rules get NEW direct-call tests in `al-runner-rows.test.ts`, red-checked by R4 and R5:
    - a refusal in `fail` or `error` is `runner-refused`;
    - a `skipped` row is `runner-test-error`;
    - an exit-3-proven unknown timeout is `timeoutWordingUnknown`, never a kill.

**M3: ordering with R-652 and R-653.** S1 starts after R-652 merges, and lands BEFORE R-653. R-653 then rebases onto S1, because S1's rewrite of T2–T6 targets serve-entries. This was agreed with the code lane.

**M4: the R553 screen arm.**
- S3's deletion of the R553 screen's `"al-runner"` arm and of `AL_RUNNER_EXCEPTION_PREFIX` changes nothing for v3: v3 is screened as bcdev today.
- [[R657]] (filed on master, `7c961d04`: "v3's failure-message shape is unmeasured") stays open as the place to measure it. S3 does not measure it.

**M5: `gate-pages.test.ts` and `alrunner.md` move into S3.**
- S2 only ADDS the v3 pins.
- S3, in the same commit that deletes the 8 v2 baselines:
  - removes the v2 entries, `ALRUNNER_FIGURES` and `"al-runner.itest.ts": "ALRUNNER_FIGURES"` from `gate-pages.test.ts`;
  - replaces `docs/gates/alrunner.md` with the "retired by R654" stub;
  - removes its `docs/gates/README.md` row.
- S4 keeps the rest of the prose sweep.

**M6: the reason the resource legs are ruled out** replaces S2's text. v3 one-shot uses the STATIC selector. `installResourceSelector` runs only under the serve-entries transport (R635), which is opt-in (`LETHAL_ITEST_V3_TRANSPORT=serve-entries`) and re-runs the gate's legs under its own runs. The existing leg S3 pins that `selectorMode: "resource"` is refused on one-shot. The ruling is unchanged.

**M7: S2 in record mode.**
- The record-mode run of L1, Y-A and Y-B asserts `EXPECTED_LAYOUT` and `EXPECTED_BY_SET` (verdict and covering or killing test) BEFORE it writes anything.
- A mismatch writes no baseline and exits 1, not 3.
- The pre-commitment states this.

### S1 pre-commitment figures (exact)

**`itest:alrunner`** (23 legs, every leg PASS, per mutant equal to its frozen baseline):

| Baseline | Figures |
|---|---|
| `al-runner.baseline.json` (sandbox-a, sandbox-b, sandbox-server, sandbox-resource) | 3 killed / 12 survived / 4 no-coverage, over 19. The 4 no-coverage mutants are all in `SandboxPricing.Codeunit.al` |
| `al-runner.cli-default.baseline.json` | 3 / 12 / 4, equal to leg A |
| `al-runner.layout.baseline.json` | 7 / 3 / 0 over 10, at `maxGuardsPerBatch` 7 |
| `al-runner.multiobject.baseline.json` | 6 / 1 / 5 over 12 |
| `al-runner.wrapped.baseline.json` | 58 / 37 / 3 over 98 |
| `al-runner.names.baseline.json` | 36 / 0 / 0 over 36 |
| `al-runner.symbols-lethala.baseline.json` | 5 / 4 / 0 over 9 |
| `al-runner.symbols-lethalb.baseline.json` | 5 / 4 / 0 over 9 |

- Kill reproduction: 2 killer rows per kill on `sandbox/one-shot`, `names/server` and `cli-default`.
- cli-default makes 23 activations and 22 server suite runs.
- `groupedCalls` 0 and `warmKills` 0.

**`itest:alrunner-v3`** (every configured leg PASS, per mutant):

| Leg | Figures |
|---|---|
| C | 26 facts: 9 defect, 16 contract, 1 warn. Each reads as pre-committed (dcdd1489 through r9) |
| S1 | 3 / 12 / 4 over 19, equal to `bcdev.baseline.json`. Sleep index 0 + 0, every kill reproduced |
| S3 | `al-runner-v3-resource-selector-refused` |
| N1 | 36 / 0 / 0 over 36, equal to `bcdev.names.baseline.json` |
| X (a)–(f) | as pre-committed in dcdd1489 + r5-xd (abe76fa6) + r5a (f32aa92a) + r6 (c7c505e6) + r10 |
| D1 (with `LETHAL_ITEST_V3_CDO`) | 51 / 12 / 0 over 63 |
| D1c | 51 / 8 / 4 over 63, both per mutant equal to the R594 oracle |
| T (with `LETHAL_ITEST_V3_TABLES`) | 290 / 57 / 59 over 406, the 52 known differences, 3 refused tests |

**Other gates in S1.** Only the agentflow-selected gates for the S1 diff, unchanged per mutant. The diff touches `line-map.ts` and `orchestrator.ts`, so expect the full set, each unchanged against its committed baseline.

## r2 (the r1 delta review: no blocker; it overrides r1 where they differ)

Review saved by the lane. Q5 holds: every S1 figure above matches the baselines, the gate pages and the itest
constants. The I1 mapping equals today's behaviour for every caller, and I3 holds.

- **D-I1, I4's evidence step makes no server call.** Never run `lethal doctor --config` for it: on a bcdev config it
  runs the live checks, and `lethal.config.local.json` names the parked Cronus28. Read each template with a script
  that prints only whether the key `alRunner` is present (`"alRunner" in cfg`), never any value.
- **D-I2, S1 updates T15.** `r586-backend-kind.test.ts` pins four exact source lines that S1 rewrites: two in
  `line-map.ts`, one in `al-runner-coverage.ts`, and one in the orchestrator's `carryBarredFiles`. Update its
  `CLASSIFIED` entries in S1. Write `wrappedRuleFor` as a `switch` with `case "al-runner":`, because the scanner
  misses a Record keyed `"al-runner":`.
- **D-m1, I1 test (a) asserts today's exact map.** An object inside the wrapper gets `refusedCoverageReason`; only
  a bare object before the wrapper gets `refusedWholeFileReason`.
- **D-m2, test (c).** Extract `carryBarredFiles` from `runSession` into a named, exported function (move-only), so
  that it can be tested.
- **D-m3, the R592 arm.** After F3, its only remaining case is an old store row with `backend: "al-runner"` against
  a bcdev session, and F3's named refusal shadows that case. In S3, delete the arm, or keep it with a test of that
  exact row. A bcdev-vs-bcdev control does not test it.
- **D-m4, the I2 table also covers orchestrator.test's "R496 T11" resume tests** (a v2 fake). They need runnerBuild
  B1 when they are re-pointed to v3.

