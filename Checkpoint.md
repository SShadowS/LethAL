# LethAL Session Checkpoint — Layer 4 Merged + al-runner Verified End-to-End

**Date:** 2026-07-18
**Branch:** master (Layer 4 merged; al-runner integration fixes on top: `82e1a46`, `47a891b`, `6cade4c`, `48eaed4`)
**Tests:** 183/183 passing. Delete `packages/*/dist` after any `tsc --build` — stale compiled test copies cause ~19 phantom failures.
**Integration:** `LETHAL_ITEST_ALRUNNER=1 LETHAL_ALRUNNER_PATH="/c/Users/SShadowS/.dotnet/tools/al-runner.exe" bun run itest:alrunner` → **PASS**

## Milestone: the loop is real

The full pipeline runs end-to-end against real infrastructure: AL source → operators → schemata → compile → al-runner execution → verdicts. Sandbox fixture: 15 mutant sites, 3 batches, **3 killed / 12 survived / 0 no-coverage, mutation score 20%** — matching the hand-computed table.

## What the first real run exposed (all fixed)

Every pinned al-runner assumption was wrong, plus deeper bugs that unit tests structurally could not catch:

- **al-runner contract** (now VERIFIED, not assumed): stdout is pure JSON (`Timing:` goes to stderr); envelope `{tests[], passed, failed, errors, total, exitCode}`; entries use `name`/`status` (NOT `method`/`result`), with `message`/`stackTrace`/`alSourceLine` on failures; exit 0 pass / 1 failures / 2 runner limitation / 3 compile error; no `--version` (use `--help`); `--test-isolation method` required — default is `codeunit`, which contradicted our advertised `full-reset` capability.
- **`TestIsolation = Function` preflight was factually wrong** — the AL compiler rejects that property on `Subtype = Test` codeunits (AL0223); it is a **TestRunner** codeunit property. The preflight would have rejected every valid AL project. Removed; fixture corrected; spec amended.
- **Schemata emitted uncompilable AL** (Layer 2 bugs, invisible to unit tests because none fed output through a real compiler): `wrapStatement` orphaned `else` on compound statements (AL0110); whole-procedure-body empty-block replacement broke body grammar (AL0104/AL0198); and **no `var MutationSelector: Codeunit "Mutation Selector";` was ever declared**, so every guard call failed AL0118 — the schemata approach could not have worked at all before this.
- **`batchByOverlap` under-batched**: mutants with disjoint raw AST ranges that resolve to the same enclosing statement collided at compile time. Overlap now uses the resolved statement range.
- **Timeout budget starvation**: the backend reported al-runner's in-VM test-body duration (~50ms) instead of wall-clock (~1.2s per invocation), so every mutant run silently timed out.

## Open items

1. **bcdev itest still unrun** — needs a live BC server. Create gitignored `fixtures/sandbox-app/.vscode/launch.local.json` + `lethal.config.local.json`, then `bun run itest:bcdev`. Three assumptions remain pinned there, each isolated to one function: `parseTestRunPayload` (bcdev_test_run payload), `Publisher.publish` (altool flag spellings), `MutationControlClient.post` (OData action shape). Expect the same hit rate as al-runner — assume they are wrong until the run proves otherwise.
2. **Known Layer 3 bug (deferred):** negate-conditional misses parenthesized-operand logical expressions (`(A) or (B)`) — `packages/builtin-tier1/src/negate-conditional.ts`. Documented in `fixtures/README.md`. That is why the fixture yields 15 sites, not 16.
3. **Mutation score is 20% by fixture design** — `ClampPercentRuns` is deliberately assertion-free so survivors are real. Not a defect.
4. **Repo hygiene:** no CI yet; al-runner install is scriptable (`dotnet tool install --global MSDyn365BC.AL.Runner`) and the al-runner itest needs no server, so it is CI-ready. `bun test` needs a dist exclusion or pre-clean step.
5. **Next layer (design.md §11):** Layer 5 — container pool, parallelism, 3× flakiness pre-flight, DB snapshots, SaaS/AAD auth.

## Lesson worth keeping

Twelve task-scoped reviews and a whole-branch review all passed while the schemata emitted AL that could never compile. One real execution found it in minutes. Run the thing against real infrastructure before believing it works.

## How to resume

> Continue LethAL. Read Checkpoint.md. Layer 4 works end-to-end on al-runner. Next: either wire up bcdev itest against the dev BC server (open item 1), fix the Layer 3 negate-conditional bug (item 2), or start Layer 5 brainstorm.
