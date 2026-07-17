# Layer 4 · Execution Runtime — Design

**Date:** 2026-07-17
**Status:** Approved by user (section-by-section review)
**Scope:** design.md §11 build-order item 4 — "Sequential execution + coverage-informed selection (proves end-to-end loop)"

## 1. Goal

Run AL tests against the Layer 2/3 instrumented project, sequentially, one mutant at a time, and produce trustworthy killed/survived verdicts. Proves the end-to-end loop: operators → schemata → deploy → execute → verdict → report. Container pool and parallelism are Layer 5.

## 2. Decisions made during brainstorm

| Question | Decision |
|---|---|
| Q1 Test invocation | bc-dev MCP server as primary backend; LethAL is an MCP client (stdio). Stefan Maron's BusinessCentral.AL.Runner as a second, in-memory backend. Interface prepared for Microsoft's announced in-memory runner. |
| Publish path | `alc.exe` compile + `altool.exe publishapp` (headless, from the AL VSCode extension) — NST backend only. In-memory backends need no deploy. |
| Q2 Coverage | Procedure granularity now (validated in bc-dev); interface keeps granularity abstract so line-level slots in later. LethAL generates its own baseline coverage map — no pre-generated files. |
| Q3 Pre-flight flakiness | Single baseline run (green check + coverage in one pass). 3× flakiness detection deferred to Layer 5. Baseline-red tests excluded from kill judgment and reported. |
| Q4 Results storage | SQLite now (design.md §10), via `bun:sqlite`. |
| Q5 DB snapshots | Deferred. Rely on `TestIsolation = Function` (NST) / full state reset (in-memory). |
| Q6 Layer 3 leftovers | Skip-on-overlap: overlapping mutants scheduled into separate schemata batches. Compile-level deconfliction, lift-prelude coalescing, operator budgets stay deferred. |
| Integration target | Small AL fixture app + test app committed under `fixtures/`, pointed at the user's dev BC server (NST) and runnable serverlessly (AL.Runner). |

Out of Layer 4 scope: diff scoping (§5 stage 1), flamegraph weighting (§5.3), history refactor migration (§5.1 — keys are recorded, migration lands with Layer 8), SaaS/AAD activation auth, hybrid fast-sweep-then-confirm across backends, `--full-matrix` (no short-circuit) mode.

## 3. Architecture

New package `packages/runner`, depends on `engine`, `schemata`, `builtin-tier1`.

```
packages/runner/src/
  backend.ts            ExecutionBackend interface, capabilities, verdict types
  discovery.ts          shared engine-AST test discovery ([Test] methods)
  bcdev-backend.ts      BcDevMcpBackend — MCP client over stdio + publish + OData activation
  publisher.ts          alc compile + altool publishapp (BcDevMcpBackend internal)
  activation.ts         MutationControlClient — HTTP OData (BcDevMcpBackend internal)
  al-runner-backend.ts  AlRunnerBackend — Stefan Maron CLI + stub-based activation
  ms-inmemory-backend.ts  placeholder for Microsoft's announced in-memory runner
  selection.ts          coverage filter, overlap batcher, history filter
  store.ts              SQLite results DB (bun:sqlite)
  orchestrator.ts       sequential session loop
  report.ts             JSON + console output
  cli.ts                `lethal run` entry
```

Data flow, one session:

1. Layer 3 operators + engine produce the mutation set for the target project.
2. `selection.ts` batches: mutants with overlapping sites split across schemata batches (Q6).
3. Per batch: `schemata` writes the instrumented project → `backend.deploy()` (publish for NST, no-op in-memory).
4. Baseline: every discovered test run once, fresh invocation, with coverage if the backend supports it → green check + coverage map.
5. Per mutant: `backend.activate(id)` → run covering tests (all tests when coverage unsupported), fresh invocation each → kill-confirmation re-run on failure → verdict.
6. Verdicts recorded in SQLite (identity keys per design.md §5.1) → report.

## 4. ExecutionBackend abstraction

Publish, activation, and isolation semantics are backend-specific, so the seam is a backend interface — not a bare test runner. This is the preparation point for Microsoft's in-memory runner: supporting it must be adapter-only work.

```ts
interface TestMethodRef { codeunitId: number; codeunitName: string; method: string; }

interface TestVerdict {
  ref: TestMethodRef;
  outcome: "pass" | "fail" | "skip" | "timeout" | "error";
  durationMs: number;
  failureMessage?: string;
  coverage?: CoverageMap;              // present when requested and supported
}

interface CoverageMap {
  granularity: "procedure" | "line";
  entries: ReadonlyArray<{ objectType: string; objectId: number; procedure: string; line?: number }>;
}

interface BackendCapabilities {
  coverage: "none" | "procedure" | "line";
  deploy: "publish" | "none";          // NST needs alc+altool; in-memory reads source
  isolation: "session" | "full-reset"; // AL.Runner resets all state per test
  authoritative: boolean;              // NST true; AL.Runner false (mocked runtime skews verdicts)
}

interface ExecutionBackend {
  capabilities(): BackendCapabilities;
  status(): Promise<BackendStatus>;    // reachability / tool presence, actionable errors
  deploy(instrumentedDir: string): Promise<void>;
  activate(mutantId: string | null): Promise<void>;  // null = baseline (inactive)
  run(ref: TestMethodRef, opts: { coverage: "none" | "procedure" | "line"; timeoutMs: number }): Promise<TestVerdict>;
}
```

Test discovery is backend-independent: `discovery.ts` scans the test project with the engine's tree-sitter-al parse for `[Test]`-attributed methods. No server, no backend involvement.

Capability-driven orchestrator behavior:

- `coverage: "none"` → coverage filter skipped; all tests run per mutant (acceptable for ms-fast in-memory runs). The `no-coverage` verdict class does not occur in this mode.
- `isolation: "full-reset"` → `TestIsolation = Function` preflight check skipped; design.md §6.2/§6.5 concerns are void.
- `authoritative: false` → report stamped with the backend and "mock runtime — indicative" label on the mutation score.

Backend selection: `--backend bcdev | al-runner` (config file equivalent supported). One backend per session.

## 5. BcDevMcpBackend (NST)

- **MCP client:** spawns the bc-dev MCP server as a child process; `@modelcontextprotocol/sdk` `Client` + `StdioClientTransport`. Long-lived: spawned once per session, reused across calls — each `bcdev_test_run` call still triggers a fresh BC-side test-runner session, which is what design.md §6.3 requires.
- **`run()`:** one `bcdev_test_run` call per test: `codeunits: [{id, methods: [method]}]`, coverage passthrough. Connection params (server, serverInstance, tenant, project, environment) always forwarded explicitly from LethAL config; server-cwd defaults are never trusted.
- **Timeout:** enforced adapter-side (`Promise.race`); expiry returns `outcome: "timeout"`, a late MCP result is discarded. bc-dev exposes no cancel.
- **Transport errors** (server crash, protocol failure): `outcome: "error"` — distinct from test failure.
- **`deploy()`:** `publisher.ts` shells `alc.exe` (path from `alcPath` config, default: newest `ms-dynamics-smb.al-*` under `~/.vscode/extensions`) with the target project's `.alpackages` as symbol cache, then `altool.exe publishapp` with schema sync `ForceSync` (re-batches replace guard sites; Add-only is insufficient). The instrumented app keeps the target app's id and version-bumps per batch (`1.0.<batch>.<run>`) so the test app's dependency stays valid; it replaces any dev-published version — fixture owns this risk, real projects get a docs warning. Compile stderr surfaced verbatim; compile or publish failure aborts the batch.
- **`activate()`:** `activation.ts` POSTs to the emitted control web service (`/ODataV4/MutationControl_SetActive`, `_ClearActive`) with company from config; Basic auth (NavUserPassword) — `fetch` cannot perform the NTLM handshake; Windows-auth support deferred. `SetActive` returns the id it wrote; response mismatch aborts. Retry once on HTTP failure, then abort the session (verdicts are meaningless without known selector state).

## 6. AlRunnerBackend (Stefan Maron's BusinessCentral.AL.Runner)

AL.Runner transpiles AL to C# via the BC compiler API, mocks runtime types, compiles with Roslyn, and executes tests in-process. No NST, no publish; in-memory tables reset between tests; `Commit()`/`Rollback()` are no-ops; dependency code in `.app` packages is auto-stubbed.

- **`deploy()`:** no-op — the CLI is pointed at the instrumented source directory each run.
- **`run()`:** spawns `al-runner --run <testName> <instrumentedSrc> <testDir> --output-json` (plus `--packages` for symbol resolution, and `--stubs` where the target app's own dependencies need hand-written stubs), parses the JSON output. `--run` selection is qualified by codeunit where the CLI allows; exact matching semantics are verified during implementation. Exit-code mapping: 0/1 → verdicts from JSON; 2 (runner limitation) → `outcome: "skip"`; 3 (compilation error) → `outcome: "error"`, abort batch (instrumented output must compile — a failure is a schemata bug or stub gap). Timeout: process kill → `outcome: "timeout"`.
- **`activate()`:** selector-rewrite activation. `--stubs` only covers *dependency* codeunits, and `MutationSelector` is project source — so instead, LethAL rewrites the emitted `MutationSelector.Codeunit.al` inside the instrumented directory (LethAL-owned scratch output) before each mutant: the table-backed body is replaced with one hardcoding `ActiveId := '<mutantId>'` (`''` for baseline). AL.Runner recompiles per invocation in milliseconds, so the per-mutant rewrite is effectively free. Guard call sites (`MutationSelector.Active('Mxxxx')`) are identical across backends.
- **Capabilities:** `coverage: "none"`, `deploy: "none"`, `isolation: "full-reset"`, `authoritative: false`.
- CI-friendly: needs no server, so the AL.Runner fixture e2e joins CI.

## 7. MsInMemoryBackend (placeholder)

Microsoft has announced an in-memory AL runner in the same spirit as AL.Runner. `ms-inmemory-backend.ts` is committed as an explicitly unimplemented placeholder (constructor throws with a pointer to this spec). When the runner ships, support must be implementable as one adapter against `ExecutionBackend` with no orchestrator/selection/store changes; if that proves false, the interface — not the adapter — is at fault and gets revisited.

## 8. Schemata selector rework (prerequisite, `packages/schemata`)

The current emitted `MutationSelector` is SingleInstance with in-memory `ActiveId`; it dies with the session, and §6.3's fresh-invocation-per-test makes it useless on NST. Emission becomes three objects:

1. **Table `Mutation Active`** — single row, `ActiveId: Text[64]`, `DataPerCompany = false` (activation valid regardless of which company the test session opens).
2. **Codeunit `Mutation Selector`** — SingleInstance kept as a per-session read cache: first `Active()` call reads the table once, caches; subsequent calls are memory-only. Per-guard runtime overhead stays ~zero.
3. **Codeunit `Mutation Control`** — `SetActive(MutantId: Text): Text` (returns what it wrote), `ClearActive()`; writes the table + `Commit()`. Published as a web service; schemata emits the `webservices.xml` entry so publishing auto-exposes it.

Sequential loop guarantees ordering: the activation HTTP call completes before the next test session starts; the session's first `Active()` read sees the committed row. `TestIsolation = Function` does not affect the activation write (separate session, normal commit).

`SelectorConfig` grows to `{ selectorId, controlId, tableId }`, defaults in the 50000 range. Layer 3's guard-emission call sites are unchanged; selector emission tests are updated.

## 9. Selection pipeline (`selection.ts`)

Stages are pure functions `(mutants, context) → mutants`. Stages 1–2 run before any deploy; stage 3 runs per batch after its baseline, because it needs the fresh coverage map:

1. **History filter** (design.md §5.1): identity key `(astSubtreeHash, enclosingCodeunitName, operatorName, operatorMajor)`. With `--skip-known-survivors`, a prior `survived` row with the same key demotes the mutant to `known-survivor` (reported, not executed). Default is to re-execute everything — the filter must prove itself before becoming default in Layer 5. No refactor migration in Layer 4.
2. **Overlap batcher** (Q6): greedy pass over mutants sorted by site; overlapping sites (schemata compile would throw) go to a later batch. Output `Batch[]`, each internally overlap-free; each batch is a separate schemata-write → deploy → run cycle. Batching is exhaustive — no mutant is dropped for overlap.
3. **Coverage filter** (design.md §5.2, per batch, post-baseline): baseline coverage inverted to `procedure → Set<test>`; a mutant's enclosing procedure (engine's `findEnclosingProcedure`) selects its test set at `granularity: "procedure"`. No covering test → verdict `no-coverage`, skipped, reported (untested-code signal). Line granularity later slots into the same lookup keyed on `line`. Skipped entirely when the backend reports `coverage: "none"`.

## 10. Results store (`store.ts`)

`bun:sqlite`, file `lethal.sqlite` beside the target project (configurable).

```sql
runs(id, started_at, finished_at, project_path, backend, app_version, batch_count, baseline_green)
mutants(id, run_id, mutant_code /*M0001*/, ast_hash, codeunit_name, operator_name, operator_major,
        file, line, verdict /* killed|survived|no-coverage|timeout-killed|known-survivor|error */,
        killing_test, duration_ms)
test_results(id, run_id, mutant_id /*NULL = baseline*/, codeunit_id, method, outcome, duration_ms, failure_message)
```

- `file`/`line` are display-only (design.md §5.1); the four identity fields are indexed and used for history equality.
- Baseline runs land in `test_results` with `mutant_id NULL`. The coverage map is recomputed per session, not persisted.
- Verdict writes are transactional per mutant — a crash leaves resumable, un-torn state.

## 11. Orchestrator (`orchestrator.ts`)

Sequential state machine, single public `runSession(config): Promise<SessionReport>`:

```
preflight:  backend.status() green; when isolation = "session": TestIsolation = Function
            verified in test app source (missing/weaker → abort, design.md §6.2)
discover:   engine-AST scan → test set
mutate:     Layer 3 ops → mutation set → history filter → overlap batches
per batch:
  schemata write → backend.deploy()
  baseline: activate(null) → run every test once (coverage on when supported)
            any fail → excluded from kill judgment + reported; all fail → abort batch
            first-run timeout budget: config.baselineTimeoutMs (default 120 s)
  coverage filter with fresh map (when supported)
  per mutant:
    activate(mutantId)
    run covering tests, fresh invocation each, timeoutMs = 2 × that test's baseline duration
      first fail → candidate kill, remaining tests skipped (short-circuit)
    fail path:  activate(null) → re-run that test once (design.md §6.6)
                  passes at baseline → verdict killed, killing_test recorded
                  fails at baseline → late flakiness: verdict error, test flagged unstable, reported
    timeout → verdict timeout-killed, no confirmation re-run (design.md §6.7; a hung
              baseline re-run would stall the session)
    no fail → verdict survived
    record, next mutant
finally:    activate(null) always, including on abort — never leave a mutant active
report:     JSON file + console summary (killed / survived / no-coverage / unstable counts,
            mutation score = killed / (killed + survived), backend + authoritative label)
```

Error handling:

- Backend `error` outcome: retry the same test once; a second error aborts the session with partial results persisted and a nonzero exit.
- Deploy failure: abort that batch; remaining batches still attempted (independent), reported per batch.
- Activation failure: retry once, then abort the session.
- Ctrl-C: finally-block deactivation; SQLite transaction boundaries prevent torn verdicts.

Short-circuit on first kill trades the full kill-matrix for wall-clock — the right sequential default; `--full-matrix` is deferred.

## 12. Fixture, testing, CLI

**Fixture** (`fixtures/sandbox-app/`, `fixtures/sandbox-tests/`):

- Target app: 2–3 codeunits with mutable material (comparisons, boolean operators, void calls, returns, blocks) so every tier-1 operator hits ≥1 site. Object ids in the 79000 range.
- Test app: `TestIsolation = Function`; tests that kill some mutants and deliberately miss others, so a fixture run produces real killed, survived, and no-coverage verdicts.
- `launch.json` committed with placeholders; sensitive server details go in a gitignored `launch.local.json`-style override.

**Testing per module:**

- `selection`, `store`, `report`, `discovery`: pure unit tests (Bun test), no BC.
- `bcdev-backend`: fake MCP server in-process (`@modelcontextprotocol/sdk` `Server` + `InMemoryTransport`) scripting `bcdev_test_run` responses — pass, fail, coverage, hang.
- `al-runner-backend`: spawn boundary mocked; JSON/exit-code parsing covered for 0/1/2/3 and timeout kill.
- `publisher`, `activation`: spawn recorder / fetch stub.
- `orchestrator`: stub backend + in-memory SQLite; scenarios: kill, survive, kill-confirmation reject, timeout, no-coverage, overlap batching, baseline-red exclusion, abort-resume state, capability degradation (`coverage: "none"`).
- **Integration:** AL.Runner fixture e2e runs in CI (serverless). bcdev fixture e2e (`bun run itest:runner`) is env-gated, manual, against the live dev server.

**CLI:** `lethal run --project <dir> --tests <dir> --backend <bcdev|al-runner> [--db <path>] [--skip-known-survivors] [--dry-run]`. `--dry-run` prints selection + batching, no deploy/run.

## 13. Exit criteria

- Fixture integration run (each backend) produces killed + survived (+ no-coverage on bcdev) verdicts matching hand-computed expectations.
- Two consecutive runs are 100% verdict-identical (determinism).
- AL.Runner e2e green in CI; bcdev e2e green against the dev server manually.
