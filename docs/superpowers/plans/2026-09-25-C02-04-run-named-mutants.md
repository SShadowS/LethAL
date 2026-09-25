# C02-04: A lease-scoped "run named mutants" primitive, extracted from runSession, implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Revision 3 (2026-09-25),** after review round 2: decision 1 states link 3 as a named trust assumption (pending owner confirmation) instead of a byte proof, and points per-mutant proof at GH-24; Task 8's fixture forwards `attach` and writes real `.app` bytes; `inLease` without a lease is refused; the red-baseline assertion slices the trace at the first mutant activation.

**Revision 2 (2026-09-25),** after review round 1 (`H:/lethal-coord/reviews/C02-04-plan/review-r1.md`). Changed: decision 1 now binds the named mutants to the installed BYTES through a trusted store record, not to a caller-supplied id (finding 1); Part A's characterization records one interleaved trace with full event and row fields and covers the worker backends, and says plainly what it cannot see (finding 2); `NamedMutantsConfig` gains the C02-05 in-lease hook and the op-sequence rebind, and Out of scope names the last-artifact and carried-verdict limits (finding 3); every cited recipe is corrected, every local read/parse failure is typed, and the end-to-end zero-call and no-record assertions are added (findings 4 to 6).

**Goal:** A caller that has a guarded build installed can say "run these named mutants against these named test methods" and get one verdict per mutant back, under the same lease, quarantine latch, R194 lost-ack reconciliation and R206 warm confirmation that `lethal run` uses, with no compile and no publish of the target. `runSession` keeps producing the same verdicts, events and store rows, because it runs its per-batch baseline and covering loop through the same code.

**Architecture:** Most of the logic already lives in functions in `packages/runner/src/orchestrator.ts`: the covering loop is `runMutantsOnBackend` (`:5393`, holding R194 via `runFenced`/`runFencedMany`/`reconcileFencedLostAck` `:1715-1987` and R206 via `confirmWarm` `:4950`), baseline dispatch is `runOnce` (`:6207`) plus `handleBaselineLeaseOutcome` (`:6251`), and the lease is `acquireSessionLease` (`:1563`) plus the unexported `LeaseSession` class (`:2165`). What is not reusable is the glue: the baseline loop, the `baseline-batch-finished` classification and stale-test-app refusal, the design section G attestation gate, the quarantine consult, the lease open and the latch-gated teardown are all inline in `runSession` (`:2878-4640`). Part A moves that glue into named functions and makes `runSession` call them. Part B adds `runNamedMutants`, composed from the same functions, plus a trusted artifact record and a no-deploy `ExecutionBackend.attach`.

**Tech Stack:** Bun + TypeScript, `bun:sqlite`, `bun test`.

**Spec:** GitHub issue #14 (child 4 of epic #10, c02): "Extract a lease-scoped 'run named mutants' primitive from runSession. Baseline + `RunMutantMany` for a given artifact and named methods, with quarantine and R194/R206 reconciliation, no deploy. Depends on: 2." Downstream: C02-05 (#15, test-app compile and publish under the lease) and C02-06 (#16, `lethal verify`). Neither is built here.

**Line numbers** are as of `b29cf49`, before C02-02. C02-02 edits `runSession` step 3 (`recordArtifact` near `:3748`, the `batch-published` emit near `:3773`) and `store.ts`, so numbers below `:3748` shift. Anchor on the step comments (`// 4. baseline`, `// 5. coverage filter`, `// 5b. R47 resume`, `// 6. per-mutant loop`), not on numbers.

## Two parts

- **Part A (coord `C02-04`): refactor only, plus the R232 fix.** Every change is to code `lethal run` already runs. Nothing new is reachable. The owner's live gates are the acceptance test (see decision 2 for why the unit snapshots cannot be).
- **Part B (coord `C02-04b`): the new entry point.** One store write is added to `runSession` step 3d (a manifest hash in C02-02's `batch_artifacts` row); nothing else on an existing path changes, and no verdict, event or report field moves.

**Dependency:** Part A starts after C02-02 has landed on master (`git merge master`, then the full test loop once). Part B needs C02-02's `batch_artifacts` table and `artifactsForRun` (Task 6 extends that table).

## The five decisions

### 1. Signature, and what proves the named mutants are in the installed binary

**What ties a manifest to the .app bytes today.** Nothing inside the package. `ArtifactCompiler.compile` (`artifact.ts:129-190`) checks `mutantManifest.artifactId === artifactId`, runs `alc` over the batch dir, hashes the output (`Bun.SHA256.hash`, `:171`) and returns a `CompiledArtifact` whose `mutantManifest` is the object it was GIVEN, not something read back out of the `.app`. `alc` does not package `mutant-manifest.json`. What the bytes do carry is the instrumented AL: every guard is the literal `MutationSelector.Active('<mutantId>')` (`schemata/src/dispatch.ts:26`, `duplicate.ts:11`) and the selector embeds `'<artifactId>'` (`schemata/src/selector.ts:46-51`). A package carries that source only when the target does not exclude it (`published-test-app.ts`: "a publisher may exclude source"), and whether a real target's package always does is not measured. So the packaged source is not a proof we can require.

**What `DeploymentVerifier` proves.** Only that the target's install codeunit registered that artifact id, at that moment. Its own doc comment (`deployment-verifier.ts:63-76`) says it is "NOT proof that the *running* binary is ours". It stays as a cheap pre-flight, nothing more.

**What this plan checks, and what it trusts** (pending owner confirmation, coord question). This is NOT a proof that the installed bytes contain the named guards. It is two checked links, one named trust assumption, and one run-time observation. None of it is supplied by the caller:

1. **The trusted record.** When `runSession` publishes a batch, it already holds `compiled: CompiledArtifact`: the exact manifest object the compiler consumed and the sha256 of the bytes it produced. Part B Task 6 adds ONE column to C02-02's `batch_artifacts` row, written in the same insert: `manifest_sha256 = SHA256(JSON.stringify(compiled.mutantManifest))`. That row is the only record LethAL writes at the moment the manifest and the bytes are both in hand. The report's `artifacts[]` is not accepted as proof: it does not carry the manifest hash, and it is a file that gets redacted, copied and edited. **Minimal new data: the one `manifest_sha256` column.** A row without it (written by a build before Task 6) is refused, never trusted by default.
2. **The local files are the recorded ones.** `sha256(appPath bytes)` must equal the row's `sha256`, and `sha256(JSON.stringify(JSON.parse(<instrumentedDir>/mutant-manifest.json)))` must equal the row's `manifest_sha256`. Names are resolved ONLY in that manifest. This is the same-id/wrong-manifest check: a manifest with the right `artifactId` but different mutants fails here.
3. **TRUST ASSUMPTION (not checked): an artifact id names one source set.** An `artifactId` is 32 random hex minted once per artifact by `newArtifactId()` (`orchestrator.ts:1181`, called per batch at `:3514`), bisection candidates get their own (`:3731`, `:4401`), and the only sites that compile an EXISTING id again recompile the SAME batch dir: the version-conflict retry, which only re-stamps `app.json` (`:3620-3640`, `writeStampedAppJson`), and worker deploys of the same `batchDir` (`:4368`). Nothing in LethAL compiles a different source set under an existing id. Nothing CHECKS that either: `ArtifactCompiler.compile` checks only the manifest's id before compiling (`artifact.ts:129-151`), and the server checks and echoes ids, not package hashes or guard membership (`run-mutant-transport.ts:1499-1559`). So the chain covers local tampering and stale local copies (links 1 and 2). It does not cover a deliberately forged, or partial, build carrying the same id: such a binary could attest on one guard while an absent named guard yields a plausible `survived`.
4. **Observed at run time: the running binary reports X on every run.** The RunMutant echo (`run-mutant-transport.ts:1548-1562`, `identityMismatch`), the server's own `artifact-mismatch` refusal (`:1499-1505`), and the per-batch section G gate. This is the only link that observes the running binary. The registry read in `attach` is a pre-flight in front of it.

Residual, stated plainly: section G needs only ONE clean observation per batch (`orchestrator.ts:4468-4479`), so it shows the binary reports X, not that each named mutant's guard exists in it or fired. Per-mutant proof is GH-24's per-mutant `ObservedActive` attestation (issue #24); see Out of scope. A named mutant whose guard never fires on its methods still scores as `runSession` scores it (`survived`, with `guardObserved`), unchanged.

**Signature.**

```ts
/** Where the installed artifact came from. The record, not the caller, supplies its identity. */
export interface InstalledArtifactRef {
  /** The run that published it, and its batch index in that run. */
  readonly fromRunId: number;
  readonly batchIndex: number;
  /** The compiled .app: `<sha256[0:16]>-<artifactId>.app` in the compiler outputDir (artifact.ts:172-173). */
  readonly appPath: string;
  /** Its batch dir: `run-<fromRunId>-batch-<batchIndex>` under the session's instrumentedDir. */
  readonly instrumentedDir: string;
}

/** What `loadInstalledArtifact` hands `attach`, after links 1 and 2 held. */
export interface BoundArtifact {
  readonly appId: string;      // runs.app_id of fromRunId (every batch publishes one app id)
  readonly artifactId: string;
  readonly sha256: string;
  readonly appPath: string;
  readonly instrumentedDir: string;
}

export interface NamedMutantRequest {
  readonly mutantId: string;
  /** Chosen by the caller (C02-06: the report's coveringTests plus new tests). */
  readonly methods: readonly TestMethodRef[];
}

/** Handed to `inLease`. `publish` runs `run` inside the lease's publication fence. */
export interface LeaseFence {
  publish<T>(run: () => Promise<T>): Promise<T>;
}

export interface NamedMutantsConfig {
  readonly backend: ExecutionBackend;
  readonly store: ResultsStore;
  /** A run row the caller created for THIS call. Verdict and test rows are written under it. */
  readonly runId: number;
  readonly installed: InstalledArtifactRef;
  readonly requests: readonly NamedMutantRequest[];
  /** C02-05's slot: runs under the lease, after acquire and BEFORE attach and the baseline. */
  readonly inLease?: (fence: LeaseFence) => Promise<void>;
  readonly lease?: LeaseSessionConfig;
  readonly resourceServer?: string;
  readonly resourceServerInstance?: string;
  readonly quarantineDir?: string;
  readonly mutantTimeoutMs?: number;
  readonly baselineTimeoutMs?: number;
  readonly groupRuns?: SessionConfig["groupRuns"];
  readonly nowIso?: () => string;
  readonly emit?: SessionConfig["emit"];
}

export interface NamedMutantsResult {
  /** Exactly one per request, in request order. Never fewer, never an empty array. */
  readonly outcomes: readonly SessionOutcome[];
  /** Set when the session latched unsafe: the text `SessionReport.quarantined.reason` would get. */
  readonly quarantined?: string;
}

export async function runNamedMutants(cfg: NamedMutantsConfig): Promise<NamedMutantsResult>;
```

`SessionOutcome` (`report.ts:34`) is the record `buildReport` maps to a `MutantOutcome` row, so the output is `MutantOutcome`-compatible by construction.

**The typed refusals.** `InstalledArtifactError extends Error` (in `artifact.ts`, beside `DeploymentError`) with `reason`:
- `"no-record"`: no `batch_artifacts` row for `(fromRunId, batchIndex)`, or the row has no `manifest_sha256`;
- `"local-copy-unreadable"`: `appPath` or the manifest file cannot be read, or the manifest is not JSON;
- `"local-copy-differs"`: the .app hash is not the row's;
- `"manifest-differs"`: the manifest hash is not the row's, or its `artifactId` is not the row's;
- `"mismatch"` / `"unavailable"`: the registry pre-flight in `attach` (unavailable fails closed);
- `"unsupported"`: the backend has no `attach` (al-runner, every fake without one).

The first four are raised by `loadInstalledArtifact` (Part B Task 6) before any backend call. `NamedMutantError extends Error` covers request mistakes (decision 3). No raw `ENOENT` or `SyntaxError` leaves `runNamedMutants`.

### 2. Extraction, not duplication

ONE implementation of each piece, called by both `runSession` and `runNamedMutants`:

| New function (orchestrator.ts unless noted) | Moved from (as of `b29cf49`) |
|---|---|
| `scoreBatch(scope, input)` | step 4 from `// 4. baseline` (`:3782`) to the `StaleTestAppError` throw (`:3999`), and step 6 from `// 6. per-mutant loop` (`:4293`) to the section G gate's `safety.latchUnsafe(note)` (`:4479`) |
| `assertLeaseConfigured(caps, lease, backend, who)` | `:2937-2941` |
| `consultQuarantine(...)` | `let resourceKey` (`:2954`) through the `quarantine-consult-disabled` warning |
| `resolveGroupRuns(...)` | `:3282-3301`, including the `group-runs-inert` warning |
| `openLeaseScope(...)` | `:3349-3417`: `leaseBindableOrThrow`, `acquireSessionLease`, `new LeaseSession`, `bindLeaseToBackend`, `start()` |
| `closeLeaseScope(...)` | the `finally` body (`:4523-4553`) |
| `emitLeaseLostInvalidation(...)` | `:4561-4565` |
| `applyBatchInvalidations(outcomes, invalidations)` (report-fold.ts) | `report-fold.ts:471-483` |
| `BcDevMcpBackend.indexArtifact(appPath, instrumentedDir)` (private) | `bcdev-backend.ts:602-611` |

What stays in `runSession`: generate, plan, prepare, R192 whole-batch carry, the R90 ceiling, the history filter, deploy and bisection, and everything between the baseline and the covering loop (the R35/R69/R140 maps, the coverage split, the no-green note, the step 5b resume carry), which becomes the `select` callback it hands to `scoreBatch`. The R69 unsupported-only recording (`:4483-4511`) stays after `scoreBatch` returns. The worker fan-out (`:4337-4441`) stays as the `executeCovering` callback, because it deploys to each worker.

`scoreBatch`'s contract:

```ts
interface BatchScope {
  readonly backend: ExecutionBackend;
  readonly caps: BackendCapabilities;
  readonly safety: SessionSafety;
  readonly leaseSession: LeaseSession | undefined;
  readonly resyncOpSeq: (() => Promise<void>) | undefined;
  readonly quarantineStore: QuarantineStore | undefined;
  readonly resourceKey: string | undefined;
  readonly nowIso: () => string;
  readonly store: ResultsStore;
  readonly runId: number;
  readonly emit: RunEmitter;
  readonly outcomes: SessionOutcome[];
  readonly killLedger: KillLedger;
  readonly sessionReuse: { warned: boolean };
  readonly groupRuns: GroupRunSettings | undefined;
  readonly minMutantBudgetMs: number;
  /** `cfg.baselineTimeoutMs ?? BASELINE_TIMEOUT_DEFAULT`; also the covering loop's fallback. */
  readonly baselineTimeoutMs: number;
}
type BaselineRow = { readonly ref: TestMethodRef; readonly verdict: TestVerdict };
interface CoveringPlan {
  readonly mutants: readonly MutantManifestEntry[];
  readonly perMutantTests: ReadonlyMap<string, readonly TestMethodRef[]>;
  readonly coverageAttribution: ReadonlyMap<string, CoverageAttribution>;
  readonly baselineDuration: ReadonlyMap<string, number>;
  readonly memberCountsByTest: ReadonlyMap<string, number>;
}
interface ScoreBatchInput {
  readonly batchIndex: number;
  /** For the section G note only: `compiled?.artifactId`, or the bound artifact's id. */
  readonly artifactId: string | undefined;
  readonly tests: readonly TestMethodRef[];
  /** R192 snapshot reuse and recording, runSession only. Absent: always run, record nothing. */
  readonly snapshot?: { readonly batchDir: string; readonly testDir: string; readonly allowReuse: boolean };
  /** Called once, after the stale-test-app check. `undefined` = nothing left to run. */
  readonly select: (baseline: readonly BaselineRow[]) => CoveringPlan | undefined;
  /** Replaces the sequential `runMutantsOnBackend` call. runSession's worker fan-out only. */
  readonly executeCovering?: (plan: CoveringPlan, attestation: { clean: boolean }) => Promise<void>;
}
/** "unsafe": latched during the baseline (today's `break` at :3902).
 *  "nothing-to-run": `select` returned undefined (today's `continue` after the no-green note).
 *  "scored": the covering loop and the gate ran; the caller checks `safety.isUnsafe` itself. */
type ScoreBatchResult = "unsafe" | "nothing-to-run" | "scored";
```

The order inside `scoreBatch` is today's, line for line: `phase-entered baseline`, `activateOnce(null)`, (snapshot hashes and reuse, only with `snapshot`), the `runOnce` loop with its lease and in-flight branches, `phase-left baseline`, return `"unsafe"` if latched, (snapshot record), `baseline-batch-finished`, `StaleTestAppError`, `select`, `phase-entered mutants`, covering loop, `phase-left mutants`, section G gate.

**What the unit evidence shows, and what it cannot.** Part A Task 1 writes a characterization test on the UNMODIFIED code: thirteen scenarios, each snapshotting ONE interleaved trace (every backend call, primary and worker, and every event, in the order they happened, with every event field except elapsed times), the per-mutant verdict table, and every `mutants` and `test_results` column that a deterministic fake makes deterministic. `--update-snapshots` is forbidden after Task 1's commit. That catches a moved phase event, a moved call, a changed field, or a changed row, ON THE FAKES.

It cannot see, and nothing in the unit suite can: how the real control app numbers op sequences and answers a stale `opSeq`; real BC session reuse, so R206's store-level session-id liveness check; real chunk prefixes and which kills go warm to cold (only `itest:chunked` sees positions on a server); real baseline durations and the budgets derived from them; hub and fenced coverage from a real server; al-runner's process and server legs; and the real stop hook under a real hang. **The owner's live gates are the acceptance test for Part A, not corroboration.** The snapshot's job is to make a gate failure unlikely and to localize one if it happens.

**Gates the owner must run before Part A is accepted** (a per-mutant difference is a BLOCK):

| Gate | What only it can see |
|---|---|
| `LETHAL_ITEST_BCDEV=1 bun run itest:bcdev` | the authoritative path against a real control app: 3 / 12 / 4, `groupedCalls` 15, `warmKills` 0, every kill at `killPosition` 1, zero `session-reused`, the store-level session-id liveness check, `assertionScreen.discrimination` `vacuous` |
| `LETHAL_ITEST_TABLES=1 bun run itest:tables` | 299 / 63 / 15, `groupedCalls` 375, `warmKills` 13 with M0160 at 5, M0164 at 4, M0156 at 2, exactly one named baseline failure |
| `LETHAL_ITEST_CHUNKED=1 bun run itest:chunked` | chunk positions on a server: both legs 17 / 7 / 2 with identical `killingTest`, control `warmKills` 9 / `groupedCalls` 33, chunked 5 / 57 |
| `LETHAL_ITEST_HANG=1 bun run itest:hang` | the real stop and in-flight quarantine, which now flow through `scoreBatch` and `closeLeaseScope` |
| `LETHAL_ITEST_ALRUNNER=1 LETHAL_ALRUNNER_PATH=... bun run itest:alrunner` | the non-authoritative path, all four legs equal per mutant, 3 / 12 / 4 |
| `LETHAL_ITEST_ENVTOOL=1 bun run itest:envtool`, only if an environment exists | the one gate that calls `afterLeaseAcquired` (Task 4 moves it); the environment was deleted 2026-09-01, so Task 4's unit test is expected to be the only evidence |

Part B changes no verdict path of `lethal run`; its live evidence is ruling 3's probe.

### 3. What "no deploy" means, and batch-qualified names

"No deploy" means `runNamedMutants` never calls `backend.deploy`, `backend.compileCheck`, `prepareArtifactDir`, `generateMutationSet`, `planArtifacts`, `bisectAndNote`, `deployOnce`, `store.recordArtifact` or `recordPublishOutcome`, and emits no `phase-entered deploy` and no `batch-published`. The only publish that can happen inside it is one the `inLease` hook asks for through the fence (C02-05's test app); the TARGET is never published. Its server calls are `status()`, the lease calls, `attach`'s two reads (harness info and `RegisteredArtifact`), and `activate`/`run`/`runMany`. A test pins this, including zero new `batch_artifacts` and `publish_outcomes` rows.

**Names are artifact-qualified.** `assignMutantIds` numbers from `M0001` per artifact (`schemata/src/ids.ts`; `orchestrator.ts:1073`), which is R231's problem for report lists. Here a name is resolved only inside the ONE manifest whose hash matches the trusted record for `(fromRunId, batchIndex)` (decision 1, links 1 and 2). Within one artifact a mutant id is unique, so the pair is unambiguous. Request refusals, all `NamedMutantError`, all before any backend call: `requests` empty; a `mutantId` twice; a `mutantId` not in the manifest (the message lists every unknown id); a request with no methods, or one method twice.

Mapping a report row `(batchIndex, mutantCode)` to an `InstalledArtifactRef` is C02-06's job; see Out of scope for what that cannot reach.

### 4. Quarantine and in-flight-unknown: the same latch

`runNamedMutants`, in order: `loadInstalledArtifact` and `resolveNamedMutants` (no backend call); `backend.attach === undefined` refuses `unsupported`; fresh `SessionSafety`; `assertLeaseConfigured`; `consultQuarantine`; `status()`; `resolveGroupRuns`; `openLeaseScope`. Then `try`: `leaseSession.currentBatchIndex = installed.batchIndex` (as `:3476`); `inLease?.(fence)` then `leaseSession.rebindBackend(backend)` (a no-op when nothing was published, `:2285-2289`); `attach`; `scoreBatch`. `catch` only `SessionUnsafeError` (as `:4515-4522`). `finally` `closeLeaseScope`, then `emitLeaseLostInvalidation`. Every latch rule therefore comes from the shared code.

Two things differ from `runSession`, and both close an empty-looking answer:
- **Invalidation is applied before returning.** In `runSession`, `batch-invalidated` is applied by the fold (`report-fold.ts:471-483`), never to `outcomes[]`. `runNamedMutants` collects its own `batch-invalidated` events and calls `applyBatchInvalidations` on its outcomes: same rule, same code, same exemptions.
- **A mutant the latch stopped is still answered.** In `runSession` it simply has no row. Here a request with no outcome gets `{ verdict: "error", failureNote: "not run: the session latched unsafe before this mutant (<reason>)" }`, returned and not stored, like `runSession`.

`runNamedMutants` does NOT call `store.finishRun`. See "Notes for C02-06".

### 5. Review Focus

Each pinned by a named test (Part B unless noted):

1. **The installed artifact is not the expected one** (local tampering, a stale local copy, or a replaced install; a forged same-id build is decision 1's trust assumption, not tested). Three shapes: the local .app is not the recorded bytes; the local manifest has the recorded `artifactId` but different mutants (same id, wrong manifest); the server reports another artifact (the caller named batch 0 of a two-batch run). Expected: `InstalledArtifactError` with `local-copy-differs`, `manifest-differs` and `mismatch` respectively; ZERO `activate`/`run`/`runMany`; zero `mutants` and `test_results` rows; for the first two, zero backend calls of any kind; for the third, the lease released. Pinned by Task 6's `"loadInstalledArtifact refuses a manifest with the recorded id but other mutants"`, `"loadInstalledArtifact refuses a .app that is not the recorded bytes"`, `"attach refuses a server that reports another artifact, and binds no transport"`, and Task 8's `"runNamedMutants: a same-id wrong manifest is refused before any backend call"` and `"runNamedMutants: a wrong installed artifact throws and runs nothing"`.
2. **A named mutant not in the manifest.** `NamedMutantError` naming every unknown id, before any backend call. Pinned by Task 7's `"resolveNamedMutants refuses ids the artifact does not contain, naming all of them"` and Task 8's `"runNamedMutants: request mistakes are refused before any backend call"`.
3. **An empty named list** (and a request with no methods, and a duplicate). `NamedMutantError`, never `{ outcomes: [] }`, zero backend calls. Pinned by Task 7's `"resolveNamedMutants refuses an empty request list and a request with no methods"` and the same Task 8 test.
4. **A covering test that hangs.** The tier is durably quarantined, `quarantined` names it, the stranded mutant is `error` with its strand cause, the one before keeps its verdict, the one after is `not run`, every request has one outcome. Pinned by `"runNamedMutants: a hang quarantines, and every request still gets exactly one outcome"`.
5. **A baseline test that goes red.** A red method is never run against its mutant; all-red gives `error` with the test's own failure text (`noGreenBaselineNote`), never `survived`; one green method means scored on that one only. Pinned by `"runNamedMutants: a red baseline method is never run against its mutant"`.

Also pinned: `"runNamedMutants never deploys the target"`, `"runNamedMutants: inLease without a lease is refused, never run unfenced"`, `"runNamedMutants: the order is lease, inLease, rebind, attach, baseline, covering, release"`, `"runNamedMutants: an unattested batch returns error outcomes, never the raw survivors"`.

## Global Constraints

- `CLAUDE.md` build order: `bun run typecheck`, then `rm -rf packages/*/dist`, then `bun test`. Biome only on touched files: `bunx biome check <paths>`.
- No `!` non-null assertions. `exactOptionalPropertyTypes`: `...(v !== undefined ? { k: v } : {})`.
- Typed errors extend `Error` directly: `InstalledArtifactError` and `NamedMutantError` extend neither `DeploymentError` nor each other, and neither can reach bisection.
- Fail loudly: throw on a caller-contract violation, never return a plausible empty default.
- No `SessionReport` field, event type, `Caveat` or `MutantErrorCause` value is added; `BatchArtifact` (the type the report re-exports) does NOT gain the manifest hash. `REPORT_SCHEMA_VERSION` and `STREAM_SCHEMA_VERSION` do not move, and `bun scripts/generate-schemas.ts` produces no diff (check at the end of each part).
- `runSession`'s signature and `SessionConfig` do not change.
- Live gates are owner-only. The lane asks; it never runs one.
- No em dashes in code comments or docs you write.

---

# Part A (coord C02-04): extract, change nothing

### Task 1: Characterization snapshot, on the unmodified code

**Files:**
- Test: `packages/runner/tests/orchestrator.test.ts`, one new `describe("C02-04 characterization")` at the end
- Test: `packages/runner/tests/resume.test.ts`, one scenario (R192 reuse uses that file's fakes)
- Creates: their `__snapshots__` entries

- [ ] **Step 1: The harness: one trace for calls and events.** In `orchestrator.test.ts`:

```ts
type Trace = unknown[];
/** Wraps a backend so every call lands in the SHARED trace, tagged by which backend made it. */
function recording(inner: ExecutionBackend, trace: Trace, tag: string): ExecutionBackend {
  const b: ExecutionBackend = {
    capabilities: () => inner.capabilities(),
    status: async () => { trace.push({ call: "status", tag }); return inner.status(); },
    deploy: async (d) => { trace.push({ call: "deploy", tag }); return inner.deploy(d); },
    compileCheck: async (d) => { trace.push({ call: "compileCheck", tag }); return inner.compileCheck(d); },
    activate: async (id) => { trace.push({ call: "activate", tag, id }); return inner.activate(id); },
    run: async (ref, o) => {
      trace.push({ call: "run", tag, method: ref.method, coverage: o.coverage, timeoutMs: o.timeoutMs });
      return inner.run(ref, o);
    },
  };
  const many = inner.runMany?.bind(inner);
  if (many !== undefined) {
    b.runMany = async (o) => {
      trace.push({ call: "runMany", tag, methods: o.methods.map((m) => [m.ref.method, m.budgetMs]),
        confirmation: o.confirmation === true, requestCeilingMs: o.requestCeilingMs });
      return many(o);
    };
  }
  const setLease = (inner as { setLease?: (l: Lease) => void }).setLease?.bind(inner);
  if (setLease !== undefined) {
    Object.assign(b, { setLease: (l: Lease) => { trace.push({ call: "setLease", tag, lastCompletedOpSeq: l.lastCompletedOpSeq }); setLease(l); } });
  }
  const fetchPkg = inner.fetchPublishedAppPackage?.bind(inner);
  if (fetchPkg !== undefined) {
    b.fetchPublishedAppPackage = async (a) => { trace.push({ call: "fetchPublishedAppPackage", tag }); return fetchPkg(a); };
  }
  return b;
}
/** Every event field except wall-clock ones; the subscriber writes into the SAME trace. */
function traceEvents(trace: Trace) {
  return (e: RunEvent) => trace.push({ event: stripClock(e) });
}
function stripClock(x: unknown): unknown {
  if (Array.isArray(x)) return x.map(stripClock);
  if (x === null || typeof x !== "object") return x;
  return Object.fromEntries(
    Object.entries(x).filter(([k]) => !/(?:Ms|At|Iso)$/.test(k) || k === "timeoutMs" || k === "budgetMs").map(([k, v]) => [k, stripClock(v)]),
  );
}
const ID32 = /[0-9a-f]{32}/g;
function normalize(x: unknown): unknown {
  return JSON.parse(JSON.stringify(x).replace(ID32, "<id32>").replaceAll(JSON.stringify(tmpdir()).slice(1, -1), "<tmp>"));
}
async function characterize(trace: Trace, store: ResultsStore, report: unknown) {
  return normalize({
    verdicts: verdictTable(report as Awaited<ReturnType<typeof runSession>>),
    quarantined: (report as { quarantined?: { reason: string } }).quarantined?.reason ?? null,
    trace,
    mutantRows: store.db.query(
      "SELECT batch_index, mutant_code, verdict, killing_test, killing_test_failure, kill_position, failure_note, duration_ms, covering_tests, coverage_attribution, unplaceable, runner FROM mutants ORDER BY id",
    ).all(),
    testRows: store.db.query(
      "SELECT mutant_row_id, mutant_code, codeunit_id, method, outcome, duration_ms, failure_message, op_kind, session_id FROM test_results ORDER BY id",
    ).all(),
  });
}
```

  A `timeoutMs`/`budgetMs` kept in the trace is derived from fake durations and is deterministic; if one is not, drop that key for that scenario only and say which in the submit note. If `store.db` is not reachable, use what `store.test.ts` uses; do not add a getter.

- [ ] **Step 2: Scenarios.** One `test` each, ending `expect(await characterize(trace, store, reportOrError)).toMatchSnapshot()`. Every scenario builds its OWN `const store = new ResultsStore(":memory:")` and passes it in: `runSessionForTest(backend, overrides)` spreads `overrides` last (`:4455-4465`), so `runSessionForTest(backend, { store, emit: [traceEvents(trace)], ... })` reaches the store it would otherwise hide. Copy each setup from the named test; do not invent one.

| # | Scenario | Setup copied from |
|---|---|---|
| 1 | one batch, sequential | "kill: mutant-active fail + baseline-pass confirmation = killed" (`:394`) |
| 2 | two batches | the `maxGuardsPerBatch: 1` test near `:1264` |
| 3 | grouped, chunked | the R198 describe (`:8193`), `groupRuns: { maxMethodsPerCall: 2 }` |
| 4 | warm kills | the R206 describe (`:8464`), a `WarmStubBackend` test with a kill above position 1 |
| 5 | strand mid-batch | `strandsOnBackend("M0007")` (`:4481`), `quarantineDir: freshTmpDir()` |
| 6 | section G unattested | `attestingBackend({ observedAny: false, identityMismatch: false })` (`:5123`) |
| 7 | lease lost mid-batch | "a genuine RunMutant lease-lost invalidates the CURRENT batch's already-recorded verdicts" (`:5861`); `FakeLeaseClient`'s own `log` goes into the trace too (push its entries as `{ lease: name }` by giving it the trace-backed array) |
| 8 | R194 rule 2b | "rule 2b: never claimed -> ONE fresh attempt, whose real verdict is recorded; no quarantine" (`:6958`) |
| 9 | no green baseline | the describe named "R100, the dead-baseline note reaches the report" (`:4578`) |
| 10 | stale test app | the R139 describe (`:1471`): characterize the thrown message plus the rows written before it |
| 11 | parallel workers | the describe named "parallel workers" (`:1827`), `workers: 2`: wrap the primary as `recording(b, trace, "primary")` AND give `backendFactory: (i) => recording(<the test's own factory>(i), trace, "worker" + i)`, so worker deploys and shard runs are in the trace |
| 12 | baseline in-flight | "a BASELINE test returning in-flight-unknown records a durable quarantine and quarantines the session before any mutant is scheduled" (`:4998`) |
| 13 | baseline pre-dispatch retry | the op-seq resync describe at the BASELINE run site (`:7147`): a `pre-dispatch-rejected` baseline run that resyncs and retries |

  In `resume.test.ts`: the R192 test around `:925-960` (`maxGuardsPerBatch: 1`, `resume: "last"`) that emits `resume-baseline-reused`, characterizing the SECOND run with its own trace-wrapped backend. It is the only path through `snapshot.allowReuse: true`. Give the fake a `fetchPublishedAppPackage` if it lacks one, so the snapshot-hash call is visible in the trace.

  Scenario 11: two workers interleave. If the trace is not stable over `--rerun-each 10`, snapshot the trace as one sub-list per `tag` (each worker's own order is deterministic), and the events separately. Say which in the submit note: this is exactly a place the live gates, not the snapshot, carry the proof.

- [ ] **Step 3: Run** `bun test packages/runner/tests/orchestrator.test.ts -t "C02-04 characterization" --rerun-each 10`, and the resume one. Expected: PASS and stable. Read every snapshot: scenarios 1 to 8, 11 and 13 must contain `mutant-scored` events; 3 must contain `runMany` entries with two methods; 4 a `confirmation: true` entry; 7 and 12 a `quarantined` or `batch-invalidated` event. A scenario that does not show what it is named for is fixed now, not later.
- [ ] **Step 4: Commit** `test(runner): characterize runSession's per-batch core before extraction (C02-04)`. From here to the end of Part A, `--update-snapshots` is forbidden.

### Task 2: `scoreBatch`, called by `runSession`

**Files:** Modify `packages/runner/src/orchestrator.ts`. Test: the Task 1 snapshots.

- [ ] **Step 1: Build the scope once** after `sessionReuse` (`:3470`) from existing locals.
- [ ] **Step 2: Move the code.**
  - `scoreBatch` part 1: from `emit({ type: "phase-entered", phase: "baseline", ... })` through the `StaleTestAppError` throw. Hashing, reuse lookup, reused-row recording and snapshot recording go under `if (input.snapshot !== undefined)`; `resumeState !== undefined` becomes `input.snapshot.allowReuse`; `batchDir`/`cfg.testDir` become `input.snapshot.batchDir`/`testDir`. The unsafe `break` becomes `return "unsafe"`.
  - `select`, in `runSession`: from `const greenTests = ...` through the end of step 5b, verbatim. The no-green `continue` becomes `return undefined`. It returns `{ mutants: toExecute, perMutantTests, coverageAttribution, baselineDuration, memberCountsByTest: memberCounts }`. `unsupportedOnlyCandidates`, `refusedThisBatch`, `testPageThisBatch` are declared with `let` above the call and assigned inside, because the R69 block reads them after.
  - `scoreBatch` part 2: `const attestation = { clean: false }`, `phase-entered mutants`, `input.executeCovering?.(plan, attestation)` or the sequential `runMutantsOnBackend` call (`backend: scope.backend`, `fallbackTimeoutMs: scope.baselineTimeoutMs`), `phase-left mutants`, the section G gate with `input.artifactId ?? "unknown"`. Return `"scored"`.
  - `executeCovering`, passed only when `workers > 1`: the `else` branch from `const shards = ...` through the `firstRejection` rethrow, verbatim.
  - The loop: `const scored = await scoreBatch(scope, {...}); if (scored === "unsafe") break; if (scored === "nothing-to-run") continue;` then the R69 block and `if (safety.isUnsafe) break;`. `snapshot` is always passed, with `allowReuse: resumeState !== undefined`.
- [ ] **Step 3: Run** typecheck, clean dist, `bun test packages/runner`. Expected: PASS, snapshots unchanged, no existing test edited.
- [ ] **Step 4: Red-checks** (report the red line, then restored green):
  - move `activateOnce(null)` after the baseline loop: every scenario's trace goes red;
  - drop `return "unsafe"`: scenario 12 goes red (a `mutants` phase and mutant activations appear after the baseline quarantine);
  - emit `baseline-batch-finished` before `phase-left baseline`: every scenario except 10 and 12 goes red (12 exits before that event; 10 goes red too, since its event is emitted before the throw);
  - move the snapshot hash (the `fetchPublishedAppPackage` call) before `activateOnce(null)`: the resume scenario goes red;
  - skip the reused-row `recordTestResult` calls: the resume scenario goes red on `testRows`;
  - run the section G gate before `phase-left mutants`: scenario 6 goes red.
- [ ] **Step 5: Commit** `refactor(runner): runSession scores each batch through scoreBatch (C02-04)`.

### Task 3: Session-scope glue as functions

**Files:** Modify `packages/runner/src/orchestrator.ts`. Test: the Task 1 snapshots; the lease, quarantine and teardown tests (`:4648`, `:4750`, `:5526-6329`) unchanged.

**Interfaces (not exported in Part A):**

```ts
function assertLeaseConfigured(caps: BackendCapabilities, lease: LeaseSessionConfig | undefined, backend: ExecutionBackend, who: string): void;
async function consultQuarantine(a: { caps: BackendCapabilities; resourceServer?: string; resourceServerInstance?: string; quarantineDir?: string; emit: RunEmitter }): Promise<{ resourceKey: string | undefined; quarantineStore: QuarantineStore | undefined }>;
function resolveGroupRuns(a: { groupRuns: SessionConfig["groupRuns"]; backend: ExecutionBackend; minMutantBudgetMs: number; emit: RunEmitter }): GroupRunSettings | undefined;
async function openLeaseScope(a: { lease: LeaseSessionConfig | undefined; backend: ExecutionBackend; safety: SessionSafety; runId: number; quarantineStore: QuarantineStore | undefined; resourceKey: string | undefined; nowIso: () => string; emit: RunEmitter }): Promise<{ leaseSession: LeaseSession | undefined; resyncOpSeq: (() => Promise<void>) | undefined }>;
async function closeLeaseScope(a: { backend: ExecutionBackend; workerBackends: readonly ExecutionBackend[]; safety: SessionSafety; leaseSession: LeaseSession | undefined; emit: RunEmitter }): Promise<void>;
function emitLeaseLostInvalidation(leaseSession: LeaseSession | undefined, safety: SessionSafety, emit: RunEmitter): void;
```

  `who` keeps `runSession`'s message byte-identical when it is `"runSession"`.

- [ ] **Step 1: Move** each block into its function, verbatim, called from the same place. `afterLeaseAcquired` stays where it is (Task 4 moves it).
- [ ] **Step 2: Run** the loop. Snapshots unchanged.
- [ ] **Step 3: Red-checks:** in `closeLeaseScope` call `activate(null)` even when unsafe: the "Task 11 quarantine consult + latch-gated finally" test and scenario 5 go red; call `emitLeaseLostInvalidation` before `closeLeaseScope`: scenario 7 goes red.
- [ ] **Step 4: Commit** `refactor(runner): the session's lease and quarantine glue are functions (C02-04)`.

### Task 4: `afterLeaseAcquired` inside the lease's try (closes R232)

R232 (filed at `900ae4e`): the comment above the call says a publish that throws must release the lease, but the call is at `:3418` and the `try` opens at `:3427`, so a throw leaves the lease held and the heartbeat scheduled until the ttl lapses.

**Files:** Modify `packages/runner/src/orchestrator.ts` (the call becomes the first line inside `try`, before the permission canary, so its order relative to the canary is unchanged). Update `docs/roadmap/R232.md` status to `done (<commit>)`, then `bun scripts/roadmap-index.ts`. Test: `orchestrator.test.ts`, in the describe whose name contains "Task 8: publish fence + op-gated release" (`:5658`).

- [ ] **Step 1: Write the failing test:**

```ts
test("an afterLeaseAcquired that throws still releases the lease and stops the heartbeat (R232)", async () => {
  const log: string[] = [];
  const client = new FakeLeaseClient(log);
  const timers = new FakeTimers();
  const { lease } = leaseCfg(client, { timers });
  const err = await runSessionForTest(leaseBackend(), {
    lease,
    quarantineDir: freshTmpDir(),
    afterLeaseAcquired: async () => {
      throw new Error("test-app publish failed");
    },
  }).catch((e) => e);
  expect((err as Error).message).toBe("test-app publish failed");
  expect(client.releaseCalls).toBe(1);
  expect(log.indexOf("acquire")).toBeLessThan(log.indexOf("release"));
  expect(timers.cleared).toBe(1);
});
```

- [ ] **Step 2: Run and see it fail** (`releaseCalls` 0, `cleared` 0).
- [ ] **Step 3: Move the call.** Full loop; Task 1 snapshots unchanged (no scenario sets the hook).
- [ ] **Step 4: Red-check:** move it back above `try`: red. Restore.
- [ ] **Step 5: Commit** `fix(runner): a failing afterLeaseAcquired releases the lease (R232)`.

### Task 5: Two small shared extractions outside the orchestrator

**Files:** Modify `packages/runner/src/report-fold.ts` (`:471-483`) and `packages/runner/src/bcdev-backend.ts` (`deploy`, `:602-611`). Tests unchanged.

**Interfaces:**
- `export function applyBatchInvalidations(outcomes: SessionOutcome[], invalidations: readonly { readonly batchIndex: number; readonly reason: string }[]): void`, in place, the loop verbatim; `foldEvents` calls it.
- `private async indexArtifact(appPath: string, instrumentedDir: string): Promise<void>`: the `methodIndex` assignment and the fenced `lineMap`/`coverageObjectIdFilter` block; `deploy` calls it at the same point (before publish).

- [ ] **Step 1: Move both.** **Step 2: Run** the loop.
- [ ] **Step 3: Red-check:** drop the `cause !== undefined` exemption: the existing `report-fold.test.ts` exemption test goes red (name it). Restore.
- [ ] **Step 4:** `bun scripts/generate-schemas.ts` produces no diff. Biome on touched files.
- [ ] **Step 5: Commit** `refactor(runner): share the invalidation rule and the artifact indexing step (C02-04)`.

**Part A submit note must say:** every red-check with its red and restored-green line; `git diff <task1-commit> -- '**/__snapshots__/**'` is empty; the scenario 11 decision; every key dropped from a scenario for nondeterminism; the R232 status change; and the gate table as the owner's to-run list.

---

# Part B (coord C02-04b): the no-deploy entry point

Starts after Part A is merged and its gates are run.

### Task 6: The trusted record, `loadInstalledArtifact`, and `attach`

**Files:**
- Modify: `packages/runner/src/store.ts` (C02-02's `batch_artifacts`: a nullable `manifest_sha256 TEXT` column, added with the `PRAGMA table_info` + `ALTER TABLE ... ADD COLUMN` pattern at `:299-373`; `recordArtifact` takes and writes it; a new `trustedArtifactRecord(runId, batchIndex): { artifactId: string; sha256: string; manifestSha256: string | null; appId: string } | null`, `appId` from `runs.app_id`). `artifactsForRun` and `BatchArtifact` do NOT change.
- Modify: `packages/runner/src/orchestrator.ts` step 3d: pass `manifestSha256: Bun.SHA256.hash(JSON.stringify(compiled.mutantManifest), "hex")`.
- Modify: `packages/runner/src/artifact.ts` (`InstalledArtifactError`), `backend.ts` (`BoundArtifact`, optional `attach`), `deployment-verifier.ts` (`verify(expected: Pick<CompiledArtifact, "artifactId" | "appId">)`: it reads only those two fields, so every caller still typechecks), `bcdev-backend.ts` (`attach`).
- Create: `loadInstalledArtifact` in `packages/runner/src/named-mutants.ts` (Task 7 adds the rest of that file).
- Test: `store.test.ts`, `named-mutants.test.ts`, `bcdev-backend.test.ts` (`makeDeployment` `:176`, `makeBackendWithDeploy` `:353`), and one `orchestrator.test.ts` test for the step 3d write.

**Interfaces:**

```ts
export class InstalledArtifactError extends Error {
  constructor(
    readonly reason: "no-record" | "local-copy-unreadable" | "local-copy-differs" | "manifest-differs" | "mismatch" | "unavailable" | "unsupported",
    readonly detail: string,
  ) {
    super(`installed artifact refused (${reason}): ${detail}`);
  }
}
/** Links 1 and 2 of decision 1. Reads only the store and local files; never a backend. */
export async function loadInstalledArtifact(store: ResultsStore, ref: InstalledArtifactRef): Promise<{ artifact: BoundArtifact; manifest: MutantManifest }>;
// backend.ts, on ExecutionBackend:
/** Bind to an ALREADY-installed artifact. Never compiles or publishes. */
attach?(artifact: BoundArtifact): Promise<void>;
```

  `loadInstalledArtifact`: record missing or `manifestSha256 === null` -> `no-record`; any read or `JSON.parse` failure -> `local-copy-unreadable` (wrap, keep the cause text); .app hash differs -> `local-copy-differs`; manifest hash differs, or `manifest.artifactId !== record.artifactId` -> `manifest-differs`. Returns the PARSED manifest object; names are resolved in it and nowhere else.

  `BcDevMcpBackend.attach`: `harnessVerifier.verify()`; `verifier.verify({ appId, artifactId })` (`mismatch` carries `verification.reported`, `unavailable` carries `verification.detail`, both throw); `indexArtifact(appPath, instrumentedDir)`, wrapping any read failure as `local-copy-unreadable`; then `this.runMutantTransport = this.runMutantTransportFactory?.(appId, artifactId)`. Nothing is bound before `accepted`.

- [ ] **Step 1: Write the failing tests.**
  - `store.test.ts`: `"recordArtifact stores the manifest hash and trustedArtifactRecord returns it"`, and `"a batch_artifacts row written before the column exists reads back manifestSha256 null"` (old-schema database, the migration test pattern C02-02 Task 1 Step 4 uses).
  - `orchestrator.test.ts`, in the Layer 5A identity describe: `"step 3d records the hash of the manifest the compiler was given"`: compare `trustedArtifactRecord(runId, 0)?.manifestSha256` against `Bun.SHA256.hash(JSON.stringify(backend.returned[0].mutantManifest), "hex")`, using C02-02's `PhaseBackend.returned` list as the independent oracle.
  - `named-mutants.test.ts`, each on a temp dir holding a real `.app`-shaped file and a manifest, and a store row written with `recordArtifact`:

```ts
test("loadInstalledArtifact refuses a manifest with the recorded id but other mutants", async () => {
  // write the manifest, record its hash; then rewrite it with the SAME artifactId and one mutant removed
  await expect(loadInstalledArtifact(store, ref)).rejects.toMatchObject({ reason: "manifest-differs" });
});
test("loadInstalledArtifact refuses a .app that is not the recorded bytes", async () => {
  // append one byte to the .app after recording
  await expect(loadInstalledArtifact(store, ref)).rejects.toMatchObject({ reason: "local-copy-differs" });
});
test("loadInstalledArtifact refuses a missing file and a corrupt manifest as local-copy-unreadable", async () => {
  // appPath removed; then manifest replaced by "{not json"
});
test("loadInstalledArtifact refuses a run with no record, and a record without the manifest hash", async () => {});
test("loadInstalledArtifact returns the parsed manifest whose hash matched", async () => {});
```
  - `bcdev-backend.test.ts`, attaching a SECOND fresh backend to the `.app` a first `makeBackendWithDeploy` produced, with a `runMutantTransportFactory` that records its arguments and a spawn wrapper recording argv:
    - `"attach binds the transport to the installed artifact without compiling or publishing"`: factory saw `(appId, TEST_ARTIFACT_ID)`; no `alc` and no `publishapp` argv; a hub-mode coverage `run` resolves procedure names.
    - `"attach refuses a server that reports another artifact, and binds no transport"`: `reportedIdentity: "b".repeat(32)`; `reason === "mismatch"`; factory never called.
    - `"attach fails closed when the server cannot say"`: verifier `fetchFn` answers 500; `reason === "unavailable"`; factory never called.
    - `"InstalledArtifactError is not a DeploymentError or an AlcCompileError"`.
- [ ] **Step 2: Run and see them fail.** **Step 3: Implement.** **Step 4: Run** the loop; the Part A snapshots are unchanged (they do not read `batch_artifacts`).
- [ ] **Step 5: Red-checks:** compare only `manifest.artifactId` and skip the manifest hash: the "recorded id but other mutants" test goes red; skip the .app hash: "not the recorded bytes" goes red; let a raw `ENOENT` through: "local-copy-unreadable" goes red; bind before the verifier: "binds no transport" goes red; treat `unavailable` as accepted: "fails closed" goes red.
- [ ] **Step 6: Commit** `feat(runner): bind an installed artifact to its recorded bytes and manifest (C02-04b)`.

### Task 7: `resolveNamedMutants` and `baselineTestsOf`

**Files:** Modify `packages/runner/src/named-mutants.ts`. Test: `named-mutants.test.ts`.

```ts
export class NamedMutantError extends Error {}
export interface ResolvedNamedMutant { readonly mutant: MutantManifestEntry; readonly methods: readonly TestMethodRef[] }
/** Decision 3's refusals. `manifest` is the one loadInstalledArtifact matched. Never returns []. */
export function resolveNamedMutants(manifest: MutantManifest, requests: readonly NamedMutantRequest[]): readonly ResolvedNamedMutant[];
/** Every method any request names, deduplicated by `testKeyOf` (selection.ts:262), first-seen order. */
export function baselineTestsOf(named: readonly ResolvedNamedMutant[]): readonly TestMethodRef[];
```

  `NamedMutantRequest` is declared here and re-exported from `orchestrator.ts`.

- [ ] **Step 1: Write the failing tests** on a hand-built manifest (`M0001`..`M0003`, entries shaped like `fakeManifestEntry` at `orchestrator.test.ts:7576`, copied):

```ts
const T1 = { codeunitId: 1, codeunitName: "T", method: "T1" };
test("resolveNamedMutants refuses ids the artifact does not contain, naming all of them", () => {
  expect(() => resolveNamedMutants(MANIFEST, [
    { mutantId: "M0001", methods: [T1] }, { mutantId: "M0099", methods: [T1] }, { mutantId: "M0100", methods: [T1] },
  ])).toThrow(/M0099.*M0100/s);
});
test("resolveNamedMutants refuses an empty request list and a request with no methods", () => {
  expect(() => resolveNamedMutants(MANIFEST, [])).toThrow(NamedMutantError);
  expect(() => resolveNamedMutants(MANIFEST, [{ mutantId: "M0001", methods: [] }])).toThrow(NamedMutantError);
});
test("resolveNamedMutants refuses a repeated id and a repeated method", () => { /* both toThrow(NamedMutantError) */ });
test("resolveNamedMutants returns the manifest's own entry objects, in request order", () => {
  const out = resolveNamedMutants(MANIFEST, [{ mutantId: "M0003", methods: [T1] }, { mutantId: "M0001", methods: [T1] }]);
  expect(out[0]?.mutant).toBe(MANIFEST.mutants[2]);
  expect(out[1]?.mutant).toBe(MANIFEST.mutants[0]);
});
test("baselineTestsOf deduplicates across requests", () => { /* T1 in two requests -> once */ });
```

- [ ] **Step 2: Fail. Step 3: Implement. Step 4: Run.**
- [ ] **Step 5: Red-checks:** stop at the first unknown id: "naming all of them" goes red; drop the empty check: red; spread-copy the entry (`{ ...m }`): "own entry objects" goes red.
- [ ] **Step 6: Commit** `feat(runner): resolve named mutants inside one verified manifest (C02-04b)`.

### Task 8: `runNamedMutants`

**Files:** Modify `packages/runner/src/orchestrator.ts` (exported `runNamedMutants`, config/result types, re-exports). Test: `orchestrator.test.ts`, `describe("C02-04b: runNamedMutants")`.

**The body** is decision 4's order. The `fence` handed to `inLease` is `{ publish: (run) => leaseSession.publish(run) }` (`LeaseSession.publish`, `:2301-2328`, which sets the op seq `rebindBackend` reads). There is no unfenced fallback: `inLease` given without a lease (`cfg.lease === undefined`) is refused with `NamedMutantError("inLease requires a lease: a publish outside the fence ...")` in the no-backend-call prefix, before `status()`, because the hook's contract is that its publish holds the lease's operation marker. `select` for named mutants (local): green = baseline rows with outcome `pass`; per mutant keep only green methods; none green -> `record(... "error" ..., noGreenBaselineNote(<that mutant's own baseline rows>))`; otherwise `perMutantTests`. `coverageAttribution` and `memberCountsByTest` are empty maps (nothing attributed); `baselineDuration` as `runSession` builds it. Return `undefined` when no mutant has a green method.

**Fixture, and what it must provide.** Task 1's `recording(...)` gains two lines: when the inner backend has `attach`, forward it and push `{ call: "attach", tag, artifactId }` into the trace; without that, `runNamedMutants` refuses the wrapped fake as `unsupported`. `PhaseBackend.compileArtifact` returns `appPath: join(dir, "phase-fake.app")` with a constant sha but never writes the file (`orchestrator.test.ts:3115-3134`), so `loadInstalledArtifact` would refuse it as unreadable: the fixture gives `PhaseBackend` an opt-in that WRITES distinct bytes to `appPath` (for example the artifact id's UTF-8) and returns `sha256: Bun.SHA256.hash(<those bytes>, "hex")`, so the trusted row records the real hash of a real file. `TEST_AL` has one method (`:73-82`), so the fixture writes its own tests file through `makeProject(testAl)` (`:330` takes one): codeunit 79100 with `[Test] OverBudgetDetected` and `[Test] RedAtBaseline`. It runs `runSession` once with C02-02's `PhaseBackend` on `THREE_PROC_AL` (nine mutants) to produce `run-1-batch-0` and its trusted row, then creates a second run row for the call. The backend under test is `recording(<fake with attach>, trace, "b")` from Task 1, where `attach` calls a real `DeploymentVerifier` with a scripted `fetchFn`, so the refusal is the production code path. `run` scripts outcomes per `(active mutant, method)`: `RedAtBaseline` fails at baseline with `failureMessage: "boom-red"`; mutant runs attest `{ observedAny: true, identityMismatch: false }` unless a test says otherwise.

- [ ] **Step 1: Write the failing tests:**

```ts
const OVER = { codeunitId: 79100, codeunitName: "Sandbox Tests", method: "OverBudgetDetected" };
const RED = { codeunitId: 79100, codeunitName: "Sandbox Tests", method: "RedAtBaseline" };
const calls = (t: Trace) => t.filter((x) => typeof x === "object" && x !== null && "call" in x);
const rowCount = (s: ResultsStore, table: string, runId: number) =>
  (s.db.query(`SELECT COUNT(*) AS n FROM ${table} WHERE run_id = ?`).get(runId) as { n: number }).n;

test("runNamedMutants: request mistakes are refused before any backend call", async () => {
  const fx = await installedFixture();
  for (const requests of [[], [{ mutantId: "M0001", methods: [] }], [{ mutantId: "M0001", methods: [OVER] }, { mutantId: "M0001", methods: [OVER] }], [{ mutantId: "M0099", methods: [OVER] }]]) {
    await expect(runNamedMutants({ ...fx.cfg, requests })).rejects.toBeInstanceOf(NamedMutantError);
  }
  expect(calls(fx.trace)).toEqual([]);
  expect(rowCount(fx.store, "mutants", fx.cfg.runId)).toBe(0);
});

test("runNamedMutants: a same-id wrong manifest is refused before any backend call", async () => {
  const fx = await installedFixture();
  await rewriteManifestKeepingId(fx.installed.instrumentedDir, (m) => ({ ...m, mutants: m.mutants.slice(1) }));
  await expect(runNamedMutants({ ...fx.cfg, requests: [{ mutantId: "M0002", methods: [OVER] }] }))
    .rejects.toMatchObject({ reason: "manifest-differs" });
  expect(calls(fx.trace)).toEqual([]);
});

test("runNamedMutants: a wrong installed artifact throws and runs nothing", async () => {
  const fx = await installedFixture({ serverReports: "b".repeat(32) });
  const err = await runNamedMutants({ ...fx.cfg, requests: [{ mutantId: "M0001", methods: [OVER] }] }).catch((e) => e);
  expect(err).toBeInstanceOf(InstalledArtifactError);
  expect((err as InstalledArtifactError).reason).toBe("mismatch");
  const work = calls(fx.trace).filter((c) => {
    const x = c as { call: string; id?: string | null };
    return x.call === "run" || x.call === "runMany" || (x.call === "activate" && x.id !== null);
  });
  expect(work).toEqual([]); // teardown's activate(null) is allowed; any mutant activation or run is not
  expect(rowCount(fx.store, "mutants", fx.cfg.runId)).toBe(0);
  expect(rowCount(fx.store, "test_results", fx.cfg.runId)).toBe(0);
  expect(fx.client.releaseCalls).toBe(1);
});

test("runNamedMutants: a hang quarantines, and every request still gets exactly one outcome", async () => {
  // M0001 killed by OVER; M0002's run: deadline-exceeded + operation "in-flight-unknown"; M0003 never reached.
  const dir = freshTmpDir();
  const fx = await installedFixture({ strand: "M0002" });
  const res = await runNamedMutants({ ...fx.cfg, quarantineDir: dir, resourceServer: "http://cronus281", resourceServerInstance: "BC",
    requests: ["M0001", "M0002", "M0003"].map((mutantId) => ({ mutantId, methods: [OVER] })) });
  expect(res.outcomes.map((o) => [o.mutant.mutantId, o.verdict])).toEqual([["M0001", "killed"], ["M0002", "error"], ["M0003", "error"]]);
  expect(res.outcomes[1]?.cause).toBeDefined();
  expect(res.outcomes[2]?.failureNote).toMatch(/^not run: /);
  expect(res.quarantined).toContain("in-flight-unknown");
  expect(await new QuarantineStore(dir).read("http://cronus281|BC")).not.toBeNull();
});

test("runNamedMutants: a red baseline method is never run against its mutant", async () => {
  const fx = await installedFixture();
  const res = await runNamedMutants({ ...fx.cfg, requests: [
    { mutantId: "M0001", methods: [RED] },
    { mutantId: "M0002", methods: [RED, OVER] },
  ] });
  expect(res.outcomes[0]?.verdict).toBe("error");
  expect(res.outcomes[0]?.failureNote).toContain("boom-red");
  expect(res.outcomes[1]?.coveringTests).toEqual(["<qualifiedTestName of OVER, read at orchestrator.ts:4808>"]);
  // Everything after the FIRST mutant activation is the mutant phase. (r1's selector filtered on
  // `id !== null`, which also kept entries with no `id` at all, including the baseline
  // run(RedAtBaseline) itself, so the assertion was red even on correct code.)
  const tr = calls(fx.trace) as Array<{ call: string; id?: string | null; method?: string; methods?: Array<[string, number]> }>;
  const firstMutant = tr.findIndex((c) => c.call === "activate" && typeof c.id === "string");
  expect(firstMutant).toBeGreaterThan(0);
  const mutantRuns = tr.slice(firstMutant).filter((c) => c.call === "run" || c.call === "runMany");
  expect(mutantRuns.length).toBeGreaterThan(0);
  const named = mutantRuns.flatMap((c) => (c.call === "run" ? [c.method] : (c.methods ?? []).map((m) => m[0])));
  expect(named).not.toContain("RedAtBaseline");
  expect(tr.slice(0, firstMutant).some((c) => c.call === "run" && c.method === "RedAtBaseline")).toBe(true); // it DID run at baseline
  expect(calls(fx.trace)).not.toContainEqual({ call: "activate", tag: "b", id: "M0001" });
});

test("runNamedMutants: inLease without a lease is refused, never run unfenced", async () => {
  const fx = await installedFixture(); // a non-lease-bindable fake, so no lease is required
  let hookRan = false;
  await expect(runNamedMutants({ ...fx.cfg, lease: undefined, inLease: async () => { hookRan = true; },
    requests: [{ mutantId: "M0001", methods: [OVER] }] })).rejects.toBeInstanceOf(NamedMutantError);
  expect(hookRan).toBe(false);
  expect(calls(fx.trace)).toEqual([]);
});

test("runNamedMutants never deploys the target", async () => {
  // the fake's deploy and compileCheck throw; count batch_artifacts and publish_outcomes rows before and after:
  // both unchanged; no event of type batch-published or phase-entered/deploy in the trace
});

test("runNamedMutants: the order is lease, inLease, rebind, attach, baseline, covering, release", async () => {
  // FakeLeaseClient logs into the same trace; inLease calls fence.publish(async () => trace.push({ call: "test-app" }))
  // expect the subsequence: acquire, beginPublish, test-app, endPublish, setLease(lastCompletedOpSeq = the publish op seq),
  // attach, activate null, run OverBudgetDetected, activate M0001, runMany, release
});

test("runNamedMutants: an unattested batch returns error outcomes, never the raw survivors", async () => {
  // mutant runs attest observedAny: false and every mutant survives on the fake;
  // every outcome is "error" with the section G note, res.quarantined is set
});
```

  `rewriteManifestKeepingId` is a three-line test helper: read the JSON, apply the function, write it back. The `coveringTests` string is built with the same format `qualifiedTestName` uses (read it at `orchestrator.ts:4808`), not by importing the private helper.

- [ ] **Step 2: Fail. Step 3: Implement. Step 4: Run** the loop; `bun scripts/generate-schemas.ts` produces no diff; biome on touched files.
- [ ] **Step 5: Red-checks** (red, then restored green):
  - remove the `attach` call: "wrong installed artifact" goes red;
  - call `resolveNamedMutants` after `status()`: "request mistakes" goes red on the trace;
  - skip `loadInstalledArtifact`'s manifest hash: "same-id wrong manifest" goes red;
  - drop the `not run` fill: the hang test goes red;
  - drop `applyBatchInvalidations`: the unattested test goes red;
  - keep red methods in `select`: the red-baseline test goes red;
  - drop `rebindBackend` after `inLease`: the order test goes red on `setLease`;
  - call `inLease` after `attach`: the order test goes red;
  - restore the `?? run()` fallback and drop the refusal: "inLease without a lease" goes red (the hook runs).
- [ ] **Step 6: Commit** `feat(runner): runNamedMutants, a lease-scoped no-deploy verdict primitive (C02-04b)`.

**Part B submit note must say:** every red-check with its red and restored-green line; that the Part A snapshots did not change; that no schema moved and `BatchArtifact` did not change; that nothing in Part B ran against a real server (ruling 3).

## Out of scope, on purpose

- **Only the currently installed artifact can be verified.** Every batch publishes the same app id, so after a multi-batch run only the highest batch is installed (C02-02). Naming an earlier batch is refused by `attach` as `mismatch`; verifying it would need a republish, which is not this primitive.
- **Carried verdicts cannot be verified through their batch's record.** A verdict carried by `--resume` was measured against a PRIOR run's artifact; the record for its batch in the resuming run is a different artifact, or none (C02-01 and C02-02 "Out of scope"). C02-06 must refuse carried rows or resolve their source run; this primitive only takes an explicit `(fromRunId, batchIndex)`.
- **Per-mutant proof that a named guard exists in, and fired in, the running binary.** That is GH-24's per-mutant `ObservedActive` attestation (issue #24). This primitive rests on decision 1's trust assumption until then; C02-06 should consume that attestation when it lands. (Scanning the `.app`'s packaged AL for `MutationSelector.Active('<id>')` is not a substitute: a target may exclude source, and that is unmeasured.)
- **Deriving covering methods, coverage for new tests, workers, the permission canary, `reportPublishedTestApp`, R192 reuse, R231's report lists.** Unchanged.

## Notes for C02-05 and C02-06 (not built here)

- **C02-05** publishes the test app from `inLease`, through `fence.publish(...)`, so the publish holds the lease's operation marker and `runNamedMutants` rebinds the backend's op sequence after it. Publishing outside the fence would leave the backend's counter stale and the first RunMutant refused `lease-invalid`.
- **C02-06: never finish the verify run row.** `priorSurvivorKeys` (`store.ts`) seeds `--skip-known-survivors` from the most recent FINISHED run's `survived` rows; `runNamedMutants` writes rows under `cfg.runId` and deliberately does not finish it. Leave it unfinished or give it a `backend` value `priorSurvivorKeys` excludes, and test which.
- **C02-06** builds `InstalledArtifactRef` from the report's `artifacts[]` for batch selection, but identity comes only from the store record; a `--db` is therefore required.

## Orchestrator rulings (2026-09-25)

1. **The split is accepted.** Coord task `C02-04` is Part A (Tasks 1 to 5) and closes issue #14's refactor half. A new coord task `C02-04b` is Part B (Tasks 6 to 8), depends on `C02-04`, and closes issue #14 when accepted. `C02-06` depends on `C02-04b`. Plan file for both: this one.
2. **R232 stays inside Part A as its own commit** (Task 4), with its own test and red-check. R232 is already filed (900ae4e); Task 4 closes it.
3. **Live probe for Part B** is the owner's call and is asked at Part B's acceptance, with option (b) recommended: after `itest:bcdev`, run `runNamedMutants` on three of its survivors and three of its kills and require every verdict to equal the gate's baseline. The lane does not run it unasked.
4. **Part A's acceptance** waits on the owner running `itest:bcdev`, `itest:tables`, `itest:chunked`, `itest:hang` and `itest:alrunner` on the merged tree, with the figures listed in this plan. A moved figure is a BLOCK.
5. **Decision 1's trust assumption is APPROVED by the owner (2026-09-25, coord question `q-20260925T195840-0432c6fb`).** Part B ships with it stated as written. Per-mutant proof that the named statement ran comes later from GH-24's `guardReached` (plan `2026-09-25-GH-24-active-guard-reach.md`, Decision 8, with its narrower "statement began" wording), which C02-06 consumes when it lands.
