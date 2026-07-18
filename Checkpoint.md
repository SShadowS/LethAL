# LethAL Session Checkpoint — Layer 4 Verified on al-runner, bcdev Blocked on Server

**Date:** 2026-07-18
**Branch:** master
**Tests:** 200/200 passing. Delete `packages/*/dist` after any `tsc --build` — stale compiled test copies cause phantom failures.
**al-runner integration:** `LETHAL_ITEST_ALRUNNER=1 LETHAL_ALRUNNER_PATH="C:/Users/SShadowS/.dotnet/tools/al-runner.exe" bun run itest:alrunner` → **PASS**
**bcdev integration:** blocked — BC web-services endpoint wedged (see below)

## Milestone: the loop is real

Full pipeline verified end-to-end on real infrastructure: AL source → operators → schemata → compile → execution → verdicts. Sandbox fixture: 15 mutant sites, 3 batches, **3 killed / 12 survived / 0 no-coverage, score 20%**.

## What real execution exposed (all fixed)

**al-runner backend** — every pinned assumption was wrong: entries are `name`/`status`, not `method`/`result` (so the lookup never matched and every run returned `error`); no `--version` flag; `--test-isolation` defaults to `codeunit`, contradicting our `full-reset` capability.

**Deeper bugs unit tests could not catch:**
- **Schemata emitted uncompilable AL** — `wrapStatement` orphaned `else` on compound statements (AL0110); whole-procedure-body replacement broke body grammar (AL0104/AL0198); and no `var MutationSelector: Codeunit "Mutation Selector";` was ever declared, so every guard failed AL0118. The schemata approach could not have worked at all before this.
- **`TestIsolation = Function` preflight was factually wrong** — the AL compiler rejects that property on `Subtype = Test` codeunits (AL0223); it belongs on TestRunner codeunits. Removed.
- `batchByOverlap` under-batched (disjoint AST ranges colliding at one enclosing statement); timeout budget used in-VM duration instead of wall-clock.

**bcdev backend** — assumptions likewise wrong, now fixed and mostly verified live:
- MCP SDK's `StdioClientTransport` inherits only a fixed env allowlist, so `BC_DEV_USER`/`BC_DEV_PASSWORD` never reached the spawned server. `BcDevConfig.env` added.
- `bcdev_test_run` payload uses `status`/`output`; coverage is a separate array with numeric `methodId`, resolved via the compiled app's `SymbolReference.json`.
- `altool publishapp` flags are all-lowercase, need explicit `--authentication UserPassword`, credentials via `BC_SERVER_USERNAME`/`BC_SERVER_PASSWORD`. **Both fixture apps published live successfully.**
- `emitWebServicesXml` emitted `Codeunit` but the compiler requires `CodeUnit` — the web service never registered. Fixed; `MutationControl_*` confirmed reachable.
- Coverage verified real: `DiscountedPrice` never appears in any covering test, so `no-coverage` derives correctly.

## Blocker: BC web-services endpoint wedged

`bun run itest:bcdev` cannot complete. Diagnosis (corrected — the earlier "stuck table lock" conclusion was wrong):

| Request | Result |
|---|---|
| `POST MutationControl_SetActive` | hangs, no response |
| `POST MutationControl_ClearActive` | hangs |
| `GET /ODataV4/$metadata` (touches no table) | hangs |
| dev endpoint 7049 (`bcdev_status`) | instant, healthy |

`$metadata` reads no table, so a row lock cannot explain it — the whole OData endpoint (7048) is unresponsive while the dev endpoint (7049) is fine. Most likely: each client-side-timed-out activation call stranded a server-side web-service session until the pool saturated.

**To resolve:** restart the BC service tier on host **Cronus28 (172.26.112.209)** — a separate machine, not a container reachable from this workspace — then re-run `LETHAL_ITEST_BCDEV=1 bun run itest:bcdev`. Only `SetActive`'s echo-response shape remains unverified.

**Design finding for Layer 5:** `MutationControlClient` aborts client-side on timeout, which strands the server session instead of cancelling it. Across thousands of mutants this would progressively exhaust the web-service session pool and wedge the endpoint. Consider activating via the dev endpoint instead of OData, or bounding activation attempts and failing fast.

## Security items needing your decision

1. **Credentials in git history.** The BC dev password appears in commits `19fb41c` and `ab775c1` (inside test files); commit `b3c375b` replaced them with placeholders, but git history retains them. The repo has **no remote**, so nothing left this machine. Options: leave as-is (local-only, throwaway container password), or purge with a history rewrite (destructive — needs your go-ahead).
2. `.mcp.json` contains the same credentials and was **not** gitignored (only untracked). Now added to `.gitignore`.

## Other open items

- **Known Layer 3 bug (deferred):** negate-conditional misses parenthesized-operand logical expressions (`(A) or (B)`) — `packages/builtin-tier1/src/negate-conditional.ts`. This is why the fixture yields 15 sites, not 16.
- **`altool runtests` exists** in AL 18.0.2498801 (`altool runtests <codeunitId> --testmethods ... --authentication UserPassword`). This contradicts the original Layer 4 investigation ("the extension ships no runtests command", based on 18.0.2293710) and is a viable fourth backend needing no MCP server at all. Worth evaluating in Layer 5.
- Mutation score of 20% is fixture design — `ClampPercentRuns` is deliberately assertion-free so survivors are real.
- No CI yet. The al-runner itest needs no server and is CI-ready (`dotnet tool install --global MSDyn365BC.AL.Runner`).
- **Next layer (design.md §11):** Layer 5 — container pool, parallelism, 3× flakiness pre-flight, DB snapshots, SaaS/AAD auth.

## Lesson worth keeping

Twelve task-scoped reviews and a whole-branch review all passed while the tool emitted AL that could never compile. Two real executions found that plus a dozen more defects. Run it against real infrastructure before believing it works.

## How to resume

> Continue LethAL. Read Checkpoint.md. al-runner path works end-to-end. bcdev needs a BC service-tier restart on Cronus28, then `LETHAL_ITEST_BCDEV=1 bun run itest:bcdev`.
