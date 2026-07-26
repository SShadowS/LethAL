import { describe, expect, it } from "bun:test";
import type { BcDevConfigSection, LethalConfigFile, RunCliConfig } from "../src/cli";
import {
  leaseSessionFor,
  makeEnvToolPublisher,
  parseCliConfig,
  resolveEnvToolSession,
  resourceIdentityFor,
  validateBcDevConfig,
} from "../src/cli";
import { EnvToolClient, EnvToolError } from "../src/env-tool";
import type { EnvToolConfigSection } from "../src/env-tool";
import type { EnvToolSession } from "../src/env-tool-session";

describe("env-tool CLI flags", () => {
  const argv = [
    "run",
    "--project",
    "p",
    "--tests",
    "t",
    "--backend",
    "bcdev",
    "--config",
    "c.json",
  ];

  it("defaults keepEnv and allowExpiringEnv to false", () => {
    const cfg = parseCliConfig(argv);
    if (cfg.mode !== "run") throw new Error("expected run mode");
    expect(cfg.keepEnv).toBe(false);
    expect(cfg.allowExpiringEnv).toBe(false);
  });

  it("accepts --keep-env and --allow-expiring-env", () => {
    const cfg = parseCliConfig([...argv, "--keep-env", "--allow-expiring-env"]);
    if (cfg.mode !== "run") throw new Error("expected run mode");
    expect(cfg.keepEnv).toBe(true);
    expect(cfg.allowExpiringEnv).toBe(true);
  });

  it("rejects --keep-env with --backend al-runner, which has no environment", () => {
    expect(() =>
      parseCliConfig([
        "run",
        "--project",
        "p",
        "--tests",
        "t",
        "--backend",
        "al-runner",
        "--config",
        "c.json",
        "--keep-env",
      ]),
    ).toThrow(/keep-env/);
  });
});

// ————————————————————————————————————————————————————————————————————————
// Task 7: `resolveEnvToolSession` — the ONLY seam in cli.ts that calls Task 6's
// `startEnvToolSession`. `buildBackend`, `leaseSessionFor`, and `resourceIdentityFor` each still
// call `validateBcDevConfig(configFile.bcdev)` independently (that stayed unchanged — it is pure
// and provisions nothing), but this function is the sole place that can trigger real provisioning,
// and `runFromCli` calls it exactly once, substituting its `effectiveConfig` into all three.
// ————————————————————————————————————————————————————————————————————————

const BCDEV_RAW = {
  mcpCommand: ["bun", "mcp"],
  company: "CRONUS",
  controlSymbolPath: "C:/lethal-control.app",
  packageCachePath: "C:/pkg",
};

const RUN_CONFIG_BCDEV: RunCliConfig = {
  mode: "run",
  projectDir: "C:/proj",
  testDir: "C:/tests",
  backendKind: "bcdev",
  dbPath: "db",
  configPath: "cfg",
  skipKnownSurvivors: false,
  workers: 1,
  keepEnv: false,
  allowExpiringEnv: false,
};

const RESOLVED_BCDEV: BcDevConfigSection = {
  ...BCDEV_RAW,
  server: "https://host",
  serverInstance: "env-4711",
  username: "admin",
  password: "hunter2",
};

/** A minimal, structurally-valid resolve-mode (non-create-mode) envTool section — `envId` is
 * present, so none of create-mode's extra blocks (createEnv/startEnv/readyWhen/publishApps) are
 * required by `validateEnvToolConfig`. */
function resolveModeCfg(envId: string): EnvToolConfigSection {
  return {
    toolPath: "tool.exe",
    envId,
    resolve: [
      { command: ["env", "get", "{envId}", "--json"], reads: { baseUrl: "url" } },
      {
        command: ["env", "users", "{envId}", "--json"],
        reads: { username: "u", password: "p" },
      },
    ],
    publish: { command: ["publish", "{envId}", "{appFile}"] },
    deleteEnv: { command: ["env", "delete", "{envId}"] },
  };
}

function fakeSpawn(envId: string, extra: Record<string, string> = {}) {
  return async (argv: readonly string[]) => {
    const line = argv.join(" ");
    if (line.includes("env get")) {
      return { exitCode: 0, stdout: `{"url":"https://host/${envId}"}`, stderr: "" };
    }
    if (line.includes("env users")) {
      return { exitCode: 0, stdout: '{"u":"admin","p":"hunter2"}', stderr: "" };
    }
    for (const [needle, stdout] of Object.entries(extra)) {
      if (line.includes(needle)) return { exitCode: 0, stdout, stderr: "" };
    }
    return { exitCode: 0, stdout: "{}", stderr: "" };
  };
}

describe("resolveEnvToolSession", () => {
  it("is a no-op for al-runner — never calls startEnvToolSession, config passes through unchanged", async () => {
    let startCalls = 0;
    const configFile: LethalConfigFile = {
      alRunner: { alRunnerPath: "al-runner" },
      envTool: resolveModeCfg("env-x"),
    };
    const result = await resolveEnvToolSession(
      { ...RUN_CONFIG_BCDEV, backendKind: "al-runner" },
      configFile,
      "run-1",
      {
        startSession: async () => {
          startCalls++;
          throw new Error("must not be called for al-runner");
        },
      },
    );
    expect(startCalls).toBe(0);
    expect(result.envSession).toBeUndefined();
    expect(result.deploy).toBeUndefined();
    expect(result.effectiveConfig).toBe(configFile);
  });

  it("is a no-op for bcdev with no envTool section configured", async () => {
    let startCalls = 0;
    const configFile: LethalConfigFile = { bcdev: RESOLVED_BCDEV };
    const result = await resolveEnvToolSession(RUN_CONFIG_BCDEV, configFile, "run-1", {
      startSession: async () => {
        startCalls++;
        throw new Error("must not be called when envTool is absent");
      },
    });
    expect(startCalls).toBe(0);
    expect(result.envSession).toBeUndefined();
    expect(result.effectiveConfig).toBe(configFile);
  });

  it("resolves the env-tool session exactly once and substitutes the resolved bcdev section", async () => {
    let startCalls = 0;
    const configFile: LethalConfigFile = {
      bcdev: BCDEV_RAW,
      envTool: resolveModeCfg("env-4711"),
    };
    const fakeSession: EnvToolSession = { bcdev: RESOLVED_BCDEV, async teardown() {} };
    const result = await resolveEnvToolSession(RUN_CONFIG_BCDEV, configFile, "run-1", {
      startSession: async (args) => {
        startCalls++;
        // The client/publisher wiring passed to `startEnvToolSession` must be usable — exercise
        // `makePublisher` the same way the real session does, proving it doesn't throw.
        args.makePublisher(RESOLVED_BCDEV);
        return fakeSession;
      },
    });
    expect(startCalls).toBe(1);
    expect(result.envSession).toBe(fakeSession);
    expect(result.effectiveConfig.bcdev).toBe(RESOLVED_BCDEV);
    expect(result.deploy).toBeDefined();

    // Downstream seams (buildBackend/leaseSessionFor/resourceIdentityFor in cli.ts) read
    // `effectiveConfig`, not the raw `configFile` — consuming it here must never re-trigger
    // provisioning (the fake above only allows exactly one call before it would already have
    // failed a caller expecting more).
    validateBcDevConfig(result.effectiveConfig.bcdev);
    leaseSessionFor(RUN_CONFIG_BCDEV, result.effectiveConfig);
    resourceIdentityFor(RUN_CONFIG_BCDEV, result.effectiveConfig);
    expect(startCalls).toBe(1);
  });

  it("validates the envTool config BEFORE ever starting a session", async () => {
    let startCalls = 0;
    const configFile: LethalConfigFile = {
      bcdev: BCDEV_RAW,
      // `resolve` is required by `validateEnvToolConfig` — omitting it must fail validation
      // before `startSession` is ever reached, since `startEnvToolSession` itself does not
      // re-validate and trusts this ordering.
      envTool: { toolPath: "tool.exe", publish: { command: ["publish"] } },
    };
    await expect(
      resolveEnvToolSession(RUN_CONFIG_BCDEV, configFile, "run-1", {
        startSession: async () => {
          startCalls++;
          throw new Error("must not be called on an invalid config");
        },
      }),
    ).rejects.toThrow(EnvToolError);
    expect(startCalls).toBe(0);
  });

  it("the raw pre-resolution bcdev section cannot satisfy validateBcDevConfig; the resolved effectiveConfig can", async () => {
    // Task 7's own hazard: a naive port could pass the RAW `configFile` (missing
    // server/serverInstance/username/password, which only the env tool supplies) to
    // leaseSessionFor/resourceIdentityFor/buildBackend instead of the resolved one.
    expect(() => validateBcDevConfig(BCDEV_RAW)).toThrow(/missing required field/);

    const configFile: LethalConfigFile = { bcdev: BCDEV_RAW, envTool: resolveModeCfg("env-4711") };
    const fakeSession: EnvToolSession = { bcdev: RESOLVED_BCDEV, async teardown() {} };
    const { effectiveConfig } = await resolveEnvToolSession(RUN_CONFIG_BCDEV, configFile, "run-1", {
      startSession: async () => fakeSession,
    });
    expect(() => validateBcDevConfig(effectiveConfig.bcdev)).not.toThrow();
    expect(resourceIdentityFor(RUN_CONFIG_BCDEV, effectiveConfig)).toEqual({
      resourceServer: RESOLVED_BCDEV.server,
      resourceServerInstance: RESOLVED_BCDEV.serverInstance,
    });
    expect(leaseSessionFor(RUN_CONFIG_BCDEV, effectiveConfig).lease).toBeDefined();
  });

  // Red-check target 2 (see task-7-report.md): a config-supplied (non-created) environment must
  // never be deleted at teardown. This exercises the REAL `startEnvToolSession` (only the spawn
  // and harness-verify are faked) through Task 7's own wrapper, not a mock of it — a wiring bug
  // that fed the wrong `keepEnv`/inverted the created/config-supplied distinction would surface
  // here, not just in Task 6's own unit tests.
  it("never deletes a config-supplied (non-created) environment, via the CLI wiring", async () => {
    const envId = "env-configured";
    const calls: string[][] = [];
    const configFile: LethalConfigFile = { bcdev: BCDEV_RAW, envTool: resolveModeCfg(envId) };
    const result = await resolveEnvToolSession(RUN_CONFIG_BCDEV, configFile, "run-1", {
      makeClient: (cfg) =>
        new EnvToolClient(cfg, {
          spawn: async (argv) => {
            calls.push([...argv]);
            return fakeSpawn(envId)(argv);
          },
        }),
      verifyHarness: async () => {},
    });
    expect(result.envSession?.createdEnvId).toBeUndefined();
    await result.envSession?.teardown({ keepEnv: false, quarantined: false });
    expect(calls.some((c) => c.includes("delete"))).toBe(false);
  });

  // Task 4's carried-forward requirement: the batch-artifact publisher (`buildBackend`) and the
  // control-app/publishApps publisher (`startEnvToolSession`'s own `makePublisher`) must derive
  // `serializerKey` identically, or per-environment publish serialization silently stops working.
  // Proven behaviorally, not by comparing strings: two publishers built the way each call site
  // actually builds them (same `deploy.client`/`deploy.publishBlock`, same resolved bcdev section)
  // must serialize against each other — a shared in-flight counter across BOTH must never exceed 1.
  it("both publisher constructions for one environment serialize against each other (identical serializerKey)", async () => {
    const envId = `env-${Math.random().toString(36).slice(2)}`;
    const counter = { current: 0, max: 0 };
    const configFile: LethalConfigFile = { bcdev: BCDEV_RAW, envTool: resolveModeCfg(envId) };
    const result = await resolveEnvToolSession(RUN_CONFIG_BCDEV, configFile, "run-1", {
      makeClient: (cfg) =>
        new EnvToolClient(cfg, {
          spawn: async (argv) => {
            const line = argv.join(" ");
            if (line.includes("publish")) {
              counter.current++;
              counter.max = Math.max(counter.max, counter.current);
              await new Promise((resolve) => setTimeout(resolve, 15));
              counter.current--;
              return { exitCode: 0, stdout: "{}", stderr: "" };
            }
            return fakeSpawn(envId)(argv);
          },
        }),
      verifyHarness: async () => {},
    });
    const { envSession, deploy, effectiveConfig } = result;
    if (envSession === undefined || deploy === undefined) {
      throw new Error("expected a resolved env-tool session");
    }
    // Publisher A: exactly what `buildBackend` constructs for the batch-artifact deployer.
    const resolvedForBuildBackend = validateBcDevConfig(effectiveConfig.bcdev);
    const publisherA = makeEnvToolPublisher(
      deploy.client,
      deploy.publishBlock,
      resolvedForBuildBackend,
    );
    // Publisher B: exactly what `startEnvToolSession`'s own `makePublisher` callback builds (same
    // recipe — reconstructed here since the session's internal instance was already used and
    // never returned).
    const publisherB = makeEnvToolPublisher(deploy.client, deploy.publishBlock, envSession.bcdev);

    // `publishFile` reads real bytes off disk (to hash and log) — point both calls at this test
    // file itself, which always exists, rather than a fictitious path.
    const realFile = import.meta.path;
    await Promise.all([publisherA.publishFile(realFile), publisherB.publishFile(realFile)]);
    expect(counter.max).toBe(1);
  });
});
