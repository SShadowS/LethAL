import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { MutationControlClient } from "../src/activation";
import { BcDevMcpBackend } from "../src/bcdev-backend";
import { Publisher } from "../src/publisher";
import { buildFakeApp } from "./helpers/fake-app";

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

/**
 * Like `makeBackend`, but also wires a `Publisher` whose fake "alc.exe" spawn writes a real
 * (hand-built) `.app` zip to the expected output path and calls `backend.deploy()` — needed
 * because `run()`'s coverage resolution reads the compiled app's own `SymbolReference.json`
 * (see app-package.ts), populated only by `deploy()`. Returns the backend plus a cleanup
 * function the caller must run (removes the temp dir the fake compile wrote into).
 */
async function makeBackendWithDeploy(
  runHandler: (args: unknown) => unknown,
  symbolReference: unknown,
  instrumentedDir?: string,
): Promise<{ backend: BcDevMcpBackend; cleanup: () => Promise<void> }> {
  const server = new McpServer({ name: "fake-bc-dev", version: "0.0.0" });
  server.registerTool("bcdev_test_run", { inputSchema: anyArgs }, async (args: unknown) => ({
    content: [{ type: "text", text: JSON.stringify(await runHandler(args)) }],
  }));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  void server.connect(serverTransport);

  const outputDir = await mkdtemp(join(tmpdir(), "lethal-bcdev-backend-test-"));
  const appPath = join(outputDir, "lethal-instrumented.app");
  const fakeSpawn = async (argv: readonly string[]) => {
    if (argv.some((a) => a.includes("alc.exe"))) {
      await Bun.write(appPath, buildFakeApp(symbolReference));
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  const publisher = new Publisher(
    {
      alcPath: "C:/fake/alc.exe",
      altoolPath: "C:/fake/altool.exe",
      packageCachePath: "C:/fake/.alpackages",
      outputDir,
      server: "http://bc",
      serverInstance: "BC",
      username: "u",
      password: "p",
    },
    fakeSpawn,
  );
  const backend = new BcDevMcpBackend(
    { mcpCommand: ["unused"], project: "/al", server: "http://bc", serverInstance: "BC" },
    () => clientTransport,
    publisher,
  );
  await backend.deploy(instrumentedDir ?? outputDir);
  return { backend, cleanup: () => rm(outputDir, { recursive: true, force: true }) };
}

describe("BcDevMcpBackend.run", () => {
  test("maps a passing result and resolves procedure coverage from the compiled app", async () => {
    const { backend, cleanup } = await makeBackendWithDeploy(
      () => ({
        results: [
          {
            codeunitId: 79100,
            method: "PostingUpdatesTotal",
            status: "passed",
            durationMs: 42,
            output: "",
          },
        ],
        coverage: [
          {
            testObjectId: 79100,
            testMethodId: 111,
            coveredProcedures: [{ objectType: 5, objectId: 70000, methodId: 222 }],
          },
        ],
      }),
      { Codeunits: [{ Id: 70000, Name: "Some Codeunit", Methods: [{ Id: 222, Name: "Post" }] }] },
    );
    try {
      const v = await backend.run(ref, { coverage: "procedure", timeoutMs: 5000 });
      expect(v.outcome).toBe("pass");
      expect(v.durationMs).toBe(42);
      expect(v.coverage?.entries[0]?.procedure).toBe("Post");
      expect(v.coverage?.entries[0]?.objectType).toBe("Codeunit");
    } finally {
      await cleanup();
    }
  });

  test("falls back to crediting local procedures when a methodId can't be resolved by name", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lethal-bcdev-backend-local-"));
    await Bun.write(
      join(dir, "SandboxLogic.Codeunit.al"),
      [
        'codeunit 79000 "Sandbox Logic"',
        "{",
        "    procedure ApplyAudit(Amount: Decimal)",
        "    begin",
        "        LogAudit(Amount);",
        "    end;",
        "",
        "    local procedure LogAudit(Amount: Decimal)",
        "    begin",
        "    end;",
        "}",
        "",
      ].join("\n"),
    );
    const { backend, cleanup } = await makeBackendWithDeploy(
      () => ({
        results: [
          {
            codeunitId: 79100,
            method: "ClampPercentRuns",
            status: "passed",
            durationMs: 1,
            output: "",
          },
        ],
        coverage: [
          {
            testObjectId: 79100,
            testMethodId: 111,
            // methodId 999 belongs to LogAudit but is absent from SymbolReference.json (it's
            // `local`) — only ApplyAudit's own methodId (333) resolves directly.
            coveredProcedures: [
              { objectType: 5, objectId: 79000, methodId: 333 },
              { objectType: 5, objectId: 79000, methodId: 999 },
            ],
          },
        ],
      }),
      {
        Codeunits: [
          { Id: 79000, Name: "Sandbox Logic", Methods: [{ Id: 333, Name: "ApplyAudit" }] },
        ],
      },
      dir,
    );
    try {
      const v = await backend.run(
        { codeunitId: 79100, codeunitName: "Sandbox Tests", method: "ClampPercentRuns" },
        { coverage: "procedure", timeoutMs: 5000 },
      );
      const procedures = v.coverage?.entries.map((e) => e.procedure).sort();
      expect(procedures).toEqual(["ApplyAudit", "LogAudit"]);
    } finally {
      await cleanup();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("forwards codeunit/method restriction and connection params", async () => {
    let seen: unknown;
    const backend = makeBackend((args) => {
      seen = args;
      return {
        results: [
          {
            codeunitId: 79100,
            method: "PostingUpdatesTotal",
            status: "passed",
            durationMs: 1,
            output: "",
          },
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
          status: "failed",
          durationMs: 7,
          output: "expected 2, got 1",
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

describe("BcDevMcpBackend env passthrough", () => {
  // StdioClientTransport's spawn only inherits a fixed OS allowlist (getDefaultEnvironment())
  // unless an explicit `env` is passed — cfg.env (e.g. BC_DEV_USER/BC_DEV_PASSWORD) must reach
  // whatever builds the transport, merged over that default rather than replacing it.
  test("cfg.env reaches the transport factory, merged over the default environment", async () => {
    let capturedEnv: Record<string, string> | undefined;
    const server = new McpServer({ name: "fake-bc-dev", version: "0.0.0" });
    server.registerTool("bcdev_status", { inputSchema: anyArgs }, async () => ({
      content: [{ type: "text", text: "ok" }],
    }));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    void server.connect(serverTransport);
    const backend = new BcDevMcpBackend(
      {
        mcpCommand: ["unused"],
        project: "/al",
        server: "http://bc",
        serverInstance: "BC",
        env: { BC_DEV_USER: "sshadows", BC_DEV_PASSWORD: "1234" },
      },
      (env) => {
        capturedEnv = env;
        return clientTransport;
      },
    );
    await backend.status();
    expect(capturedEnv).toEqual({
      ...getDefaultEnvironment(),
      BC_DEV_USER: "sshadows",
      BC_DEV_PASSWORD: "1234",
    });
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
    const dir = await mkdtemp(join(tmpdir(), "lethal-bcdev-deploy-test-"));
    try {
      const calls: string[][] = [];
      const appPath = join(dir, "lethal-instrumented.app");
      const recordingSpawn = async (argv: readonly string[]) => {
        calls.push([...argv]);
        // deploy() reads the compiled app's own SymbolReference.json right after compile()
        // returns — the fake alc.exe call must actually produce one, same as a real compile.
        if (argv[0] === "C:/alc.exe") await Bun.write(appPath, buildFakeApp({ Codeunits: [] }));
        return { exitCode: 0, stdout: "", stderr: "" };
      };
      const publisher = new Publisher(
        {
          alcPath: "C:/alc.exe",
          altoolPath: "C:/altool.exe",
          packageCachePath: "C:/.alpackages",
          outputDir: dir,
          server: "http://bc",
          serverInstance: "BC",
          username: "u",
          password: "p",
        },
        recordingSpawn,
      );
      const backend = new BcDevMcpBackend(
        { mcpCommand: ["unused"], project: "/al", server: "http://bc", serverInstance: "BC" },
        undefined,
        publisher,
      );
      await backend.deploy(dir);
      expect(calls).toHaveLength(2);
      expect(calls[0]?.[0]).toBe("C:/alc.exe");
      expect(calls[1]?.[0]).toBe("C:/altool.exe");
      expect(calls[1]?.[1]).toBe("publishapp");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
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
