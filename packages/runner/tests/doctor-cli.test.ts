import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BcDevConfigSection, LethalConfigFile } from "../src/cli";
import { buildBackend, buildDoctorDeps, validateBcDevConfig } from "../src/cli";
import { runDoctor } from "../src/doctor";
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

describe("lethal doctor CLI wiring — config-level parity", () => {
  test("a config `run` would reject for a missing bcdev section also makes doctor's config-building step refuse", async () => {
    const configFile: LethalConfigFile = {};
    expect(() => validateBcDevConfig(configFile.bcdev)).toThrow(/missing the "bcdev" section/);
    // `buildDoctorDeps` calls the SAME validator internally, not a second parse — this is not two
    // independent assertions that happen to agree, it is one piece of shared machinery exercised
    // twice. Covers every check's shared prerequisite, including "lease" (which has no live
    // read-only signal of its own — see `buildDoctorDeps`'s doc comment in cli.ts for why).
    await expect(buildDoctorDeps(configFile)).rejects.toThrow(/missing the "bcdev" section/);
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
    // status !== requireStatus.equals.
    const runOutcome = await startEnvToolSession({
      cfg,
      bcdevRaw: BCDEV_RAW,
      projectDir: "C:/proj",
      testDir: "C:/tests",
      runId: "r1",
      client: new EnvToolClient(cfg, { spawn }),
      makePublisher: () => ({ publishFile: async () => {} }),
      verifyHarness: async () => {},
      stateDir: await mkdtemp(join(tmpdir(), "lethal-envstate-")),
    }).then(
      () => ({ refused: false }),
      () => ({ refused: true }),
    );
    expect(runOutcome.refused).toBe(true);

    // What `lethal doctor` does against the IDENTICAL cfg/spawn: same resolve, same comparison.
    const configFile: LethalConfigFile = { bcdev: BCDEV_RAW, envTool: cfg };
    const { cfg: doctorCfg, deps } = await buildDoctorDeps(configFile, {
      makeEnvToolClient: (c) => new EnvToolClient(c, { spawn }),
    });
    const report = await runDoctor(doctorCfg, deps);
    expect(report.checks.find((c) => c.name === "environment")?.ok).toBe(false);
  });

  test("a Running reused environment passes both", async () => {
    const cfg = envToolCfg("Running");
    const spawn = fakeSpawn("Running");
    const configFile: LethalConfigFile = { bcdev: BCDEV_RAW, envTool: cfg };
    const { cfg: doctorCfg, deps } = await buildDoctorDeps(configFile, {
      makeEnvToolClient: (c) => new EnvToolClient(c, { spawn }),
    });
    const report = await runDoctor(doctorCfg, deps);
    expect(report.checks.find((c) => c.name === "environment")?.ok).toBe(true);
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
});
