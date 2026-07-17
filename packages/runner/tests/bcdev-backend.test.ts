import { describe, expect, test } from "bun:test";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { BcDevMcpBackend } from "../src/bcdev-backend";

const ref = { codeunitId: 79100, codeunitName: "Sandbox Tests", method: "PostingUpdatesTotal" };

// SDK 1.29.0's McpServer.tool()/registerTool() validates arguments through a Zod schema
// (see node_modules/@modelcontextprotocol/sdk/dist/esm/server/zod-compat.js). A permissive
// passthrough object schema lets the fake tools receive whatever shape the adapter sends
// without the fake server needing to mirror the production request shape.
const anyArgs = z.object({}).passthrough();

function makeBackend(handler: (args: unknown) => unknown) {
  const server = new McpServer({ name: "fake-bc-dev", version: "0.0.0" });
  // `await` matters here: a handler that returns a never-resolving Promise (the timeout
  // scenario) must keep this tool call pending, not synchronously serialize the Promise
  // object itself (JSON.stringify(new Promise(...)) resolves to "{}" instantly otherwise).
  server.registerTool("bcdev_test_run", { inputSchema: anyArgs }, async (args: unknown) => ({
    content: [{ type: "text", text: JSON.stringify(await handler(args)) }],
  }));
  server.registerTool("bcdev_status", { inputSchema: anyArgs }, async () => ({
    content: [{ type: "text", text: JSON.stringify({ ok: true, details: "fake" }) }],
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
