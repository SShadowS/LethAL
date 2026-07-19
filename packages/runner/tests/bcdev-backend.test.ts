import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { MutationControlClient } from "../src/activation";
import {
  AlcCompileError,
  ArtifactCompiler,
  DeploymentError,
  defaultArtifactIo,
} from "../src/artifact";
import { BcDevMcpBackend } from "../src/bcdev-backend";
import type { BcDevDeployment } from "../src/bcdev-backend";
import { DeploymentVerifier } from "../src/deployment-verifier";
import { ContainerDeployer } from "../src/publisher";
import type { SpawnFn } from "../src/publisher";
import { buildFakeApp } from "./helpers/fake-app";

const ref = { codeunitId: 79100, codeunitName: "Sandbox Tests", method: "PostingUpdatesTotal" };

const TEST_ARTIFACT_ID = "0123456789abcdef0123456789abcdef";
const TEST_APP_ID = "11111111-1111-1111-1111-111111111111";

/** Writes the compile inputs deploy()'s prepare step reads from an instrumented dir. */
async function writeDeployInputs(dir: string): Promise<void> {
  await Bun.write(
    join(dir, "app.json"),
    JSON.stringify({
      id: TEST_APP_ID,
      name: "Fixture",
      publisher: "LethAL",
      version: "1.0.20653.100",
    }),
  );
  await Bun.write(
    join(dir, "mutant-manifest.json"),
    JSON.stringify({
      selectorIds: { selectorId: 1, controlId: 2, tableId: 3 },
      artifactId: TEST_ARTIFACT_ID,
      mutants: [],
    }),
  );
}

/**
 * The real ArtifactCompiler + ContainerDeployer + DeploymentVerifier composition with only
 * the process/network edges faked: `spawn` writes a real (hand-built) .app zip wherever alc's
 * `/out:` argument points, and the verifier's fetch reports `reportedIdentity`
 * (default: the fixture artifact id, i.e. a verified deploy) — but ONLY once a publish has
 * actually been observed (an altool `publishapp` spawn call). Before that, it reports a
 * different, well-formed artifact id, exactly like `PhaseBackend` in orchestrator.test.ts
 * models a failed publish. This is deliberate, not incidental: if `BcDevMcpBackend.deploy()`
 * ever called `verify()` before `publish()`, this fake would report the pre-publish id and
 * the deploy would fail on an identity mismatch — without the statefulness, verify() would
 * report a match unconditionally and a publish/verify reordering would sail through silently.
 */
function makeDeployment(
  outputDir: string,
  symbolReference: unknown,
  opts: { spawn?: SpawnFn; reportedIdentity?: string } = {},
): BcDevDeployment {
  // Tracks whether ContainerDeployer.publish() has actually invoked altool. Wraps whichever
  // spawn ends up running (default or a test's own `opts.spawn` override) so the tracking
  // stays accurate regardless of which one produced the .app.
  let published = false;
  const baseSpawn: SpawnFn =
    opts.spawn ??
    (async (argv) => {
      const out = argv.find((a) => a.startsWith("/out:"))?.slice("/out:".length);
      if (argv[0]?.includes("alc") && out !== undefined) {
        await Bun.write(out, buildFakeApp(symbolReference));
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    });
  const spawn: SpawnFn = async (argv, spawnOpts) => {
    const res = await baseSpawn(argv, spawnOpts);
    if (argv[1] === "publishapp") published = true;
    return res;
  };
  const compiler = new ArtifactCompiler(
    { alcPath: "C:/fake/alc.exe", packageCachePath: "C:/fake/.alpackages", outputDir },
    { ...defaultArtifactIo, spawn },
  );
  const deployer = new ContainerDeployer(
    {
      altoolPath: "C:/fake/altool.exe",
      server: "http://bc",
      serverInstance: "BC",
      username: "u",
      password: "p",
    },
    { ...defaultArtifactIo, spawn },
  );
  const fetchFn = (async (_url: unknown, _init?: RequestInit) =>
    new Response(
      JSON.stringify({
        value: opts.reportedIdentity ?? (published ? TEST_ARTIFACT_ID : "f".repeat(32)),
      }),
      { status: 200 },
    )) as typeof fetch;
  const verifier = new DeploymentVerifier(
    { baseUrl: "http://bc:7048/BC", company: "CRONUS", username: "u", password: "p" },
    fetchFn,
  );
  return { compiler, deployer, verifier };
}

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
 * Like `makeBackend`, but also wires the real compile/publish/verify composition (see
 * `makeDeployment`) and calls `backend.deploy()` — needed because `run()`'s coverage
 * resolution reads the compiled app's own `SymbolReference.json` (see app-package.ts),
 * populated only by `deploy()`. Returns the backend plus a cleanup function the caller must
 * run (removes the temp dir the fake compile wrote into).
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
  const deployDir = instrumentedDir ?? outputDir;
  await writeDeployInputs(deployDir);
  const backend = new BcDevMcpBackend(
    { mcpCommand: ["unused"], project: "/al", server: "http://bc", serverInstance: "BC" },
    () => clientTransport,
    makeDeployment(outputDir, symbolReference),
  );
  await backend.deploy(deployDir);
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
      // Wall-clock, not the payload's in-VM 42ms: the orchestrator derives each
      // mutant's timeout budget from this, so it must include round-trip overhead.
      expect(v.durationMs).not.toBe(42);
      expect(v.durationMs).toBeGreaterThanOrEqual(0);
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

  test("bcdev has no runner-confirmed timeout, so its deadline is deadline-exceeded", async () => {
    const backend = makeBackend(() => new Promise(() => {}) as never);
    const v = await backend.run(ref, { coverage: "none", timeoutMs: 50 });
    expect(v.outcome).toBe("deadline-exceeded");
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
        env: { BC_DEV_USER: "testuser", BC_DEV_PASSWORD: "testpass" },
      },
      (env) => {
        capturedEnv = env;
        return clientTransport;
      },
    );
    await backend.status();
    expect(capturedEnv).toEqual({
      ...getDefaultEnvironment(),
      BC_DEV_USER: "testuser",
      BC_DEV_PASSWORD: "testpass",
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
  test("invokes compiler then deployer in order and returns the verified CompiledArtifact", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lethal-bcdev-deploy-test-"));
    try {
      await writeDeployInputs(dir);
      const calls: string[][] = [];
      const recordingSpawn: SpawnFn = async (argv) => {
        calls.push([...argv]);
        // deploy() reads the compiled app's own SymbolReference.json right after compile()
        // returns — the fake alc.exe call must actually produce one, same as a real compile.
        const out = argv.find((a) => a.startsWith("/out:"))?.slice("/out:".length);
        if (argv[0]?.includes("alc") && out !== undefined) {
          await Bun.write(out, buildFakeApp({ Codeunits: [] }));
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      };
      const backend = new BcDevMcpBackend(
        { mcpCommand: ["unused"], project: "/al", server: "http://bc", serverInstance: "BC" },
        undefined,
        makeDeployment(dir, { Codeunits: [] }, { spawn: recordingSpawn }),
      );
      const artifact = await backend.deploy(dir);
      expect(calls).toHaveLength(2);
      expect(calls[0]?.[0]).toBe("C:/fake/alc.exe");
      expect(calls[1]?.[0]).toBe("C:/fake/altool.exe");
      expect(calls[1]?.[1]).toBe("publishapp");
      expect(artifact.artifactId).toBe(TEST_ARTIFACT_ID);
      expect(artifact.appId).toBe(TEST_APP_ID);
      expect(artifact.appVersion).toBe("1.0.20653.100");
      // No fixed filename anywhere: the .app path is content-addressed per artifact.
      expect(artifact.appPath).not.toContain("lethal-instrumented");
      expect(artifact.appPath).toContain(TEST_ARTIFACT_ID);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("throws a typed DeploymentError when identity reports a different artifact", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lethal-bcdev-deploy-mismatch-"));
    try {
      await writeDeployInputs(dir);
      const backend = new BcDevMcpBackend(
        { mcpCommand: ["unused"], project: "/al", server: "http://bc", serverInstance: "BC" },
        undefined,
        makeDeployment(dir, { Codeunits: [] }, { reportedIdentity: "f".repeat(32) }),
      );
      const err = await backend.deploy(dir).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(DeploymentError);
      expect((err as DeploymentError).outcome).toBe("indeterminate");
      expect(String(err)).toMatch(/identity mismatch/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("BcDevMcpBackend.compileCheck", () => {
  test("compiles without ever spawning altool (no publish, no verify)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lethal-bcdev-compilecheck-test-"));
    try {
      await writeDeployInputs(dir);
      const calls: string[][] = [];
      const recordingSpawn: SpawnFn = async (argv) => {
        calls.push([...argv]);
        const out = argv.find((a) => a.startsWith("/out:"))?.slice("/out:".length);
        if (argv[0]?.includes("alc") && out !== undefined) {
          await Bun.write(out, buildFakeApp({ Codeunits: [] }));
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      };
      const backend = new BcDevMcpBackend(
        { mcpCommand: ["unused"], project: "/al", server: "http://bc", serverInstance: "BC" },
        undefined,
        makeDeployment(dir, { Codeunits: [] }, { spawn: recordingSpawn }),
      );
      await backend.compileCheck(dir);
      // Exactly the one alc invocation — never altool, unlike deploy()'s 2 calls (see the
      // sibling "invokes compiler then deployer" test above).
      expect(calls).toHaveLength(1);
      expect(calls[0]?.[0]).toBe("C:/fake/alc.exe");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("throws AlcCompileError on a compiler rejection, without ever spawning altool", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lethal-bcdev-compilecheck-fail-"));
    try {
      await writeDeployInputs(dir);
      const calls: string[][] = [];
      const failSpawn: SpawnFn = async (argv) => {
        calls.push([...argv]);
        if (argv[0]?.includes("alc")) return { exitCode: 1, stdout: "", stderr: "AL0001: boom" };
        return { exitCode: 0, stdout: "", stderr: "" };
      };
      const backend = new BcDevMcpBackend(
        { mcpCommand: ["unused"], project: "/al", server: "http://bc", serverInstance: "BC" },
        undefined,
        makeDeployment(dir, { Codeunits: [] }, { spawn: failSpawn }),
      );
      const err = await backend.compileCheck(dir).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AlcCompileError);
      expect(calls.some((c) => c[0]?.includes("altool"))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("deletes the candidate .app it wrote — bisection candidates must not accumulate in outputDir", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lethal-bcdev-compilecheck-cleanup-"));
    try {
      await writeDeployInputs(dir);
      const backend = new BcDevMcpBackend(
        { mcpCommand: ["unused"], project: "/al", server: "http://bc", serverInstance: "BC" },
        undefined,
        makeDeployment(dir, { Codeunits: [] }),
      );
      await backend.compileCheck(dir);
      const appsAfter = (await readdir(dir)).filter((f) => f.endsWith(".app"));
      expect(appsAfter).toHaveLength(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // The specific clobber the brief warns about: `deploy()` sets `this.methodIndex`/
  // `this.localProcedures` from whatever it just compiled, so `run()`'s coverage resolution can
  // map a wire methodId back to a procedure name. A bisection candidate compiled through
  // compileCheck() must NEVER replace those — they describe the REAL artifact `run()` is about
  // to execute tests against, not a narrowed, possibly-different candidate subset.
  //
  // Proven end to end (not by inspecting private fields): deploy(dirA) establishes the real
  // coverage indexes from a source tree whose local procedure is named "LogAudit". compileCheck
  // (dirB) then compiles a DIFFERENT source tree — same codeunit id, but its local procedure is
  // named "OtherHelper" instead. If compileCheck ever reassigned localProcedures, the
  // methodId-999 fallback below would report "OtherHelper"; it must still report dirA's
  // "LogAudit".
  test("a candidate compile does not overwrite the coverage indexes deploy() established", async () => {
    const dirA = await mkdtemp(join(tmpdir(), "lethal-bcdev-compilecheck-clobber-a-"));
    const dirB = await mkdtemp(join(tmpdir(), "lethal-bcdev-compilecheck-clobber-b-"));
    const outputDir = await mkdtemp(join(tmpdir(), "lethal-bcdev-compilecheck-clobber-out-"));
    try {
      await writeDeployInputs(dirA);
      await writeDeployInputs(dirB);
      await Bun.write(
        join(dirA, "SandboxLogic.Codeunit.al"),
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
      await Bun.write(
        join(dirB, "SandboxLogic.Codeunit.al"),
        [
          'codeunit 79000 "Sandbox Logic"',
          "{",
          "    procedure ApplyAudit(Amount: Decimal)",
          "    begin",
          "        OtherHelper(Amount);",
          "    end;",
          "",
          "    local procedure OtherHelper(Amount: Decimal)",
          "    begin",
          "    end;",
          "}",
          "",
        ].join("\n"),
      );
      const symbolReference = {
        Codeunits: [
          { Id: 79000, Name: "Sandbox Logic", Methods: [{ Id: 333, Name: "ApplyAudit" }] },
        ],
      };
      const deployment = makeDeployment(outputDir, symbolReference);
      const server = new McpServer({ name: "fake-bc-dev", version: "0.0.0" });
      server.registerTool("bcdev_test_run", { inputSchema: anyArgs }, async () => ({
        content: [
          {
            type: "text",
            text: JSON.stringify({
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
                  // methodId 333 resolves by name (ApplyAudit); methodId 999 does not (it's
                  // `local`) and must fall back to crediting whichever local procedures
                  // `localProcedures` currently lists for codeunit 79000.
                  coveredProcedures: [
                    { objectType: 5, objectId: 79000, methodId: 333 },
                    { objectType: 5, objectId: 79000, methodId: 999 },
                  ],
                },
              ],
            }),
          },
        ],
      }));
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      void server.connect(serverTransport);
      const backend = new BcDevMcpBackend(
        { mcpCommand: ["unused"], project: "/al", server: "http://bc", serverInstance: "BC" },
        () => clientTransport,
        deployment,
      );

      await backend.deploy(dirA);
      await backend.compileCheck(dirB); // a bisection candidate against a DIFFERENT source tree

      const v = await backend.run(
        { codeunitId: 79100, codeunitName: "Sandbox Tests", method: "ClampPercentRuns" },
        { coverage: "procedure", timeoutMs: 5000 },
      );
      const procedures = v.coverage?.entries.map((e) => e.procedure).sort();
      expect(procedures).toEqual(["ApplyAudit", "LogAudit"]);
    } finally {
      await rm(dirA, { recursive: true, force: true });
      await rm(dirB, { recursive: true, force: true });
      await rm(outputDir, { recursive: true, force: true });
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
