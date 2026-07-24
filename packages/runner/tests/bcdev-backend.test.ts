import { describe, expect, mock, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { z } from "zod";
import {
  AlcCompileError,
  ArtifactCompiler,
  DeploymentError,
  defaultArtifactIo,
} from "../src/artifact";
import type { ArtifactIo, CompileInput } from "../src/artifact";
import { BcDevMcpBackend } from "../src/bcdev-backend";
import type { BcDevConfig, BcDevDeployment } from "../src/bcdev-backend";
import { DeploymentVerifier } from "../src/deployment-verifier";
import { CONTROL_APP_ID, HarnessVerificationError } from "../src/harness";
import type { HarnessVerifier } from "../src/harness";
import { requiresUnsafeLatch } from "../src/operation-outcome";
import { ContainerDeployer } from "../src/publisher";
import type { SpawnFn } from "../src/publisher";
import { RunMutantTransport } from "../src/run-mutant-transport";
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
 * `BcDevConfig.controlSymbolPath`/`packageCachePath` (Task 8): `deploy()`/`compileCheck()` now
 * unconditionally `cp`/`mkdir` a REAL LethAL Control symbol into `packageCachePath` via
 * `stageForCompile` — for any test that actually calls one of those, the fields must point at a
 * real file/dir the test controls, never a fake "C:/fake/..." string (that would try to write
 * outside the test's own tmp dir on the real filesystem). Both are rooted under `dir` so a
 * single `rm(dir, { recursive: true })` cleans everything up. The symbol fixture lives in its
 * own NESTED subdirectory (never a direct child of `dir` named `*.app`) so it can never be
 * mistaken for a compiled artifact by a test's own `readdir(dir)`-based `.app`-count assertion.
 */
async function controlStaging(
  dir: string,
): Promise<Pick<BcDevConfig, "controlSymbolPath" | "packageCachePath">> {
  const fixtureDir = join(dir, "control-fixture");
  await mkdir(fixtureDir, { recursive: true });
  const controlSymbolPath = join(fixtureDir, "lethal-control.app");
  await Bun.write(controlSymbolPath, "fake-lethal-control-app-bytes");
  return { controlSymbolPath, packageCachePath: join(dir, ".alpackages") };
}

/**
 * `BcDevConfig` staging fields for a backend that never calls `deploy()`/`compileCheck()` in a
 * given test — `stageForCompile` (and hence these two fields) is never read, so the values only
 * need to satisfy the type, never the filesystem.
 */
const UNUSED_STAGING_CFG = {
  controlSymbolPath: "C:/unused/lethal-control.app",
  packageCachePath: "C:/unused/.alpackages",
};

/**
 * `stageForCompile` (Task 8) creates `${instrumentedDir}-staged` as a SIBLING directory via a
 * real `cp` — outside whatever tmp dir a test passed to `deploy()`, so it survives that dir's
 * own cleanup and leaks under the OS tmp root unless removed explicitly. (`compileCheck()`
 * cleans its own staged copy internally — this helper is only needed after `deploy()`.)
 */
async function rmStaged(instrumentedDir: string): Promise<void> {
  await rm(`${instrumentedDir}-staged`, { recursive: true, force: true });
}

/** No-op fake `HarnessVerifier` — `verify()` resolves immediately, never throws. */
function fakeHarnessVerifier(): HarnessVerifier {
  return { verify: async () => {} } as HarnessVerifier;
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
  opts: { spawn?: SpawnFn; reportedIdentity?: string; harnessVerifier?: HarnessVerifier } = {},
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
  return {
    compiler,
    deployer,
    verifier,
    harnessVerifier: opts.harnessVerifier ?? fakeHarnessVerifier(),
  };
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
    {
      mcpCommand: ["unused"],
      project: "/al",
      server: "http://bc",
      serverInstance: "BC",
      ...UNUSED_STAGING_CFG,
    },
    () => clientTransport,
  );
}

/** `run()` never resolves the deadline race until its timer wins: a callTool that never
 * settles is exactly the harness `makeBackend` already supports (see the pre-existing
 * "bcdev has no runner-confirmed timeout" test below) — this is a thin named wrapper over it. */
function makeBackendWithHangingRun(): BcDevMcpBackend {
  return makeBackend(() => new Promise(() => {}) as never);
}

/**
 * Fails inside `connect()` itself — before any MCP handshake, let alone a `callTool` dispatch
 * — by throwing straight out of the injected `transportFactory`. `BcDevMcpBackend.connect()`
 * calls `this.transportFactory(env)` before constructing the `Client` or awaiting
 * `client.connect(transport)`, so this proves the failure is provably pre-dispatch: no fake
 * MCP server is ever wired up for this backend.
 */
function makeBackendWhoseConnectThrows(message: string): BcDevMcpBackend {
  return new BcDevMcpBackend(
    {
      mcpCommand: ["unused"],
      project: "/al",
      server: "http://bc",
      serverInstance: "BC",
      ...UNUSED_STAGING_CFG,
    },
    () => {
      throw new Error(message);
    },
  );
}

/**
 * Wraps a real, linked `InMemoryTransport` so the initialize handshake (and any other
 * non-tool-call message) passes through untouched — `client.connect()` completes normally —
 * but the `tools/call` request that `run()` dispatches rejects instead of reaching the fake
 * server. This is what distinguishes "rejected after dispatch" from
 * `makeBackendWhoseConnectThrows`: here `connect()` succeeds first.
 */
function makeRejectAfterDispatchTransport(inner: Transport, failMessage: string): Transport {
  const wrapper: Transport = {
    start: () => inner.start(),
    send: (message, options) => {
      if ((message as { method?: string }).method === "tools/call") {
        return Promise.reject(new Error(failMessage));
      }
      return inner.send(message, options);
    },
    close: () => inner.close(),
  };
  inner.onmessage = (message, extra) => wrapper.onmessage?.(message, extra);
  inner.onclose = () => wrapper.onclose?.();
  inner.onerror = (error) => wrapper.onerror?.(error);
  return wrapper;
}

function makeBackendWhoseCallRejectsAfterDispatch(message: string): BcDevMcpBackend {
  const server = new McpServer({ name: "fake-bc-dev", version: "0.0.0" });
  server.registerTool("bcdev_test_run", { inputSchema: anyArgs }, async () => ({
    content: [{ type: "text", text: JSON.stringify({ results: [] }) }],
  }));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  void server.connect(serverTransport);
  return new BcDevMcpBackend(
    {
      mcpCommand: ["unused"],
      project: "/al",
      server: "http://bc",
      serverInstance: "BC",
      ...UNUSED_STAGING_CFG,
    },
    () => makeRejectAfterDispatchTransport(clientTransport, message),
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
  runMutantTransportFactory?: (targetAppId: string, artifactId: string) => RunMutantTransport,
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
    {
      mcpCommand: ["unused"],
      project: "/al",
      server: "http://bc",
      serverInstance: "BC",
      ...(await controlStaging(outputDir)),
    },
    () => clientTransport,
    makeDeployment(outputDir, symbolReference),
    runMutantTransportFactory,
  );
  await backend.deploy(deployDir);
  return {
    backend,
    cleanup: async () => {
      await rmStaged(deployDir);
      await rm(outputDir, { recursive: true, force: true });
    },
  };
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
    // coverage discovery stays on the hub (bcdev_test_run); mutant execution (coverage:"none")
    // now routes to RunMutant, so the hub-path assertions run at coverage:"procedure".
    await backend.run(ref, { coverage: "procedure", timeoutMs: 5000 });
    expect(seen).toMatchObject({
      codeunits: [{ id: 79100, methods: ["PostingUpdatesTotal"] }],
      coverage: "procedure",
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
    const v = await backend.run(ref, { coverage: "procedure", timeoutMs: 5000 });
    expect(v.outcome).toBe("fail");
    expect(v.failureMessage).toBe("expected 2, got 1");
  });

  test("bcdev has no runner-confirmed timeout, so its deadline is deadline-exceeded", async () => {
    const backend = makeBackend(() => new Promise(() => {}) as never);
    const v = await backend.run(ref, { coverage: "procedure", timeoutMs: 50 });
    expect(v.outcome).toBe("deadline-exceeded");
  });

  test("transport error yields outcome=error", async () => {
    const backend = makeBackend(() => {
      throw new Error("NST unreachable");
    });
    const v = await backend.run(ref, { coverage: "procedure", timeoutMs: 5000 });
    expect(v.outcome).toBe("error");
    expect(v.failureMessage).toContain("NST unreachable");
  });

  test("run() deadline is in-flight-unknown (server may still be executing)", async () => {
    // Harness: a transportFactory whose callTool never resolves within the budget.
    const backend = makeBackendWithHangingRun();
    const v = await backend.run(
      { codeunitId: 50000, codeunitName: "T", method: "t1" },
      { coverage: "procedure", timeoutMs: 20 },
    );
    expect(v.outcome).toBe("deadline-exceeded");
    expect(v.operation).toBe("in-flight-unknown");
    expect(requiresUnsafeLatch(v.operation ?? "completed-accepted")).toBe(true);
  });

  test("run() connect failure before dispatch is pre-dispatch-rejected", async () => {
    const backend = makeBackendWhoseConnectThrows("ECONNREFUSED");
    const v = await backend.run(
      { codeunitId: 50000, codeunitName: "T", method: "t1" },
      { coverage: "procedure", timeoutMs: 1000 },
    );
    expect(v.outcome).toBe("error");
    expect(v.operation).toBe("pre-dispatch-rejected");
  });

  test("run() rejection AFTER dispatch is in-flight-unknown", async () => {
    const backend = makeBackendWhoseCallRejectsAfterDispatch("socket hang up");
    const v = await backend.run(
      { codeunitId: 50000, codeunitName: "T", method: "t1" },
      { coverage: "procedure", timeoutMs: 1000 },
    );
    expect(v.outcome).toBe("error");
    expect(v.operation).toBe("in-flight-unknown");
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
        ...UNUSED_STAGING_CFG,
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
        {
          mcpCommand: ["unused"],
          project: "/al",
          server: "http://bc",
          serverInstance: "BC",
          ...(await controlStaging(dir)),
        },
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
      await rmStaged(dir);
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("throws a typed DeploymentError when identity reports a different artifact", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lethal-bcdev-deploy-mismatch-"));
    try {
      await writeDeployInputs(dir);
      const backend = new BcDevMcpBackend(
        {
          mcpCommand: ["unused"],
          project: "/al",
          server: "http://bc",
          serverInstance: "BC",
          ...(await controlStaging(dir)),
        },
        undefined,
        makeDeployment(dir, { Codeunits: [] }, { reportedIdentity: "f".repeat(32) }),
      );
      const err = await backend.deploy(dir).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(DeploymentError);
      expect((err as DeploymentError).outcome).toBe("indeterminate");
      expect(String(err)).toMatch(/identity mismatch/);
    } finally {
      await rmStaged(dir);
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("injects the LethAL Control dependency into the staged app.json, stages the symbol, leaves the original untouched, and reclaims the staged copy", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lethal-bcdev-deploy-stage-"));
    try {
      await writeDeployInputs(dir);
      let capturedProjectDir: string | undefined;
      // Captured DURING compile(), not re-read after deploy() returns: deploy() now cleans up
      // its staged copy in a `finally` right after compile() settles (Important-1 fix), so by
      // the time this test can inspect anything, `capturedProjectDir` no longer exists on disk.
      let capturedAppJson: { dependencies?: Array<{ id: string }> } | undefined;
      const fakeCompiler = {
        compile: async (input: CompileInput) => {
          capturedProjectDir = input.projectDir;
          capturedAppJson = JSON.parse(
            await readFile(join(input.projectDir, "app.json"), "utf8"),
          ) as { dependencies?: Array<{ id: string }> };
          // deploy() reads the returned appPath's own SymbolReference.json right after compile()
          // returns (AppMethodIndex.fromAppFile) — must be a real, readable fake .app zip.
          const appPath = join(dir, "fake.app");
          await Bun.write(appPath, buildFakeApp({ Codeunits: [] }));
          return {
            artifactId: input.artifactId,
            appId: input.appId,
            appVersion: input.appVersion,
            appPath,
            sha256: "0".repeat(64),
            mutantManifest: input.mutantManifest,
            appManifest: input.appManifest,
          };
        },
      } as unknown as ArtifactCompiler;
      const { controlSymbolPath, packageCachePath } = await controlStaging(dir);
      const backend = new BcDevMcpBackend(
        {
          mcpCommand: ["unused"],
          project: "/al",
          server: "http://bc",
          serverInstance: "BC",
          controlSymbolPath,
          packageCachePath,
        },
        undefined,
        {
          compiler: fakeCompiler,
          deployer: { publish: async () => {} } as unknown as ContainerDeployer,
          verifier: {
            verify: async () => ({ status: "accepted" as const }),
          } as unknown as DeploymentVerifier,
          harnessVerifier: fakeHarnessVerifier(),
        },
      );
      await backend.deploy(dir);

      expect(capturedProjectDir).toBeDefined();
      expect(capturedAppJson?.dependencies?.some((d) => d.id === CONTROL_APP_ID)).toBe(true);

      // The shared instrumentedDir's own app.json — never mutated. al-runner reads this exact
      // dir directly, so any dependency leaking into it would break al-runner's dependency-free
      // compile.
      const originalAppJson = JSON.parse(await readFile(join(dir, "app.json"), "utf8")) as {
        dependencies?: unknown[];
      };
      expect(originalAppJson.dependencies).toBeUndefined();

      const stagedSymbol = await readFile(join(packageCachePath, "lethal-control.app"));
      expect(stagedSymbol.length).toBeGreaterThan(0);

      // Important-1 fix: deploy() reclaims its staged compile copy once compile() settles —
      // each batch has a distinct batchDir, so leaving `${batchDir}-staged` behind would
      // accumulate one full instrumented-project copy per batch across a session.
      await expect(stat(capturedProjectDir as string)).rejects.toThrow();
    } finally {
      await rmStaged(dir);
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("reclaims the staged compile copy even when compile() throws", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lethal-bcdev-deploy-stage-cleanup-throws-"));
    try {
      await writeDeployInputs(dir);
      const fakeCompiler = {
        compile: async () => {
          throw new AlcCompileError("boom");
        },
      } as unknown as ArtifactCompiler;
      const backend = new BcDevMcpBackend(
        {
          mcpCommand: ["unused"],
          project: "/al",
          server: "http://bc",
          serverInstance: "BC",
          ...(await controlStaging(dir)),
        },
        undefined,
        {
          compiler: fakeCompiler,
          deployer: {} as ContainerDeployer,
          verifier: {} as DeploymentVerifier,
          harnessVerifier: fakeHarnessVerifier(),
        },
      );
      await expect(backend.deploy(dir)).rejects.toBeInstanceOf(AlcCompileError);
      // Even on a compile failure, the staged copy must not linger — same `finally` cleanup as
      // the success path above.
      await expect(stat(`${dir}-staged`)).rejects.toThrow();
    } finally {
      await rmStaged(dir);
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("calls harnessVerifier.verify() unconditionally and aborts before compile if it throws", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lethal-bcdev-deploy-harness-abort-"));
    try {
      await writeDeployInputs(dir);
      const compile = mock(async () => {
        throw new Error("compile must not be called");
      });
      const fakeCompiler = { compile } as unknown as ArtifactCompiler;
      const verify = mock(async () => {
        throw new HarnessVerificationError("bad harness");
      });
      const backend = new BcDevMcpBackend(
        {
          mcpCommand: ["unused"],
          project: "/al",
          server: "http://bc",
          serverInstance: "BC",
          ...(await controlStaging(dir)),
        },
        undefined,
        {
          compiler: fakeCompiler,
          deployer: {} as ContainerDeployer,
          verifier: {} as DeploymentVerifier,
          harnessVerifier: { verify } as unknown as HarnessVerifier,
        },
      );
      await expect(backend.deploy(dir)).rejects.toBeInstanceOf(HarnessVerificationError);
      expect(verify).toHaveBeenCalledTimes(1);
      expect(compile).not.toHaveBeenCalled();
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
        {
          mcpCommand: ["unused"],
          project: "/al",
          server: "http://bc",
          serverInstance: "BC",
          ...(await controlStaging(dir)),
        },
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
        {
          mcpCommand: ["unused"],
          project: "/al",
          server: "http://bc",
          serverInstance: "BC",
          ...(await controlStaging(dir)),
        },
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
        {
          mcpCommand: ["unused"],
          project: "/al",
          server: "http://bc",
          serverInstance: "BC",
          ...(await controlStaging(dir)),
        },
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

  // Task 14 fold-in: the post-compile cleanup `rm(artifact.appPath, ...)` must be best-effort —
  // a failed cleanup (e.g. a transient Windows file lock) must never mask an already-decided
  // compile result behind an unrelated fs error. Provoked without relying on any OS-specific
  // locking behavior: a fake `writeArtifact` places the "compiled" artifact at a DIRECTORY path
  // instead of a file, so `rm(appPath, { force: true })` (no `recursive: true`) throws on the
  // directory regardless of platform — `force` only ignores a MISSING path, never a real fs
  // error like this one.
  test("compileCheck swallows a cleanup rm failure (does not mask the compile result)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lethal-bcdev-compilecheck-rmfail-"));
    try {
      await writeDeployInputs(dir);
      const io: ArtifactIo = {
        spawn: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
        readArtifact: async () => new Uint8Array([1, 2, 3]),
        writeArtifact: async (_from, to) => {
          await mkdir(to, { recursive: true }); // appPath now names a directory, not a file
        },
      };
      const compiler = new ArtifactCompiler(
        { alcPath: "C:/fake/alc.exe", packageCachePath: "C:/fake/.alpackages", outputDir: dir },
        io,
      );
      const backend = new BcDevMcpBackend(
        {
          mcpCommand: ["unused"],
          project: "/al",
          server: "http://bc",
          serverInstance: "BC",
          ...(await controlStaging(dir)),
        },
        undefined,
        {
          compiler,
          deployer: {} as ContainerDeployer,
          verifier: {} as DeploymentVerifier,
          harnessVerifier: fakeHarnessVerifier(),
        },
      );
      await expect(backend.compileCheck(dir)).resolves.toBeUndefined();
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
        {
          mcpCommand: ["unused"],
          project: "/al",
          server: "http://bc",
          serverInstance: "BC",
          ...(await controlStaging(outputDir)),
        },
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
      await rmStaged(dirA); // deploy()'s own staged copy — compileCheck() cleans dirB's internally
      await rm(dirA, { recursive: true, force: true });
      await rm(dirB, { recursive: true, force: true });
      await rm(outputDir, { recursive: true, force: true });
    }
  });
});

/** A fake RunMutant transport factory backed by a fetch that records each request body and
 *  echoes an identity-matching `status:ran` / `result:2` (pass) response. `attestation` lets a
 *  caller override the echoed `observedAny`/`identityMismatch` wire fields (default: absent,
 *  i.e. `RunMutantTransport` maps them to `{observedAny:false, identityMismatch:false}`). */
function capturingRunMutantFactory(
  bodies: Array<Record<string, unknown>>,
  attestation: { observedAny?: boolean; identityMismatch?: boolean } = {},
) {
  const captureFetch = (async (_url: unknown, init?: RequestInit) => {
    const b = JSON.parse(String(init?.body)) as Record<string, unknown>;
    bodies.push(b);
    const inner = {
      status: "ran",
      targetAppId: b.targetAppId,
      artifactId: b.artifactId,
      attemptId: b.attemptId,
      mutantId: b.mutantId,
      codeunitId: b.testCodeunitId,
      method: b.testMethod,
      codeunitResults: JSON.stringify({ testResults: [{ method: b.testMethod, result: 2 }] }),
      ...attestation,
    };
    return new Response(JSON.stringify({ value: JSON.stringify(inner) }), { status: 200 });
  }) as typeof fetch;
  return (targetAppId: string, artifactId: string) =>
    new RunMutantTransport(
      {
        baseUrl: "http://bc:7048/BC",
        company: "CRONUS",
        username: "u",
        password: "p",
        tenant: "default",
      },
      targetAppId,
      artifactId,
      captureFetch,
    );
}

describe("BcDevMcpBackend.activate — bookkeeping (Layer 5C-A)", () => {
  test("activate() never networks and never throws — no active client needed", async () => {
    const backend = new BcDevMcpBackend({
      mcpCommand: ["unused"],
      project: "/al",
      server: "http://bc",
      serverInstance: "BC",
      ...UNUSED_STAGING_CFG,
    });
    await backend.activate("M0007");
    await backend.activate(null);
    // No throw: there is no persistent server-side active state to set anymore.
  });

  test("run(coverage:none) before a successful deploy throws (transport not yet bound)", async () => {
    const backend = new BcDevMcpBackend({
      mcpCommand: ["unused"],
      project: "/al",
      server: "http://bc",
      serverInstance: "BC",
      ...UNUSED_STAGING_CFG,
    });
    await backend.activate("M0007");
    await expect(backend.run(ref, { coverage: "none", timeoutMs: 1000 })).rejects.toThrow(
      /RunMutant transport not configured/,
    );
  });

  test("the activated mutant flows into RunMutant; activate(null) sends baseline", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const { backend, cleanup } = await makeBackendWithDeploy(
      () => ({ results: [] }),
      {},
      undefined,
      capturingRunMutantFactory(bodies),
    );
    try {
      await backend.activate("M0003");
      const killed = await backend.run(ref, { coverage: "none", timeoutMs: 5000 });
      expect(killed.outcome).toBe("pass"); // fake echoes result:2

      await backend.activate(null);
      await backend.run(ref, { coverage: "none", timeoutMs: 5000 });

      expect(bodies[0]).toMatchObject({
        mutantId: "M0003",
        targetAppId: TEST_APP_ID,
        artifactId: TEST_ARTIFACT_ID,
        testCodeunitId: ref.codeunitId,
        testMethod: ref.method,
        leaseEpoch: "",
        leaseToken: "",
      });
      expect(bodies[1]).toMatchObject({ mutantId: "" });
    } finally {
      await cleanup();
    }
  });

  // TestVerdict.attestation (backend.ts, design §G) is set by RunMutantTransport and must
  // survive BcDevMcpBackend.runViaTransport()'s pass-through unchanged — this is what lets the
  // orchestrator's clean-attestation gate (Task 5/10) see it from run()'s return value.
  test("bcdev run() carries transport attestation through", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const { backend, cleanup } = await makeBackendWithDeploy(
      () => ({ results: [] }),
      {},
      undefined,
      capturingRunMutantFactory(bodies, { observedAny: true, identityMismatch: false }),
    );
    try {
      const v = await backend.run(ref, { coverage: "none", timeoutMs: 1000 });
      expect(v.attestation).toEqual({ observedAny: true, identityMismatch: false });
    } finally {
      await cleanup();
    }
  });
});
