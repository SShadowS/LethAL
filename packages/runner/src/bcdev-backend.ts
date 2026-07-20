import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { MutantManifest } from "@lethal/schemata";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { MutationControlClient } from "./activation";
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
import type { ContainerDeployer } from "./publisher";

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
}

// Verified against a real BC server (2026-07-18) via bc-dev-mcp source
// (packages test-tools.ts's runTestsOutputSchema / test-runner-hub.ts's RunTestsResult) and a
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
 * three are required together: identity verification is mandatory ADDITIONAL evidence (see
 * deployment-verifier.ts) — a backend that could compile and publish but not verify would
 * make every deploy `indeterminate` by construction, so the type forbids configuring one.
 */
export interface BcDevDeployment {
  readonly compiler: ArtifactCompiler;
  readonly deployer: ContainerDeployer;
  readonly verifier: DeploymentVerifier;
}

export class BcDevMcpBackend implements ExecutionBackend {
  private client: Client | undefined;
  // Populated by deploy() from the just-compiled .app so run() can resolve coverage
  // methodIds to procedure names — see app-package.ts for why this needs the compiled
  // artifact (and the source tree) rather than being derivable from the wire payload alone.
  private methodIndex: AppMethodIndex | undefined;
  private localProcedures: Map<string, readonly string[]> | undefined;

  constructor(
    private readonly cfg: BcDevConfig,
    private readonly transportFactory?: (env: Record<string, string>) => Transport,
    private readonly deployment?: BcDevDeployment,
    private readonly activation?: MutationControlClient,
  ) {}

  capabilities(): BackendCapabilities {
    return { coverage: "procedure", deploy: "publish", isolation: "session", authoritative: true };
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
    const { project, server, serverInstance, tenant, environmentType, environmentName, company } =
      this.cfg;
    return Object.fromEntries(
      Object.entries({
        project,
        server,
        serverInstance,
        tenant,
        environmentType,
        environmentName,
        company,
      }).filter(([, v]) => v !== undefined),
    );
  }

  async status(): Promise<BackendStatus> {
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

  async deploy(instrumentedDir: string): Promise<CompiledArtifact> {
    const deployment = this.deployment;
    if (!deployment) throw new Error("BcDevMcpBackend: no compiler/deployer/verifier configured");
    const artifact = await deployment.compiler.compile(
      await this.prepareCompileInput(instrumentedDir),
    );
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
   * before `alc` produced output) leaves nothing to delete.
   */
  async compileCheck(instrumentedDir: string): Promise<void> {
    const deployment = this.deployment;
    if (!deployment) throw new Error("BcDevMcpBackend: no compiler/deployer/verifier configured");
    const artifact = await deployment.compiler.compile(
      await this.prepareCompileInput(instrumentedDir),
    );
    await rm(artifact.appPath, { force: true });
  }

  async activate(mutantId: string | null): Promise<void> {
    if (!this.activation) throw new Error("BcDevMcpBackend: no activation client configured");
    if (mutantId === null) await this.activation.clearActive();
    else await this.activation.setActive(mutantId);
  }

  async run(ref: TestMethodRef, opts: RunOpts): Promise<TestVerdict> {
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
          failureMessage: "bcdev_test_run returned no result for the requested method",
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
