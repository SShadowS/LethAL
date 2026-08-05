import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BcDevConfigSection, LethalConfigFile } from "../src/cli";
import { buildBackend, buildDoctorDeps, validateBcDevConfig } from "../src/cli";
import { ENV_STATUS_REACHABLE_NO_VENDOR_STATUS, runDoctor } from "../src/doctor";
import { EnvToolClient } from "../src/env-tool";
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
  test("a config `run` would reject for a missing bcdev section also makes doctor's config-building step refuse", async () => {
    const configFile: LethalConfigFile = {};
    expect(() => validateBcDevConfig(configFile.bcdev)).toThrow(/missing the "bcdev" section/);
    // `buildDoctorDeps` calls the SAME validator internally, not a second parse — this is not two
    // independent assertions that happen to agree, it is one piece of shared machinery exercised
    // twice. Covers every remaining check's shared prerequisite.
    await expect(buildDoctorDeps(configFile)).rejects.toThrow(/missing the "bcdev" section/);
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
    const configFile: LethalConfigFile = { bcdev: BCDEV_RAW, envTool: cfg };
    const { cfg: doctorCfg, deps } = await buildDoctorDeps(configFile, {
      makeEnvToolClient: (c) => new EnvToolClient(c, { spawn }),
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
    const { cfg: doctorCfg, deps } = await buildDoctorDeps(configFile, {
      makeEnvToolClient: (c) => new EnvToolClient(c, { spawn }),
    });
    const report = await runDoctor(doctorCfg, deps);
    expect(report.checks.find((c) => c.name === "environment")?.ok).toBe(true);
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
  // `envToolDeploy === undefined` (cli.ts:1548, R21) — an env-tool project publishes through the
  // tool and never spawns altool. `checkToolPaths` used to require BOTH unconditionally, so this
  // exact config made `run` proceed while doctor reported `[FAIL] tool-paths — missing: altool`.
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
