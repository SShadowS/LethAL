import { describe, expect, mock, spyOn, test } from "bun:test";
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
import type { Lease } from "../src/lease";
import { requiresUnsafeLatch } from "../src/operation-outcome";
import { ContainerDeployer } from "../src/publisher";
import type { SpawnFn } from "../src/publisher";
import { RunMutantTransport } from "../src/run-mutant-transport";
import { buildFakeApp } from "./helpers/fake-app";

const ref = { codeunitId: 79100, codeunitName: "Sandbox Tests", method: "PostingUpdatesTotal" };

const TEST_ARTIFACT_ID = "0123456789abcdef0123456789abcdef";
const TEST_APP_ID = "11111111-1111-1111-1111-111111111111";

/** A held lease fixture (Layer 5C-B1) — `lastCompletedOpSeq: 4` so tests can assert the FIRST
 * `run(coverage:"none")` after `setLease()` sends `opSeq: 5` (design §5: exactly-next). */
const FAKE_LEASE: Lease = {
  epoch: 2,
  token: "tok-xyz",
  serverGeneration: "gen-abc",
  lastCompletedOpSeq: 4,
  expiresAt: "2026-07-24T00:05:00.000Z",
};

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
 * A minimal, valid `BcDevConfig` for tests that only touch `capabilities()`/`status()` and never
 * `deploy()`/`compileCheck()` — same shape as the literal repeated across `makeBackend` and the
 * activate/bookkeeping tests below, factored out for Task 5's `coverageMode`/`port` tests so they
 * don't have to restate every field just to layer on one override.
 */
function baseConfig(): BcDevConfig {
  return {
    mcpCommand: ["unused"],
    project: "/al",
    server: "http://bc",
    serverInstance: "BC",
    ...UNUSED_STAGING_CFG,
  };
}

/**
 * A `BcDevDeployment` stub for tests that need a `deployment` object to exist (so
 * `this.deployment?.harnessVerifier` resolves) but never call `deploy()`/`compileCheck()` — the
 * compiler/deployer/verifier fields are structurally present but never read. Callers overriding
 * `harnessVerifier` (e.g. the coverageMode:"none" status() tests) spread over this.
 */
function deploymentStub(): BcDevDeployment {
  return {
    compiler: {} as ArtifactCompiler,
    deployer: {} as ContainerDeployer,
    verifier: {} as DeploymentVerifier,
    harnessVerifier: fakeHarnessVerifier(),
  };
}

/**
 * `stageForCompile` (Task 8) creates `${instrumentedDir}-staged` as a SIBLING directory via a
 * real `cp` — outside whatever tmp dir a test passed to `deploy()`, so it survives that dir's
 * own cleanup and leaks under the OS tmp root unless removed explicitly. (`compileCheck()`
 * cleans its own staged copy internally — this helper is only needed after `deploy()`.)
 */
async function rmStaged(instrumentedDir: string): Promise<void> {
  await rm(`${instrumentedDir}-staged`, { recursive: true, force: true });
}

/**
 * No-op fake `HarnessVerifier` — `verify()` resolves immediately, never throws. Cast through
 * `unknown`: since Layer 5C-B1 `verify()` returns `HarnessDetails` (protocol version, the
 * container's `serverGeneration`, and whether design §7's tenant gate was actually enforced), so
 * a bare `{ verify }` object no longer structurally overlaps the class. Nothing in `deploy()`
 * reads the returned details — the orchestrator does, via its own verifier — so a resolved
 * placeholder is enough here.
 */
function fakeHarnessVerifier(): HarnessVerifier {
  return {
    verify: async () => ({
      protocolVersion: 2,
      serverGeneration: "f".repeat(32),
      tenantGate: "unenforced" as const,
    }),
  } as unknown as HarnessVerifier;
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
  overrides: Partial<BcDevConfig> = {},
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
      ...overrides,
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

  // R63: the pre-fix behaviour expanded an unresolvable methodId to EVERY local procedure in the
  // object. Measured on Continia Document Output: one genuinely-executed local credited five
  // tests with all ten locals of the codeunit, and 77 mutants in procedures those tests cannot
  // reach were scored `survived` against them — confident, non-empty, WRONG covering sets. The
  // expansion's doc comment called it safe because it "never hides a real kill"; it manufactures
  // false survivors instead. An unresolvable member is now emitted at OBJECT level, which lands
  // in `byObject` (sound, one precision level coarser) and never invents member credit.
  test("emits an unresolvable methodId at OBJECT level, never expanded to local-procedure guesses", async () => {
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
      // ApplyAudit names exactly; methodId 999 says only "79000 executed an unnamed member" —
      // one object-level entry, and crucially NO `LogAudit` member entry.
      expect(v.coverage?.entries).toEqual([
        { objectType: "Codeunit", objectId: 79000, procedure: "ApplyAudit" },
        { objectType: "Codeunit", objectId: 79000 },
      ]);
    } finally {
      await cleanup();
      await rm(dir, { recursive: true, force: true });
    }
  });

  // R61, measured on `sandbox-data` and again on Document Output: the hub payload covers
  // everything the platform executed — Base App (`Codeunit:423`), the test framework
  // (`Codeunit:130011/130012`), LethAL's own control app (`Codeunit:71002`) — and the old code
  // emitted object-level entries for all of it: byObject credit for code the run does not own,
  // one manifest-id coincidence away from R29's shape. Objects outside the compiled artifact's
  // SymbolReference are now skipped, same scope rule the fenced path applies.
  test("skips coverage for objects the compiled artifact does not declare", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lethal-bcdev-backend-foreign-"));
    await Bun.write(
      join(dir, "SandboxLogic.Codeunit.al"),
      [
        'codeunit 79000 "Sandbox Logic"',
        "{",
        "    procedure ApplyAudit(Amount: Decimal)",
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
            coveredProcedures: [
              { objectType: 5, objectId: 79000, methodId: 333 }, // own, resolves
              { objectType: 5, objectId: 423, methodId: 42 }, // Base App — foreign
              { objectType: 5, objectId: 71002, methodId: 7 }, // LethAL Control — foreign
              { objectType: 5, objectId: 130011, methodId: 1 }, // test framework — foreign
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
      expect(v.coverage?.entries).toEqual([
        { objectType: "Codeunit", objectId: 79000, procedure: "ApplyAudit" },
      ]);
    } finally {
      await cleanup();
      await rm(dir, { recursive: true, force: true });
    }
  });

  // The false-survivor bug, at its seam. BC DOES report coverage for table-trigger code (measured
  // on Cronus282: table 79300, methodId -1650094725 for one test, 2060272969 for another), but
  // SymbolReference.json records no trigger, so `AppMethodIndex.lookup` returns undefined — and a
  // table whose procedures are all PUBLIC has no local-procedure fallback either. The old code
  // emitted NOTHING for such an observation, so the object lost credit along with the member:
  // `byObject` held only the sibling test whose methodId happened to resolve, `coverageFilter`'s
  // FALLBACK 1 returned that non-empty-but-wrong set, FALLBACK 2 never fired, and every table
  // trigger mutant ran against one irrelevant test. 10 of 20 survivors were false.
  test("credits the OBJECT when a methodId resolves to no name and the object declares no local procedure", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lethal-bcdev-backend-objlevel-"));
    await Bun.write(
      join(dir, "DataMain.Table.al"),
      [
        // Deliberately NO `local procedure` anywhere — both procedures are public, which is the
        // shape of every real app's tables and the reason the local-procedure fallback is empty.
        'table 79300 "Data Main"',
        "{",
        '    fields { field(1; "No."; Code[20]) { trigger OnValidate() begin Touch(); end; } }',
        "",
        "    procedure Touch()",
        "    begin",
        "    end;",
        "",
        "    procedure TouchCount(): Integer",
        "    begin",
        "        exit(1);",
        "    end;",
        "}",
        "",
      ].join("\n"),
    );
    const { backend, cleanup } = await makeBackendWithDeploy(
      () => ({
        results: [
          { codeunitId: 79100, method: "ValidatesNo", status: "passed", durationMs: 1, output: "" },
        ],
        coverage: [
          {
            testObjectId: 79100,
            testMethodId: 111,
            // The real trigger methodId observed live. It is in no SymbolReference.json, and
            // table 79300 declares no local procedure, so BOTH naming routes come up empty.
            coveredProcedures: [{ objectType: 1, objectId: 79300, methodId: -1650094725 }],
          },
        ],
      }),
      { Tables: [{ Id: 79300, Name: "Data Main", Methods: [{ Id: 777, Name: "Touch" }] }] },
      dir,
    );
    try {
      const v = await backend.run(
        { codeunitId: 79100, codeunitName: "Sandbox Data Tests", method: "ValidatesNo" },
        { coverage: "procedure", timeoutMs: 5000 },
      );
      // Not nothing: one entry, naming the object and NO member.
      expect(v.coverage?.entries).toEqual([{ objectType: "Table", objectId: 79300 }]);
      // Absence is the property being ABSENT, never "" — an empty string would key `byMember` as
      // `table:79300::`, colliding with the empty member key a trigger mutant itself builds.
      const [only] = v.coverage?.entries ?? [];
      expect(only === undefined ? "MISSING" : "procedure" in only).toBe(false);
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

  // The specific clobber the brief warns about: `deploy()` sets `this.methodIndex` from
  // whatever it just compiled, so `run()`'s coverage resolution can map a wire methodId back to
  // a procedure name. A bisection candidate compiled through compileCheck() must NEVER replace
  // it — it describes the REAL artifact `run()` is about to execute tests against, not a
  // narrowed, possibly-different candidate subset.
  //
  // Proven end to end (not by inspecting private fields): deploy(dirA) compiles a symbol
  // reference naming methodId 333 "ApplyAudit". compileCheck(dirB) then compiles a DIFFERENT
  // candidate whose symbol reference names the SAME methodId "RenamedAudit" — if compileCheck
  // ever reassigned methodIndex, the run below would resolve 333 to "RenamedAudit"; it must
  // still report dirA's "ApplyAudit". (The pre-R63 observable was the local-procedure fallback;
  // that fallback is gone, so the clobber is now observed at the methodIndex itself.)
  test("a candidate compile does not overwrite the coverage index deploy() established", async () => {
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
          "    procedure RenamedAudit(Amount: Decimal)",
          "    begin",
          "    end;",
          "}",
          "",
        ].join("\n"),
      );
      // Each alc invocation writes the NEXT symbol reference: deploy() sees 333=ApplyAudit,
      // compileCheck() sees 333=RenamedAudit.
      const symbolReferences = [
        {
          Codeunits: [
            { Id: 79000, Name: "Sandbox Logic", Methods: [{ Id: 333, Name: "ApplyAudit" }] },
          ],
        },
        {
          Codeunits: [
            { Id: 79000, Name: "Sandbox Logic", Methods: [{ Id: 333, Name: "RenamedAudit" }] },
          ],
        },
      ];
      let compiles = 0;
      const spawn: SpawnFn = async (argv) => {
        const out = argv.find((a) => a.startsWith("/out:"))?.slice("/out:".length);
        if (argv[0]?.includes("alc") && out !== undefined) {
          const ref = symbolReferences[Math.min(compiles, symbolReferences.length - 1)];
          compiles++;
          await Bun.write(out, buildFakeApp(ref));
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      };
      const deployment = makeDeployment(outputDir, symbolReferences[0] ?? {}, { spawn });
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
                  // methodId 333 resolves by name through whichever SymbolReference methodIndex
                  // currently holds — dirA's (correct) or dirB's (the clobber being tested).
                  coveredProcedures: [{ objectType: 5, objectId: 79000, methodId: 333 }],
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
      expect(v.coverage?.entries).toEqual([
        { objectType: "Codeunit", objectId: 79000, procedure: "ApplyAudit" },
      ]);
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

  // Layer 5C-B1: the transport is bound (deploy() succeeded), but the orchestrator hasn't called
  // setLease() yet — must fail loudly, never send a RunMutant with a missing/fabricated lease
  // tuple (the "empty-vs-empty match" this project treats as its signature bug).
  test("run(coverage:none) with a bound transport but no lease bound throws (setLease not called)", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const { backend, cleanup } = await makeBackendWithDeploy(
      () => ({ results: [] }),
      {},
      undefined,
      capturingRunMutantFactory(bodies),
    );
    try {
      await expect(backend.run(ref, { coverage: "none", timeoutMs: 1000 })).rejects.toThrow(
        /no lease bound/,
      );
      expect(bodies).toHaveLength(0); // never dispatched
    } finally {
      await cleanup();
    }
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
      backend.setLease(FAKE_LEASE);
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
        leaseEpoch: FAKE_LEASE.epoch,
        leaseToken: FAKE_LEASE.token,
        serverGeneration: FAKE_LEASE.serverGeneration,
        opSeq: FAKE_LEASE.lastCompletedOpSeq + 1, // seeded from lastCompletedOpSeq, exactly-next
      });
      expect(bodies[1]).toMatchObject({
        mutantId: "",
        opSeq: FAKE_LEASE.lastCompletedOpSeq + 2, // incremented once per RunMutant call issued
      });
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
      backend.setLease(FAKE_LEASE);
      const v = await backend.run(ref, { coverage: "none", timeoutMs: 1000 });
      expect(v.attestation).toEqual({ observedAny: true, identityMismatch: false });
    } finally {
      await cleanup();
    }
  });
});

/** A fake RunMutant transport factory whose fetch always answers `status:"lease-invalid"` with
 *  the given `reason` (or none), echoing the request's own identity fields back — exactly what
 *  ControlApi.RunMutant's BuildStatus does on every phase-1 refusal (it echoes the caller's own
 *  input params regardless of status), so this must echo them too or the transport's identity
 *  guard (§I5) rejects the response before ever reaching the lease-invalid branch. Used to prove
 *  `BcDevMcpBackend.run()`'s pass-through never loses the distinction between a genuine lost
 *  lease and an "op-in-flight" same-attempt duplicate. */
function leaseInvalidRunMutantFactory(reason?: string) {
  const fetchFn = (async (_url: unknown, init?: RequestInit) => {
    const b = JSON.parse(String(init?.body)) as Record<string, unknown>;
    const inner = {
      status: "lease-invalid",
      ...(reason !== undefined ? { reason } : {}),
      targetAppId: b.targetAppId,
      artifactId: b.artifactId,
      attemptId: b.attemptId,
      mutantId: b.mutantId,
      codeunitId: b.testCodeunitId,
      method: b.testMethod,
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
      fetchFn,
    );
}

// THE BINDING REQUIREMENT (design §5/§8): a lease-invalid RunMutant result must never parse into
// anything a caller could mistake for a successful run, AND the op-in-flight sub-case (the
// caller's own attempt still active server-side) must stay distinguishable from a genuine lost
// lease all the way through BcDevMcpBackend.run()'s pass-through — never silently folded into an
// indistinguishable operation:"lease-lost".
describe("BcDevMcpBackend.run — lease-invalid pass-through (Layer 5C-B1)", () => {
  test("genuine lease-invalid (reason:'lease-invalid') -> error + operation:lease-lost, reason preserved", async () => {
    const { backend, cleanup } = await makeBackendWithDeploy(
      () => ({ results: [] }),
      {},
      undefined,
      leaseInvalidRunMutantFactory("lease-invalid"),
    );
    try {
      backend.setLease(FAKE_LEASE);
      const v = await backend.run(ref, { coverage: "none", timeoutMs: 1000 });
      expect(v.outcome).toBe("error");
      expect(v.operation).toBe("lease-lost");
      expect(v.leaseInvalidReason).toBe("lease-invalid");
      expect(requiresUnsafeLatch(v.operation ?? "completed-accepted")).toBe(true);
    } finally {
      await cleanup();
    }
  });

  test("op-in-flight duplicate claim -> error + operation:lease-lost BUT leaseInvalidReason:'op-in-flight' distinguishes it", async () => {
    const { backend, cleanup } = await makeBackendWithDeploy(
      () => ({ results: [] }),
      {},
      undefined,
      leaseInvalidRunMutantFactory("op-in-flight"),
    );
    try {
      backend.setLease(FAKE_LEASE);
      const v = await backend.run(ref, { coverage: "none", timeoutMs: 1000 });
      expect(v.outcome).toBe("error");
      expect(v.operation).toBe("lease-lost");
      // The distinguishing signal Task 8 must branch on BEFORE treating this as genuine loss.
      expect(v.leaseInvalidReason).toBe("op-in-flight");
    } finally {
      await cleanup();
    }
  });
});

describe("coverageMode", () => {
  test("defaults to procedure and probes status through bc-dev-mcp", () => {
    const backend = new BcDevMcpBackend(baseConfig());
    expect(backend.capabilities().coverage).toBe("procedure");
  });

  test('reports coverage "none" when configured, keeping authoritative true', () => {
    const backend = new BcDevMcpBackend({ ...baseConfig(), coverageMode: "none" });
    expect(backend.capabilities().coverage).toBe("none");
    expect(backend.capabilities().authoritative).toBe(true);
  });

  test('status() in "none" mode probes the harness, never bc-dev-mcp', async () => {
    let harnessCalls = 0;
    const harnessVerifier = {
      verify: async () => {
        harnessCalls += 1;
        return { serverGeneration: "g1" } as never;
      },
    };
    const backend = new BcDevMcpBackend(
      { ...baseConfig(), coverageMode: "none" },
      () => {
        throw new Error("bc-dev-mcp must not be contacted in coverage:none mode");
      },
      { ...deploymentStub(), harnessVerifier } as never,
    );
    const status = await backend.status();
    expect(status.ok).toBe(true);
    expect(harnessCalls).toBe(1);
  });

  test('throws in "none" mode when no harness verifier was provided', async () => {
    const backend = new BcDevMcpBackend({ ...baseConfig(), coverageMode: "none" });
    await expect(backend.status()).rejects.toThrow(/harnessVerifier/);
  });

  // Ledger item m10 (final review): `harnessVerifier.verify()` itself throwing (a real HarnessInfo
  // failure — network error, HTTP 404, malformed response) must map to `{ok: false}` like every
  // other status() failure mode, never rethrow — the orchestrator's readiness gate expects a
  // BackendStatus, not an exception, from status().
  test('status() in "none" mode maps a harnessVerifier.verify() failure to {ok:false}, never a throw', async () => {
    const harnessVerifier = {
      verify: async () => {
        throw new Error("HarnessInfo failed: HTTP 404");
      },
    };
    const backend = new BcDevMcpBackend(
      { ...baseConfig(), coverageMode: "none" },
      () => {
        throw new Error("bc-dev-mcp must not be contacted in coverage:none mode");
      },
      { ...deploymentStub(), harnessVerifier } as never,
    );
    const status = await backend.status();
    expect(status.ok).toBe(false);
    expect(status.details).toContain("HarnessInfo failed");
  });
});

// A path-routed HTTPS portal (Continia) has no listener at bc-dev-mcp's OnPrem fallback port
// (7049) — the resolved port must actually reach the wire call, not just live on the config
// object. Asserted on the arguments bc-dev-mcp's OWN tool handler receives (McpServer +
// InMemoryTransport, the same live-round-trip pattern `makeBackend`/`statusHandler` already use
// in this file), not on a private-method reach-in, since `connectionParams()` is private and the
// wire arguments are the thing that actually matters.
describe("port in connectionParams", () => {
  test("omits port from bcdev_status's arguments when the config sets none", async () => {
    let seenArgs: Record<string, unknown> = {};
    const backend = makeBackend(
      () => ({ results: [] }),
      (args) => {
        seenArgs = args as Record<string, unknown>;
        return "ok";
      },
    );
    await backend.status();
    expect(seenArgs.port).toBeUndefined();
  });

  test("carries port through to bcdev_status's arguments when the config sets one", async () => {
    let seenArgs: Record<string, unknown> = {};
    const backend = makeBackend(
      () => ({ results: [] }),
      (args) => {
        seenArgs = args as Record<string, unknown>;
        return "ok";
      },
      { port: 443 },
    );
    await backend.status();
    expect(seenArgs.port).toBe(443);
  });
});
/**
 * R58 — `coverageMode: "fenced"`: per-procedure coverage collected on the SAME fenced session the
 * mutants run on. The three routing bugs these tests pin were all SILENT: each left the mode
 * looking configured and behaving like the old one.
 */
describe('coverageMode "fenced" (R58)', () => {
  /**
   * A fenced transport factory: records the URL and body of each call and answers with an
   * identity-echoing `ran` result carrying `coverageRows`. A REAL `RunMutantTransport` (not a stub)
   * so the action-name selection and the coverage parsing are both exercised end to end.
   */
  function fencedRunMutantFactory(
    calls: Array<{ url: string; body: Record<string, unknown> }>,
    coverageRows: unknown,
  ) {
    const captureFetch = (async (url: unknown, init?: RequestInit) => {
      const b = JSON.parse(String(init?.body)) as Record<string, unknown>;
      calls.push({ url: String(url), body: b });
      const inner = {
        status: "ran",
        targetAppId: b.targetAppId,
        artifactId: b.artifactId,
        attemptId: b.attemptId,
        mutantId: b.mutantId,
        codeunitId: b.testCodeunitId,
        method: b.testMethod,
        codeunitResults: JSON.stringify({ testResults: [{ method: b.testMethod, result: 2 }] }),
        coverage: coverageRows,
      };
      return new Response(JSON.stringify({ value: JSON.stringify(inner) }), { status: 200 });
    }) as typeof fetch;
    return (targetAppId: string, artifactId: string) =>
      new RunMutantTransport(
        { baseUrl: "http://bc:7048/BC", company: "CRONUS", username: "u", password: "p" },
        targetAppId,
        artifactId,
        captureFetch,
      );
  }

  /** One codeunit whose lines are counted out, so the assertions below name real boundaries.
   *  1 codeunit 79100 "Ours"   2 {   3 procedure Alpha()   4 begin   5 end;   6 } */
  const OURS_AL = `codeunit 79100 "Ours"
{
    procedure Alpha()
    begin
    end;
}
`;

  /**
   * A deployed fenced backend over a REAL instrumented dir, so the line map is built from source
   * the way production builds it, and scoped by the compiled package's own symbol reference.
   */
  async function fencedBackend(
    calls: Array<{ url: string; body: Record<string, unknown> }>,
    coverageRows: unknown,
    idRangesOverride?: Record<string, unknown>,
  ): Promise<{ backend: BcDevMcpBackend; cleanup: () => Promise<void> }> {
    const outputDir = await mkdtemp(join(tmpdir(), "lethal-fenced-test-"));
    await writeDeployInputs(outputDir);
    // The fenced path reads the artifact's OWN idRanges out of this file to build the server-side
    // `Code Coverage."Object ID"` filter — see `coverageObjectIdFilterOf`.
    const appJsonPath = join(outputDir, "app.json");
    const app = JSON.parse(await readFile(appJsonPath, "utf8")) as Record<string, unknown>;
    await Bun.write(
      appJsonPath,
      JSON.stringify({
        ...app,
        ...(idRangesOverride ?? { idRanges: [{ from: 79000, to: 79199 }] }),
      }),
    );
    await Bun.write(join(outputDir, "Ours.Codeunit.al"), OURS_AL);
    const backend = new BcDevMcpBackend(
      {
        mcpCommand: ["unused"],
        project: "/al",
        server: "http://bc",
        serverInstance: "BC",
        coverageMode: "fenced",
        ...(await controlStaging(outputDir)),
      },
      () => {
        throw new Error("bc-dev-mcp must not be contacted in fenced mode");
      },
      makeDeployment(outputDir, { Codeunits: [{ Id: 79100, Name: "Ours" }] }),
      fencedRunMutantFactory(calls, coverageRows),
    );
    await backend.deploy(outputDir);
    backend.setLease(FAKE_LEASE);
    await backend.activate(null);
    return {
      backend,
      cleanup: async () => {
        await rmStaged(outputDir);
        await rm(outputDir, { recursive: true, force: true });
      },
    };
  }

  test("capabilities() reports the mode verbatim, still authoritative", () => {
    const backend = new BcDevMcpBackend({ ...baseConfig(), coverageMode: "fenced" });
    expect(backend.capabilities().coverage).toBe("fenced");
    expect(backend.capabilities().authoritative).toBe(true);
  });

  test("status() probes the harness, NEVER bc-dev-mcp — the dependency the mode removes", async () => {
    // The bug this pins: `status()` branched on `=== "none"`, so fenced fell through and probed the
    // hub. It would have succeeded everywhere the hub works and failed only where the mode matters.
    let harnessCalls = 0;
    const harnessVerifier = {
      verify: async () => {
        harnessCalls += 1;
        return { serverGeneration: "g1" } as never;
      },
    };
    const backend = new BcDevMcpBackend(
      { ...baseConfig(), coverageMode: "fenced" },
      () => {
        throw new Error("bc-dev-mcp must not be contacted in fenced mode");
      },
      { ...deploymentStub(), harnessVerifier } as never,
    );
    const status = await backend.status();
    expect(status.ok).toBe(true);
    expect(harnessCalls).toBe(1);
  });

  test("a fenced run goes to RunMutantWithCoverage, not the hub", async () => {
    // The bug this pins: `run()` dispatched on `opts.coverage !== "none"`, so a fenced baseline —
    // which requests coverage — went to the hub, and the mode measured exactly the session it
    // exists to stop using. The MCP transport factory above throws if it is ever contacted.
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const { backend, cleanup } = await fencedBackend(calls, []);
    try {
      const v = await backend.run(ref, { coverage: "fenced", timeoutMs: 1000 });
      expect(v.outcome).toBe("pass");
      expect(calls).toHaveLength(1);
      expect(calls[0]?.url).toContain("LethALControl_RunMutantWithCoverage");
      expect(calls[0]?.body.mutantId).toBe(""); // baseline
    } finally {
      await cleanup();
    }
  });

  test("maps a line inside a procedure to a member entry, and line 0 to an object entry", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const { backend, cleanup } = await fencedBackend(calls, [
      { objectType: 5, objectId: 79100, lineNo: 0, hits: 1 },
      { objectType: 5, objectId: 79100, lineNo: 3, hits: 1 },
      { objectType: 5, objectId: 79100, lineNo: 5, hits: 2 },
    ]);
    try {
      const v = await backend.run(ref, { coverage: "fenced", timeoutMs: 1000 });
      expect(v.coverage?.granularity).toBe("procedure");
      expect(v.coverage?.entries).toEqual([
        { objectType: "Codeunit", objectId: 79100 },
        { objectType: "Codeunit", objectId: 79100, procedure: "Alpha" },
      ]);
    } finally {
      await cleanup();
    }
  });

  test("rows for objects the artifact does not declare are SKIPPED, not errors and not entries", async () => {
    // `CoverageArray` serializes the whole Code Coverage table — Base App, System App, Test Runner,
    // Continia Core. Treating those as errors aborts every real run; emitting them bloats every
    // baseline verdict with hundreds of rows that can never match a mutant.
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const { backend, cleanup } = await fencedBackend(calls, [
      { objectType: 5, objectId: 1, hits: 9, lineNo: 40 }, // Base App codeunit
      { objectType: 1, objectId: 18, hits: 4, lineNo: 100 }, // Table Customer
      { objectType: 5, objectId: 79100, lineNo: 4, hits: 1 },
    ]);
    try {
      const v = await backend.run(ref, { coverage: "fenced", timeoutMs: 1000 });
      expect(v.coverage?.entries).toEqual([
        { objectType: "Codeunit", objectId: 79100, procedure: "Alpha" },
      ]);
    } finally {
      await cleanup();
    }
  });

  test("a covered procedure's many line rows collapse to ONE entry", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const { backend, cleanup } = await fencedBackend(
      calls,
      [3, 4, 5].map((lineNo) => ({ objectType: 5, objectId: 79100, lineNo, hits: 1 })),
    );
    try {
      const v = await backend.run(ref, { coverage: "fenced", timeoutMs: 1000 });
      expect(v.coverage?.entries).toEqual([
        { objectType: "Codeunit", objectId: 79100, procedure: "Alpha" },
      ]);
    } finally {
      await cleanup();
    }
  });

  test("no entry ever carries a blank procedure — it would collide with a trigger mutant's key", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const { backend, cleanup } = await fencedBackend(calls, [
      { objectType: 5, objectId: 79100, lineNo: 2, hits: 1 },
    ]);
    try {
      const v = await backend.run(ref, { coverage: "fenced", timeoutMs: 1000 });
      for (const e of v.coverage?.entries ?? []) expect(e.procedure).not.toBe("");
      expect(v.coverage?.entries).toEqual([{ objectType: "Codeunit", objectId: 79100 }]);
    } finally {
      await cleanup();
    }
  });

  test("a fenced-coverage run with a mutant still pending REFUSES — it would be a mutated baseline", async () => {
    // `runViaTransport` sends `pendingMutantId ?? ""`. A stale id runs the ENTIRE baseline against
    // a mutant: no crash, no error verdict, just a green set measured on mutated code.
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const { backend, cleanup } = await fencedBackend(calls, []);
    try {
      await backend.activate("M0007");
      await expect(backend.run(ref, { coverage: "fenced", timeoutMs: 1000 })).rejects.toThrow(
        /BASELINE run, but mutant M0007 is still pending/,
      );
      expect(calls).toHaveLength(0); // never dispatched
    } finally {
      await cleanup();
    }
  });

  test("mutant runs are unaffected: the plain RunMutant action still carries them", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const { backend, cleanup } = await fencedBackend(calls, []);
    try {
      await backend.activate("M0007");
      const v = await backend.run(ref, { coverage: "none", timeoutMs: 1000 });
      expect(v.outcome).toBe("pass");
      expect(v.coverage).toBeUndefined();
      expect(calls[0]?.url).toContain("LethALControl_RunMutant?");
      expect(calls[0]?.url).not.toContain("WithCoverage");
      expect(calls[0]?.body.mutantId).toBe("M0007");
    } finally {
      await cleanup();
    }
  });
});
/**
 * R58's server-side object filter, and the reason the client half could not ship without it.
 *
 * MEASURED 2026-07-28 on Cronus281, `fixtures/sandbox-app`, control app 1.0.0.8: unfiltered,
 * `RunMutantWithCoverage` did not return HEADERS within 300 s, and the fetch that gave up was
 * classified `in-flight-unknown`, i.e. a durable tier quarantine. The whole test body is three
 * lines — the cost is not the target's code, it is the `Code Coverage` table holding every line the
 * platform recorded during the run (the entire Test Runner and Base App machinery). Filtered to the
 * artifact's own `idRanges` the same call answered in **126 ms with 1,546 bytes**.
 *
 * Only rows for objects the artifact DECLARES can ever be attributed (`buildFencedCoverageMap` rule
 * 1 skips every other one), so the filter throws away nothing the client could have used. It is not
 * load-bearing for CORRECTNESS either — the client re-checks each row against the compiled
 * package's `SymbolReference.json` — which is why a too-wide filter costs only bytes.
 */
describe("fenced coverage — the server-side object-id filter", () => {
  function captureFactory(calls: Array<{ url: string; body: Record<string, unknown> }>) {
    const captureFetch = (async (url: unknown, init?: RequestInit) => {
      const b = JSON.parse(String(init?.body)) as Record<string, unknown>;
      calls.push({ url: String(url), body: b });
      const inner = {
        status: "ran",
        targetAppId: b.targetAppId,
        artifactId: b.artifactId,
        attemptId: b.attemptId,
        mutantId: b.mutantId,
        codeunitId: b.testCodeunitId,
        method: b.testMethod,
        codeunitResults: JSON.stringify({ testResults: [{ method: b.testMethod, result: 2 }] }),
        coverage: [],
      };
      return new Response(JSON.stringify({ value: JSON.stringify(inner) }), { status: 200 });
    }) as typeof fetch;
    return (targetAppId: string, artifactId: string) =>
      new RunMutantTransport(
        { baseUrl: "http://bc:7048/BC", company: "CRONUS", username: "u", password: "p" },
        targetAppId,
        artifactId,
        captureFetch,
      );
  }

  const OURS_AL = `codeunit 79100 "Ours"
{
    procedure Alpha()
    begin
    end;
}
`;

  async function deployFenced(
    calls: Array<{ url: string; body: Record<string, unknown> }>,
    appJsonExtra: Record<string, unknown>,
  ): Promise<{ backend: BcDevMcpBackend; cleanup: () => Promise<void> }> {
    const outputDir = await mkdtemp(join(tmpdir(), "lethal-fenced-filter-"));
    await writeDeployInputs(outputDir);
    const appJsonPath = join(outputDir, "app.json");
    const app = JSON.parse(await readFile(appJsonPath, "utf8")) as Record<string, unknown>;
    await Bun.write(appJsonPath, JSON.stringify({ ...app, ...appJsonExtra }));
    await Bun.write(join(outputDir, "Ours.Codeunit.al"), OURS_AL);
    const backend = new BcDevMcpBackend(
      {
        mcpCommand: ["unused"],
        project: "/al",
        server: "http://bc",
        serverInstance: "BC",
        coverageMode: "fenced",
        ...(await controlStaging(outputDir)),
      },
      () => {
        throw new Error("bc-dev-mcp must not be contacted in fenced mode");
      },
      makeDeployment(outputDir, { Codeunits: [{ Id: 79100, Name: "Ours" }] }),
      captureFactory(calls),
    );
    await backend.deploy(outputDir);
    backend.setLease(FAKE_LEASE);
    await backend.activate(null);
    return {
      backend,
      cleanup: async () => {
        await rmStaged(outputDir);
        await rm(outputDir, { recursive: true, force: true });
      },
    };
  }

  test("sends the artifact's own idRanges as an AL SetFilter expression", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const { backend, cleanup } = await deployFenced(calls, {
      idRanges: [{ from: 79000, to: 79199 }],
    });
    try {
      await backend.run(ref, { coverage: "fenced", timeoutMs: 1000 });
      expect(calls[0]?.body.coverageObjectIdFilter).toBe("79000..79199");
    } finally {
      await cleanup();
    }
  });

  test("joins several ranges with AL's OR separator", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const { backend, cleanup } = await deployFenced(calls, {
      idRanges: [
        { from: 6175200, to: 6175499 },
        { from: 79000, to: 79199 },
      ],
    });
    try {
      await backend.run(ref, { coverage: "fenced", timeoutMs: 1000 });
      expect(calls[0]?.body.coverageObjectIdFilter).toBe("6175200..6175499|79000..79199");
    } finally {
      await cleanup();
    }
  });

  test("accepts the legacy singular idRange a real project may still declare", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const { backend, cleanup } = await deployFenced(calls, {
      idRange: { from: 50000, to: 50099 },
    });
    try {
      await backend.run(ref, { coverage: "fenced", timeoutMs: 1000 });
      expect(calls[0]?.body.coverageObjectIdFilter).toBe("50000..50099");
    } finally {
      await cleanup();
    }
  });

  test("a manifest with NO range refuses at deploy rather than sending an empty filter", async () => {
    // An empty filter is not a benign default — it is the 300 s hang, which the client classifies
    // `in-flight-unknown` and turns into a durable tier quarantine. Failing here names the manifest.
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    await expect(deployFenced(calls, { idRanges: [] })).rejects.toThrow(
      /declares no usable idRanges/,
    );
  });

  test("the plain RunMutant body never carries the filter — its OData signature has no such param", async () => {
    // BC validates an action's request shape BEFORE its body runs (R25), so an extra field on the
    // unchanged action is a request-shape rejection, not an ignored key.
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const { backend, cleanup } = await deployFenced(calls, {
      idRanges: [{ from: 79000, to: 79199 }],
    });
    try {
      await backend.activate("M0007");
      await backend.run(ref, { coverage: "none", timeoutMs: 1000 });
      expect(calls[0]?.url).not.toContain("WithCoverage");
      expect("coverageObjectIdFilter" in (calls[0]?.body ?? {})).toBe(false);
    } finally {
      await cleanup();
    }
  });
});
/**
 * The two ways fenced coverage comes back USELESS while every layer reports success.
 *
 * Neither is an error, neither changes a count, and both surface downstream only as mutants landing
 * `no-coverage` — which reads as "the suite does not cover this code", the reassuring misreading.
 * Measured on Continia Document Output: a 56/56 GREEN fenced baseline attributed 2 procedures where
 * the hub attributed 13, and nothing anywhere said so.
 */
describe("fenced coverage — the thin-coverage diagnostic", () => {
  function factory(calls: Array<{ url: string; body: Record<string, unknown> }>, inner: unknown) {
    const captureFetch = (async (url: unknown, init?: RequestInit) => {
      const b = JSON.parse(String(init?.body)) as Record<string, unknown>;
      calls.push({ url: String(url), body: b });
      const payload = {
        status: "ran",
        targetAppId: b.targetAppId,
        artifactId: b.artifactId,
        attemptId: b.attemptId,
        mutantId: b.mutantId,
        codeunitId: b.testCodeunitId,
        method: b.testMethod,
        codeunitResults: JSON.stringify({ testResults: [{ method: b.testMethod, result: 2 }] }),
        ...(inner as Record<string, unknown>),
      };
      return new Response(JSON.stringify({ value: JSON.stringify(payload) }), { status: 200 });
    }) as typeof fetch;
    return (targetAppId: string, artifactId: string) =>
      new RunMutantTransport(
        { baseUrl: "http://bc:7048/BC", company: "CRONUS", username: "u", password: "p" },
        targetAppId,
        artifactId,
        captureFetch,
      );
  }

  const OURS_AL = `codeunit 79100 "Ours"
{
    procedure Alpha()
    begin
    end;
}
`;

  async function deployed(inner: unknown): Promise<{
    backend: BcDevMcpBackend;
    cleanup: () => Promise<void>;
  }> {
    const outputDir = await mkdtemp(join(tmpdir(), "lethal-thin-"));
    await writeDeployInputs(outputDir);
    const appJsonPath = join(outputDir, "app.json");
    const app = JSON.parse(await readFile(appJsonPath, "utf8")) as Record<string, unknown>;
    await Bun.write(
      appJsonPath,
      JSON.stringify({ ...app, idRanges: [{ from: 79000, to: 79199 }] }),
    );
    await Bun.write(join(outputDir, "Ours.Codeunit.al"), OURS_AL);
    const backend = new BcDevMcpBackend(
      {
        mcpCommand: ["unused"],
        project: "/al",
        server: "http://bc",
        serverInstance: "BC",
        coverageMode: "fenced",
        ...(await controlStaging(outputDir)),
      },
      () => {
        throw new Error("bc-dev-mcp must not be contacted in fenced mode");
      },
      makeDeployment(outputDir, { Codeunits: [{ Id: 79100, Name: "Ours" }] }),
      factory([], inner),
    );
    await backend.deploy(outputDir);
    backend.setLease(FAKE_LEASE);
    await backend.activate(null);
    return {
      backend,
      cleanup: async () => {
        await rmStaged(outputDir);
        await rm(outputDir, { recursive: true, force: true });
      },
    };
  }

  test("rows arrived but NONE for a declared object — blames the filter, not the line map", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const { backend, cleanup } = await deployed({
      coverage: [
        { objectType: 5, objectId: 1, lineNo: 40, hits: 3 },
        { objectType: 1, objectId: 18, lineNo: 100, hits: 1 },
      ],
      coverageScannedRows: 2,
      coverageEmittedRows: 2,
      coverageRunMs: 900,
      coverageSerializeMs: 4,
    });
    try {
      await backend.run(ref, { coverage: "fenced", timeoutMs: 1000 });
      const said = warn.mock.calls.map((c) => String(c[0])).join("\n");
      expect(said).toContain("NONE of them for an object this artifact declares");
      expect(said).toContain("server scanned 2, emitted 2");
      // The distinction is the whole point: the line map was never consulted here.
      expect(said).toContain("not the line map, which was never consulted");
    } finally {
      warn.mockRestore();
      await cleanup();
    }
  });

  test("declared-object rows arrived but nothing resolved to a member — blames the line map", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    // Object-level row (line 0) plus a line past the object: both real, neither nameable.
    const { backend, cleanup } = await deployed({
      coverage: [
        { objectType: 5, objectId: 79100, lineNo: 0, hits: 1 },
        { objectType: 5, objectId: 79100, lineNo: 999, hits: 1 },
      ],
    });
    try {
      await backend.run(ref, { coverage: "fenced", timeoutMs: 1000 });
      const said = warn.mock.calls.map((c) => String(c[0])).join("\n");
      expect(said).toContain("NOT ONE line fell inside a known procedure");
      expect(said).toContain("base-line frame");
    } finally {
      warn.mockRestore();
      await cleanup();
    }
  });

  test("silent when even one line resolves to a member", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const { backend, cleanup } = await deployed({
      coverage: [
        { objectType: 5, objectId: 1, lineNo: 40, hits: 3 },
        { objectType: 5, objectId: 79100, lineNo: 0, hits: 1 },
        { objectType: 5, objectId: 79100, lineNo: 4, hits: 1 },
      ],
    });
    try {
      await backend.run(ref, { coverage: "fenced", timeoutMs: 1000 });
      const said = warn.mock.calls.map((c) => String(c[0])).join("\n");
      expect(said).not.toContain("fenced coverage for");
    } finally {
      warn.mockRestore();
      await cleanup();
    }
  });

  test("silent when the server sent no rows at all — that is a different, already-loud case", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const { backend, cleanup } = await deployed({ coverage: [] });
    try {
      await backend.run(ref, { coverage: "fenced", timeoutMs: 1000 });
      const said = warn.mock.calls.map((c) => String(c[0])).join("\n");
      expect(said).not.toContain("fenced coverage for");
    } finally {
      warn.mockRestore();
      await cleanup();
    }
  });
});
