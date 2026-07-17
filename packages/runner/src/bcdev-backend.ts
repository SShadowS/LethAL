import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { MutationControlClient } from "./activation";
import type {
  BackendCapabilities,
  BackendStatus,
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
}

interface RawResult {
  codeunitId: number;
  method: string;
  outcome: "pass" | "fail" | "skip";
  durationMs: number;
  failureMessage?: string;
  coverage?: CoverageMap;
}

interface TestRunPayload {
  results: RawResult[];
}

export class BcDevMcpBackend implements ExecutionBackend {
  private client: Client | undefined;

  constructor(
    private readonly cfg: BcDevConfig,
    private readonly transportFactory?: () => Transport,
    private readonly publisher?: Publisher,
    private readonly activation?: MutationControlClient,
  ) {}

  capabilities(): BackendCapabilities {
    return { coverage: "procedure", deploy: "publish", isolation: "session", authoritative: true };
  }

  private async connect(): Promise<Client> {
    if (this.client) return this.client;
    const transport = this.transportFactory
      ? this.transportFactory()
      : new StdioClientTransport({
          command: this.cfg.mcpCommand[0] ?? "",
          args: [...this.cfg.mcpCommand.slice(1)],
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
      return {
        ref,
        outcome: r.outcome,
        durationMs: r.durationMs,
        ...(r.failureMessage !== undefined ? { failureMessage: r.failureMessage } : {}),
        ...(r.coverage !== undefined ? { coverage: r.coverage } : {}),
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
