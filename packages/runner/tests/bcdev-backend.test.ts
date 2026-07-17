import { describe, expect, test } from "bun:test";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { MutationControlClient } from "../src/activation";
import { BcDevMcpBackend } from "../src/bcdev-backend";
import { Publisher } from "../src/publisher";

const ref = { codeunitId: 79100, codeunitName: "Sandbox Tests", method: "PostingUpdatesTotal" };

// SDK 1.29.0's McpServer.tool()/registerTool() validates arguments through a Zod schema
// (see node_modules/@modelcontextprotocol/sdk/dist/esm/server/zod-compat.js). A permissive
// passthrough object schema lets the fake tools receive whatever shape the adapter sends
// without the fake server needing to mirror the production request shape.
const anyArgs = z.object({}).passthrough();

function makeBackend(
  runHandler: (args: unknown) => unknown,
  statusHandler: (args: unknown) => unknown = () => "fake",
) {
  const server = new McpServer({ name: "fake-bc-dev", version: "0.0.0" });
  // `await` matters here: a handler that returns a never-resolving Promise (the timeout
  // scenario) must keep this tool call pending, not synchronously serialize the Promise
  // object itself (JSON.stringify(new Promise(...)) resolves to "{}" instantly otherwise).
  server.registerTool("bcdev_test_run", { inputSchema: anyArgs }, async (args: unknown) => ({
    content: [{ type: "text", text: JSON.stringify(await runHandler(args)) }],
  }));
  // status() treats the response's text content as an opaque details string (no JSON
  // parsing), so the fake tool returns statusHandler's result as plain text.
  server.registerTool("bcdev_status", { inputSchema: anyArgs }, async (args: unknown) => ({
    content: [{ type: "text", text: String(await statusHandler(args)) }],
  }));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  void server.connect(serverTransport);
  return new BcDevMcpBackend(
    { mcpCommand: ["unused"], project: "/al", server: "http://bc", serverInstance: "BC" },
    () => clientTransport,
  );
}

describe("BcDevMcpBackend.run", () => {
  test("maps a passing result with coverage", async () => {
    const backend = makeBackend(() => ({
      results: [
        {
          codeunitId: 79100,
          method: "PostingUpdatesTotal",
          outcome: "pass",
          durationMs: 42,
          coverage: {
            granularity: "procedure",
            entries: [{ objectType: "Codeunit", objectId: 70000, procedure: "Post" }],
          },
        },
      ],
    }));
    const v = await backend.run(ref, { coverage: "procedure", timeoutMs: 5000 });
    expect(v.outcome).toBe("pass");
    expect(v.durationMs).toBe(42);
    expect(v.coverage?.entries[0]?.procedure).toBe("Post");
  });

  test("forwards codeunit/method restriction and connection params", async () => {
    let seen: unknown;
    const backend = makeBackend((args) => {
      seen = args;
      return {
        results: [
          { codeunitId: 79100, method: "PostingUpdatesTotal", outcome: "pass", durationMs: 1 },
        ],
      };
    });
    await backend.run(ref, { coverage: "none", timeoutMs: 5000 });
    expect(seen).toMatchObject({
      codeunits: [{ id: 79100, methods: ["PostingUpdatesTotal"] }],
      coverage: "none",
      project: "/al",
      server: "http://bc",
      serverInstance: "BC",
    });
  });

  test("maps a failing result", async () => {
    const backend = makeBackend(() => ({
      results: [
        {
          codeunitId: 79100,
          method: "PostingUpdatesTotal",
          outcome: "fail",
          durationMs: 7,
          failureMessage: "expected 2, got 1",
        },
      ],
    }));
    const v = await backend.run(ref, { coverage: "none", timeoutMs: 5000 });
    expect(v.outcome).toBe("fail");
    expect(v.failureMessage).toBe("expected 2, got 1");
  });

  test("timeout yields outcome=timeout", async () => {
    const backend = makeBackend(() => new Promise(() => {}) as never);
    const v = await backend.run(ref, { coverage: "none", timeoutMs: 50 });
    expect(v.outcome).toBe("timeout");
  });

  test("transport error yields outcome=error", async () => {
    const backend = makeBackend(() => {
      throw new Error("NST unreachable");
    });
    const v = await backend.run(ref, { coverage: "none", timeoutMs: 5000 });
    expect(v.outcome).toBe("error");
    expect(v.failureMessage).toContain("NST unreachable");
  });
});

describe("BcDevMcpBackend.status", () => {
  test("maps a healthy status", async () => {
    const backend = makeBackend(
      () => ({ results: [] }),
      () => "NST reachable, 3 tenants",
    );
    const s = await backend.status();
    expect(s.ok).toBe(true);
    expect(s.details).toBe("NST reachable, 3 tenants");
  });

  test("tool error yields ok=false, not a false-healthy status", async () => {
    const backend = makeBackend(
      () => ({ results: [] }),
      () => {
        throw new Error("NST unreachable");
      },
    );
    const s = await backend.status();
    expect(s.ok).toBe(false);
    expect(s.details).toContain("NST unreachable");
  });
});

describe("BcDevMcpBackend.deploy", () => {
  test("invokes publisher compile then publish in order", async () => {
    const calls: string[][] = [];
    const recordingSpawn = async (argv: readonly string[]) => {
      calls.push([...argv]);
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const publisher = new Publisher(
      {
        alcPath: "C:/alc.exe",
        altoolPath: "C:/altool.exe",
        packageCachePath: "C:/.alpackages",
        outputDir: "C:/out",
        server: "http://bc",
        serverInstance: "BC",
      },
      recordingSpawn,
    );
    const backend = new BcDevMcpBackend(
      { mcpCommand: ["unused"], project: "/al", server: "http://bc", serverInstance: "BC" },
      undefined,
      publisher,
    );
    await backend.deploy("C:/instr");
    expect(calls).toHaveLength(2);
    expect(calls[0]?.[0]).toBe("C:/alc.exe");
    expect(calls[1]?.[0]).toBe("C:/altool.exe");
    expect(calls[1]?.[1]).toBe("publishapp");
  });
});

describe("BcDevMcpBackend.activate", () => {
  test("activate with mutantId hits SetActive", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fakeFetch = (async (url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ value: "M0002" }), { status: 200 });
    }) as typeof fetch;
    const client = new MutationControlClient(
      {
        baseUrl: "http://bc:7048/BC",
        company: "CRONUS",
        username: "u",
        password: "p",
      },
      fakeFetch,
    );
    const backend = new BcDevMcpBackend(
      { mcpCommand: ["unused"], project: "/al", server: "http://bc", serverInstance: "BC" },
      undefined,
      undefined,
      client,
    );
    await backend.activate("M0002");
    expect(calls[0]?.url).toContain("MutationControl_SetActive");
  });

  test("activate with null hits ClearActive", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fakeFetch = (async (url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({}), { status: 200 });
    }) as typeof fetch;
    const client = new MutationControlClient(
      {
        baseUrl: "http://bc:7048/BC",
        company: "CRONUS",
        username: "u",
        password: "p",
      },
      fakeFetch,
    );
    const backend = new BcDevMcpBackend(
      { mcpCommand: ["unused"], project: "/al", server: "http://bc", serverInstance: "BC" },
      undefined,
      undefined,
      client,
    );
    await backend.activate(null);
    expect(calls[0]?.url).toContain("MutationControl_ClearActive");
  });

  test("activate without client throws", async () => {
    const backend = new BcDevMcpBackend(
      { mcpCommand: ["unused"], project: "/al", server: "http://bc", serverInstance: "BC" },
      undefined,
      undefined,
    );
    await expect(backend.activate("M0002")).rejects.toThrow(
      "BcDevMcpBackend: no activation client configured",
    );
  });
});
