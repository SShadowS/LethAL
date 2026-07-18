import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { MutationControlClient } from "./activation";
import { AppMethodIndex, findLocalProcedureNames, objectTypeName } from "./app-package";
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
import type { Publisher } from "./publisher";

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
    private readonly publisher?: Publisher,
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

  async deploy(instrumentedDir: string): Promise<void> {
    if (!this.publisher) throw new Error("BcDevMcpBackend: no Publisher configured");
    const appPath = await this.publisher.compile(instrumentedDir);
    // Must happen before publish(): resolves this batch's coverage methodIds ahead of any
    // run() call, from the exact artifact/source that produced them.
    this.methodIndex = await AppMethodIndex.fromAppFile(appPath);
    this.localProcedures = await findLocalProcedureNames(instrumentedDir);
    await this.publisher.publish(appPath);
  }

  async activate(mutantId: string | null): Promise<void> {
    if (!this.activation) throw new Error("BcDevMcpBackend: no activation client configured");
    if (mutantId === null) await this.activation.clearActive();
    else await this.activation.setActive(mutantId);
  }

  async run(ref: TestMethodRef, opts: RunOpts): Promise<TestVerdict> {
    const started = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const client = await this.connect();
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
        call.catch(() => {}); // late result/error deliberately discarded
        return { ref, outcome: "timeout", durationMs: Date.now() - started };
      }
      // A thrown tool handler doesn't reject callTool() — the MCP protocol reports it as a
      // normal CallToolResult with isError:true and the message as plain (non-JSON) text.
      if (isToolError(res)) {
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
        durationMs: r.durationMs,
        ...(outcome === "fail" && r.output ? { failureMessage: r.output } : {}),
        ...(coverage !== undefined ? { coverage } : {}),
      };
    } catch (err) {
      return {
        ref,
        outcome: "error",
        durationMs: Date.now() - started,
        failureMessage: String(err),
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
