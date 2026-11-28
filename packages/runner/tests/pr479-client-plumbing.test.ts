import { describe, expect, spyOn, test } from "bun:test";
import { join } from "node:path";
import { IDENTITY_SCHEME } from "@lethal/schemata";
import {
  BCDEV_CLIENT,
  type BackendCapabilities,
  type BackendStatus,
  type ExecutionBackend,
  type RunOpts,
  type TestMethodRef,
  type TestVerdict,
  isBcServer,
  isBcServerName,
  isBcdev,
  isBcdevClient,
} from "../src/backend";
import { BcDevMcpBackend } from "../src/bcdev-backend";
import type { BcDevConfig, BcDevDeployment } from "../src/bcdev-backend";
import { changedLineSurvivors } from "../src/changed-line-survivors";
import {
  type BcDevConfigSection,
  bcDevBackendConfig,
  buildBackend,
  helpText,
  initFromCli,
  parseCliConfig,
  resourceIdentityFor,
} from "../src/cli";
import {
  BcdevClientExperimentalError,
  BcdevClientMethodRunError,
  CLIENT_MIN_CONTROL_VERSION,
  ClientControlTooOldError,
  ClientModeRefusedError,
  ClientNeverMixedError,
  ClientSessionUnavailableError,
  assertClientControlVersion,
  probeClientSession,
} from "../src/client-mode";
import type { ClientCodeunitResult } from "../src/client-run";
import { ConfirmBackendNotBcdevError, ConfirmInputNotV3Error } from "../src/confirm";
import {
  ConfirmMergeBcNotBcdevError,
  ConfirmMergeNotConfirmRunError,
  assertConfirmInput,
  mergeConfirmation,
} from "../src/confirm";
import type { RunEvent } from "../src/events";
import { MIN_CONTROL_VERSION } from "../src/harness";
import type { HarnessVerifier } from "../src/harness";
import { isRunOpKind } from "../src/lease";
import type { LeaseApi } from "../src/lease";
import { describe as describeMutant, toMutationElements } from "../src/mutation-elements";
import { NamedMutantError } from "../src/named-mutants";
import { notRunLine, notRunSurvivors } from "../src/not-run-survivors";
import {
  KillLedgerFlagBackendError,
  LeaseSession,
  runNamedMutants,
  runSession,
} from "../src/orchestrator";
import { CAVEAT_INTERPRETATIONS } from "../src/report";
import type { MutantOutcome } from "../src/report";
import { SessionKindUnsetError, backendSessionKind } from "../src/session-kind";
import { SessionSafety } from "../src/session-safety";
import { ResultsStore, backendBuildRefusal } from "../src/store";
import { servesTestApp, testAppJson } from "./helpers/proven-test-app";
import { scratchDirs } from "./helpers/scratch";

/**
 * PR-479 (479a, round 1): the plumbing of the experimental `bcdev-client` backend. There is no driver yet: a built
 * backend throws `BcdevClientMethodRunError` from run and runMany (round 3b: a client run goes through
 * runClientCodeunit). Each guard has a red test in each direction.
 */

const scratch = scratchDirs();

// ---------------------------------------------------------------------------------------------
// 1. The kind and its predicates
// ---------------------------------------------------------------------------------------------

describe("PR-479: the kind", () => {
  test("isBcdev stays headless-only; isBcServer is true for both BC kinds; isBcdevClient only for the client", () => {
    expect(isBcdev("bcdev")).toBe(true);
    expect(isBcdev(BCDEV_CLIENT)).toBe(false);
    expect(isBcdev("al-runner-v3")).toBe(false);
    expect(isBcServer("bcdev")).toBe(true);
    expect(isBcServer(BCDEV_CLIENT)).toBe(true);
    expect(isBcServer("al-runner-v3")).toBe(false);
    expect(isBcdevClient(BCDEV_CLIENT)).toBe(true);
    expect(isBcdevClient("bcdev")).toBe(false);
    expect(isBcServerName("bcdev")).toBe(true);
    expect(isBcServerName(BCDEV_CLIENT)).toBe(true);
    expect(isBcServerName("al-runner-v3")).toBe(false);
  });

  test("backendSessionKind says client for bcdev-client, and is unchanged for the others", () => {
    expect(backendSessionKind({ bcdev: false, client: true })).toBe("client");
    expect(backendSessionKind({ bcdev: false, client: true, noClient: true })).toBe("client");
    expect(backendSessionKind({ bcdev: true })).toBe("headless");
    expect(backendSessionKind({ bcdev: false })).toBe("client");
    expect(backendSessionKind({ bcdev: false, noClient: true })).toBe("headless");
  });

  test("the lease and quarantine wiring treats a client run as a BC server run", () => {
    const config = {
      bcdev: {
        mcpCommand: ["bun", "x", "bc-dev-mcp"],
        server: "http://Cronus281",
        serverInstance: "BC",
        company: "CRONUS",
        username: "u",
        password: "p",
        packageCachePath: "C:/.alpackages",
        controlSymbolPath: "C:/lethal-control.app",
      },
    };
    const inputs = { projectDir: "p", testDir: "t" };
    expect(resourceIdentityFor({ ...inputs, backendKind: BCDEV_CLIENT }, config)).toEqual({
      resourceServer: "http://Cronus281",
      resourceServerInstance: "BC",
    });
    expect(resourceIdentityFor({ ...inputs, backendKind: "al-runner-v3" }, config)).toEqual({});
  });
});

// ---------------------------------------------------------------------------------------------
// 2. The experimental gate (where the backend is built, never in the parse)
// ---------------------------------------------------------------------------------------------

describe("PR-479: --backend bcdev-client needs --experimental-client-mode", () => {
  const base = ["run", "--project", "P", "--tests", "T"];

  test("the parse accepts the name (the gate is not in parseBackendKind) and reads the flag", () => {
    const without = parseCliConfig([...base, "--backend", BCDEV_CLIENT]);
    expect(without.mode === "run" ? without.backendKind : "wrong").toBe(BCDEV_CLIENT);
    expect(without.mode === "run" ? "experimentalClientMode" in without : "wrong").toBe(false);
    const withFlag = parseCliConfig([
      ...base,
      "--backend",
      BCDEV_CLIENT,
      "--experimental-client-mode",
    ]);
    expect(withFlag.mode === "run" ? withFlag.experimentalClientMode : "wrong").toBe(true);
    // A headless run never sets it.
    const headless = parseCliConfig([...base, "--backend", "bcdev"]);
    expect(headless.mode === "run" ? "experimentalClientMode" in headless : "wrong").toBe(false);
  });

  test("buildBackend refuses a client run without the flag, by name, before any config work", async () => {
    const dir = scratch("lethal-pr479-gate-");
    const parsed = { projectDir: dir, testDir: dir, backendKind: BCDEV_CLIENT } as const;
    let err: unknown;
    try {
      await buildBackend(parsed, {}, dir);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(BcdevClientExperimentalError);
    expect((err as BcdevClientExperimentalError).reason).toBe("bcdev-client-experimental");
    expect((err as Error).message).toContain("--experimental-client-mode");
  });

  test("with the flag the gate is open: buildBackend fails later, on the missing config, not on the gate", async () => {
    const dir = scratch("lethal-pr479-gate2-");
    const parsed = {
      projectDir: dir,
      testDir: dir,
      backendKind: BCDEV_CLIENT,
      experimentalClientMode: true,
    } as const;
    let err: unknown;
    try {
      await buildBackend(parsed, {}, dir);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(BcdevClientExperimentalError);
  });

  test("a headless run is not asked for the flag", async () => {
    const dir = scratch("lethal-pr479-gate3-");
    let err: unknown;
    try {
      await buildBackend({ projectDir: dir, testDir: dir, backendKind: "bcdev" }, {}, dir);
    } catch (e) {
      err = e;
    }
    expect(err).not.toBeInstanceOf(BcdevClientExperimentalError);
  });

  test("a dry run of the client backend is refused by name, and so is the flag on a dry run", () => {
    expect(() => parseCliConfig([...base, "--dry-run", "--backend", BCDEV_CLIENT])).toThrow(
      ClientModeRefusedError,
    );
    expect(() => parseCliConfig([...base, "--dry-run", "--experimental-client-mode"])).toThrow(
      "--experimental-client-mode has no effect with --dry-run",
    );
  });

  test("bcDevBackendConfig carries clientMode and webClientBaseUrl only when asked", () => {
    const section = {
      mcpCommand: ["x"],
      server: "http://s",
      serverInstance: "BC",
      company: "C",
      username: "u",
      password: "p",
      packageCachePath: "pc",
      controlSymbolPath: "cs",
      webClientBaseUrl: "https://web/BC",
    } as BcDevConfigSection;
    const client = bcDevBackendConfig(section, "p", undefined, true);
    expect(client.clientMode).toBe(true);
    expect(client.webClientBaseUrl).toBe("https://web/BC");
    expect("clientMode" in bcDevBackendConfig(section, "p")).toBe(false);
  });

  // Round 3b. Red: drop the clientConfigPath spread in bcDevBackendConfig, or `parsed.configPath` at its call.
  test("round 3b: a client backend gets the config file's absolute path, the driver path and the company; headless gets no config path", () => {
    const section = {
      mcpCommand: ["x"],
      server: "http://s",
      serverInstance: "BC",
      company: "CRONUS",
      username: "u",
      password: "p",
      packageCachePath: "pc",
      controlSymbolPath: "cs",
      webClientBaseUrl: "https://web/BC",
      clientDriverPath: "/opt/driver/client-driver.dll",
    } as BcDevConfigSection;
    const client = bcDevBackendConfig(section, "p", undefined, true, "proj/lethal.config.json");
    expect(client.clientConfigPath).toBe(join(process.cwd(), "proj", "lethal.config.json"));
    expect(client.clientDriverPath).toBe("/opt/driver/client-driver.dll");
    expect(client.company).toBe("CRONUS");
    expect(
      "clientConfigPath" in
        bcDevBackendConfig(section, "p", undefined, undefined, "proj/lethal.config.json"),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// 3. The backend: its kind, coverage, preflight and the not-built error
// ---------------------------------------------------------------------------------------------

function deployment(version: string, log: string[]): BcDevDeployment {
  return {
    compiler: {} as never,
    deployer: {} as never,
    verifier: {} as never,
    harnessVerifier: {
      fetchControlVersion: async () => {
        log.push("version");
        return version;
      },
    } as unknown as HarnessVerifier,
  };
}

function backendOf(over: Partial<BcDevConfig>, version = "1.0.0.31", log: string[] = []) {
  return new BcDevMcpBackend(
    {
      mcpCommand: ["unused"],
      project: "/al",
      server: "http://bc",
      serverInstance: "BC",
      controlSymbolPath: "C:/unused/lethal-control.app",
      packageCachePath: "C:/unused/.alpackages",
      ...over,
    },
    undefined,
    deployment(version, log),
  );
}

const REF: TestMethodRef = { codeunitId: 1, method: "T" } as TestMethodRef;
const RUN_OPTS = { coverage: "none", timeoutMs: 1000 } as RunOpts;

describe("PR-479: the built backend", () => {
  test("a client backend reports its own kind and stores coverage none, whatever the config says", () => {
    const caps = backendOf({ clientMode: true, coverageMode: "fenced" }).capabilities();
    expect(caps.kind).toBe(BCDEV_CLIENT);
    expect(caps.coverage).toBe("none");
    const headless = backendOf({ coverageMode: "fenced" }).capabilities();
    expect(headless.kind).toBe("bcdev");
    expect(headless.coverage).toBe("fenced");
  });

  test("run throws BcdevClientMethodRunError on a client backend (a client run sends whole codeunits)", async () => {
    await expect(backendOf({ clientMode: true }).run(REF, RUN_OPTS)).rejects.toBeInstanceOf(
      BcdevClientMethodRunError,
    );
  });

  test("runMany throws BcdevClientMethodRunError on a client backend, and does not on a headless one", async () => {
    await expect(backendOf({ clientMode: true }).runMany({} as never)).rejects.toBeInstanceOf(
      BcdevClientMethodRunError,
    );
    // Headless: the same call fails for its own reason (no deploy), never as the client error.
    await expect(backendOf({}).runMany({} as never)).rejects.not.toBeInstanceOf(
      BcdevClientMethodRunError,
    );
  });

  test("MIN_CONTROL_VERSION stays 1.0.0.29; a client run needs 1.0.0.31", () => {
    expect(MIN_CONTROL_VERSION).toBe("1.0.0.29");
    expect(CLIENT_MIN_CONTROL_VERSION).toBe("1.0.0.31");
  });
});

describe("PR-479: the version gate", () => {
  test("a control app older than 1.0.0.31 is refused by name; 1.0.0.31 and newer pass", () => {
    expect(() => assertClientControlVersion("1.0.0.30")).toThrow(ClientControlTooOldError);
    expect(() => assertClientControlVersion("1.0.0.29")).toThrow(ClientControlTooOldError);
    expect(() => assertClientControlVersion("not a version")).toThrow(ClientControlTooOldError);
    expect(() => assertClientControlVersion("1.0.0.31")).not.toThrow();
    expect(() => assertClientControlVersion("1.0.0.32")).not.toThrow();
    expect(() => assertClientControlVersion("1.0.1.0")).not.toThrow();
  });

  test("clientPreflight refuses 1.0.0.30 on a client backend, and the same server passes a headless run", async () => {
    const probe = async () => 405;
    const client = backendOf(
      { clientMode: true, webClientBaseUrl: "https://web/BC", clientSessionProbe: probe },
      "1.0.0.30",
    );
    const err = await client.clientPreflight().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ClientControlTooOldError);
    expect((err as ClientControlTooOldError).reason).toBe("client-control-too-old");
    // Headless: no preflight at all, so the old control app is not this gate's business.
    const log: string[] = [];
    await backendOf({}, "1.0.0.30", log).clientPreflight();
    expect(log).toEqual([]);
    // 1.0.0.31 passes on the client backend.
    await backendOf(
      { clientMode: true, webClientBaseUrl: "https://web/BC", clientSessionProbe: probe },
      "1.0.0.31",
    ).clientPreflight();
  });
});

describe("PR-479: the /cs probe", () => {
  test("a missing field, a connection failure and a 404 each refuse client-session-unavailable", async () => {
    await expect(probeClientSession(undefined, async () => 405)).rejects.toBeInstanceOf(
      ClientSessionUnavailableError,
    );
    await expect(probeClientSession("", async () => 405)).rejects.toBeInstanceOf(
      ClientSessionUnavailableError,
    );
    await expect(
      probeClientSession("https://web/BC", async () => {
        throw new Error("ECONNREFUSED");
      }),
    ).rejects.toThrow(/client-session-unavailable.*ECONNREFUSED/);
    await expect(probeClientSession("https://web/BC", async () => 404)).rejects.toThrow(
      /client-session-unavailable.*404/,
    );
  });

  // Red: change `status >= 500` back to a bare 404 test (client-mode.ts): each 5xx passes the probe.
  test("any 5xx refuses, not only a 404; the line below 500 still passes", async () => {
    for (const status of [500, 502, 503, 599]) {
      await expect(probeClientSession("https://web/BC", async () => status)).rejects.toThrow(
        new RegExp(`client-session-unavailable.*${status}`),
      );
    }
    await probeClientSession("https://web/BC", async () => 499);
  });

  test("a 405 (the measured answer with /cs present), a 200 and a 401 pass; the URL is <base>/cs", async () => {
    const seen: string[] = [];
    for (const status of [405, 200, 401]) {
      await probeClientSession("https://web/BC/", async (url) => {
        seen.push(url);
        return status;
      });
    }
    expect(seen).toEqual(["https://web/BC/cs", "https://web/BC/cs", "https://web/BC/cs"]);
  });

  test("the probe runs BEFORE the version read: a refused probe never reads the control version", async () => {
    const log: string[] = [];
    const backend = backendOf(
      { clientMode: true, webClientBaseUrl: "https://web/BC", clientSessionProbe: async () => 404 },
      "1.0.0.31",
      log,
    );
    await expect(backend.clientPreflight()).rejects.toBeInstanceOf(ClientSessionUnavailableError);
    expect(log).toEqual([]);
  });

  test("a client backend with no webClientBaseUrl refuses (nothing was probed)", async () => {
    const backend = backendOf({ clientMode: true, clientSessionProbe: async () => 405 });
    await expect(backend.clientPreflight()).rejects.toBeInstanceOf(ClientSessionUnavailableError);
  });
});

// ---------------------------------------------------------------------------------------------
// 4. The session: stored name, caveat, preflight order, never-mixed refusals
// ---------------------------------------------------------------------------------------------

const TARGET_AL = `codeunit 79000 "Sandbox Logic"
{
    procedure IsOverBudget(Amount: Decimal; Budget: Decimal): Boolean
    begin
        exit(Amount > Budget);
    end;
}
`;
const TESTS_AL = `codeunit 79100 "Alpha Tests"
{
    Subtype = Test;

    [Test]
    procedure A1() begin end;
}

codeunit 79101 "Zulu Tests"
{
    Subtype = Test;

    [Test]
    procedure Z1() begin end;
}
`;
const APP_JSON = JSON.stringify({
  id: "11111111-1111-1111-1111-111111111111",
  name: "Sandbox Orchestrator Fixture",
  publisher: "LethAL",
  version: "1.0.0.0",
  idRanges: [{ from: 79000, to: 79199 }],
});
const HEADLESS: BackendCapabilities = {
  coverage: "procedure",
  deploy: "publish",
  isolation: "session",
  kind: "bcdev",
  authoritative: true,
};
const CLIENT: BackendCapabilities = { ...HEADLESS, coverage: "none", kind: BCDEV_CLIENT };
const selectorIds = { selectorId: 50000, controlId: 50001, tableId: 50002 };

async function makeProject(extraTestFiles: Record<string, string> = {}) {
  const root = scratch("lethal-pr479-");
  const projectDir = join(root, "app");
  const testDir = join(root, "tests");
  await Bun.write(join(projectDir, "SandboxLogic.Codeunit.al"), TARGET_AL);
  await Bun.write(join(projectDir, "app.json"), APP_JSON);
  await Bun.write(join(testDir, "SandboxTests.Codeunit.al"), TESTS_AL);
  for (const [name, text] of Object.entries(extraTestFiles))
    await Bun.write(join(testDir, name), text);
  await Bun.write(join(testDir, "app.json"), testAppJson());
  return { projectDir, testDir, instrumentedDir: join(root, "instr") };
}

/** A BC-server stub: kills M0001 with A1, everything else survives. Counts every call. */
class Stub implements ExecutionBackend {
  private readonly testApp = servesTestApp();
  fetchPublishedAppPackage = this.testApp.fetchPublishedAppPackage;
  microsoftMode = this.testApp.microsoftMode;
  private active: string | null = null;
  readonly log: string[] = [];
  /** Every mutated run, in order. */
  readonly runs: Array<{ mutant: string; method: string }> = [];
  runsOf(mutant: string): string[] {
    return this.runs.filter((r) => r.mutant === mutant).map((r) => r.method);
  }
  preflightError: Error | undefined;
  constructor(private readonly caps: BackendCapabilities) {}
  capabilities() {
    return this.caps;
  }
  async status(): Promise<BackendStatus> {
    this.log.push("status");
    return { ok: true, details: "stub" };
  }
  async clientPreflight(): Promise<void> {
    this.log.push("preflight");
    if (this.preflightError !== undefined) throw this.preflightError;
  }
  async deploy() {
    this.log.push("deploy");
    return null;
  }
  async compileCheck(): Promise<void> {}
  async activate(id: string | null) {
    this.active = id;
  }
  /** Round 3b: a client run's ops. The same rule as `run`: only M0001's Z1 fails; every row reached the mutant. */
  private generation = 0;
  async runClientCodeunit(req: {
    readonly codeunitId: number;
    readonly declaredMethods: readonly string[];
    readonly mutantId: string;
  }): Promise<ClientCodeunitResult> {
    this.log.push(`run:${req.mutantId === "" ? "baseline" : req.mutantId}`);
    this.generation += 1;
    const generation = this.generation;
    const methods = req.declaredMethods.map((method, i) => {
      if (req.mutantId !== "") this.runs.push({ mutant: req.mutantId, method });
      const fail = req.mutantId === "M0001" && method === "Z1";
      return {
        method,
        outcome: fail ? ("fail" as const) : ("pass" as const),
        row: {
          attemptId: `a${generation}`,
          opSeq: generation,
          codeunitId: req.codeunitId,
          method,
          loaded: true,
          loadedGeneration: generation,
          loadedMutantId: req.mutantId,
          observedAny: true,
          observedIdentityMismatch: false,
          observedActive: req.mutantId !== "",
          success: !fail,
          testMethodRuns: i + 1,
          sessionId: 100 + generation,
          serverGeneration: "g",
          databaseId: "d",
        },
      };
    });
    return {
      codeunitId: req.codeunitId,
      methods,
      boundSessionId: 100 + generation,
      generation,
      workDates: { before: "2026-10-01", after: "2026-10-01" },
    };
  }
  async run(ref: TestMethodRef, opts: RunOpts): Promise<TestVerdict> {
    this.log.push(`run:${this.active ?? "baseline"}`);
    const active = this.active;
    if (active !== null) this.runs.push({ mutant: active, method: ref.method });
    // Only M0001's Z1 kills: every later mutant survives, so a ledger (Z1 first) would cross codeunits.
    const outcome = active === "M0001" && ref.method === "Z1" ? "fail" : "pass";
    const baseline = active === null && this.caps.coverage !== "none";
    return {
      ref,
      outcome,
      durationMs: 5,
      ...(baseline
        ? {
            coverage: {
              granularity: "procedure" as const,
              entries: [{ objectType: "Codeunit", objectId: 79000, procedure: "IsOverBudget" }],
            },
          }
        : {}),
      ...(this.caps.authoritative && opts.coverage === "none"
        ? {
            attestation: { observedAny: true, identityMismatch: false },
            reachedActive: active !== null,
          }
        : {}),
    };
  }
}

async function session(
  backend: Stub,
  extra: Partial<Parameters<typeof runSession>[0]> = {},
  o: { store?: ResultsStore; project?: Awaited<ReturnType<typeof makeProject>>; tag?: string } = {},
) {
  const store = o.store ?? new ResultsStore(":memory:");
  const project = o.project ?? (await makeProject());
  const report = await runSession({
    backend,
    store,
    ...project,
    instrumentedDir: `${project.instrumentedDir}${o.tag ?? ""}`,
    selectorIds,
    // The opt-in a client run needs; a test that checks the gate passes `experimentalClientMode: false`.
    ...(backend.capabilities().kind === BCDEV_CLIENT ? { experimentalClientMode: true } : {}),
    ...extra,
  });
  return { report, store, project };
}

describe("PR-479: a client session", () => {
  test("the run row stores bcdev-client (the collapse is gone) and coverage mode none", async () => {
    const { report, store } = await session(new Stub(CLIENT));
    expect(report.backend).toBe(BCDEV_CLIENT);
    expect(report.coverageMode).toBe("none");
    expect(store.db.query("SELECT backend AS b, coverage_mode AS c FROM runs").get()).toEqual({
      b: BCDEV_CLIENT,
      c: "none",
    });
    store.close();
    const headless = await session(new Stub(HEADLESS));
    expect(headless.store.db.query("SELECT backend AS b FROM runs").get()).toEqual({ b: "bcdev" });
    headless.store.close();
  });

  test("the client-no-coverage caveat is on EVERY bcdev-client report and on no other", async () => {
    const client = await session(new Stub(CLIENT));
    expect(client.report.validity.caveats).toContain("client-no-coverage");
    client.store.close();
    const headless = await session(new Stub(HEADLESS));
    expect(headless.report.validity.caveats).not.toContain("client-no-coverage");
    headless.store.close();
    // Even with coverage configured off on a headless run (coverage "none" is not what carries the caveat).
    const none = await session(new Stub({ ...HEADLESS, coverage: "none" }));
    expect(none.report.validity.caveats).not.toContain("client-no-coverage");
    none.store.close();
  });

  test("the caveat's interpretation names the open risks and says not to read the survivors as headless ones", () => {
    const i = CAVEAT_INTERPRETATIONS["client-no-coverage"];
    expect(i.meaning).toContain("Coverage is off on this backend");
    expect(i.meaning).toContain("Do not read these survivors as headless survivors");
    for (const risk of [
      "second session of its own",
      "number sequence",
      "stored secrets",
      "background session or job",
      "per-method events",
      "dead session",
      "never ends",
    ])
      expect(i.meaning).toContain(risk);
    // Plain words: no unexplained product term (the nit of the round-1 review).
    for (const jargon of ["NST", "NumberSequence", "zombie", "TaskScheduler", "IsolatedStorage"])
      expect(i.meaning).not.toContain(jargon);
    expect(i.basis).toBe("R1170");
  });

  test("the /cs probe and version gate run before anything is published; a refusal means deploy was never called", async () => {
    const ok = new Stub(CLIENT);
    await session(ok).then((s) => s.store.close());
    expect(ok.log.indexOf("preflight")).toBeGreaterThan(ok.log.indexOf("status"));
    expect(ok.log.indexOf("preflight")).toBeLessThan(ok.log.indexOf("deploy"));
    for (const err of [
      new ClientSessionUnavailableError("no /cs"),
      new ClientControlTooOldError("1.0.0.30"),
    ]) {
      const refused = new Stub(CLIENT);
      refused.preflightError = err;
      await expect(session(refused)).rejects.toBe(err);
      expect(refused.log).not.toContain("deploy");
      expect(refused.log.some((l) => l.startsWith("run:"))).toBe(false);
    }
    // A headless session never calls a preflight.
    const headless = new Stub(HEADLESS);
    await session(headless).then((s) => s.store.close());
    expect(headless.log).not.toContain("preflight");
  });

  test("--resume and --resume-run are refused on a client run, by name, before any backend call", async () => {
    for (const resume of ["last", 1] as const) {
      const backend = new Stub(CLIENT);
      await expect(session(backend, { resume })).rejects.toBeInstanceOf(ClientNeverMixedError);
      expect(backend.log).toEqual([]);
    }
  });

  test("a headless --resume-run of a client run is refused by name, and a headless --resume never picks one up", async () => {
    const store = new ResultsStore(":memory:");
    const project = await makeProject();
    await session(new Stub(CLIENT), {}, { store, project, tag: "-1" });
    store.db.run("UPDATE runs SET finished_at = NULL WHERE id = 1");
    const byId = new Stub(HEADLESS);
    await expect(
      session(byId, { resume: 1 }, { store, project, tag: "-2" }),
    ).rejects.toBeInstanceOf(ClientNeverMixedError);
    expect(byId.log.some((l) => l.startsWith("run:"))).toBe(false);
    const last = new Stub(HEADLESS);
    await expect(session(last, { resume: "last" }, { store, project, tag: "-3" })).rejects.toThrow(
      /found no unfinished run/,
    );
    store.close();
  });

  // One test per flag, so each guard has its own red.
  const refusedFlags: Array<
    [string, Partial<Parameters<typeof runSession>[0]>, new (...a: never[]) => Error]
  > = [
    ["--exclude-test", { excludeTests: ["Alpha Tests.A1"] }, ClientModeRefusedError],
    ["workers above 1", { workers: 2 }, ClientModeRefusedError],
    ["--no-kill-ledger", { killLedger: false }, KillLedgerFlagBackendError],
    ["--confirm-from", { confirm: {} as never }, ClientNeverMixedError],
    ["--stop-hung-sessions", { stopHungSessions: true }, ClientModeRefusedError],
  ];
  for (const [flag, extra, expected] of refusedFlags) {
    test(`${flag} is refused on a client run, by name, before any run`, async () => {
      const backend = new Stub(CLIENT);
      let err: unknown;
      try {
        await session(backend, extra);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(expected);
      expect(backend.log.some((l) => l.startsWith("run:"))).toBe(false);
    });
  }

  test("the same options on a headless run are not refused by those guards", async () => {
    const backend = new Stub(HEADLESS);
    const { store } = await session(backend, { excludeTests: ["Alpha Tests.NoSuchMethod"] }).catch(
      (e: unknown) => {
        // The headless refusal for an excluded name that matches nothing is its own, never a client one.
        expect(e).not.toBeInstanceOf(ClientModeRefusedError);
        expect(e).not.toBeInstanceOf(ClientNeverMixedError);
        return { store: new ResultsStore(":memory:") };
      },
    );
    store.close();
  });

  // Red: drop `|| isBcdevClient(caps.kind)` from `killLedgerOff` (orchestrator.ts): the client rows read [Z1, A1, A1, Z1].
  test("R197's ledger and R1174's re-walk are off on a client run; a headless run on the same rig has both", async () => {
    const client = new Stub(CLIENT);
    const c = await session(client);
    expect(c.report.mutants.find((m) => m.mutantCode === "M0002")?.verdict).toBe("survived");
    // The fixed no-ledger order (narrowest first, then name), once: no Z1-first reorder, no second walk.
    expect(client.runsOf("M0002")).toEqual(["A1", "Z1"]);
    expect(client.runsOf("M0003")).toEqual(["A1", "Z1"]);
    c.store.close();
    const headless = new Stub({ ...HEADLESS, coverage: "none" });
    const h = await session(headless);
    expect(headless.runsOf("M0002")).toEqual(["Z1", "A1", "A1", "Z1"]);
    h.store.close();
  });
});

// ---------------------------------------------------------------------------------------------
// 5. Lending and snapshot reuse across the line
// ---------------------------------------------------------------------------------------------

describe("PR-479: lending never crosses the client line", () => {
  const run = (backend: string) => ({ id: 7, backend, runnerBuild: null });
  const sess = (backend: string) => ({ backend, runnerBuild: undefined });

  test("backendBuildRefusal: client into client lends; every other pair with a client side is refused, both directions", () => {
    expect(backendBuildRefusal(run(BCDEV_CLIENT), sess(BCDEV_CLIENT))).toBeUndefined();
    expect(backendBuildRefusal(run("bcdev"), sess("bcdev"))).toBeUndefined();
    expect(backendBuildRefusal(run(BCDEV_CLIENT), sess("bcdev"))).toContain("lent only within");
    expect(backendBuildRefusal(run("bcdev"), sess(BCDEV_CLIENT))).toContain("lent only within");
    expect(backendBuildRefusal(run(BCDEV_CLIENT), sess("al-runner-v3"))).toBeDefined();
    expect(backendBuildRefusal(run("al-runner-v3"), sess(BCDEV_CLIENT))).toBeDefined();
  });

  test("with NO session a client run refuses, and a headless run still lends (unchanged)", () => {
    expect(backendBuildRefusal(run(BCDEV_CLIENT), undefined)).toContain("named no session backend");
    expect(backendBuildRefusal(run("bcdev"), undefined)).toBeUndefined();
  });

  // Coverage is "none" on BOTH sides, so R354's coverage-mode refusal cannot pass the test: only the backend arms
  // (`backendBuildRefusal`) can. Red: drop the client arms in `backendBuildRefusal` (store.ts): the cross cases lend.
  test("--skip-known-survivors never lends a survivor across the line, either way; within one side it does", async () => {
    const headlessNone = { ...HEADLESS, coverage: "none" as const };
    const cases = [
      { first: headlessNone, second: headlessNone, lent: true },
      { first: CLIENT, second: CLIENT, lent: true },
      { first: CLIENT, second: headlessNone, lent: false },
      { first: headlessNone, second: CLIENT, lent: false },
    ] as const;
    for (const c of cases) {
      const store = new ResultsStore(":memory:");
      const project = await makeProject();
      const one = await session(new Stub(c.first), {}, { store, project, tag: "-1" });
      const survivor = one.report.mutants.find((m) => m.verdict === "survived");
      expect(survivor, `${c.first.kind} -> ${c.second.kind}`).toBeDefined();
      const b2 = new Stub(c.second);
      const events: RunEvent[] = [];
      await session(
        b2,
        { skipKnownSurvivors: true, emit: [(e) => events.push(e)] },
        { store, project, tag: "-2" },
      );
      const reran = b2.log.includes(`run:${survivor?.mutantCode}`);
      const codes = events.flatMap((e) => (e.type === "warning" ? [e.code] : []));
      // A lent survivor is skipped (never executed); a refused one runs again and says why.
      expect(reran, `${c.first.kind} -> ${c.second.kind}`).toBe(!c.lent);
      expect(
        codes.includes("history-backend-build-changed"),
        `${c.first.kind} -> ${c.second.kind}`,
      ).toBe(!c.lent);
      store.close();
    }
  });
});

describe("PR-479: baseline-snapshot reuse never crosses the client line", () => {
  function seed(store: ResultsStore, backend: string): number {
    const id = store.createRun({
      testScope: [],
      coverageMode: "none",
      identityScheme: IDENTITY_SCHEME,
      buildSymbols: [],
      projectPath: "/p",
      backend,
      appVersion: "1",
      testAppHash: "package:t",
      testAppProven: true,
      testAppDeps: "D",
    });
    const ref = { codeunitId: 79100, codeunitName: "Tests", method: "A" };
    store.recordBaselineSnapshot({
      runId: id,
      batchIndex: 0,
      batchHash: "b",
      testAppHash: "package:t",
      baseline: [{ ref, verdict: { ref, outcome: "pass", durationMs: 12 } }],
    });
    return id;
  }

  test("findBaselineSnapshot: client finds only a client snapshot, and no other session finds a client one", () => {
    const store = new ResultsStore(":memory:");
    const headlessRun = seed(store, "bcdev");
    const find = (backend: string | undefined) =>
      store.findBaselineSnapshot("b", "package:t", "D", "none", undefined, backend)?.runId ?? null;
    expect(find("bcdev")).toBe(headlessRun);
    expect(find(BCDEV_CLIENT)).toBeNull(); // client session, headless snapshot
    const clientRun = seed(store, BCDEV_CLIENT);
    expect(find(BCDEV_CLIENT)).toBe(clientRun);
    expect(find("bcdev")).toBe(headlessRun); // headless session keeps its own, never the newer client one
    store.close();
    const only = new ResultsStore(":memory:");
    seed(only, BCDEV_CLIENT);
    expect(only.findBaselineSnapshot("b", "package:t", "D", "none", undefined, "bcdev")).toBeNull(); // headless session, client snapshot
    only.close();
  });

  // Red: drop the `caps.kind` argument of `findBaselineSnapshot` in `scoreBatch` (orchestrator.ts): the session then
  // asks with no side, and finds the NEWEST snapshot, which may be the other side's.
  // Snapshots are reused by a resume only, and a client run cannot resume, so the session-level ask is a headless one.
  test("a headless --resume names its own backend when it asks the store for a baseline snapshot", async () => {
    const caps = { ...HEADLESS, coverage: "none" as const };
    const store = new ResultsStore(":memory:");
    const project = await makeProject();
    await session(new Stub(caps), {}, { store, project, tag: "-1" });
    store.db.run("UPDATE runs SET finished_at = NULL WHERE id = 1");
    const asked: unknown[] = [];
    const find = store.findBaselineSnapshot.bind(store);
    spyOn(store, "findBaselineSnapshot").mockImplementation((...a) => {
      asked.push(a[5]);
      return find(...a);
    });
    await session(new Stub(caps), { resume: 1 }, { store, project, tag: "-2" });
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.every((b) => b === "bcdev")).toBe(true);
    store.close();
  });
});

// ---------------------------------------------------------------------------------------------
// 6. confirm, the join
// ---------------------------------------------------------------------------------------------

describe("PR-479: confirm and the join refuse a client report", () => {
  const rep = (backend: string) => ({ schemaVersion: 3, backend, mutants: [] });

  test("--confirm-from on a client run is refused by name; on a headless run it parses", () => {
    const base = ["run", "--project", "P", "--tests", "T", "--confirm-from", "v3.json"];
    expect(() => parseCliConfig([...base, "--backend", BCDEV_CLIENT])).toThrow(
      ConfirmBackendNotBcdevError,
    );
    expect(() => parseCliConfig([...base, "--backend", "bcdev"])).not.toThrow();
  });

  test("a client report is no --confirm-from input, and no BC side of a merge", () => {
    expect(() => assertConfirmInput(rep(BCDEV_CLIENT))).toThrow(ConfirmInputNotV3Error);
    expect(() => assertConfirmInput(rep("al-runner-v3"))).not.toThrow();
    const v3 = rep("al-runner-v3");
    expect(() => mergeConfirmation({ v3, v3Sha256: "x", bc: rep(BCDEV_CLIENT) })).toThrow(
      ConfirmMergeBcNotBcdevError,
    );
    // Headless bc reaches the next check (no confirm block), proving the refusal above was the client arm.
    expect(() => mergeConfirmation({ v3, v3Sha256: "x", bc: rep("bcdev") })).toThrow(
      ConfirmMergeNotConfirmRunError,
    );
  });

  // scripts/bc-v3-join.ts's refusal is tested in scripts/bc-v3-join.test.ts.
});

// ---------------------------------------------------------------------------------------------
// 7. The five opKind sites
// ---------------------------------------------------------------------------------------------

describe("PR-479: client-run beside run", () => {
  test("isRunOpKind: run and client-run are runs; nothing else is", () => {
    expect(isRunOpKind("run")).toBe(true);
    expect(isRunOpKind("client-run")).toBe(true);
    for (const k of ["none", "publish", "restore", "", "client", "Run"])
      expect(isRunOpKind(k)).toBe(false);
  });

  /** A lease session whose status reads are scripted: the first says an op is running, the rest say it cleared. */
  function leaseRig(opKind: string, lateClaim = false) {
    let reads = 0;
    const running = {
      opKind,
      opAttemptId: "a1",
      opSeq: 5,
      lastCompletedOpSeq: 4,
      completed: false,
    };
    const idleBefore = {
      opKind: "none",
      opAttemptId: "",
      opSeq: 0,
      lastCompletedOpSeq: 4,
      completed: false,
    };
    const client = {
      getOperationStatus: async () => {
        reads += 1;
        // `lateClaim`: the first read finds the marker idle (rule 2b), and the op lands before the settling re-read.
        if (reads === 1) return lateClaim ? idleBefore : running;
        if (reads === 2 && lateClaim) return running;
        return {
          opKind: "none",
          opAttemptId: "",
          opSeq: 0,
          lastCompletedOpSeq: 5,
          completed: true,
        };
      },
    } as unknown as LeaseApi;
    return new LeaseSession({
      client,
      lease: { epoch: 1, token: "t", serverGeneration: "g", lastCompletedOpSeq: 4, expiresAt: "x" },
      safety: new SessionSafety(),
      ttlSeconds: 15,
      timers: { setInterval: () => 1, clearInterval: () => {} },
      sleep: async () => {},
      quarantineStore: undefined,
      resourceKey: undefined,
      nowIso: () => "2026-11-28T00:00:00.000Z",
      runId: 1,
      emit: () => {},
      onLost: () => {},
      windowMark: () => ({ mutantId: 0, snapshotId: 0, scoredSeq: 0 }),
      onDegraded: () => {},
    });
  }

  test("reconcileLostAck polls a client-run op that is ours until it clears, as it does a run op; another kind is not ours", async () => {
    expect(await leaseRig("run").reconcileLostAck({ attemptId: "a1", opSeq: 5 })).toBe("completed");
    expect(await leaseRig("client-run").reconcileLostAck({ attemptId: "a1", opSeq: 5 })).toBe(
      "completed",
    );
    expect(await leaseRig("publish").reconcileLostAck({ attemptId: "a1", opSeq: 5 })).not.toBe(
      "completed",
    );
  });

  test("reconcileLostAck's settling re-read also treats a client-run op that landed late as ours", async () => {
    const op = { attemptId: "a1", opSeq: 5 };
    expect(await leaseRig("run", true).reconcileLostAck(op)).toBe("completed");
    expect(await leaseRig("client-run", true).reconcileLostAck(op)).toBe("completed");
    expect(await leaseRig("publish", true).reconcileLostAck(op)).toBe("unresolved");
  });

  test("classifyRetryRefusal sees a client-run original as still running (then cleared); another kind is a genuine loss", async () => {
    expect(await leaseRig("run").classifyRetryRefusal({ attemptId: "a1", opSeq: 5 }, 1000)).toBe(
      "original-cleared",
    );
    expect(
      await leaseRig("client-run").classifyRetryRefusal({ attemptId: "a1", opSeq: 5 }, 1000),
    ).toBe("original-cleared");
    expect(
      await leaseRig("publish").classifyRetryRefusal({ attemptId: "a1", opSeq: 5 }, 1000),
    ).toBe("genuine");
  });
});

// ---------------------------------------------------------------------------------------------
// 8. Survivor wording
// ---------------------------------------------------------------------------------------------

describe("PR-479: survivors carry the caveat", () => {
  const survivor = { verdict: "survived", failureNote: "" } as const;

  test("the not-run wording and count follow bcdev's for a client run (no nearby tag)", () => {
    const n = notRunSurvivors({
      backend: BCDEV_CLIENT,
      notRunAtBaseline: ["T"],
      mutants: [survivor],
    });
    expect(n).toEqual({ survivors: 1, notRunTests: 1 });
    expect(
      notRunLine({ backend: BCDEV_CLIENT, notRunAtBaseline: ["T"], mutants: [survivor] }),
    ).toContain("BC could not run");
    expect(
      notRunLine({ backend: "al-runner-v3", notRunAtBaseline: ["T"], mutants: [survivor] }),
    ).toContain("v3 did not run");
  });

  test("the changed-line list carries the client text on a client report only", () => {
    const m = {
      batchIndex: 0,
      mutantCode: "M0001",
      file: "a.al",
      line: 1,
      operatorName: "o",
      procedureName: "p",
      verdict: "survived",
      coveringTests: [],
    } as unknown as MutantOutcome;
    const validity = { caveats: ["line-narrowed"] };
    const client = changedLineSurvivors({ validity, backend: BCDEV_CLIENT, mutants: [m] });
    expect(client?.clientNoCoverage).toContain("client-no-coverage");
    expect(
      changedLineSurvivors({ validity, backend: "bcdev", mutants: [m] })?.clientNoCoverage,
    ).toBeUndefined();
  });

  test("the elements description carries the client text on a survivor, and only when asked", () => {
    const ctx = { unplaceable: new Set<string>(), likelyEquivalent: new Set<string>() };
    const survived = { verdict: "survived", mutantCode: "M0001" } as unknown as MutantOutcome;
    const killed = { verdict: "killed", mutantCode: "M0002" } as unknown as MutantOutcome;
    const text = "client-no-coverage: x";
    expect(describeMutant(survived, { ...ctx, clientText: text })).toContain(text);
    expect(describeMutant(killed, { ...ctx, clientText: text })).toBeUndefined();
    expect(describeMutant(survived, ctx)).toBeUndefined();
  });

  // Red: make `clientText` always undefined in `toMutationElements`, or drop the loss line in `lossesFor`.
  test("the projection of a client report carries the text on each survivor and in the losses; a headless report's does not", async () => {
    const mutant = (code: string, verdict: string) => ({
      mutantCode: code,
      batchIndex: 0,
      file: "A.al",
      line: 1,
      operatorName: "lethal.op",
      verdict,
      startIndex: 0,
      endIndex: 1,
      coveringTests: [],
    });
    const make = (backend: string) =>
      ({
        schemaVersion: 3,
        backend,
        validity: { caveats: [] },
        counts: {},
        mutationScore: null,
        mutants: [mutant("M0001", "survived"), mutant("M0002", "killed")],
      }) as unknown as Parameters<typeof toMutationElements>[0];
    const opts = {
      projectDir: "/p",
      thresholds: { high: 80, low: 60 },
      readSource: async () => "x := 1;",
    };
    const text = (r: { files: Record<string, unknown> }) =>
      JSON.stringify((r.files["A.al"] as { mutants: unknown[] }).mutants);
    const client = await toMutationElements(make(BCDEV_CLIENT), opts);
    expect(text(client.report)).toContain("client-no-coverage");
    expect(client.losses.join(" ")).toContain("client-no-coverage");
    const headless = await toMutationElements(make("bcdev"), opts);
    expect(text(headless.report)).not.toContain("client-no-coverage");
    expect(headless.losses.join(" ")).not.toContain("client-no-coverage");
    // Only the survivor carries it.
    const rows = (
      client.report.files["A.al"] as { mutants: { id: string; description?: string }[] }
    ).mutants;
    expect(rows.find((r) => r.id === "0/M0001")?.description).toContain("client-no-coverage");
    expect(rows.find((r) => r.id === "0/M0002")?.description).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------
// 9. Round 3: the review's rulings (S2 to S5)
// ---------------------------------------------------------------------------------------------

describe("PR-479 S2: runSession is the second experimental gate", () => {
  // Red: delete the `experimentalClientMode !== true` line in runSession: the unflagged client run starts.
  test("a client backend without experimentalClientMode is refused by name before any backend call; with it, it runs", async () => {
    const refused = new Stub(CLIENT);
    await expect(session(refused, { experimentalClientMode: false })).rejects.toBeInstanceOf(
      BcdevClientExperimentalError,
    );
    expect(refused.log).toEqual([]);
    const absent = new Stub(CLIENT);
    const project = await makeProject();
    await expect(
      runSession({
        backend: absent,
        store: new ResultsStore(":memory:"),
        ...project,
        selectorIds,
      }),
    ).rejects.toBeInstanceOf(BcdevClientExperimentalError);
    expect(absent.log).toEqual([]);
    // The flag opens the gate; a headless run never needs it.
    const open = await session(new Stub(CLIENT));
    expect(open.report.backend).toBe(BCDEV_CLIENT);
    open.store.close();
    const headless = await session(new Stub(HEADLESS));
    expect(headless.report.backend).toBe("bcdev");
    headless.store.close();
  });
});

describe("PR-479 S3: runNamedMutants refuses a client backend", () => {
  const cfgOf = (backend: Stub) =>
    ({
      backend,
      store: new ResultsStore(":memory:"),
      runId: 999,
      testPageRefused: new Map(),
    }) as unknown as Parameters<typeof runNamedMutants>[0];

  // Red: delete the client check at the top of runNamedMutantsBody: the client call reaches "run 999 does not exist".
  test("a client backend is refused by name with no backend call; a headless one gets past the check", async () => {
    const client = new Stub(CLIENT);
    await expect(runNamedMutants(cfgOf(client))).rejects.toThrow(
      /bcdev-client-refused-named-mutants/,
    );
    await expect(runNamedMutants(cfgOf(new Stub(CLIENT)))).rejects.toBeInstanceOf(
      ClientModeRefusedError,
    );
    expect(client.log).toEqual([]);
    // Headless: the next check (the run row) answers instead.
    await expect(runNamedMutants(cfgOf(new Stub(HEADLESS)))).rejects.toBeInstanceOf(
      NamedMutantError,
    );
  });
});

describe("PR-479 S4: --stop-hung-sessions and init", () => {
  // Red: delete the stopHungSessions block in runSession's client arm: the flag is accepted.
  test("--stop-hung-sessions is refused on a client run by name; headless is not refused by that guard", async () => {
    const backend = new Stub(CLIENT);
    await expect(session(backend, { stopHungSessions: true })).rejects.toThrow(
      /bcdev-client-refused-stop-hung-sessions/,
    );
    expect(backend.log).toEqual([]);
    const headless = await session(new Stub(HEADLESS), { stopHungSessions: true }).catch(
      (e: unknown) => e,
    );
    expect(headless).not.toBeInstanceOf(ClientModeRefusedError);
    if (!(headless instanceof Error)) (headless as { store: ResultsStore }).store.close();
  });

  // Red: delete the client check at the top of initFromCli: the client call reads the project instead.
  test("lethal init --backend bcdev-client is refused by name; --backend bcdev is not", async () => {
    const dir = scratch("lethal-pr479-init-");
    const client = await initFromCli({
      mode: "init",
      projectDir: dir,
      backendKind: BCDEV_CLIENT,
    }).catch((e: unknown) => e);
    expect(client).toBeInstanceOf(ClientModeRefusedError);
    expect((client as Error).message).toContain("bcdev-client-refused-init");
    const headless = await initFromCli({
      mode: "init",
      projectDir: dir,
      backendKind: "bcdev",
    }).catch((e: unknown) => e);
    expect(headless).not.toBeInstanceOf(ClientModeRefusedError);
  });
});

describe("PR-479 S5: a client run switches no method off", () => {
  const COMPANY_AL = `codeunit 79102 "Company Tests"
{
    Subtype = Test;

    [Test]
    procedure W()
    var
        C: Record Company;
    begin
        C.Insert();
    end;
}
`;
  const PAGE_AL = `codeunit 79103 "Page Tests"
{
    Subtype = Test;

    [Test]
    procedure OpensCard()
    var
        Card: TestPage "Some Card";
    begin
        Card.OpenView();
    end;
}
`;
  const warnings = (events: readonly RunEvent[]) =>
    events.flatMap((e) => (e.type === "warning" ? [e.code] : []));

  // Red: delete the client-company-writes refusal in runSession: the client run silently leaves the method out.
  test("company-write methods: refused by name on a client run; --keep-company-tests runs them; headless leaves them out", async () => {
    const project = await makeProject({ "Company.Codeunit.al": COMPANY_AL });
    const client = new Stub(CLIENT);
    const err = await session(client, {}, { project, tag: "-a" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ClientModeRefusedError);
    expect((err as Error).message).toContain("client-company-writes");
    expect((err as Error).message).toContain("Company Tests.W");
    expect(client.log.some((l) => l.startsWith("run:") || l === "deploy")).toBe(false);

    const kept = new Stub(CLIENT);
    const events: RunEvent[] = [];
    const k = await session(
      kept,
      { keepCompanyTests: true, emit: [(e) => events.push(e)] },
      { project, tag: "-b" },
    );
    expect(k.report.excludedTests ?? []).toEqual([]);
    expect(warnings(events)).toContain("company-write-tests-kept");
    k.store.close();

    const headless = new Stub(HEADLESS);
    const h = await session(headless, {}, { project, tag: "-c" });
    expect(h.report.excludedTests?.map((t) => [t.test, t.reason])).toEqual([
      ["Company Tests.W", "company-write"],
    ]);
    h.store.close();
  });

  // Red: make the refusal read every test file's source, not the run's own list (an over-broad refusal): this goes red.
  test("--tests-only that drops the company-writing codeunit leaves nothing to refuse", async () => {
    const project = await makeProject({ "Company.Codeunit.al": COMPANY_AL });
    const r = await session(
      new Stub(CLIENT),
      { testsOnly: ["SandboxTests.Codeunit.al"] },
      { project, tag: "-d" },
    );
    expect(r.report.backend).toBe(BCDEV_CLIENT);
    r.store.close();
  });

  // Red: restore `isBcServer(...)` as the testPageRefused source for a client run: the test is refused, not run.
  test("TestPage methods run on a client run and are named client-ran-testpage-unscored; headless refuses them", async () => {
    const project = await makeProject({ "Page.Codeunit.al": PAGE_AL });
    const events: RunEvent[] = [];
    const c = await session(
      new Stub(CLIENT),
      { ciSessionKind: "client", emit: [(e) => events.push(e)] },
      { project, tag: "-e" },
    );
    const named = events.find(
      (e) => e.type === "warning" && e.code === "client-ran-testpage-unscored",
    );
    expect(JSON.stringify(named)).toContain("Page Tests.OpensCard");
    expect(events.some((e) => e.type === "tests-testpage-refused")).toBe(false);
    c.store.close();

    const hEvents: RunEvent[] = [];
    const h = await session(
      new Stub(HEADLESS),
      { emit: [(e) => hEvents.push(e)] },
      { project, tag: "-f" },
    );
    expect(hEvents.some((e) => e.type === "tests-testpage-refused")).toBe(true);
    expect(warnings(hEvents)).not.toContain("client-ran-testpage-unscored");
    h.store.close();
  });

  // Red: pass `!isBcServer(caps.kind)` again to sessionKindSensitiveTests: the client run with no ciSessionKind starts.
  test("session-kind-sensitive: a TestPage test with ciSessionKind unset is refused on a client run, and not on headless bcdev", async () => {
    const project = await makeProject({ "Page.Codeunit.al": PAGE_AL });
    const client = new Stub(CLIENT);
    const err = await session(client, {}, { project, tag: "-g" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SessionKindUnsetError);
    expect((err as Error).message).toContain("Page Tests.OpensCard (testpage)");
    expect(client.log.some((l) => l.startsWith("run:"))).toBe(false);
    const events: RunEvent[] = [];
    const headless = await session(
      new Stub(HEADLESS),
      { emit: [(e) => events.push(e)] },
      { project, tag: "-h" },
    );
    expect(events.some((e) => e.type === "tests-session-kind-sensitive")).toBe(false);
    headless.store.close();
  });
});

describe("PR-479 nits", () => {
  // Red: restore the old two-kind strings in parseBackendKind (cli.ts).
  test("the --backend error strings list all three kinds, the client one marked experimental", () => {
    const parse = (backend: string) =>
      parseCliConfig(["run", "--project", "/p", "--tests", "/t", "--backend", backend]);
    expect(() => parse("nope")).toThrow(
      'unknown --backend "nope" (expected "bcdev", "al-runner-v3" or "bcdev-client" (experimental))',
    );
    expect(() => parseCliConfig(["run", "--project", "/p", "--tests", "/t"])).toThrow(
      'missing required --backend <"bcdev" | "al-runner-v3" | "bcdev-client" (experimental)>',
    );
  });

  // Red: take one space out of the --workers help line (cli.ts).
  test("the help keeps --workers on the column its neighbours use", () => {
    const lines = helpText("0").split("\n");
    const col = (flag: string) => {
      const l = lines.find((x) => x.startsWith(`  ${flag}`));
      if (l === undefined) throw new Error(`no help line for ${flag}`);
      return l.length - l.slice(2 + flag.length).trimStart().length;
    };
    expect(col("--workers <n>")).toBe(col("--progress-out <path>"));
  });
});
