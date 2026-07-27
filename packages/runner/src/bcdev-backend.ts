import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { MutantManifest } from "@lethal/schemata";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { AppMethodIndex, findLocalProcedureNames, objectTypeName } from "./app-package";
import { ArtifactPrepareError, DeploymentError } from "./artifact";
import type { ArtifactCompiler, CompileInput, CompiledArtifact } from "./artifact";
import type {
  BackendCapabilities,
  BackendStatus,
  CoverageEntry,
  CoverageMap,
  ExecutionBackend,
  RunOpts,
  TestMethodRef,
  TestVerdict,
} from "./backend";
import { decidePublishOutcome } from "./deployment-verifier";
import type { DeploymentVerifier } from "./deployment-verifier";
import { CONTROL_APP_ID } from "./harness";
import type { HarnessVerifier } from "./harness";
import type { Lease } from "./lease";
import type { AppPublisher } from "./publisher";
import type { RunMutantTransport } from "./run-mutant-transport";

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
  // The `ArtifactCompiler`'s own package-cache directory (mirrors
  // `ArtifactCompilerConfig.packageCachePath`, fixed at compiler construction) — `deploy()`/
  // `compileCheck()` need this SEPARATELY so `stageForCompile` can stage the control symbol
  // into the exact cache alc reads from via `/packagecachepath:`.
  readonly packageCachePath: string;
  /**
   * Coverage the backend claims. Default "procedure" — bc-dev-mcp returns per-procedure coverage
   * for the baseline run. Set to "none" when bc-dev-mcp cannot reach the environment (the env-tool
   * fallback, spec §Coverage): the session then runs every mutant against all green tests, which
   * is slower and never wrong. Per-mutant execution is `coverage: "none"` through the fenced
   * transport in BOTH modes, so this changes baseline routing and selection only.
   */
  readonly coverageMode?: "procedure" | "none";
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

export class BcDevMcpBackend implements ExecutionBackend {
  private client: Client | undefined;
  // Populated by deploy() from the just-compiled .app so run() can resolve coverage
  // methodIds to procedure names — see app-package.ts for why this needs the compiled
  // artifact (and the source tree) rather than being derivable from the wire payload alone.
  private methodIndex: AppMethodIndex | undefined;
  private localProcedures: Map<string, readonly string[]> | undefined;
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
      coverage: this.cfg.coverageMode ?? "procedure",
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
    // In "none" mode nothing in this session ever calls bc-dev-mcp — baseline and mutant runs both
    // go through RunMutantTransport, and discovery is static from source. Probing it here would
    // fail the session's readiness gate (orchestrator.ts) for a capability it does not use, so the
    // readiness question becomes "does the control app answer", which is the thing that matters.
    if ((this.cfg.coverageMode ?? "procedure") === "none") {
      const harnessVerifier = this.deployment?.harnessVerifier;
      if (harnessVerifier === undefined) {
        throw new Error(
          'BcDevMcpBackend: coverageMode "none" requires a harnessVerifier in BcDevDeployment — ' +
            "it is the readiness probe in that mode",
        );
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
    const deps = Array.isArray(app.dependencies)
      ? (app.dependencies as Array<Record<string, unknown>>)
      : [];
    if (!deps.some((d) => d.id === CONTROL_APP_ID)) {
      deps.push({
        id: CONTROL_APP_ID,
        name: "LethAL Control",
        publisher: "LethAL",
        version: "1.0.0.0",
      });
    }
    await writeFile(
      appJsonPath,
      `${JSON.stringify({ ...app, dependencies: deps }, null, 2)}\n`,
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
      // reads `artifact.appPath` (the compiled .app in outputDir) and localProcedures reads the
      // ORIGINAL instrumentedDir below. Best-effort, same idiom as compileCheck()'s own cleanup —
      // a compile already decided the outcome by here, so a stray cleanup failure must never
      // mask it.
      await rm(staged, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(
        () => {},
      );
    }
    // Must happen before publish(): resolves this batch's coverage methodIds ahead of any
    // run() call, from the exact artifact/source that produced them.
    this.methodIndex = await AppMethodIndex.fromAppFile(artifact.appPath);
    this.localProcedures = await findLocalProcedureNames(instrumentedDir);

    let publishOk = true;
    let publishError: string | undefined;
    try {
      await deployment.deployer.publish(artifact);
    } catch (err) {
      publishOk = false;
      publishError = err instanceof Error ? err.message : String(err);
    }
    // Verification runs whether or not publish succeeded: decidePublishOutcome needs it to
    // tell a plain `failed` publish apart from an `anomalous` one (publish failed yet the
    // server claims to run our artifact — a deployment we cannot explain).
    const verification = await deployment.verifier.verify(artifact);
    const outcome = decidePublishOutcome(publishOk, verification);
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
   * publish, no verify, no `recordArtifact`, and critically no `this.methodIndex` /
   * `this.localProcedures` assignment: those describe the REAL artifact's coverage indexes, and
   * a bisection candidate (a narrowed, possibly-malformed subset) must never clobber them out
   * from under an in-flight `run()`.
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
   * One test run. `coverage` discovery stays on the bc-dev hub (`bcdev_test_run`, one method per
   * call — spec §10); a mutant execution (`coverage: "none"`) goes through the self-contained
   * RunMutant OData call (activate + run one method + clear), which is 5B-classified and
   * identity-validated by `RunMutantTransport`.
   */
  async run(ref: TestMethodRef, opts: RunOpts): Promise<TestVerdict> {
    if (opts.coverage !== "none") return this.runOnHub(ref, opts);
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
    this.attemptSeq += 1;
    const opSeq = this.nextOpSeq;
    this.nextOpSeq += 1;
    return transport.run({
      ref,
      mutantId: this.pendingMutantId ?? "",
      attemptId: `a${this.attemptSeq}`,
      timeoutMs: opts.timeoutMs,
      lease: {
        epoch: lease.epoch,
        token: lease.token,
        serverGeneration: lease.serverGeneration,
        opSeq,
      },
    });
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
   * `methodIndex` (built in deploy() from the compiled app's own SymbolReference.json)
   * resolves *public* procedures exactly. Local/private procedures are never listed there
   * (verified 2026-07-18), so an unresolvable methodId falls back to crediting every local
   * procedure `findLocalProcedureNames` found declared in that same object — an
   * over-approximation (it can mark a genuinely-uncovered local procedure as covered) but a
   * SAFE one: it only ever turns a would-be "no-coverage" skip into an actual test run, never
   * hides a real kill by wrongly skipping a mutant a test could have caught.
   *
   * When even that finds nothing (an unresolvable methodId in an object declaring NO local
   * procedure — the shape of every table whose procedures are public, and of every trigger,
   * which SymbolReference.json never records), the observation is emitted at OBJECT level: a
   * `CoverageEntry` carrying `objectType`/`objectId` and no `procedure`. Same safe direction,
   * one precision level coarser. See the branch below for the false survivors that emitting
   * nothing produced.
   */
  private buildCoverageMap(
    wireCoverage: readonly WireCoverageEntry[] | undefined,
    testCodeunitId: number,
  ): CoverageMap {
    const entry = wireCoverage?.find((e) => e.testObjectId === testCodeunitId);
    const entries: CoverageEntry[] = [];
    for (const p of entry?.coveredProcedures ?? []) {
      const name = this.methodIndex?.lookup(p.objectType, p.objectId, p.methodId);
      if (name !== undefined) {
        entries.push({
          objectType: objectTypeName(p.objectType),
          objectId: p.objectId,
          procedure: name,
        });
        continue;
      }
      const locals = this.localProcedures?.get(`${p.objectType}:${p.objectId}`) ?? [];
      if (locals.length === 0) {
        // Neither route can NAME this member — but BC measured it, so the observation is still
        // hard evidence that this test executed code in this OBJECT. Emit it at object level
        // (no `procedure`; see CoverageEntry) rather than dropping it.
        //
        // Dropping it was the false-survivor bug (measured on Cronus282): BC reports coverage for
        // table-trigger code, SymbolReference.json records no trigger, and a table whose
        // procedures are all PUBLIC has no local-procedure fallback either — so the object lost
        // credit along with the member. `byObject` then held only whichever sibling test happened
        // to resolve, `coverageFilter`'s FALLBACK 1 returned that non-empty-but-wrong set, its
        // all-green-tests FALLBACK 2 never fired, and every table-trigger mutant ran against one
        // irrelevant test. 10 of 20 survivors on the table fixture were false.
        entries.push({ objectType: objectTypeName(p.objectType), objectId: p.objectId });
        continue;
      }
      for (const localName of locals) {
        entries.push({
          objectType: objectTypeName(p.objectType),
          objectId: p.objectId,
          procedure: localName,
        });
      }
    }
    return { granularity: "procedure", entries };
  }
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
