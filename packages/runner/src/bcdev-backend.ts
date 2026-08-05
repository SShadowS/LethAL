import { appendFile, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { MutantManifest } from "@lethal/schemata";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { AppMethodIndex, objectTypeName } from "./app-package";
import { ArtifactPrepareError, DeploymentError } from "./artifact";
import type { ArtifactCompiler, CompileInput, CompiledArtifact } from "./artifact";
import type {
  BackendCapabilities,
  BackendStatus,
  CoverageEntry,
  CoverageMap,
  CoverageMode,
  ExecutionBackend,
  RunOpts,
  TestMethodRef,
  TestVerdict,
} from "./backend";
import { decidePublishOutcome } from "./deployment-verifier";
import type { DeploymentVerifier } from "./deployment-verifier";
import { describeThrown } from "./describe-error";
import { injectControlDependency } from "./harness";
import type { HarnessVerifier } from "./harness";
import type { Lease } from "./lease";
import { type LineMap, buildLineMap } from "./line-map";
import type { AppPublisher } from "./publisher";
import { quarantineResourceKey } from "./resource-key";
import type {
  FencedCoverageRow,
  FencedCoverageStats,
  RunMutantTransport,
} from "./run-mutant-transport";

export interface BcDevConfig {
  readonly mcpCommand: readonly string[]; // e.g. ["bun", "x", "bc-dev-mcp"] — argv to spawn
  readonly project: string; // AL project dir (launch.json defaults source)
  readonly server?: string;
  readonly serverInstance?: string;
  readonly tenant?: string;
  readonly environmentType?: "OnPrem" | "Sandbox" | "Production";
  readonly environmentName?: string;
  readonly company?: string;
  // Extra env vars for the spawned bc-dev-mcp server process (e.g. BC_DEV_USER/BC_DEV_PASSWORD).
  // StdioClientTransport's underlying spawn only inherits a fixed OS-level allowlist
  // (getDefaultEnvironment()) — anything else, including these, must be passed explicitly.
  readonly env?: Record<string, string>;
  // Absolute path to the compiled `lethal-control.app` — staged into `packageCachePath` by
  // `stageForCompile` (Task 8) so a private compile copy of the target can resolve its
  // delegating selector's `Codeunit "LC Control State"` reference (schemata/selector.ts).
  readonly controlSymbolPath: string;
  /**
   * R53 (`--stop-hung-sessions`), opt-in. When set, a RunMutant that exceeds its budget is HELD
   * OPEN while `StopHungRun` is issued on a second connection, so BC's 408 can make the run
   * scoreable instead of quarantining the tier. See `SessionConfig.stopHungSessions` for why this
   * is opt-in rather than default.
   */
  readonly stopHungSessions?: boolean;
  // The `ArtifactCompiler`'s own package-cache directory (mirrors
  // `ArtifactCompilerConfig.packageCachePath`, fixed at compiler construction) — `deploy()`/
  // `compileCheck()` need this SEPARATELY so `stageForCompile` can stage the control symbol
  // into the exact cache alc reads from via `/packagecachepath:`.
  readonly packageCachePath: string;
  /**
   * Coverage the backend claims. **Default `"fenced"` (R58 rollout, spec step 5):** per-procedure
   * coverage collected on the SAME fenced session the mutants run on, via
   * `RunMutantWithCoverage` — so the green set and the verdicts come from ONE session type, and
   * the dual-runner asymmetry (R55: 12 of 56 Continia Document Output tests fail on the hub and
   * pass on the fence, each taking its coverage out of the green set with it, for a measured 14
   * mutants wrongly reported `no-coverage`) no longer exists on the default path. It is also the
   * only mode that can name LOCAL procedures (the line map resolves by position; the hub's
   * SymbolReference route structurally cannot — R63), and the only mode that works where
   * bc-dev-mcp's SignalR hub cannot reach (path-routed portals — measured).
   *
   * `"procedure"` (legacy hub) remains for one release and is then DELETED (spec decision 2:
   * the hub measures a different session type, so keeping it as a "cross-check" is a
   * permanently red-noisy R55-shaped misdiagnosis invitation). `"none"` runs every mutant
   * against all green tests — slower, never wrong. Per-mutant execution is `coverage: "none"`
   * through the fenced transport in ALL modes, so this changes baseline routing and selection
   * only. The default flip is gated on the differential in
   * `docs/superpowers/specs/2026-07-28-fenced-coverage-design.md` — PASSED 2026-07-28, including
   * the 77-mutant discrimination (R63).
   */
  readonly coverageMode?: "procedure" | "none" | "fenced";
  /**
   * Explicit dev-endpoint port, passed through verbatim to bc-dev-mcp as `port`. Required whenever
   * the server has no port of its own AND the environment does not listen on bc-dev-mcp's OnPrem
   * fallback (7049) — a path-routed HTTPS portal (Continia's `demoportaldev.continiaonline.com`)
   * is exactly that case (see the corrected "Probe result" section of this plan). The WHATWG URL
   * API normalizes away a default port (`new URL("https://host:443").port === ""`), so embedding
   * `:443` inside `server` does nothing — only this field reaches bc-dev-mcp's own override
   * (`bc-dev-mcp/src/core/urls.ts:12`: `c.port ?? (u.port ? Number(u.port) : DEFAULT_DEV_PORT)`).
   */
  readonly port?: number;
}

/**
 * The mode a session takes when config does not say. `"fenced"` since the R58 rollout (spec
 * step 5); `"procedure"` survives one release for escape-hatch purposes and is then deleted.
 * A single constant because the previous flip (to `"procedure"` by default) lived as three
 * separate `?? "procedure"` literals that had to move in lockstep.
 */
export const DEFAULT_COVERAGE_MODE: CoverageMode = "fenced";

// Verified against a real BC server (2026-07-18) via bc-dev-mcp source
// (packages test-tools.ts's runTestsOutputSchema / test-runner-hub.ts's RunTestsResult) and a
/**
 * R31: the server was asked to run a specific method and returned no result for it, which means
 * the PUBLISHED test app does not contain that method — the source declares a test the server has
 * never seen.
 *
 * Exported because `runSession` aggregates these into a stale-test-app diagnosis, and a detector
 * matching a string literal the producer might later reword is a silent regression: the diagnosis
 * would simply stop firing, and the symptom it explains (red baseline, dozens of no-coverage
 * mutants) reads as a mutation-scoring problem instead.
 */
export const NO_RESULT_FOR_METHOD = "bcdev_test_run returned no result for the requested method";

// direct bcdev_test_run call: the actual payload nests `status`
// ("passed"|"failed"|"skipped", not "outcome": "pass"|"fail"|"skip") and `output` (combined
// failure message + AL callstack, not `failureMessage`) per result, and coverage is a
// SEPARATE top-level array — one entry per *test* method run (keyed by `testObjectId` /
// `testMethodId`), not nested under each result — listing the procedures IT covered.
interface WireTestMethodResult {
  codeunitId: number;
  method: string;
  status: "passed" | "failed" | "skipped";
  durationMs: number;
  output: string;
}

interface WireCoveredProcedure {
  objectType: number;
  objectId: number;
  methodId: number;
  file?: string;
}

interface WireCoverageEntry {
  testObjectId: number;
  testMethodId: number;
  coveredProcedures: WireCoveredProcedure[];
}

interface TestRunPayload {
  results: WireTestMethodResult[];
  coverage?: WireCoverageEntry[];
  runAborted?: boolean;
  abortReason?: string;
}

const WIRE_STATUS_TO_OUTCOME = {
  passed: "pass",
  failed: "fail",
  skipped: "skip",
} as const;

/**
 * Everything `deploy()` needs to turn an instrumented dir into a verified deployment. All
 * four are required together: identity verification is mandatory ADDITIONAL evidence (see
 * deployment-verifier.ts) — a backend that could compile and publish but not verify would
 * make every deploy `indeterminate` by construction, so the type forbids configuring one.
 * `harnessVerifier` is scoped here (rather than a trailing constructor param) for the same
 * reason: it is only ever needed by a session that actually calls `deploy()`, so a backend
 * built without a `BcDevDeployment` (e.g. a script driving compile/publish/verify directly,
 * or activation/run only — see stale-publish.itest.ts) needs no harness verifier either.
 */
export interface BcDevDeployment {
  readonly compiler: ArtifactCompiler;
  readonly deployer: AppPublisher;
  readonly verifier: DeploymentVerifier;
  readonly harnessVerifier: HarnessVerifier;
}

/**
 * A publish attempt that demonstrably failed: `deployment.deployer.publish()` threw AND identity
 * verification found nothing to redeem it (`decidePublishOutcome`'s `"failed"` outcome — see
 * deploy() below). Deliberately NOT `DeploymentError` (CLAUDE.md's typed-error separation rule:
 * extend `Error` directly, never another typed error) — `anomalous`/`indeterminate` outcomes are
 * an IDENTITY puzzle (the deployer reports one thing, verification reports another) and stay
 * `DeploymentError`; this is reserved for the one case where the publish call itself is the
 * demonstrated cause.
 *
 * **What this actually reaches** (anything that makes `deployment.deployer.publish()` THROW): a
 * non-zero `altool publishapp` exit (`ContainerDeployer`), a spawn failure on either publisher,
 * and `EnvToolClient`'s OWN `envTool.timeoutSeconds` budget expiring. It does NOT reach, and by
 * construction CANNOT reach, R90's actually-measured reproduction: an external publish tool
 * (`continia publish`) that EXITS 0 while its JSON body reports `{success: false, ...}`.
 * `env-tool.ts` has no `success`-field handling today, so that shape resolves as `publishOk ===
 * true` followed by a verification mismatch — `decidePublishOutcome`'s `"indeterminate"`, not
 * `"failed"` — so `DeploymentError` is thrown there instead, not this class. Closing that gap is
 * a separate, filed concern (env-tool.ts), out of scope here.
 *
 * `guardCount`/`file` name WHAT was too big to publish, `tier` names WHERE (so one container's
 * measured ceiling is never confused with another's), and `detail` is the raw diagnosis. R90's
 * per-tier publish ceiling (Task 3) can learn from these for the failure modes above.
 *
 * R65: the message is guaranteed non-empty NO MATTER WHAT the caller passes — a Bun spawn
 * failure can arrive with an EMPTY `.message`, and reporting that empty string here would
 * reproduce the exact defect this class exists to close. The guarantee lives in the constructor
 * itself, not at the call site, so it holds even against a future caller that forgets
 * `describeThrown`.
 */
export class PublishFailedError extends Error {
  readonly guardCount: number;
  readonly file: string | undefined;
  readonly tier: string;
  readonly detail: string;

  constructor(
    message: string,
    info: {
      readonly guardCount: number;
      readonly file: string | undefined;
      readonly tier: string;
      readonly detail: string;
    },
  ) {
    const trimmed = message.trim();
    super(trimmed.length > 0 ? trimmed : "publish failed with no detail");
    this.guardCount = info.guardCount;
    this.file = info.file;
    this.tier = info.tier;
    this.detail = info.detail;
  }
}

export class BcDevMcpBackend implements ExecutionBackend {
  private client: Client | undefined;
  // Populated by deploy() from the just-compiled .app so run() can resolve coverage
  // methodIds to procedure names — see app-package.ts for why this needs the compiled
  // artifact (and the source tree) rather than being derivable from the wire payload alone.
  private methodIndex: AppMethodIndex | undefined;
  // R58 (`coverageMode: "fenced"` only): line -> procedure for THIS batch's artifact, built in
  // deploy() from the same instrumented source alc compiled and scoped by that compiled package's
  // own SymbolReference.json. Left undefined in every other mode — nothing builds it and nothing
  // reads it.
  private lineMap: LineMap | undefined;
  // R58 (`coverageMode: "fenced"` only): the `SetFilter` expression over `Code Coverage."Object ID"`
  // this batch's artifact declares — see `coverageObjectIdFilterOf`.
  private coverageObjectIdFilter: string | undefined;
  // Layer 5C-A: activate() is bookkeeping — it records the intended mutant here, and run()
  // (coverage: "none") passes it to a single RunMutant OData call that activates+runs+clears
  // server-side. The transport is built at deploy() once the target's identity is known.
  private pendingMutantId: string | null = null;
  private runMutantTransport: RunMutantTransport | undefined;
  // Monotonic per-backend attempt id, echoed by RunMutant and validated by the transport (§I5).
  private attemptSeq = 0;
  // Layer 5C-B1: the machine-global lease this session holds, bound by the orchestrator (Task 8)
  // via setLease() — see that method's doc comment for why setLease, not the constructor.
  private sessionLease: Lease | undefined;
  // Seeded from sessionLease.lastCompletedOpSeq by setLease() (design §5: the server accepts
  // only opSeq = lastCompletedOpSeq + 1), then incremented once per RunMutant call issued —
  // mirrors attemptSeq's simple monotonic-increment shape. This is a per-call counter only: it
  // does NOT resync against the server's actual lastCompletedOpSeq after a failed/refused call
  // (that reconciliation, via getOperationStatus, is Task 8's job), so a caller that retries a
  // refused call must account for the counter having already moved on.
  private nextOpSeq = 0;

  constructor(
    private readonly cfg: BcDevConfig,
    private readonly transportFactory?: (env: Record<string, string>) => Transport,
    private readonly deployment?: BcDevDeployment,
    private readonly runMutantTransportFactory?: (
      targetAppId: string,
      artifactId: string,
    ) => RunMutantTransport,
  ) {}

  capabilities(): BackendCapabilities {
    return {
      coverage: this.cfg.coverageMode ?? DEFAULT_COVERAGE_MODE,
      deploy: "publish",
      isolation: "session",
      authoritative: true,
    };
  }

  private async connect(): Promise<Client> {
    if (this.client) return this.client;
    // StdioClientTransport defaults to a fixed OS-level allowlist (getDefaultEnvironment())
    // when no `env` is given, silently dropping BC_DEV_USER/BC_DEV_PASSWORD and anything
    // else the spawned bc-dev-mcp server needs — merge cfg.env over that default explicitly.
    const env = { ...getDefaultEnvironment(), ...this.cfg.env };
    const transport = this.transportFactory
      ? this.transportFactory(env)
      : new StdioClientTransport({
          command: this.cfg.mcpCommand[0] ?? "",
          args: [...this.cfg.mcpCommand.slice(1)],
          env,
        });
    const client = new Client({ name: "lethal-runner", version: "0.0.0" });
    await client.connect(transport);
    this.client = client;
    return client;
  }

  /**
   * Shut down the MCP client and the bc-dev server child process it spawned.
   *
   * Required, not optional hygiene: `connect()` keeps a long-lived
   * `StdioClientTransport`, and its child process holds the event loop open, so
   * a caller that finishes a session without calling this never exits. That is
   * exactly how the bcdev itest came to hang for 20 minutes after its
   * assertions had already passed — `cli.ts` only appeared unaffected because
   * it calls `process.exit()`, which masks the leak rather than fixing it.
   *
   * Safe to call more than once, and safe to call when never connected.
   */
  async close(): Promise<void> {
    const client = this.client;
    if (!client) return;
    this.client = undefined;
    await client.close();
  }

  private connectionParams(): Record<string, unknown> {
    const {
      project,
      server,
      serverInstance,
      tenant,
      environmentType,
      environmentName,
      company,
      port,
    } = this.cfg;
    return Object.fromEntries(
      Object.entries({
        project,
        server,
        serverInstance,
        tenant,
        environmentType,
        environmentName,
        company,
        port,
      }).filter(([, v]) => v !== undefined),
    );
  }

  async status(): Promise<BackendStatus> {
    // In "none" AND "fenced" mode nothing in this session ever calls bc-dev-mcp — baseline and
    // mutant runs both go through RunMutantTransport, and discovery is static from source. Probing
    // it here would fail the session's readiness gate (orchestrator.ts) for a capability it does not
    // use, so the readiness question becomes "does the control app answer", which is the thing that
    // matters.
    //
    // The predicate is `!== "procedure"`, not `=== "none"`: written the other way (which it was),
    // `"fenced"` fell through and probed bc-dev-mcp — the exact dependency the mode exists to
    // remove, and a silent one, since the probe succeeds in every environment where the hub works
    // and the mode would look fine until it met one where it does not.
    const mode = this.cfg.coverageMode ?? DEFAULT_COVERAGE_MODE;
    if (mode !== "procedure") {
      const harnessVerifier = this.deployment?.harnessVerifier;
      if (harnessVerifier === undefined) {
        const why = "requires a harnessVerifier in BcDevDeployment — it is the readiness probe";
        throw new Error(`BcDevMcpBackend: coverageMode "${mode}" ${why} in that mode`);
      }
      try {
        const details = await harnessVerifier.verify();
        return { ok: true, details: `harness generation ${details.serverGeneration}` };
      } catch (err) {
        return { ok: false, details: err instanceof Error ? err.message : String(err) };
      }
    }
    try {
      const client = await this.connect();
      const res = await client.callTool({
        name: "bcdev_status",
        arguments: this.connectionParams(),
      });
      // Same protocol quirk as run(): a thrown tool handler surfaces as a normal
      // (non-rejecting) CallToolResult with isError:true, not a rejected callTool().
      if (isToolError(res)) {
        return { ok: false, details: firstText(res) };
      }
      const text = firstText(res);
      return { ok: true, details: text };
    } catch (err) {
      return { ok: false, details: String(err) };
    }
  }

  /**
   * Reads the compile inputs `prepareArtifactDir`/`prepareBatchProject` (orchestrator.ts)
   * wrote into the instrumented dir: app.json supplies appId/appVersion/appManifest, and
   * mutant-manifest.json supplies the mutant manifest plus the artifact's identity. Anything
   * missing or malformed is an `ArtifactPrepareError` — never a compile verdict.
   */
  private async prepareCompileInput(instrumentedDir: string): Promise<CompileInput> {
    const appJsonPath = join(instrumentedDir, "app.json");
    let appManifest: Record<string, unknown>;
    try {
      appManifest = JSON.parse(await readFile(appJsonPath, "utf8")) as Record<string, unknown>;
    } catch (err) {
      throw new ArtifactPrepareError(
        `cannot read ${appJsonPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const appId = appManifest.id;
    const appVersion = appManifest.version;
    if (typeof appId !== "string" || typeof appVersion !== "string") {
      throw new ArtifactPrepareError(
        `${appJsonPath} must carry string "id" and "version" fields ` +
          `(got id=${JSON.stringify(appId)}, version=${JSON.stringify(appVersion)})`,
      );
    }
    const manifestPath = join(instrumentedDir, "mutant-manifest.json");
    let mutantManifest: MutantManifest;
    try {
      mutantManifest = JSON.parse(await readFile(manifestPath, "utf8")) as MutantManifest;
    } catch (err) {
      throw new ArtifactPrepareError(
        `cannot read ${manifestPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (typeof mutantManifest.artifactId !== "string") {
      throw new ArtifactPrepareError(`${manifestPath} has no string "artifactId" field`);
    }
    return {
      projectDir: instrumentedDir,
      artifactId: mutantManifest.artifactId,
      appId,
      appVersion,
      mutantManifest,
      appManifest,
    };
  }

  /**
   * Builds a private, compile-only staging copy of `instrumentedDir` with the LethAL Control
   * dependency injected into its `app.json` and `lethal-control.app` staged into the compiler's
   * package cache. The instrumented target's delegating selector always references `Codeunit
   * "LC Control State"` (schemata/selector.ts) and cannot compile without both — bcdev-ONLY:
   * `instrumentedDir` itself is NEVER touched. AlRunnerBackend reads that same shared dir
   * directly (it strips the control-registration codeunits instead) and must stay
   * dependency-free, so the injection must land only on this throwaway sibling copy.
   *
   * Idempotent: re-staging the same `instrumentedDir` wipes and rebuilds the sibling (Windows
   * retry knobs mirror AlRunnerBackend's own `rm` of `activeDir` — a stale copy can be locked by
   * an indexer/AV a moment after the previous compile).
   */
  private async stageForCompile(instrumentedDir: string): Promise<string> {
    const staging = `${instrumentedDir}-staged`;
    await rm(staging, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    await cp(instrumentedDir, staging, { recursive: true });
    // Inject the dependency into the STAGED app.json only (never the shared instrumented dir).
    const appJsonPath = join(staging, "app.json");
    const app = JSON.parse(await readFile(appJsonPath, "utf8")) as Record<string, unknown>;
    await writeFile(
      appJsonPath,
      `${JSON.stringify(injectControlDependency(app), null, 2)}\n`,
      "utf8",
    );
    // Stage the control symbol into the compiler's package cache (safe to share: al-runner's
    // compiled source carries no LC Control State reference, so an unused symbol is harmless).
    await mkdir(this.cfg.packageCachePath, { recursive: true });
    await cp(this.cfg.controlSymbolPath, join(this.cfg.packageCachePath, "lethal-control.app"));
    return staging;
  }

  async deploy(instrumentedDir: string): Promise<CompiledArtifact> {
    const deployment = this.deployment;
    if (!deployment) throw new Error("BcDevMcpBackend: no compiler/deployer/verifier configured");
    // Verify the LethAL Control harness (identity + protocol + isolation/test-type compat) BEFORE
    // compiling or publishing the target — the target depends on it and every RunMutant call routes
    // through it, so a missing/incompatible harness must fail the session loudly, not surface later
    // as a corrupt verdict (spec §8). Cheap OData round-trip; harmless to repeat per batch. Required
    // and unconditional — a backend configured to deploy() always has a `harnessVerifier` (see
    // `BcDevDeployment`'s doc comment), so there is no "skip if absent" branch anymore.
    await deployment.harnessVerifier.verify();
    const staged = await this.stageForCompile(instrumentedDir);
    let artifact: CompiledArtifact;
    try {
      artifact = await deployment.compiler.compile(await this.prepareCompileInput(staged));
    } finally {
      // Reclaim the staged copy — each batch has a distinct batchDir, so `${batchDir}-staged`
      // would otherwise accumulate one full instrumented-project copy per batch (the `rm` at
      // the top of stageForCompile only overwrites a re-staged SAME name, never a prior batch's
      // differently-named one). Nothing reads `staged` again after this point: methodIndex
      // reads `artifact.appPath` (the compiled .app in outputDir). Best-effort, same idiom as
      // compileCheck()'s own cleanup — a compile already decided the outcome by here, so a
      // stray cleanup failure must never mask it.
      await rm(staged, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(
        () => {},
      );
    }
    // Must happen before publish(): resolves this batch's coverage methodIds ahead of any
    // run() call, from the exact artifact that produced them.
    this.methodIndex = await AppMethodIndex.fromAppFile(artifact.appPath);
    // R58: same timing and the same two inputs as the hub's own indexes — the artifact that was
    // just compiled, and the source it was compiled from — because a line number only means
    // anything in the frame of the bytes that were published. `instrumentedDir`, not `staged`:
    // `staged` differs from it only in `app.json` (the control dependency injection) and has
    // already been deleted above.
    if ((this.cfg.coverageMode ?? DEFAULT_COVERAGE_MODE) === "fenced") {
      this.lineMap = await buildLineMap(instrumentedDir, this.methodIndex.declaredObjects());
      this.coverageObjectIdFilter = await coverageObjectIdFilterOf(instrumentedDir);
    } else {
      this.lineMap = undefined;
      this.coverageObjectIdFilter = undefined;
    }

    let publishOk = true;
    let publishError: string | undefined;
    try {
      await deployment.deployer.publish(artifact);
    } catch (err) {
      publishOk = false;
      // R65: `err instanceof Error ? err.message : String(err)` is the idiom that let a Bun
      // spawn ENOENT arrive with an EMPTY message and surface as a bare, textless failure —
      // `describeThrown` is guaranteed non-empty and carries the errno fields when there is no
      // message at all.
      publishError = describeThrown(err);
    }
    // Verification runs whether or not publish succeeded: decidePublishOutcome needs it to
    // tell a plain `failed` publish apart from an `anomalous` one (publish failed yet the
    // server claims to run our artifact — a deployment we cannot explain).
    const verification = await deployment.verifier.verify(artifact);
    const outcome = decidePublishOutcome(publishOk, verification);
    if (outcome === "failed") {
      // A demonstrated publish failure, not merely an identity puzzle — PublishFailedError
      // (never DeploymentError, see its doc comment), so Task 3's per-tier publish ceiling
      // (R90) can catch it specifically and learn from guardCount/file/tier.
      const detail = publishError ?? "publish failed with no detail";
      throw new PublishFailedError(detail, {
        guardCount: artifact.mutantManifest.mutants.length,
        file: soleFileOf(artifact.mutantManifest),
        tier: tierIdentityOf(this.cfg),
        detail,
      });
    }
    if (outcome !== "accepted") {
      throw new DeploymentError(outcome, publishError, verification);
    }
    // The deployment is confirmed — bind a RunMutant transport to THIS artifact's identity so
    // run() (coverage: "none") executes each mutant against the exact target/artifact just
    // published. The transport echoes and validates this identity tuple on every call (§I5).
    this.runMutantTransport = this.runMutantTransportFactory?.(artifact.appId, artifact.artifactId);
    return artifact;
  }

  /**
   * Bisection's compile-only seam (Task 7b, spec §8/§10): compile the candidate and throw on a
   * compiler rejection, exactly like `deploy()`'s prepare+compile phase — but stop there. No
   * publish, no verify, no `recordArtifact`, and critically no `this.methodIndex`
   * assignment: it describes the REAL artifact's coverage index, and a bisection candidate
   * (a narrowed, possibly-malformed subset) must never clobber it out from under an
   * in-flight `run()`.
   *
   * The compiled `.app` this writes is never published or consumed by anything — deleted
   * immediately so repeated candidate compiles across a bisection search don't accumulate
   * unboundedly in the compiler's `outputDir` (spec: candidate artifacts must not pile up across
   * a session). `force: true` because a compile that never reached the write step (e.g. rejected
   * before `alc` produced output) leaves nothing to delete. The cleanup itself is best-effort
   * (`.catch(() => {})`): a compile already succeeded by the time this runs, so a stray cleanup
   * failure (e.g. a transient Windows file lock) must never mask that real, already-decided
   * compile result behind an unrelated fs error — worst case a candidate `.app` lingers in
   * `outputDir` instead of the search itself failing.
   *
   * Also stages the LethAL Control dependency+symbol (same `stageForCompile` as `deploy()`):
   * a bisection candidate is built by the exact same `writeInstrumentedProject`
   * (schemata/project.ts) as any other instrumented dir, so it carries the identical delegating
   * selector referencing `Codeunit "LC Control State"` and cannot compile without them either.
   * The staged sibling copy is removed here too (`finally`, best-effort) — bisection candidates
   * must not accumulate on disk across a search, and unlike `outputDir`'s `.app` files this
   * staging copy lives outside any dir the caller already cleans up.
   */
  async compileCheck(instrumentedDir: string): Promise<void> {
    const deployment = this.deployment;
    if (!deployment) throw new Error("BcDevMcpBackend: no compiler/deployer/verifier configured");
    const staged = await this.stageForCompile(instrumentedDir);
    try {
      const artifact = await deployment.compiler.compile(await this.prepareCompileInput(staged));
      await rm(artifact.appPath, { force: true }).catch(() => {});
    } finally {
      await rm(staged, { recursive: true, force: true }).catch(() => {});
    }
  }

  async activate(mutantId: string | null): Promise<void> {
    // Bookkeeping only (Layer 5C-A): RunMutant folds activate + run-one-method + clear into a
    // single OData call, so there is NO persistent server-side active state to set here. Record
    // the intended mutant (null = baseline); run() passes it to RunMutant. Never a network call,
    // never throws — all failure classification moved to run() (spec §7). The orchestrator's
    // activate(mutant) -> run -> activate(null) -> confirm dance still works: each activate()
    // just changes which mutant the NEXT run() sends, and RunMutant clears after itself.
    this.pendingMutantId = mutantId;
  }

  /**
   * Binds the machine-global lease this session holds (Layer 5C-B1, design §5/§6) — the
   * orchestrator (Task 8) calls this once, after `LeaseClient.acquire()` grants a lease and
   * before the first `run(coverage:"none")` (a setter rather than a constructor param: the
   * backend is constructed before the lease exists — acquisition happens per-session, at
   * `runSession` start, while the backend itself may outlive one lease across retries).
   *
   * Seeds the local op-seq counter from `lease.lastCompletedOpSeq` — the exact value the server
   * returned in the acquire grant — so the FIRST `run(coverage:"none")` sends the correct
   * `lastCompletedOpSeq + 1` (design §5). Overwrites any previous lease/counter: a re-acquired
   * lease (e.g. after a renew-based recovery) always restarts the op-seq sequence from ITS OWN
   * `lastCompletedOpSeq`, never carries over the prior lease's counter.
   */
  setLease(lease: Lease): void {
    this.sessionLease = lease;
    this.nextOpSeq = lease.lastCompletedOpSeq + 1;
  }

  /**
   * One test run, ROUTED BY MODE — and the routing is the whole point of this method.
   *
   * `"procedure"`/`"line"` are hub modes: coverage discovery goes to bc-dev-mcp (`bcdev_test_run`,
   * one method per call — spec §10). Everything else goes through the self-contained RunMutant
   * OData call (activate + run one method + clear), which is 5B-classified and identity-validated
   * by `RunMutantTransport`: `"none"` without coverage, `"fenced"` (R58) with it.
   *
   * The predicate enumerates the HUB modes rather than testing `!== "none"`, which is what it used
   * to do. That older form sends a fenced baseline — which requests coverage — straight to the hub,
   * i.e. `coverageMode: "fenced"` would have quietly gone on measuring the green set on exactly the
   * session it exists to stop using, and every gate would still have passed.
   */
  async run(ref: TestMethodRef, opts: RunOpts): Promise<TestVerdict> {
    if (opts.coverage === "procedure" || opts.coverage === "line") return this.runOnHub(ref, opts);
    return this.runViaTransport(ref, opts);
  }

  private async runViaTransport(ref: TestMethodRef, opts: RunOpts): Promise<TestVerdict> {
    const transport = this.runMutantTransport;
    if (!transport) {
      throw new Error(
        "BcDevMcpBackend: RunMutant transport not configured — deploy() must run (and succeed) first",
      );
    }
    const lease = this.sessionLease;
    if (!lease) {
      throw new Error(
        'BcDevMcpBackend: no lease bound — the orchestrator must call setLease() (Layer 5C-B1) before run(coverage:"none")',
      );
    }
    const collectCoverage = opts.coverage === "fenced";
    // Stated rather than assumed (spec §Error handling). A fenced-coverage run is BY CONSTRUCTION a
    // baseline run — only the baseline passes `caps.coverage` through, every mutant run passes
    // `"none"` — and the request below sends `this.pendingMutantId ?? ""`. A stale pending id would
    // therefore run the ENTIRE baseline against a mutant, producing a green set measured on mutated
    // code: not a crash, not an error verdict, just a wrong answer with full confidence.
    if (collectCoverage && this.pendingMutantId !== null) {
      const why =
        "the orchestrator must activate(null) first, or the whole baseline " +
        "would be measured against that mutant";
      throw new Error(
        `BcDevMcpBackend: a fenced-coverage run is a BASELINE run, but mutant ${this.pendingMutantId} is still pending — ${why}`,
      );
    }
    this.attemptSeq += 1;
    const opSeq = this.nextOpSeq;
    this.nextOpSeq += 1;
    const attemptId = `a${this.attemptSeq}`;
    const req = {
      ref,
      mutantId: this.pendingMutantId ?? "",
      attemptId,
      timeoutMs: opts.timeoutMs,
      lease: {
        epoch: lease.epoch,
        token: lease.token,
        serverGeneration: lease.serverGeneration,
        opSeq,
      },
      ...(this.coverageObjectIdFilter !== undefined
        ? { coverageObjectIdFilter: this.coverageObjectIdFilter }
        : {}),
      // R53: wired ONLY for a mutant run. A BASELINE run (mutantId "") that overruns is not a
      // hanging mutant — there is no mutation active to blame — so stopping its session would end
      // a healthy run and score nothing. The hook's absence keeps that path byte-for-byte as it was.
      ...(this.cfg.stopHungSessions === true && (this.pendingMutantId ?? "") !== ""
        ? {
            onBudgetExceeded: async (): Promise<void> => {
              const stop = await transport.stopHungRun({
                // Captured at request-build time, not re-read here: `attemptSeq` advances per
                // call and this closure fires on a TIMER, after the request was built. Equal
                // today under sequential execution, but a late read could name a different
                // attempt than the request the hook belongs to.
                attemptId,
                lease: {
                  epoch: lease.epoch,
                  token: lease.token,
                  serverGeneration: lease.serverGeneration,
                  opSeq,
                },
              });
              // A REFUSAL IS AN ANSWER. Discarding it produced a wrong diagnosis: the quarantine
              // note read "BC never answered this request with its stop confirmation" when BC had
              // answered and named the reason (`no-session-id` for a marker written before the
              // field existed, `already-completed` for a lost-ack-after-success). Throwing carries
              // it through `stopHookError` into the "stop was attempted and FAILED (…)" message.
              if (!stop.stopped) {
                throw new Error(
                  `StopHungRun refused: ${stop.reason ?? "no reason given"} (attempt ${attemptId}, opSeq ${opSeq})`,
                );
              }
            },
          }
        : {}),
    } as const;
    if (!collectCoverage) return transport.run(req);
    const { verdict, coverageRows, coverageStats } = await transport.runWithCoverage(req);
    if (coverageRows === undefined) return verdict; // non-`ran`: a refusal carries no coverage
    await dumpFencedCoverage(ref, coverageRows, coverageStats);
    return { ...verdict, coverage: this.buildFencedCoverageMap(coverageRows, ref, coverageStats) };
  }

  /**
   * Collapses BC's LINE rows into the same `CoverageMap` shape the hub path produces (spec
   * decision 3: no per-statement attribution now — but the raw rows stay available on the
   * transport's result for the first time a line lands in no known range on a real project).
   *
   * Three rules, each chosen to fail toward "say less" rather than "guess" — a line attributed to
   * the WRONG procedure yields a confident, non-empty, wrong covering set, which is the R29 failure
   * that made 10 of 20 fixture survivors false:
   *
   *  1. A row for an object the artifact does not declare is SKIPPED, not an error and not an
   *     entry. `CoverageArray` serializes the entire `Code Coverage` table — Base App, System App,
   *     Test Runner, the test app, Continia Core, LethAL's own control codeunits — so most rows are
   *     legitimately not ours. (The hub path skips them for the same reason and says so:
   *     `AppMethodIndex.lookup` is "undefined when the object isn't in this app's own symbol
   *     reference — callers should skip it.") Emitting them at object level instead would be
   *     harmless downstream and would bloat every baseline verdict with hundreds of rows.
   *  2. A row for a DECLARED object whose line falls in no procedure range — BC's line-0
   *     object-level row, a trigger body, a var section, a blank line — emits an OBJECT-level
   *     entry with no `procedure`. Never `""` (that key collides with a trigger mutant's own
   *     `byMember` key) and never dropped: dropping it is precisely what made table triggers false
   *     survivors.
   *  3. A declared object with no line map at all THROWS, from `LineMap.lookup`. Its source is
   *     source LethAL itself wrote and compiled.
   *
   * Deduplicated, because a covered procedure produces one row per executed LINE and the same
   * `(object, procedure)` pair carries no more information the tenth time.
   */
  private buildFencedCoverageMap(
    rows: readonly FencedCoverageRow[],
    ref: TestMethodRef,
    stats?: FencedCoverageStats,
  ): CoverageMap {
    const lineMap = this.lineMap;
    if (lineMap === undefined) {
      throw new Error(
        "BcDevMcpBackend: no line map — deploy() must run (and succeed) before a fenced-coverage run",
      );
    }
    const entries: CoverageEntry[] = [];
    const seen = new Set<string>();
    let declaredRows = 0;
    let memberEntries = 0;
    for (const row of rows) {
      const objectType = objectTypeName(row.objectType);
      if (!lineMap.declares(objectType, row.objectId)) continue; // rule 1
      declaredRows += 1;
      const procedure = lineMap.lookup(objectType, row.objectId, row.lineNo);
      const key = `${objectType}:${row.objectId}:${procedure ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (procedure !== undefined) memberEntries += 1;
      entries.push({
        objectType,
        objectId: row.objectId,
        ...(procedure !== undefined ? { procedure } : {}),
      });
    }
    this.warnOnThinFencedCoverage(ref, rows.length, declaredRows, memberEntries, stats);
    return { granularity: "procedure", entries };
  }

  /**
   * Names the two ways fenced coverage can come back USELESS while every layer reports success.
   *
   * Both produce a non-empty, well-formed `CoverageMap` that simply attributes nothing, so their
   * only downstream symptom is mutants landing `no-coverage` — which reads as "the test suite does
   * not cover this code", the most reassuring possible misreading. Measured on Continia Document
   * Output: the fenced baseline was 56/56 GREEN and still attributed just 2 procedures where the
   * hub attributed 13, i.e. 92 mutants reported `no-coverage` against the hub's 15. Nothing in the
   * verdicts, the counts or the exit code said anything was wrong.
   *
   * The two cases are distinguished on purpose, because they have opposite causes:
   *
   * - **rows arrived, but NONE for an object this artifact declares** — the server-side
   *   `coverageObjectIdFilter` and the artifact's real object ids disagree, or the platform simply
   *   did not record the target. Nothing about the line map is involved.
   * - **rows for declared objects arrived, but no line resolved to a member** — the line map is the
   *   suspect: a wrong base line shifts every range off its procedure, and the observations then
   *   degrade to object level rather than naming anything.
   *
   * Reported per test rather than aggregated: the point is to name WHICH test, and a fenced
   * baseline is tens of tests, not thousands. Silent when coverage looks healthy.
   */
  private warnOnThinFencedCoverage(
    ref: TestMethodRef,
    totalRows: number,
    declaredRows: number,
    memberEntries: number,
    stats?: FencedCoverageStats,
  ): void {
    if (totalRows === 0 || memberEntries > 0) return;
    const server =
      stats !== undefined
        ? ` (server scanned ${stats.scannedRows}, emitted ${stats.emittedRows} row(s) in ${stats.serializeMs} ms; the run itself took ${stats.runMs} ms)`
        : "";
    const where = `${ref.codeunitName}.${ref.method}`;
    const consequence = "Every mutant covered only by this test will be reported no-coverage.";
    if (declaredRows === 0) {
      const blame =
        "Suspect the object-id filter or the artifact's declared ids — not the line map, " +
        "which was never consulted.";
      console.warn(
        `[lethal] fenced coverage for ${where}: ${totalRows} row(s) came back, NONE of them for an object this artifact declares${server}. ${consequence} ${blame}`,
      );
      return;
    }
    const blame =
      "Suspect the line map's base-line frame — a shifted range degrades every observation " +
      "to object level instead of naming a member.";
    console.warn(
      `[lethal] fenced coverage for ${where}: ${declaredRows} row(s) for objects this artifact declares, but NOT ONE line fell inside a known procedure${server}. ${consequence} ${blame}`,
    );
  }

  private async runOnHub(ref: TestMethodRef, opts: RunOpts): Promise<TestVerdict> {
    const started = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;

    // Phase 1 — connect. A failure here provably never dispatched a test run.
    let client: Client;
    try {
      client = await this.connect();
    } catch (err) {
      return {
        ref,
        outcome: "error",
        durationMs: Date.now() - started,
        failureMessage: String(err),
        operation: "pre-dispatch-rejected",
      };
    }

    // Phase 2 — dispatch. From the moment callTool is issued, a failure is ambiguous:
    // the run may already be executing server-side.
    try {
      const call = client.callTool({
        name: "bcdev_test_run",
        arguments: {
          codeunits: [{ id: ref.codeunitId, methods: [ref.method] }],
          coverage: opts.coverage,
          ...this.connectionParams(),
        },
      });
      const res = await Promise.race([
        call,
        new Promise<"timeout">((resolve) => {
          timer = setTimeout(() => resolve("timeout"), opts.timeoutMs);
        }),
      ]);
      if (res === "timeout") {
        call.catch(() => {}); // late result discarded; the SERVER RUN IS NOT CANCELLED
        // bc-dev exposes no server-confirmed test-timeout signal, so we cannot
        // tell "the mutant hung" from "our timer fired / the endpoint wedged".
        // Fail safe: report infrastructure, never fabricate a kill.
        // Our timer fired; the server may still be executing. Ambiguous → in-flight-unknown.
        return {
          ref,
          outcome: "deadline-exceeded",
          durationMs: Date.now() - started,
          operation: "in-flight-unknown",
        };
      }
      // A thrown tool handler doesn't reject callTool() — the MCP protocol reports it as a
      // normal CallToolResult with isError:true and the message as plain (non-JSON) text.
      if (isToolError(res)) {
        // The server answered (a thrown handler surfaces as a normal isError result), so this
        // is a completed, well-formed error — not an in-flight ambiguity.
        return {
          ref,
          outcome: "error",
          durationMs: Date.now() - started,
          failureMessage: firstText(res),
        };
      }
      const payload = parseTestRunPayload(firstText(res));
      const r = payload.results.find(
        (x) => x.codeunitId === ref.codeunitId && x.method === ref.method,
      );
      if (!r) {
        return {
          ref,
          outcome: "error",
          durationMs: Date.now() - started,
          failureMessage: NO_RESULT_FOR_METHOD,
        };
      }
      const outcome = WIRE_STATUS_TO_OUTCOME[r.status];
      const coverage =
        opts.coverage !== "none"
          ? this.buildCoverageMap(payload.coverage, ref.codeunitId)
          : undefined;
      return {
        ref,
        outcome,
        // Wall-clock (MCP call dispatch -> result), NOT `r.durationMs`, which is
        // BC's in-VM test-body time only (tens of ms) and excludes the publish/
        // session/round-trip overhead that dominates a real invocation (seconds).
        // The orchestrator derives each mutant run's timeout budget from the
        // baseline `durationMs` (`2 * baseline`, see orchestrator.ts), so reporting
        // in-VM time starves every mutant run into a client-side timeout — and each
        // abandoned timeout leaves a test run in flight server-side, so the next
        // call fails with "A test run is already running". Same bug and same fix as
        // AlRunnerBackend.run().
        durationMs: Date.now() - started,
        ...(outcome === "fail" && r.output ? { failureMessage: r.output } : {}),
        ...(coverage !== undefined ? { coverage } : {}),
      };
    } catch (err) {
      // The call was dispatched and then rejected (transport dropped mid-flight, etc.). The
      // server may still be running the test → ambiguous.
      return {
        ref,
        outcome: "error",
        durationMs: Date.now() - started,
        failureMessage: String(err),
        operation: "in-flight-unknown",
      };
    } finally {
      // Whichever side of the race settled first, the timer must not keep the event
      // loop (or the test runner) alive for the remainder of opts.timeoutMs.
      clearTimeout(timer);
    }
  }

  /**
   * Resolves the wire coverage payload (numeric objectId/methodId only) for the ONE test
   * method `run()` just executed into the name-keyed `CoverageMap` `selection.ts`'s
   * `coverageFilter` matches mutants against.
   *
   * Two scope rules, both measured rather than argued:
   *
   * - **R61: only the artifact's own objects are eligible.** The payload covers everything the
   *   platform observed — Base App, the test framework, LethAL's own control app — and nothing
   *   downstream can tell an object-level entry for `Codeunit:71002` from one for the target.
   *   An object outside the compiled artifact's SymbolReference is SKIPPED, same rule the fenced
   *   path applies (`line-map.ts`, scoped by `declaredObjects()`).
   *
   * - **R63: an unresolvable methodId is emitted at OBJECT level, never expanded to member
   *   guesses.** `methodIndex` (built in deploy() from the compiled app's own
   *   SymbolReference.json) resolves *public* procedures exactly. Local procedures and triggers
   *   are never listed there (verified 2026-07-18; locals confirmed absent from Document
   *   Output's compiled symbol reference 2026-07-28, method ids an uncracked hash), so an
   *   unresolved methodId says "this object executed a member we cannot name" — nothing more.
   *   The pre-R63 fallback expanded that to EVERY local procedure declared in the object: on
   *   Document Output, one genuinely-executed local credited five tests with all ten locals of
   *   the codeunit, and 77 mutants in procedures those tests cannot reach were scored
   *   `survived` against them — confident, non-empty, wrong covering sets (R29's exact shape).
   *   The doc comment that justified the expansion called it safe because it "never hides a
   *   real kill"; it manufactures false survivors instead, which is the error class this
   *   project treats as the worst kind. Object-level credit lands in `byObject`, whose FALLBACK
   *   1 semantics are sound one precision level coarser — and dropping the observation entirely
   *   is the false-survivor bug the object-level branch fixed (measured on Cronus282), so
   *   object-level, not silence.
   */
  private buildCoverageMap(
    wireCoverage: readonly WireCoverageEntry[] | undefined,
    testCodeunitId: number,
  ): CoverageMap {
    const entry = wireCoverage?.find((e) => e.testObjectId === testCodeunitId);
    const entries: CoverageEntry[] = [];
    for (const p of entry?.coveredProcedures ?? []) {
      // R61: skip anything the compiled artifact does not declare (Base App, test framework,
      // LethAL's own control app) — see the doc comment above.
      const declaredKey = `${objectTypeName(p.objectType).toLowerCase()}:${p.objectId}`;
      if (this.methodIndex !== undefined && !this.methodIndex.declaredObjects().has(declaredKey)) {
        continue;
      }
      const name = this.methodIndex?.lookup(p.objectType, p.objectId, p.methodId);
      if (name !== undefined) {
        entries.push({
          objectType: objectTypeName(p.objectType),
          objectId: p.objectId,
          procedure: name,
        });
        continue;
      }
      // R63: an unresolvable member says only "this object executed something we cannot name"
      // (a local procedure or a trigger — both are absent from SymbolReference.json). Emit the
      // observation at OBJECT level; expanding it to member guesses produced Document Output's
      // 77 false survivors (see the doc comment above).
      entries.push({ objectType: objectTypeName(p.objectType), objectId: p.objectId });
    }
    return { granularity: "procedure", entries };
  }
}

/**
 * The artifact's own `idRanges`, as one AL `SetFilter` expression over `Code Coverage."Object ID"`
 * (e.g. `79000..79199`, or `6175200..6175499|79000..79199` for a multi-range app).
 *
 * MEASURED, and the reason this exists at all: unfiltered, `RunMutantWithCoverage` does not return
 * headers within 300 s even for a fixture whose test body is three lines — the `Code Coverage` table
 * holds every line the platform recorded during the run, which inside `RunMutant` is the whole Test
 * Runner and Base App machinery. See `RunMutantRequest.coverageObjectIdFilter`.
 *
 * Reads the INSTRUMENTED dir's own `app.json`, which is what alc compiled: `stageForCompile`'s
 * sibling copy differs from it only in `dependencies`.
 *
 * Throws when the manifest declares no range. That is deliberate rather than "fall back to no
 * filter": the empty filter is precisely the shape that hangs, so degrading to it would turn a
 * legible manifest problem into a 300 s timeout classified as an in-flight-unknown, i.e. a durable
 * tier quarantine.
 */
async function coverageObjectIdFilterOf(instrumentedDir: string): Promise<string> {
  const appJsonPath = join(instrumentedDir, "app.json");
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(await readFile(appJsonPath, "utf8")) as Record<string, unknown>;
  } catch (err) {
    throw new ArtifactPrepareError(
      `cannot read ${appJsonPath} for the fenced-coverage object filter: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  // AL accepts both the plural array and the legacy singular object; a real project may use either.
  const single = manifest.idRange;
  const ranges = Array.isArray(manifest.idRanges)
    ? (manifest.idRanges as unknown[])
    : single !== undefined
      ? [single]
      : [];
  const parts: string[] = [];
  for (const r of ranges) {
    const { from, to } = (r ?? {}) as { from?: unknown; to?: unknown };
    if (typeof from === "number" && typeof to === "number") parts.push(`${from}..${to}`);
  }
  if (parts.length === 0) {
    const why =
      'declares no usable idRanges, so coverageMode "fenced" has no object filter to send. ' +
      "An unfiltered coverage request does not return within 300 s (measured), so this refuses " +
      "rather than degrading into a timeout that reads as a stranded container.";
    throw new ArtifactPrepareError(`${appJsonPath} ${why}`);
  }
  return parts.join("|");
}

/**
 * Spec decision 3: keep the RAW line rows as a diagnostic artifact, not only their collapsed
 * `CoverageMap` form. Opt-in via `LETHAL_FENCED_COVERAGE_DUMP=<path>` (JSONL, one object per test).
 *
 * Earned, not speculative. On Continia Document Output the fenced baseline was 56/56 green, every
 * test resolved at least one member, no diagnostic fired — and the union across all 56 tests was a
 * single procedure where the hub named thirteen. Nothing in the verdicts, the counts, the warnings
 * or the exit code distinguished that from "the suite genuinely covers one procedure", and the only
 * thing that could have was the line numbers BC actually sent.
 *
 * Best-effort by construction: this is a diagnostic, and a failed dump must never change a verdict
 * or abort a run that is otherwise fine.
 */
async function dumpFencedCoverage(
  ref: TestMethodRef,
  rows: readonly FencedCoverageRow[],
  stats: FencedCoverageStats | undefined,
): Promise<void> {
  const path = process.env.LETHAL_FENCED_COVERAGE_DUMP;
  if (path === undefined || path === "") return;
  const record = {
    test: `${ref.codeunitName}.${ref.method}`,
    ...(stats !== undefined ? { stats } : {}),
    rows,
  };
  await appendFile(
    path,
    `${JSON.stringify(record)}
`,
    "utf8",
  ).catch(() => {});
}

/**
 * `PublishFailedError.file` (R90/Task 3): the ONE file this batch's guards came from, when there
 * is one. `undefined` for a multi-file batch (nothing single to name) or an empty manifest —
 * `file` is `string | undefined` for exactly this reason, never an empty string standing in for
 * "unknown".
 */
function soleFileOf(manifest: MutantManifest): string | undefined {
  const [first, ...rest] = manifest.mutants;
  if (first === undefined) return undefined;
  return rest.every((m) => m.file === first.file) ? first.file : undefined;
}

/**
 * `PublishFailedError.tier` (R90/Task 3): the same physical-BC-service-tier identity quarantine
 * already keys on (`quarantineResourceKey` — server + serverInstance, tenant deliberately
 * excluded, since the publish ceiling is a proxy/container property shared across every tenant on
 * one tier, same reasoning as the quarantine consult).
 *
 * The `"unconfigured-tier"` fallback is DEFENSIVE, not a live production gap — measured: both
 * known production factories of `BcDevConfig` always populate `server`/`serverInstance` or throw
 * first. `bcDevBackendConfig` (cli.ts) sources them from `BcDevConfigSection.server`/
 * `serverInstance`, which are non-optional required `string` fields (cli.ts), so a directly
 * configured container always has them. The env-tool-routed path
 * (`resolveEnvToolSession` -> `splitBaseUrl`, env-tool-session.ts) always derives both from the
 * resolved `baseUrl` or throws (`EnvToolError`) before a `BcDevConfig` is ever constructed — it
 * does NOT leave them undefined either. `server`/`serverInstance` are merely optional on the
 * `BcDevConfig` TYPE (a test, or a future caller, can construct one without them); `tier` is
 * required and non-optional on `PublishFailedError`, so this fallback exists to keep that
 * contract honest against such a config, never to describe a reachable production path.
 */
function tierIdentityOf(cfg: BcDevConfig): string {
  const { server, serverInstance } = cfg;
  if (server === undefined || serverInstance === undefined) return "unconfigured-tier";
  return quarantineResourceKey({ server, serverInstance });
}

function isToolError(res: unknown): boolean {
  return (res as { isError?: boolean }).isError === true;
}

function firstText(res: unknown): string {
  const content = (res as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  const t = content.find((c) => c.type === "text")?.text;
  if (t === undefined) throw new Error("MCP result had no text content");
  return t;
}

function parseTestRunPayload(text: string): TestRunPayload {
  return JSON.parse(text) as TestRunPayload;
}
