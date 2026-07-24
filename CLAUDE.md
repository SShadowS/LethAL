# LethAL — project instructions

Mutation-testing tool for Microsoft Dynamics 365 Business Central **AL** code. Bun + TypeScript monorepo. Authoritative architecture is `design.md` (repo root); per-layer specs/plans under `docs/superpowers/`.

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
- Lint: `biome check .` is noisy (pre-existing organizeImports/format debt in `engine`/`builtin-tier1`). Run biome **only on files you touched**: `bunx biome check <paths>`. (A PostToolUse hook auto-formats touched `*.ts` — see settings.)

## Integration tests (env-gated, live BC, minutes each — run foreground, never poll)
- `LETHAL_ITEST_BCDEV=1 bun run itest:bcdev` — authoritative backend. Frozen: killed **3** / survived **10** / no-coverage **3**.
- `LETHAL_ITEST_ALRUNNER=1 LETHAL_ALRUNNER_PATH="C:/Users/SShadowS/.dotnet/tools/al-runner.exe" bun run itest:alrunner` — frozen: **3 / 13 / 0**.
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
