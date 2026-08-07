import { describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BcDevConfigSection, LethalConfigFile } from "../src/cli";
import {
  DOCTOR_CREATE_MODE_CAVEAT,
  DOCTOR_NOT_CHECKED,
  buildBackend,
  buildDoctorDeps,
  doctorFromCli,
  renderDoctorReport,
  validateBcDevConfig,
} from "../src/cli";
import { ENV_STATUS_REACHABLE_NO_VENDOR_STATUS, runDoctor } from "../src/doctor";
import type { DoctorReport } from "../src/doctor";
import { EnvToolClient, validateEnvToolConfig } from "../src/env-tool";
import type { EnvToolConfigSection } from "../src/env-tool";
import { startEnvToolSession } from "../src/env-tool-session";
import {
  CONTROL_APP_ID,
  HarnessVerificationError,
  HarnessVerifier,
  MIN_CONTROL_VERSION,
} from "../src/harness";
import { QuarantineStore } from "../src/quarantine-store";
import { quarantineResourceKey } from "../src/resource-key";

/**
 * R109 ruling, honesty constraint 4: "one pinned test per check that a fixture making `run`
 * refuse also makes doctor non-green." Each test below drives the SAME machinery `lethal run`
 * would use (never a hand-rolled duplicate) against an identical fixture, proving both `run`'s own
 * path and `lethal doctor`'s `buildDoctorDeps`/`runDoctor` agree it is a problem — a `DoctorConfig`
 * that drifted from what `run` actually requires would let doctor report all-green on a config
 * `run` would reject, which is worse than no doctor at all.
 */

const BCDEV_RAW = {
  mcpCommand: ["bun", "mcp"],
  company: "CRONUS",
  controlSymbolPath: "C:/lethal-control.app",
  packageCachePath: "C:/pkg",
};

const RESOLVED_BCDEV: BcDevConfigSection = {
  ...BCDEV_RAW,
  server: "https://host",
  serverInstance: "env-4711",
  username: "admin",
  password: "hunter2",
};

function info(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    appId: CONTROL_APP_ID,
    semver: MIN_CONTROL_VERSION,
    protocolVersion: 2,
    serverGeneration: "b".repeat(32),
    tenantCountReachable: false,
    isolationModes: ["Codeunit"],
    testTypes: ["codeunit"],
    // R110: the read-only lease peek. An IDLE lease by default, so the existing "every check
    // passes" fixtures keep meaning what they say; a test that wants a held lease overrides it.
    leaseOwner: "",
    leaseOpKind: "none",
    leaseExpiresAt: "",
    leaseTokenPresent: false,
    ...over,
  };
}

function okFetch(inner: Record<string, unknown>): typeof fetch {
  return (async (_url: unknown, _init?: RequestInit) =>
    new Response(JSON.stringify({ value: JSON.stringify(inner) }), {
      status: 200,
    })) as typeof fetch;
}

function errorFetch(status: number, body: string): typeof fetch {
  return (async (_url: unknown, _init?: RequestInit) =>
    new Response(body, { status })) as typeof fetch;
}

describe("lethal doctor CLI wiring — config-level parity", () => {
  // Final review (Minor 4): an EMPTY config (`bcdev` fully absent) is exactly the shape a valid
  // al-runner-only project has — `run --backend al-runner` never touches `configFile.bcdev` at
  // all, so `validateBcDevConfig`'s own "...required for --backend bcdev" message is confusing
  // for a command with no --backend flag. `run --backend bcdev` still refuses this config (same
  // as before — parity holds), but doctor's OWN message is now scoped to what doctor actually
  // needs, not a copy of `run`'s.
  test("an empty config (the al-runner shape) refuses with doctor's own scoped message, not run's --backend one", async () => {
    const configFile: LethalConfigFile = {};
    expect(() => validateBcDevConfig(configFile.bcdev)).toThrow(/missing the "bcdev" section/);
    await expect(buildDoctorDeps(configFile)).rejects.toThrow(
      /doctor only checks a bcdev-configured project/,
    );
    await expect(buildDoctorDeps(configFile)).rejects.toThrow(/al-runner/);
  });

  // A `bcdev` section that IS present but missing a required field is a genuine typo, not the
  // al-runner-ambiguous case above — `validateBcDevConfig`'s own field-listing message is the
  // right one here, and doctor must still surface it (not the al-runner-scoped message, which
  // would be wrong: this config clearly intends a bcdev/live-BC project).
  test("a present-but-incomplete bcdev section still refuses with validateBcDevConfig's own field-listing message", async () => {
    const configFile: LethalConfigFile = { bcdev: { company: "CRONUS" } };
    expect(() => validateBcDevConfig(configFile.bcdev)).toThrow(/missing required field/);
    // `buildDoctorDeps` calls the SAME validator internally, not a second parse — this is not two
    // independent assertions that happen to agree, it is one piece of shared machinery exercised
    // twice. Covers every remaining check's shared prerequisite.
    await expect(buildDoctorDeps(configFile)).rejects.toThrow(/missing required field/);
  });
});

/**
 * Review round 2 (Open 2, Minor 6): the direct-container `environment` behaviour was correct but
 * unpinned — every OTHER describe block in this file uses a direct-bcdev (no `envTool`) config,
 * which exercises this code path on every run, but none of them asserts on the `environment`
 * check's own outcome. Reverting the whole fix to round 0's `await verify(); return "Running";`
 * left the suite green. These three probes are exactly the ones the fix exists for.
 */
describe("lethal doctor CLI wiring — environment (direct container)", () => {
  test("a healthy direct container reports the reachable sentinel, never an invented status word", async () => {
    const configFile: LethalConfigFile = { bcdev: RESOLVED_BCDEV };
    const dir = await mkdtemp(join(tmpdir(), "lethal-doctor-env-direct-ok-"));
    const { cfg, deps } = await buildDoctorDeps(configFile, {
      quarantineDir: dir,
      fetchFn: okFetch(info()),
    });
    const report = await runDoctor(cfg, deps);
    const check = report.checks.find((c) => c.name === "environment");
    expect(check?.ok).toBe(true);
    expect(check?.detail).toBe(ENV_STATUS_REACHABLE_NO_VENDOR_STATUS);
  });

  test("an unreachable container fails the environment check with the real HTTP detail, not an invented one", async () => {
    const configFile: LethalConfigFile = { bcdev: RESOLVED_BCDEV };
    const dir = await mkdtemp(join(tmpdir(), "lethal-doctor-env-direct-500-"));
    const { cfg, deps } = await buildDoctorDeps(configFile, {
      quarantineDir: dir,
      fetchFn: errorFetch(500, "boom"),
    });
    const report = await runDoctor(cfg, deps);
    const check = report.checks.find((c) => c.name === "environment");
    expect(check?.ok).toBe(false);
    expect(check?.detail).toMatch(/HTTP 500/);
    expect(check?.detail).toMatch(/boom/);
  });

  // The mis-attribution `checkReachable()` exists to avoid: `verify()` would refuse THIS response
  // (wrong appId), but that is `verify()`'s concern (and no check here reports it — a genuine,
  // separately-tracked gap, not this test's subject). `environment` must stay GREEN, because
  // reachability — the one thing it claims to observe — genuinely succeeded.
  test("a wrong appId does not fail the environment check — that mis-attribution is what checkReachable() exists to avoid", async () => {
    const configFile: LethalConfigFile = { bcdev: RESOLVED_BCDEV };
    const dir = await mkdtemp(join(tmpdir(), "lethal-doctor-env-direct-wrongid-"));
    const { cfg, deps } = await buildDoctorDeps(configFile, {
      quarantineDir: dir,
      fetchFn: okFetch(info({ appId: "not-the-control-app" })),
    });
    const report = await runDoctor(cfg, deps);
    const check = report.checks.find((c) => c.name === "environment");
    expect(check?.ok).toBe(true);
    expect(check?.detail).toBe(ENV_STATUS_REACHABLE_NO_VENDOR_STATUS);
  });
});

describe("lethal doctor CLI wiring — environment (R34)", () => {
  const statusResolve = [
    { command: ["env", "get", "{envId}", "--json"], reads: { baseUrl: "url", status: "status" } },
    { command: ["env", "users", "{envId}", "--json"], reads: { username: "u", password: "p" } },
  ];

  function envToolCfg(status: string): EnvToolConfigSection {
    return {
      toolPath: "tool.exe",
      envId: "env-4711",
      resolve: statusResolve,
      requireStatus: { equals: "Running" },
      publish: { command: ["publish", "{envId}", "{appFile}"] },
      deleteEnv: { command: ["env", "delete", "{envId}"] },
    };
  }

  function fakeSpawn(status: string) {
    return async (argv: readonly string[]) => {
      const line = argv.join(" ");
      if (line.includes("env get")) {
        return {
          exitCode: 0,
          stdout: `{"url":"https://host/env-4711","status":"${status}"}`,
          stderr: "",
        };
      }
      if (line.includes("env users")) {
        return { exitCode: 0, stdout: '{"u":"admin","p":"hunter2"}', stderr: "" };
      }
      return { exitCode: 0, stdout: "{}", stderr: "" };
    };
  }

  test("a Stopped reused environment that would make `run`'s startEnvToolSession refuse also fails doctor's environment check", async () => {
    const cfg = envToolCfg("Stopped");
    const spawn = fakeSpawn("Stopped");

    // What `lethal run` actually does (env-tool-session.ts, R34): resolves, then refuses because
    // status !== requireStatus.equals. Review round 1 (Important): asserting on the SPECIFIC
    // rejection text, not merely "it rejected" — a boolean refused/not-refused catches ANY
    // rejection reason (a missing publisher, a bad stateDir, a future unrelated validation) and
    // would stay green even if the R34 status refusal this test claims to pin had silently
    // stopped firing.
    await expect(
      startEnvToolSession({
        cfg,
        bcdevRaw: BCDEV_RAW,
        projectDir: "C:/proj",
        testDir: "C:/tests",
        runId: "r1",
        client: new EnvToolClient(cfg, { spawn }),
        makePublisher: () => ({ publishFile: async () => {} }),
        verifyHarness: async () => {},
        stateDir: await mkdtemp(join(tmpdir(), "lethal-envstate-")),
      }),
    ).rejects.toThrow(/reports status "Stopped", not "Running"/);

    // What `lethal doctor` does against the IDENTICAL cfg/spawn: same resolve, same comparison.
    // Final review (Minor 5): `fetchFn`/`quarantineDir` injected so `quarantine`/`control-version`
    // — which `runDoctor` also runs, this is not create-mode — never touch the real network or the
    // real machine-global quarantine dir; this test asserts only `environment`, so what those two
    // report does not matter, but a REAL outbound `fetch` to `https://host/env-4711` cost ~2.7s
    // per run before this, relying on DNS failing fast.
    const configFile: LethalConfigFile = { bcdev: BCDEV_RAW, envTool: cfg };
    const dir = await mkdtemp(join(tmpdir(), "lethal-doctor-envtool-stopped-"));
    const { cfg: doctorCfg, deps } = await buildDoctorDeps(configFile, {
      makeEnvToolClient: (c) => new EnvToolClient(c, { spawn }),
      fetchFn: okFetch(info()),
      quarantineDir: dir,
    });
    const report = await runDoctor(doctorCfg, deps);
    const check = report.checks.find((c) => c.name === "environment");
    expect(check?.ok).toBe(false);
    expect(check?.detail).toMatch(/reports status "Stopped", not "Running"/);
  });

  test("a Running reused environment passes both", async () => {
    const cfg = envToolCfg("Running");
    const spawn = fakeSpawn("Running");

    // Review round 1 (Important): this test previously asserted ONLY doctor's side, so it could
    // not have failed if doctor and `run` disagreed. Drive the SAME cfg/spawn through
    // `startEnvToolSession` too and assert it actually succeeds.
    const session = await startEnvToolSession({
      cfg,
      bcdevRaw: BCDEV_RAW,
      projectDir: "C:/proj",
      testDir: "C:/tests",
      runId: "r1",
      client: new EnvToolClient(cfg, { spawn }),
      makePublisher: () => ({ publishFile: async () => {} }),
      verifyHarness: async () => {},
      stateDir: await mkdtemp(join(tmpdir(), "lethal-envstate-")),
    });
    expect(session.bcdev.baseUrl).toBe("https://host/env-4711");

    const configFile: LethalConfigFile = { bcdev: BCDEV_RAW, envTool: cfg };
    // Final review (Minor 5): same fix as the Stopped test above — no real network/quarantine dir.
    const dir = await mkdtemp(join(tmpdir(), "lethal-doctor-envtool-running-"));
    const { cfg: doctorCfg, deps } = await buildDoctorDeps(configFile, {
      makeEnvToolClient: (c) => new EnvToolClient(c, { spawn }),
      fetchFn: okFetch(info()),
      quarantineDir: dir,
    });
    const report = await runDoctor(doctorCfg, deps);
    expect(report.checks.find((c) => c.name === "environment")?.ok).toBe(true);
  });
});

/**
 * Final review (Important 4): a create-mode envTool config (`envId` absent, `createEnv`/
 * `startEnv`/`readyWhen`/`publishApps`/`deleteEnv` declared — `validateEnvToolConfig`'s dedicated
 * create-mode branch, under env-tool.ts's `const createMode`) is structurally valid, and
 * `lethal run` provisions it. `requireStatus` is REFUSED in create mode (env-tool.ts's
 * "applies only to a REUSED environment" refusal), so it is never configured here.
 * Round-0/1 `buildDoctorDeps` supplied `envId: resolvedEnvCfg.envId ?? ""` unconditionally, and a
 * `resolve` block's `{envId}` placeholder then had nothing to substitute — `renderCommand` throws
 * BY NAME: `envTool: no value available for placeholder {envId} while building "env get ...`. That
 * message names an INTERNAL placeholder, reads as a bug in the user's (correct) config, and would
 * send someone editing a file that needs no edit. The fix omits `environment`/`quarantine`/
 * `control-version` from `deps` entirely for this config shape, leaving only `tool-paths` (still
 * meaningful — resolving a local compiler path needs no environment).
 */
describe("lethal doctor CLI wiring — create-mode envTool config (final review, Important 4)", () => {
  function createModeCfg(): EnvToolConfigSection {
    return {
      toolPath: "tool.exe",
      // envId deliberately absent — this IS the create-mode trigger.
      resolve: [
        { command: ["env", "get", "{envId}", "--json"], reads: { baseUrl: "url" } },
        { command: ["env", "users", "{envId}", "--json"], reads: { username: "u", password: "p" } },
      ],
      publish: { command: ["publish", "{envId}", "{appFile}"] },
      createEnv: { command: ["env", "create", "--json"], reads: { envId: "id" } },
      startEnv: { command: ["env", "start", "{envId}"] },
      readyWhen: {
        command: ["env", "status", "{envId}", "--json"],
        reads: { status: "status" },
        equals: "Running",
      },
      deleteEnv: { command: ["env", "delete", "{envId}"] },
      publishApps: ["tests.app"],
    };
  }

  test("`run` accepts a create-mode config structurally (validateEnvToolConfig, the same validator `resolveEnvToolSession` calls)", () => {
    // `hasPackageCachePath: true` matches `BCDEV_RAW.packageCachePath` being set, exactly what
    // `buildDoctorDeps`/`resolveEnvToolSession` derive from `configFile.bcdev` in the tests below.
    expect(() =>
      validateEnvToolConfig(createModeCfg(), {
        env: {},
        hasPackageCachePath: true,
        bcdevDeclaredKeys: [],
      }),
    ).not.toThrow();
  });

  test("doctor omits environment/quarantine/control-version for create mode, keeps tool-paths, and names why", async () => {
    const cfg = createModeCfg();
    const configFile: LethalConfigFile = { bcdev: BCDEV_RAW, envTool: cfg };
    const {
      cfg: doctorCfg,
      deps,
      createModeCaveat,
    } = await buildDoctorDeps(configFile, {
      alToolPaths: async () => ({ alcPath: "C:/alc.exe", altoolPath: "C:/altool.exe" }),
    });
    expect(createModeCaveat).toBe(DOCTOR_CREATE_MODE_CAVEAT);
    const report = await runDoctor(doctorCfg, deps);
    expect(report.checks.map((c) => c.name)).toEqual(["tool-paths"]);
    expect(report.checks[0]?.ok).toBe(true);
    expect(report.ok).toBe(true);
  });

  test("buildDoctorDeps never calls resolveEnvToolOnce for create mode — no {envId} placeholder crash", async () => {
    // A spawn that THROWS if ever invoked: proves the create-mode omission means "never resolve",
    // not merely "resolve, then discard the result" — the exact machinery a real create-mode
    // `resolve` would fail inside (an unsubstitutable {envId} placeholder) never runs at all.
    const spawnThatMustNotRun = async (): Promise<{
      exitCode: number;
      stdout: string;
      stderr: string;
    }> => {
      throw new Error("spawn must not be called for a create-mode config's omitted checks");
    };
    const cfg = createModeCfg();
    const configFile: LethalConfigFile = { bcdev: BCDEV_RAW, envTool: cfg };
    const { cfg: doctorCfg, deps } = await buildDoctorDeps(configFile, {
      makeEnvToolClient: (c) => new EnvToolClient(c, { spawn: spawnThatMustNotRun }),
      alToolPaths: async () => ({ alcPath: "C:/alc.exe", altoolPath: "C:/altool.exe" }),
    });
    const report = await runDoctor(doctorCfg, deps);
    expect(report.ok).toBe(true);
  });

  test("the caveat appears in the rendered report", async () => {
    const cfg = createModeCfg();
    const configFile: LethalConfigFile = { bcdev: BCDEV_RAW, envTool: cfg };
    const {
      cfg: doctorCfg,
      deps,
      createModeCaveat,
    } = await buildDoctorDeps(configFile, {
      alToolPaths: async () => ({ alcPath: "C:/alc.exe", altoolPath: "C:/altool.exe" }),
    });
    const report = await runDoctor(doctorCfg, deps);
    const rendered = renderDoctorReport(report, createModeCaveat);
    expect(rendered).toContain(DOCTOR_CREATE_MODE_CAVEAT);
    expect(rendered).not.toContain("{envId}");
  });
});

/**
 * Fix round 1 (Important 2), found while implementing R51's follow-on: `resolvedBcdev` assembles
 * a `BcDevConfigSection` from `configFile.bcdev ?? {}` plus the resolved connection fields, but
 * never supplied `packageCachePath` — which `validateBcDevConfig` requires unconditionally. A
 * config that legally leaves it to `downloadSymbols` (no static path declared — the exact case
 * `validateEnvToolConfig`'s `hasPackageCachePath` option exists for) made `buildDoctorDeps` throw
 * "missing required field(s): packageCachePath" before `runDoctor` ran a single check — the third
 * instance of doctor being stricter than `run` in this subsystem (after the `altool` requirement
 * and the `requireStatus` comparison). Fixed by sharing `packageCachePathDefault` with
 * `resolveForceResetLeaseConfig` (cli.ts) — one place, so the two cannot drift apart on it again.
 */
describe("lethal doctor CLI wiring — packageCachePath default (fix round 1, Important 2)", () => {
  test("an env-tool config that legally omits a static packageCachePath does not make buildDoctorDeps throw", async () => {
    const bcdevNoCache = {
      mcpCommand: ["bun", "mcp"],
      company: "CRONUS",
      controlSymbolPath: "C:/lethal-control.app",
      // Deliberately no packageCachePath — legal per validateEnvToolConfig's hasPackageCachePath
      // option, since downloadSymbols is declared below.
    };
    const envCfg: EnvToolConfigSection = {
      toolPath: "tool.exe",
      envId: "env-4711",
      resolve: [
        { command: ["env", "get", "{envId}", "--json"], reads: { baseUrl: "url" } },
        {
          command: ["env", "users", "{envId}", "--json"],
          reads: { username: "u", password: "p" },
        },
      ],
      publish: { command: ["publish", "{envId}", "{appFile}"] },
      downloadSymbols: { command: ["env", "download-symbols", "{envId}"] },
    };
    const spawn = async (argv: readonly string[]) => {
      const line = argv.join(" ");
      if (line.includes("env get")) {
        return { exitCode: 0, stdout: '{"url":"https://host/env-4711"}', stderr: "" };
      }
      if (line.includes("env users")) {
        return { exitCode: 0, stdout: '{"u":"admin","p":"hunter2"}', stderr: "" };
      }
      return { exitCode: 0, stdout: "{}", stderr: "" };
    };

    const configFile: LethalConfigFile = { bcdev: bcdevNoCache, envTool: envCfg };
    const dir = await mkdtemp(join(tmpdir(), "lethal-doctor-no-pkgcache-"));
    // The bug threw INSIDE buildDoctorDeps itself, before runDoctor ever ran — so reaching
    // runDoctor at all (rather than a rejected promise here) is already most of this assertion.
    const { cfg, deps } = await buildDoctorDeps(configFile, {
      quarantineDir: dir,
      fetchFn: okFetch(info()),
      makeEnvToolClient: (c) => new EnvToolClient(c, { spawn }),
    });
    const report = await runDoctor(cfg, deps);
    expect(report.checks.find((c) => c.name === "quarantine")?.ok).toBe(true);
    expect(report.checks.find((c) => c.name === "control-version")?.ok).toBe(true);
  });
});

describe("lethal doctor CLI wiring — quarantine", () => {
  test("a quarantined tier that would make `run`'s consult refuse also fails doctor's quarantine check", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lethal-doctor-quarantine-"));
    const key = quarantineResourceKey({
      server: RESOLVED_BCDEV.server,
      serverInstance: RESOLVED_BCDEV.serverInstance,
    });
    const store = new QuarantineStore(dir);
    await store.record({
      resourceKey: key,
      opKind: "run",
      detail: "activation deadline exceeded",
      recordedAtIso: new Date().toISOString(),
    });

    // What `runSession`'s quarantine consult reads (orchestrator.ts) — the SAME store, SAME key.
    const consulted = await new QuarantineStore(dir).read(key);
    expect(consulted).not.toBeNull();

    const configFile: LethalConfigFile = { bcdev: RESOLVED_BCDEV };
    const { cfg, deps } = await buildDoctorDeps(configFile, {
      quarantineDir: dir,
      fetchFn: okFetch(info()),
    });
    const report = await runDoctor(cfg, deps);
    const check = report.checks.find((c) => c.name === "quarantine");
    expect(check?.ok).toBe(false);
    expect(check?.detail).toContain("activation deadline exceeded");
  });

  test("an unquarantined tier passes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lethal-doctor-quarantine-clear-"));
    const configFile: LethalConfigFile = { bcdev: RESOLVED_BCDEV };
    const { cfg, deps } = await buildDoctorDeps(configFile, {
      quarantineDir: dir,
      fetchFn: okFetch(info()),
    });
    const report = await runDoctor(cfg, deps);
    expect(report.checks.find((c) => c.name === "quarantine")?.ok).toBe(true);
  });
});

describe("lethal doctor CLI wiring — control-version (R28)", () => {
  test("a stale control app that would make `run`'s HarnessVerifier refuse also fails doctor's control-version check", async () => {
    const fetchFn = okFetch(info({ semver: "1.0.0.0" }));
    // What `run` uses for readiness/lease acquisition (harness.ts) — same fetch, same response.
    await expect(
      new HarnessVerifier(
        { baseUrl: "http://x", company: "C", username: "u", password: "p" },
        fetchFn,
      ).verify(),
    ).rejects.toBeInstanceOf(HarnessVerificationError);

    const configFile: LethalConfigFile = { bcdev: RESOLVED_BCDEV };
    const dir = await mkdtemp(join(tmpdir(), "lethal-doctor-cv-"));
    const { cfg, deps } = await buildDoctorDeps(configFile, { quarantineDir: dir, fetchFn });
    const report = await runDoctor(cfg, deps);
    const check = report.checks.find((c) => c.name === "control-version");
    expect(check?.ok).toBe(false);
    expect(check?.detail).toMatch(/1\.0\.0\.0/);
  });

  test("a current control app passes", async () => {
    const fetchFn = okFetch(info());
    const configFile: LethalConfigFile = { bcdev: RESOLVED_BCDEV };
    const dir = await mkdtemp(join(tmpdir(), "lethal-doctor-cv-ok-"));
    const { cfg, deps } = await buildDoctorDeps(configFile, { quarantineDir: dir, fetchFn });
    const report = await runDoctor(cfg, deps);
    expect(report.checks.find((c) => c.name === "control-version")?.ok).toBe(true);
  });
});

describe("lethal doctor CLI wiring — tool-paths", () => {
  test("no AL extension installed, which would make `run`'s buildBackend refuse, also fails doctor's tool-paths check", async () => {
    const noExtension = async () => undefined; // same shape `defaultAlToolPaths` returns when none is found
    const configFile: LethalConfigFile = { bcdev: RESOLVED_BCDEV };

    // What `lethal run` does (cli.ts's `buildBackend`) against the IDENTICAL fake discovery.
    const parsed = {
      mode: "run" as const,
      projectDir: "C:/proj",
      testDir: "C:/tests",
      backendKind: "bcdev" as const,
      dbPath: "db",
      configPath: "cfg",
      skipKnownSurvivors: false,
      workers: 1,
      keepEnv: false,
      allowExpiringEnv: false,
    };
    await expect(
      buildBackend(parsed, configFile, "C:/scratch", undefined, { alToolPaths: noExtension }),
    ).rejects.toThrow(/could not locate alc\.exe/);

    const dir = await mkdtemp(join(tmpdir(), "lethal-doctor-tools-"));
    const { cfg, deps } = await buildDoctorDeps(configFile, {
      quarantineDir: dir,
      fetchFn: okFetch(info()),
      alToolPaths: noExtension,
    });
    const report = await runDoctor(cfg, deps);
    const check = report.checks.find((c) => c.name === "tool-paths");
    expect(check?.ok).toBe(false);
    expect(check?.detail).toMatch(/alc/);
  });

  test("a resolved alc/altool passes", async () => {
    const found = async () => ({ alcPath: "C:/alc.exe", altoolPath: "C:/altool.exe" });
    const configFile: LethalConfigFile = { bcdev: RESOLVED_BCDEV };
    const dir = await mkdtemp(join(tmpdir(), "lethal-doctor-tools-ok-"));
    const { cfg, deps } = await buildDoctorDeps(configFile, {
      quarantineDir: dir,
      fetchFn: okFetch(info()),
      alToolPaths: found,
    });
    const report = await runDoctor(cfg, deps);
    expect(report.checks.find((c) => c.name === "tool-paths")?.ok).toBe(true);
  });

  // Review round 1 (Important): `run`'s `buildBackend` requires altool only when
  // `envToolDeploy === undefined` (cli.ts's "could not locate altool.exe" guard, R21) — an
  // env-tool project publishes through the tool and never spawns altool. `checkToolPaths` used to
  // require BOTH unconditionally, so this exact config made `run` proceed while doctor reported
  // `[FAIL] tool-paths — missing: altool`.
  test("an env-tool project with alc pinned and no altool passes both — `run` does not require altool on that route", async () => {
    const noExtension = async () => undefined;
    const publishBlock = { command: ["publish", "{envId}", "{appFile}"] };
    const envCfg: EnvToolConfigSection = {
      toolPath: "tool.exe",
      envId: "env-4711",
      resolve: [
        { command: ["env", "get", "{envId}", "--json"], reads: { baseUrl: "url" } },
        { command: ["env", "users", "{envId}", "--json"], reads: { username: "u", password: "p" } },
      ],
      publish: publishBlock,
    };
    const spawn = async () => ({ exitCode: 0, stdout: "{}", stderr: "" });

    // Review round 2 fix: TWO config shapes, matching the TWO different pipeline stages `run`
    // and doctor each actually see. `buildBackend` is called (both in real `run`, via
    // `runFromCli`, and here) with the config `resolveEnvToolSession` has ALREADY resolved —
    // `server`/`serverInstance`/`username`/`password` filled in from the tool, not read fresh —
    // so it needs `RESOLVED_BCDEV`'s shape. `buildDoctorDeps` does its OWN resolution (it has no
    // upstream `resolveEnvToolSession` step), so it must see the RAW, pre-resolution section,
    // where `username`/`password` are legitimately absent (the tool supplies them) — declaring
    // them there too would collide with `envCfg.resolve`'s own reads of the same keys
    // (`validateEnvToolConfig`'s "two sources, one value" guard, env-tool.ts). Round 1's fixture
    // used `BCDEV_RAW` for BOTH, which is neither: `buildBackend`'s `validateBcDevConfig` threw
    // on the missing server/serverInstance/username/password BEFORE ever reaching the altool
    // gate, so `not.toMatch(/alc\.exe|altool\.exe/)` passed on a config-validation error that
    // would have read identically whether `run` was lenient or strict about altool — the
    // assertion was inert. Verified below with the exact mutation the second review round used
    // to prove it (`cli.ts`'s altool gate made unconditional): see the red-check in the report.
    const resolvedRunBcdev: BcDevConfigSection = { ...RESOLVED_BCDEV, alcPath: "C:/alc.exe" };
    const runConfigFile: LethalConfigFile = { bcdev: resolvedRunBcdev };
    const rawDoctorBcdev = { ...BCDEV_RAW, alcPath: "C:/alc.exe" };
    const doctorConfigFile: LethalConfigFile = { bcdev: rawDoctorBcdev, envTool: envCfg };

    // What `lethal run` does: `buildBackend` given a real envToolDeploy (never invoked below —
    // `buildBackend` only checks it is DEFINED before the altool gate) must not refuse for a
    // missing altool. `parsed.projectDir` is fake, so this rejects LATER for an unrelated reason
    // (validating selector ids against a project that does not exist) — the assertion is
    // specifically that the rejection is NOT about alc/altool.
    const envToolDeploy = {
      client: new EnvToolClient(envCfg, { spawn }),
      publishBlock,
      envId: "env-4711",
    };
    const parsed = {
      mode: "run" as const,
      projectDir: "C:/does-not-exist",
      testDir: "C:/tests",
      backendKind: "bcdev" as const,
      dbPath: "db",
      configPath: "cfg",
      skipKnownSurvivors: false,
      workers: 1,
      keepEnv: false,
      allowExpiringEnv: false,
    };
    const runErr = await buildBackend(parsed, runConfigFile, "C:/scratch", envToolDeploy, {
      alToolPaths: noExtension,
    }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(runErr).not.toBeNull();
    // Positive control for the negative assertion below: reaching a DIFFERENT, expected failure
    // (selector-id validation against a project that does not exist) proves the altool gate was
    // actually passed through, not merely never reached for some other unrelated reason.
    expect(String(runErr)).toMatch(/validate selector ids/);
    expect(String(runErr)).not.toMatch(/alc\.exe|altool\.exe/);

    const dir = await mkdtemp(join(tmpdir(), "lethal-doctor-tools-envtool-"));
    const { cfg, deps } = await buildDoctorDeps(doctorConfigFile, {
      quarantineDir: dir,
      fetchFn: okFetch(info()),
      alToolPaths: noExtension,
      makeEnvToolClient: (c) => new EnvToolClient(c, { spawn }),
    });
    const report = await runDoctor(cfg, deps);
    const check = report.checks.find((c) => c.name === "tool-paths");
    expect(check?.ok).toBe(true);
  });
});

/**
 * Final review (Important 1) — "the sixth 'cannot fail'": `renderDoctorReport` and `doctorFromCli`
 * had ZERO tests. The reviewer replaced `renderDoctorReport`'s entire body with a constant string
 * and ran `doctor.test.ts` + `doctor-cli.test.ts` + `cli.test.ts`: 107 pass / 0 fail. Three things
 * rode on it, all unpinned: `DOCTOR_NOT_CHECKED` (this branch's ENTIRE answer to the round-1
 * Critical — the lease check was withdrawn into a caveat "printed on every invocation", and
 * deleting that printing broke nothing), the `[ok]`/`[FAIL]` per-check rendering, and
 * `doctorFromCli`'s documented exit code (the one thing the README tells a user/script to rely
 * on). Pinned below, both as a pure-function unit test (`renderDoctorReport`) and end-to-end
 * (`doctorFromCli`, real config file on disk, real `buildDoctorDeps` with only the low-level I/O
 * seams swapped — see `doctorFromCli`'s own doc comment for why NOT a top-level swap).
 */
describe("renderDoctorReport (final review, Important 1)", () => {
  function reportOf(checks: DoctorReport["checks"]): DoctorReport {
    return { checks, ok: checks.every((c) => c.ok) };
  }

  test("renders [ok] for a passing check and [FAIL] for a failing one, by name", () => {
    const rendered = renderDoctorReport(
      reportOf([
        { name: "environment", ok: true, detail: "reachable (no vendor status reported)" },
        { name: "quarantine", ok: false, detail: "run: activation deadline exceeded" },
      ]),
    );
    expect(rendered).toMatch(/\[ok\] environment: reachable \(no vendor status reported\)/);
    expect(rendered).toMatch(/\[FAIL\] quarantine: run: activation deadline exceeded/);
  });

  test("the top line says ok only when every check passed", () => {
    const allOk = renderDoctorReport(reportOf([{ name: "tool-paths", ok: true, detail: "x" }]));
    expect(allOk).toMatch(/^ok: every check passed/);
    const oneFailed = renderDoctorReport(
      reportOf([{ name: "tool-paths", ok: false, detail: "x" }]),
    );
    expect(oneFailed).toMatch(/^FAIL: at least one check failed/);
  });

  test("always includes DOCTOR_NOT_CHECKED — this IS the round-1 Critical's whole answer", () => {
    const rendered = renderDoctorReport(reportOf([{ name: "tool-paths", ok: true, detail: "x" }]));
    expect(rendered).toContain(DOCTOR_NOT_CHECKED);
  });

  test("appends the create-mode caveat only when given — genuinely conditional, not always present", () => {
    const report = reportOf([{ name: "tool-paths", ok: true, detail: "x" }]);
    expect(renderDoctorReport(report)).not.toContain(DOCTOR_CREATE_MODE_CAVEAT);
    expect(renderDoctorReport(report, DOCTOR_CREATE_MODE_CAVEAT)).toContain(
      DOCTOR_CREATE_MODE_CAVEAT,
    );
  });
});

describe("doctorFromCli (final review, Important 1)", () => {
  async function writeConfig(configFile: LethalConfigFile): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "lethal-doctor-fromcli-"));
    const path = join(dir, "lethal.config.json");
    await writeFile(path, JSON.stringify(configFile), "utf8");
    return path;
  }

  async function run(
    configFile: LethalConfigFile,
    deps: Parameters<typeof doctorFromCli>[1],
  ): Promise<{ code: number; out: string }> {
    const configPath = await writeConfig(configFile);
    const lines: string[] = [];
    const log = spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      lines.push(a.map(String).join(" "));
    });
    try {
      const code = await doctorFromCli({ mode: "doctor", configPath }, deps);
      return { code, out: lines.join("\n") };
    } finally {
      log.mockRestore();
    }
  }

  test("returns 0 and prints ok when every check passes — the REAL buildDoctorDeps, only I/O swapped", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lethal-doctor-fromcli-quarantine-"));
    const { code, out } = await run(
      { bcdev: RESOLVED_BCDEV },
      {
        quarantineDir: dir,
        fetchFn: okFetch(info()),
        alToolPaths: async () => ({ alcPath: "C:/alc.exe", altoolPath: "C:/altool.exe" }),
      },
    );
    expect(code).toBe(0);
    expect(out).toMatch(/^ok: every check passed/);
    expect(out).toContain(DOCTOR_NOT_CHECKED);
  });

  test("returns 1 and prints FAIL when a check fails — the exit code the README tells users to rely on", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lethal-doctor-fromcli-quarantine-fail-"));
    const { code, out } = await run(
      { bcdev: RESOLVED_BCDEV },
      {
        quarantineDir: dir,
        fetchFn: okFetch(info({ semver: "1.0.0.0" })),
        alToolPaths: async () => ({ alcPath: "C:/alc.exe", altoolPath: "C:/altool.exe" }),
      },
    );
    expect(code).toBe(1);
    expect(out).toMatch(/^FAIL: at least one check failed/);
    expect(out).toMatch(/\[FAIL\] control-version:/);
  });

  test("prints the create-mode caveat for a create-mode config, end to end", async () => {
    const envCfg: EnvToolConfigSection = {
      toolPath: "tool.exe",
      resolve: [
        { command: ["env", "get", "{envId}", "--json"], reads: { baseUrl: "url" } },
        { command: ["env", "users", "{envId}", "--json"], reads: { username: "u", password: "p" } },
      ],
      publish: { command: ["publish", "{envId}", "{appFile}"] },
      createEnv: { command: ["env", "create", "--json"], reads: { envId: "id" } },
      startEnv: { command: ["env", "start", "{envId}"] },
      readyWhen: {
        command: ["env", "status", "{envId}", "--json"],
        reads: { status: "status" },
        equals: "Running",
      },
      deleteEnv: { command: ["env", "delete", "{envId}"] },
      publishApps: ["tests.app"],
    };
    const { code, out } = await run(
      { bcdev: BCDEV_RAW, envTool: envCfg },
      { alToolPaths: async () => ({ alcPath: "C:/alc.exe", altoolPath: "C:/altool.exe" }) },
    );
    expect(code).toBe(0);
    expect(out).toContain(DOCTOR_CREATE_MODE_CAVEAT);
    expect(out).not.toContain("{envId}");
  });
});
