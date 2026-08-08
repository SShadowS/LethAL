# LethAL — project instructions

Write in plain English.
Use common words and short sentences. Avoid jargon when a simpler term exists. If a technical term is necessary, define it the first time you use it.
Assume I am intelligent but unfamiliar with the terminology. Be concise, but do not remove details needed for correctness.

Mutation-testing tool for Microsoft Dynamics 365 Business Central **AL** code. Bun + TypeScript monorepo. Authoritative architecture is `design.md` (repo root); per-layer specs/plans under `docs/superpowers/`.

## The roadmap — `docs/roadmap/` is the record, `ROADMAP.md` is a generated index
Open work, measured-but-unclosed correctness risks, and known product gaps live **one item per file** in `docs/roadmap/R<nnn>.md` (zero-padded), each with a stable `R<n>` id, a `status` and an evidence pointer. Repo-root `ROADMAP.md` is a GENERATED index of titles, statuses and links — never hand-edit it; `bun scripts/roadmap-index.ts` rebuilds it and `scripts/roadmap-index.test.ts` fails if the two disagree.
- **Reading:** the index answers "is this already filed?" for ~6 KT; reading one item is reading its file. The single-table form is gone because a field-wise read on `|` silently returned a fraction of a row and looked complete (R118) — one file per row makes that impossible.
- **Adding:** **file an item the moment you discover one** (a limitation you hit, a gap a real project would trip on) — write `docs/roadmap/R<nnn>.md`, then regenerate. Two sessions filing at once cannot collide.
- **Closing:** mark `status` `done (<commit>)` as it lands, then regenerate. A row that closes with a RULING rather than a code landing may say `closed <date> — <the ruling>` instead; both count as closed, and a "how many are open" count must accept either. (R77 and R101 are the two, and they were written that way deliberately — a ruling has no commit to name.) Session ledgers under `.superpowers/` are scratch and get archived; the roadmap is the durable record.
- Check it before starting new work: what you are about to build may already be filed, or blocked on something that is.

## Packages (workspaces under `packages/`)
- `engine` — AST (tree-sitter-al), `MutationSpec`, semantic layer, `astSubtreeHash`.
- `operator-sdk` — operator interfaces.
- `builtin-tier1` — Tier-1 mutation operators.
- `schemata` — compiler: instrument a project with all mutations behind runtime guards, one artifact (`selector.ts`, `project.ts`, `compile.ts`).
- `runner` — orchestration + execution: `orchestrator.ts`, backends (`bcdev-backend.ts`, `al-runner-backend.ts`), `store.ts` (bun:sqlite), `deployment-verifier.ts`, `run-mutant-transport.ts`, `harness.ts`.

AL extension: `extensions/lethal-control` (the `LethAL Control` BC extension, runtime 16).

## Build / test loop (order matters — the dist trap bites every session)
1. `bun run typecheck` — `tsc --build --force`. SEPARATE from tests; run explicitly.
2. `rm -rf packages/*/dist` — **AFTER typecheck, BEFORE any `bun test`**. `tsc --build` regenerates `packages/*/dist`, whose stale compiled `*.test.js` get picked up by `bun test` and cause ~21 phantom failures. (A PostToolUse hook auto-cleans dist after a typecheck — see `.claude/settings.json`.)
3. `bun test` (or `bun test packages/<pkg>`) — full unit suite; does NOT type-check.
4. `bun run compile:fixtures` — offline `alc` compile of every `fixtures/*` AL project. Run it after
   touching ANY `.al` under `fixtures/`. Nothing else compiles them: LethAL publishes the target on
   every run but treats publishing the TEST APP as the user's own workflow, so a broken test fixture
   leaves the live gate happily measuring the previously published build. That is not hypothetical —
   a docs-only commit deleted a procedure's body and `itest:tables` stayed green for days (R56).
- Lint: `biome check .` is noisy (pre-existing organizeImports/format debt in `engine`/`builtin-tier1`). Run biome **only on files you touched**: `bunx biome check <paths>`. (A PostToolUse hook auto-formats touched `*.ts` — see settings.)

## Integration tests (env-gated, live BC, minutes each — run foreground, never poll)
- `LETHAL_ITEST_BCDEV=1 bun run itest:bcdev` — authoritative backend. Frozen: killed **3** / survived **10** / no-coverage **3**.
- `LETHAL_ITEST_ALRUNNER=1 LETHAL_ALRUNNER_PATH="C:/Users/SShadowS/.dotnet/tools/al-runner.exe" bun run itest:alrunner` — frozen: **3 / 13 / 0**, measured against **al-runner v2.1.1.0** (re-measured 2026-08-08 after bumping 2.1.0.0 -> 2.1.1.0; unchanged). al-runner ships several times a day and is a global dotnet tool, so the gate PRINTS the build it ran against as its first line — read it before calling a difference a regression. The measured v2 CLI/wire contract is in `docs/measurements/README.md` §"al-runner v2"; R123 is the probe that would check it per session instead of by habit. **Do not pin the tool to an older release to make this gate pass** — 2.1.0.0 needed `--auto-provision` in the argv, not a downgrade (R125).
- `LETHAL_ITEST_ENVTOOL=1 bun run itest:envtool` — bcdev reached through a config-declared external environment tool (Layer 6C; see `fixtures/README.md` §"Running against an external environment tool") instead of a directly-configured container. Frozen: **3 / 10 / 3** — identical to `itest:bcdev` on the same fixture, which is the point: procedure-level coverage survives the indirection. Needs a gitignored `fixtures/sandbox-app/lethal.config.envtool.json` naming a reachable environment.
- `LETHAL_ITEST_TABLES=1 bun run itest:tables` — the TABLE fixture (`fixtures/sandbox-data` + `-tests`), where Tier-2 operators and table-trigger mutation live. Frozen: killed **113** / survived **18** / no-coverage **10** over 141 deployed mutants (154 raw specs), plus `untargetedTriggerCount` **0**, and **exactly ONE expected baseline failure** — `Data Tests.PageActionComputesNonZero`, which opens a `TestPage` the fenced session refuses. (R30 grew it from 64/9/2 over 75: a `tableextension` — 5 new mutants, all killed — and a `page`/`pageextension` pair whose 4 mutants are `no-coverage`. R78 took it to 69/9/9 over 87: a minimal `codeunit`/`page` pair reachable ONLY through a TestPage test, so its 3 mutants are the measured statement of the R69 gap. **R69 is now CLOSED — recovery measured at 2.30% of a real app's mutants and the routed path DELETED (`c1da575`)** — so those three are permanent, not provisional: they are what "we do not recover this, and we say so" looks like in a gate. R70 then took it to 71/9/10 over 90: `table 79309` / `page 79324 "Data Scope Probe"`, a cross-kind NAME COLLISION — the one shape all four gates were blind to. Its `void-method-call` at the `SetRange` site is the detector: under the R70 bug Tier 2 claims that site instead and §3.2 precedence DELETES the Tier-1 mutant, so the regression appears as an OPERATOR NAME change the per-mutant baseline catches.) NOTE the gate no longer asserts a blanket green baseline: it asserts that exactly that one test fails, BY NAME, and that the refusal is NAMED in the report — flipping the old assertion to `false` would have gutted it. R82 then took it to 109/17/10 over 136: `codeunit 79311 "Data Swap Ops"`, six arms measuring `lethal.swap-call-arguments` live, with all 30 per-mutant verdicts PRE-COMMITTED before the run and all 30 matching. Four of its sites carry BOTH a swap and a `void-method-call` mutant — the operator adds mutants rather than displacing them. Arm E is the one to know about: a swap killed by a BC length overflow under a test that asserts NOTHING, i.e. a false kill, and it exposed R86 — no kill records why it died.) R72 then took it to 113/18/10 over 141: `Data Commit Ops.CommitThenRunValueForm`, the SAME shape as `CommitThenRun` with `Codeunit.Run`'s return value consumed, which is the one factor a 2x2x2 on Cronus281 measured as deciding BC's write-transaction refusal. Its `remove-commit` mutant is the first anywhere scored `killed` AND screened as a platform artifact (`SessionReport.platformArtifactKills`); the verdict deliberately does not move. All five new verdicts were pre-committed in `docs/superpowers/specs/2026-08-08-r72-value-form-arm-precommitment.md` before the run and all five matched. The gate also asserts R121's assertion screen reports itself as **`vacuous`** here: all 22 tests raise via bare `Error(...)`, so the screen flags every kill and separates nothing, and pinning the DISCRIMINATION rather than a count is what stops the same number reading as a finding on this suite and on a suite that uses an assertion library. Needs a gitignored `fixtures/sandbox-data/lethal.config.local.json` — **not** sandbox-app's; the two fixtures target different containers.
- A differing verdict is a BLOCK (a real regression), never "close enough". Live execution is the authority — unit tests are structurally blind to AL that can't compile or to real BC behavior. Use `/live-gate`.

## AL has no unit-test harness
Verify AL edits by an offline `alc` compile (use `/al-compile` or the `al-compiler` subagent), plus the live gate. `alc.exe` lives under `~/.vscode/extensions/ms-dynamics-smb.al-*/bin/win32/`.

## Conventions (enforced — CI will fail otherwise)
- No `!` non-null assertions (biome `noNonNullAssertion: error`). Destructure then check `undefined`.
- `exactOptionalPropertyTypes`: build optional props with `...(v !== undefined ? { k: v } : {})`.
- Typed error classes extend `Error` **directly**, never each other — `AlcCompileError` (deterministic alc rejection) vs `ArtifactPrepareError` (spawn/IO/hash/manifest) vs `DeploymentError`. Bisection reads ONLY `AlcCompileError` as "subset does not compile"; anything else aborts. Preserve this separation.
- Fail loudly on caller-contract violations (bad artifact-id, corrupt manifest, echo mismatch) — throw, never return a plausible empty default. Empty-vs-empty "matches" is this project's signature bug.
- Generated AL: web-service `ObjectType` exactly `CodeUnit` (capital U). `emitMutationSelector` and `emitStaticSelector` must expose the identical procedure set. Artifact id: 32 lowercase hex, random per artifact.
- Assert phase ordering with call counters on stateful fakes, never wall-clock timing.

## The recurring hazard: "test passes for the wrong reason"
A test asserts the right thing but passes whether or not the code is correct. Reading the diff does not catch it; only mutation does. **Red-check every fix**: revert the specific fix, confirm the specific test goes red, restore — report both. Use the `mutation-red-checker` subagent. Gate on per-mutant equality, not aggregate counts.

## Environment
Git bash on Windows; use bash syntax with Windows paths. **Never `2>nul`** (creates undeletable files) — use `2>/dev/null`. The `! <cmd>` prefix is only for interactive logins the tools can't complete (e.g. device-code auth). BC container publish/unpublish/restart are NOT user-only: `bccontainerhelper` is reachable from the PowerShell tool — the Cronus BC servers are Windows Docker containers on this machine (switch `docker context use desktop-windows` first, since the session default is the Linux engine). `altool publishapp` publishes over HTTP (dev endpoint); removal needs `UnPublish-BcContainerApp` under the Windows context.
