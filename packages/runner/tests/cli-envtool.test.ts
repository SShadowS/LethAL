import { describe, expect, it, spyOn } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AlRunnerBackend } from "../src/al-runner-backend";
import type { BcDevConfigSection, LethalConfigFile, RunCliConfig } from "../src/cli";
import {
  bcDevBackendConfig,
  buildBackend,
  deployerFor,
  leaseSessionFor,
  makeEnvToolPublisher,
  parseCliConfig,
  resolveEnvToolSession,
  resourceIdentityFor,
  runFromCli,
  validateBcDevConfig,
  withEnvTeardown,
} from "../src/cli";
import { EnvToolClient, EnvToolError } from "../src/env-tool";
import type { EnvToolConfigSection } from "../src/env-tool";
import type { EnvToolPublisher } from "../src/env-tool-publisher";
import type { EnvToolSession } from "../src/env-tool-session";
import type { SessionReport } from "../src/report";
import { ResultsStore } from "../src/store";

/** Writes a minimal valid (empty) `lethal.config.json` to a fresh scratch dir and returns its path.
 * Every field of `LethalConfigFile` is optional, so `{}` parses fine — tests that need real
 * `bcdev`/`envTool` content inject `resolveEnvToolSession` instead of relying on this file's
 * content, exactly like `resolveEnvToolSession`'s own no-op path for al-runner/no-envTool. */
async function writeTempConfig(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "lethal-cfgtest-"));
  const path = join(dir, "lethal.config.json");
  await writeFile(path, "{}", "utf8");
  return path;
}

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
    // Minor 9 (Task 7 review): `/keep-env/` also matches parseArgs' OWN "Unknown option
    // '--keep-env'" — deleting both the option declaration and the guard would leave this green.
    // Match text unique to the guard's own message instead.
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
    ).toThrow(/al-runner has no environment/);
  });

  // Minor 5 (Task 7 review): `--allow-expiring-env` got the silent-no-op treatment `--keep-env`
  // above explicitly refuses against — give it the identical guard and the identical test shape.
  it("rejects --allow-expiring-env with --backend al-runner, which has no environment", () => {
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
        "--allow-expiring-env",
      ]),
    ).toThrow(/al-runner has no environment/);
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
    const fakeSession: EnvToolSession = {
      bcdev: RESOLVED_BCDEV,
      envId: RESOLVED_BCDEV.serverInstance,
      async teardown() {},
    };
    const result = await resolveEnvToolSession(RUN_CONFIG_BCDEV, configFile, "run-1", {
      startSession: async (args) => {
        startCalls++;
        // The client/publisher wiring passed to `startEnvToolSession` must be usable — exercise
        // `makePublisher` the same way the real session does, proving it doesn't throw.
        args.makePublisher(RESOLVED_BCDEV, RESOLVED_BCDEV.serverInstance);
        return fakeSession;
      },
    });
    expect(startCalls).toBe(1);
    expect(result.envSession).toBe(fakeSession);
    expect(result.effectiveConfig.bcdev).toBe(RESOLVED_BCDEV);
    expect(result.deploy).toBeDefined();

    // Downstream seams (buildBackend/leaseSessionFor/resourceIdentityFor in cli.ts) read
    // `effectiveConfig`, not the raw `configFile`. None of them take `startSession` as an
    // argument, so by construction they cannot re-trigger provisioning — there is nothing further
    // to assert about `startCalls` after calling them (Minor 8, Task 7 review: a trailing
    // `expect(startCalls).toBe(1)` here could never go red no matter what these three functions
    // did, and was deleted). What this DOES still prove: none of the three throw when fed
    // `effectiveConfig`. The exactly-once guarantee itself is already pinned by the
    // `expect(startCalls).toBe(1)` directly above, right after `resolveEnvToolSession` returns.
    validateBcDevConfig(result.effectiveConfig.bcdev);
    leaseSessionFor(RUN_CONFIG_BCDEV, result.effectiveConfig);
    resourceIdentityFor(RUN_CONFIG_BCDEV, result.effectiveConfig);
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
    const fakeSession: EnvToolSession = {
      bcdev: RESOLVED_BCDEV,
      envId: RESOLVED_BCDEV.serverInstance,
      async teardown() {},
    };
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
    // Publisher A: exactly what `buildBackend` constructs for the batch-artifact deployer — via
    // `deployerFor`, the SAME function `buildBackend` itself calls (Minor 7, Task 7 review: this
    // test used to call `makeEnvToolPublisher` directly for BOTH publishers, which only proved
    // that function deterministic and would have stayed green even if `buildBackend` inlined a
    // divergent `serializerKey` — the exact regression this test claims to guard). `deployerFor`
    // is given an `envToolDeploy`, so it always takes the env-tool branch and the (unused in that
    // branch) `altoolPath` argument is a placeholder.
    const resolvedForBuildBackend = validateBcDevConfig(effectiveConfig.bcdev);
    const publisherA = deployerFor(
      resolvedForBuildBackend,
      "unused-altool-path",
      deploy,
    ) as EnvToolPublisher;
    // Publisher B: exactly what `startEnvToolSession`'s own `makePublisher` callback builds (same
    // recipe — reconstructed here since the session's internal instance was already used and
    // never returned).
    const publisherB = makeEnvToolPublisher(
      deploy.client,
      deploy.publishBlock,
      deploy.envId,
      envSession.bcdev,
    );

    // `publishFile` reads real bytes off disk (to hash and log) — point both calls at this test
    // file itself, which always exists, rather than a fictitious path.
    const realFile = import.meta.path;
    await Promise.all([publisherA.publishFile(realFile), publisherB.publishFile(realFile)]);
    expect(counter.max).toBe(1);
  });

  // Final review item 2: `makeEnvToolPublisher` used to derive `envId` from `bcdev.serverInstance`,
  // which only coincidentally equals the real envId when `serverInstance` is itself derived from
  // `baseUrl`'s first path segment AND that segment happens to be the envId. Neither holds for a
  // portal whose URL is `https://host/tenants/{envId}` — fixtures/README.md's own worked example
  // of the failure mode — where `serverInstance` derives to `"tenants"`. The publish command must
  // still target the real, resolved envId.
  it("threads the actual resolved envId to the publish command, not bcdev.serverInstance derived from an unrelated URL segment", async () => {
    const envId = "env-4711";
    const calls: string[][] = [];
    const configFile: LethalConfigFile = { bcdev: BCDEV_RAW, envTool: resolveModeCfg(envId) };
    const result = await resolveEnvToolSession(RUN_CONFIG_BCDEV, configFile, "run-1", {
      makeClient: (cfg) =>
        new EnvToolClient(cfg, {
          spawn: async (argv) => {
            calls.push([...argv]);
            const line = argv.join(" ");
            if (line.includes("env get")) {
              // First path segment is "tenants", not the envId — exactly the case
              // fixtures/README.md calls out by name.
              return { exitCode: 0, stdout: `{"url":"https://host/tenants/${envId}"}`, stderr: "" };
            }
            return fakeSpawn(envId)(argv);
          },
        }),
      verifyHarness: async () => {},
    });
    const { envSession, deploy } = result;
    if (envSession === undefined || deploy === undefined) {
      throw new Error("expected a resolved env-tool session");
    }
    expect(envSession.bcdev.serverInstance).toBe("tenants");
    expect(envSession.envId).toBe(envId);
    expect(deploy.envId).toBe(envId);

    const publisher = makeEnvToolPublisher(
      deploy.client,
      deploy.publishBlock,
      deploy.envId,
      envSession.bcdev,
    );
    calls.length = 0; // isolate the argv this publish call itself produces
    await publisher.publishFile(import.meta.path);
    const publishCall = calls.find((c) => c.includes("publish"));
    expect(publishCall).toBeDefined();
    expect(publishCall).toContain(envId);
    expect(publishCall).not.toContain("tenants");
  });
});

// ————————————————————————————————————————————————————————————————————————
// Task 7 review, Important 1 + 2 — `withEnvTeardown`: the core mechanism that (1) tears down
// `envSession` no matter how `body` settles (a `buildBackend` failure must not leak a real,
// possibly-billed environment), and (2) never lets a REJECTING `teardown` replace `body`'s own
// report or thrown error (a `deleteEnv` block naming an unsuppliable placeholder like `{appFile}`
// makes `env-tool-session.ts`'s own `teardown` reject even after it already caught its own
// `client.run` failure — see that file's doc comment).
// ————————————————————————————————————————————————————————————————————————

const FAKE_REPORT: SessionReport = {
  schemaVersion: 1,
  validity: {
    reliability: "full",
    caveats: [],
    scoreDescribes: "test fixture",
    baselineTests: { total: 0, failing: 0 },
    scoredMutants: { scored: 0, recorded: 0 },
  },
  survivorsByProcedure: [],
  testFiles: {},
  backend: "fake",
  authoritative: true,
  baselineGreen: true,
  batches: 1,
  counts: {
    killed: 0,
    survived: 0,
    noCoverage: 0,
    timeoutKilled: 0,
    knownSurvivors: 0,
    unstable: 0,
    errors: 0,
    deadlineExceeded: 0,
  },
  mutationScore: null,
  mutants: [],
  unsupportedTests: [],
  notInstrumented: { totalFiles: 0, fileCount: 0, siteCount: 0, files: [] },
  timings: {
    totalMs: 0,
    generateMutationSetMs: 0,
    deployMs: 0,
    baselineMs: 0,
    mutantsMs: 0,
    perMutant: { count: 0, meanMs: 0, medianMs: 0, p95Ms: 0, maxMs: 0 },
  },
  untargetedTriggerCount: 0,
};

const QUARANTINED_FAKE_REPORT: SessionReport = {
  ...FAKE_REPORT,
  quarantined: { reason: "test: in-flight-unknown" },
};

describe("withEnvTeardown", () => {
  it("Important 1: tears down even when body throws (e.g. buildBackend failing)", async () => {
    const teardownCalls: Array<{ keepEnv: boolean; quarantined: boolean }> = [];
    const envSession: EnvToolSession = {
      bcdev: RESOLVED_BCDEV,
      envId: RESOLVED_BCDEV.serverInstance,
      createdEnvId: "env-created",
      async teardown(opts) {
        teardownCalls.push(opts);
      },
    };
    const bodyErr = new Error("could not locate alc.exe/altool.exe");
    await expect(
      withEnvTeardown(envSession, false, async () => {
        throw bodyErr;
      }),
    ).rejects.toBe(bodyErr);
    expect(teardownCalls).toEqual([{ keepEnv: false, quarantined: false }]);
  });

  it("is a no-op when there is no env-tool session (al-runner / bcdev without envTool)", async () => {
    const result = await withEnvTeardown(undefined, false, async () => FAKE_REPORT);
    expect(result).toBe(FAKE_REPORT);
  });

  it("Important 2: a rejecting teardown does not replace the body's report (exit code stays intact)", async () => {
    const warnCalls: unknown[][] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnCalls.push(args);
    };
    try {
      const envSession: EnvToolSession = {
        bcdev: RESOLVED_BCDEV,
        envId: RESOLVED_BCDEV.serverInstance,
        createdEnvId: "env-created",
        async teardown() {
          // Mirrors env-tool-session.ts's own failure mode: `deleteEnv` names `{appFile}`, which
          // `renderCommand` cannot supply at teardown time.
          throw new EnvToolError(
            "envTool: no value available for placeholder {appFile} while building deleteEnv",
          );
        },
      };
      const result = await withEnvTeardown(envSession, false, async () => FAKE_REPORT);
      expect(result).toBe(FAKE_REPORT);
    } finally {
      console.warn = originalWarn;
    }
    expect(warnCalls.some((args) => String(args[0]).includes("teardown failed"))).toBe(true);
  });

  it("Important 2: a rejecting teardown does not replace the body's own thrown error", async () => {
    const envSession: EnvToolSession = {
      bcdev: RESOLVED_BCDEV,
      envId: RESOLVED_BCDEV.serverInstance,
      createdEnvId: "env-created",
      async teardown() {
        throw new Error("deleteEnv boom");
      },
    };
    const bodyErr = new Error("runSession blew up");
    await expect(
      withEnvTeardown(envSession, false, async () => {
        throw bodyErr;
      }),
    ).rejects.toBe(bodyErr);
  });
});

// ————————————————————————————————————————————————————————————————————————
// Task 7 review, Important 1 + 3 + Minor 6 — `runFromCli`'s own wiring: proves the fixes actually
// reach the real entry point (not just `withEnvTeardown` in isolation). `resolveEnvToolSession` and
// `buildBackend` are injected so these run without a real environment tool or a real alc/altool
// install; `loadLethalConfigFile` still reads a REAL (minimal, empty) file since it isn't
// injectable — its content is irrelevant once `resolveEnvToolSession` is replaced.
// ————————————————————————————————————————————————————————————————————————
// ————————————————————————————————————————————————————————————————————————
// R3 review: `validateSelectorIdsForProject` must run BEFORE `resolveEnvToolSession` —
// `resolveEnvToolSession` can provision a real, billed Layer-6C environment (`startEnvToolSession`
// in create-mode), so a bad selector id should fail in milliseconds, not after that environment
// already exists. Asserted with a call-order counter on fakes for both, per this project's "assert
// phase ordering with call counters on stateful fakes, never wall-clock timing" convention — NOT
// by timing anything.
// ————————————————————————————————————————————————————————————————————————
describe("runFromCli (R3 review — id validation runs before env-tool provisioning)", () => {
  it("calls validateSelectorIdsForProject before resolveEnvToolSession", async () => {
    const configPath = await writeTempConfig();
    const parsed: RunCliConfig = { ...RUN_CONFIG_BCDEV, configPath };
    const calls: string[] = [];
    await expect(
      runFromCli(parsed, {
        validateSelectorIdsForProject: async () => {
          calls.push("validateSelectorIdsForProject");
        },
        resolveEnvToolSession: async () => {
          calls.push("resolveEnvToolSession");
          return { effectiveConfig: {} };
        },
        buildBackend: async () => {
          calls.push("buildBackend");
          throw new Error("stop before a real backend build");
        },
      }),
    ).rejects.toThrow("stop before a real backend build");
    expect(calls).toEqual([
      "validateSelectorIdsForProject",
      "resolveEnvToolSession",
      "buildBackend",
    ]);
  });

  it("a rejecting validateSelectorIdsForProject aborts before resolveEnvToolSession ever runs", async () => {
    const configPath = await writeTempConfig();
    const parsed: RunCliConfig = { ...RUN_CONFIG_BCDEV, configPath };
    const calls: string[] = [];
    const idErr = new Error("selector id out of range: selectorId = 1 falls outside...");
    await expect(
      runFromCli(parsed, {
        validateSelectorIdsForProject: async () => {
          calls.push("validateSelectorIdsForProject");
          throw idErr;
        },
        resolveEnvToolSession: async () => {
          calls.push("resolveEnvToolSession");
          return { effectiveConfig: {} };
        },
      }),
    ).rejects.toBe(idErr);
    // The whole point: resolveEnvToolSession (and therefore any real environment provisioning)
    // never runs at all once id validation has already failed.
    expect(calls).toEqual(["validateSelectorIdsForProject"]);
  });
});

describe("runFromCli (Task 7 review wiring)", () => {
  it("Important 1: a buildBackend failure still tears down an env-tool-provisioned environment", async () => {
    const configPath = await writeTempConfig();
    const teardownCalls: Array<{ keepEnv: boolean; quarantined: boolean }> = [];
    const fakeSession: EnvToolSession = {
      bcdev: RESOLVED_BCDEV,
      envId: RESOLVED_BCDEV.serverInstance,
      createdEnvId: "env-created",
      async teardown(opts) {
        teardownCalls.push(opts);
      },
    };
    const parsed: RunCliConfig = { ...RUN_CONFIG_BCDEV, configPath };
    const buildErr = new Error(
      "could not locate alc.exe/altool.exe under the AL Language VS Code extension install",
    );
    await expect(
      runFromCli(parsed, {
        // R3 review: `runFromCli` now runs `validateSelectorIdsForProject` before
        // `resolveEnvToolSession` — faked here (a no-op) since `RUN_CONFIG_BCDEV.projectDir`
        // ("C:/proj") has no real app.json for the real one to read.
        validateSelectorIdsForProject: async () => {},
        resolveEnvToolSession: async () => ({
          effectiveConfig: {},
          envSession: fakeSession,
        }),
        buildBackend: async () => {
          throw buildErr;
        },
      }),
    ).rejects.toBe(buildErr);
    expect(teardownCalls).toEqual([{ keepEnv: false, quarantined: false }]);
  });

  it("Important 2: teardown rejecting after a buildBackend failure surfaces the ORIGINAL error, not teardown's", async () => {
    const configPath = await writeTempConfig();
    const fakeSession: EnvToolSession = {
      bcdev: RESOLVED_BCDEV,
      envId: RESOLVED_BCDEV.serverInstance,
      createdEnvId: "env-created",
      async teardown() {
        throw new EnvToolError("envTool: no value available for placeholder {appFile}");
      },
    };
    const parsed: RunCliConfig = { ...RUN_CONFIG_BCDEV, configPath };
    const buildErr = new Error("could not locate alc.exe/altool.exe");
    await expect(
      runFromCli(parsed, {
        validateSelectorIdsForProject: async () => {},
        resolveEnvToolSession: async () => ({
          effectiveConfig: {},
          envSession: fakeSession,
        }),
        buildBackend: async () => {
          throw buildErr;
        },
      }),
    ).rejects.toBe(buildErr);
  });

  it("Minor 6: --keep-env with bcdev but no envTool section warns instead of a silent no-op", async () => {
    const configPath = await writeTempConfig();
    const parsed: RunCliConfig = { ...RUN_CONFIG_BCDEV, configPath, keepEnv: true };
    const warnCalls: unknown[][] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnCalls.push(args);
    };
    try {
      // The REAL `resolveEnvToolSession` runs here (not injected) — `{}` has no `bcdev`/`envTool`
      // section, so it takes the no-op path (`envSession` undefined) exactly like a real bcdev
      // config with no `envTool` section would. `buildBackend` is injected to stop the run before
      // it needs a real alc/altool install — this test is only about the warning.
      await expect(
        runFromCli(parsed, {
          validateSelectorIdsForProject: async () => {},
          buildBackend: async () => {
            throw new Error("stop before a real backend build");
          },
        }),
      ).rejects.toThrow("stop before a real backend build");
    } finally {
      console.warn = originalWarn;
    }
    expect(warnCalls.some((args) => String(args[0]).includes("--keep-env has no effect"))).toBe(
      true,
    );
  });

  // Task 7 review, wave 2: the restructure that fixed Important 1 introduced a new bug — a
  // `return await runSession(...)` directly inside the `try` whose `finally` calls
  // `store.close()`/`backend.close()`. Per JS `try/finally` semantics, a throw from `finally`
  // silently DISCARDS the `try`'s pending return value. `report = await runSession(...)` (a local,
  // captured BEFORE the `finally` runs) plus non-fatal, warn-only cleanup closes both holes. Uses a
  // REAL `ResultsStore(":memory:")`/`AlRunnerBackend`, monkey-patching their own `close()` methods
  // to fail — exactly how the coordinator's own re-review verified the defect — rather than fully
  // fake objects, so the `instanceof` checks in `runFromCli`'s cleanup actually engage.
  it("wave 2: a quarantined report survives a store.close() failure, and teardown still sees quarantined:true", async () => {
    const configPath = await writeTempConfig();
    const teardownCalls: Array<{ keepEnv: boolean; quarantined: boolean }> = [];
    const fakeSession: EnvToolSession = {
      bcdev: RESOLVED_BCDEV,
      envId: RESOLVED_BCDEV.serverInstance,
      createdEnvId: "env-created",
      async teardown(opts) {
        teardownCalls.push(opts);
      },
    };
    // al-runner (not bcdev): `resourceIdentityFor`/`leaseSessionFor` are no-ops for al-runner, so
    // this doesn't ALSO need a real/fake `bcdev` config section just to reach `runTheSession` — the
    // point of this test is purely the store/backend cleanup-vs-return-value ordering, which is
    // identical for either backend kind.
    const parsed: RunCliConfig = {
      ...RUN_CONFIG_BCDEV,
      backendKind: "al-runner",
      configPath,
      dbPath: ":memory:",
    };
    const originalClose = ResultsStore.prototype.close;
    ResultsStore.prototype.close = () => {
      throw new Error("store.close boom");
    };
    try {
      const result = await runFromCli(parsed, {
        validateSelectorIdsForProject: async () => {},
        resolveEnvToolSession: async () => ({
          effectiveConfig: {},
          envSession: fakeSession,
        }),
        buildBackend: async () =>
          new AlRunnerBackend({
            alRunnerPath: "unused",
            instrumentedDir: "unused",
            testDir: "unused",
            selectorObjectId: 1,
          }),
        runSession: async () => QUARANTINED_FAKE_REPORT,
      });
      expect(result).toBe(QUARANTINED_FAKE_REPORT);
    } finally {
      ResultsStore.prototype.close = originalClose;
    }
    // Asserted via the teardown spy's actual arguments — not inferred from the resolved report —
    // since the whole point is that a `store.close()` failure must not make `quarantined` look
    // `false` to `envSession.teardown` (which would delete the environment the quarantine exists
    // to preserve).
    expect(teardownCalls).toEqual([{ keepEnv: false, quarantined: true }]);
  });

  it("wave 2: a normal report survives a backend.close() failure", async () => {
    const configPath = await writeTempConfig();
    const parsed: RunCliConfig = {
      ...RUN_CONFIG_BCDEV,
      backendKind: "al-runner",
      configPath,
      dbPath: ":memory:",
    };
    const originalClose = AlRunnerBackend.prototype.close;
    AlRunnerBackend.prototype.close = async () => {
      throw new Error("backend.close boom");
    };
    try {
      const result = await runFromCli(parsed, {
        validateSelectorIdsForProject: async () => {},
        buildBackend: async () =>
          new AlRunnerBackend({
            alRunnerPath: "unused",
            instrumentedDir: "unused",
            testDir: "unused",
            selectorObjectId: 1,
          }),
        runSession: async () => FAKE_REPORT,
      });
      expect(result).toBe(FAKE_REPORT);
    } finally {
      AlRunnerBackend.prototype.close = originalClose;
    }
  });
});

// ————————————————————————————————————————————————————————————————————————
// Task 7 review, Important 3 — `buildBackend` must refuse to silently fall back to
// `ContainerDeployer`/altool for a bcdev config that has an `envTool` section configured but was
// not given an env-tool deploy to publish through (the worker-backend loop is the one call site
// that used to omit it).
// ————————————————————————————————————————————————————————————————————————
describe("buildBackend (Important 3 — never silently drop the env-tool publisher)", () => {
  it("throws when bcdev + envTool is configured but no env-tool deploy was supplied", async () => {
    const configFile: LethalConfigFile = {
      bcdev: RESOLVED_BCDEV,
      envTool: resolveModeCfg("env-4711"),
    };
    // Reachable without a real alc/altool install: the check fires before `defaultAlToolPaths()`.
    await expect(buildBackend(RUN_CONFIG_BCDEV, configFile, "C:/scratch")).rejects.toThrow(
      /no env-tool deploy was supplied/,
    );
  });
});

// ————————————————————————————————————————————————————————————————————————
// R21: the env-tool publish path never constructs a `ContainerDeployer`, so altool.exe is
// irrelevant to it — only alc.exe (compilation, which is always local) is genuinely required
// there. `buildBackend`'s "could not locate..." message must name only what the CHOSEN path
// actually uses.
// ————————————————————————————————————————————————————————————————————————
describe("buildBackend (R21 — accurate alc/altool requirement per path)", () => {
  const configFile: LethalConfigFile = {
    bcdev: RESOLVED_BCDEV,
    envTool: resolveModeCfg("env-4711"),
  };
  const deploy = {
    client: new EnvToolClient(resolveModeCfg("env-4711"), {
      spawn: async () => ({ exitCode: 0, stdout: "{}", stderr: "" }),
    }),
    publishBlock: { command: ["publish"] },
    envId: "env-4711",
  };
  const missingAlToolPaths = async () => undefined;

  it("names only alc.exe (not altool.exe) when the env-tool deploy path is taken", async () => {
    await expect(
      buildBackend(RUN_CONFIG_BCDEV, configFile, "C:/scratch", deploy, {
        alToolPaths: missingAlToolPaths,
      }),
    ).rejects.toThrow(/could not locate alc\.exe under/);
    // The differentiator: must not ALSO claim altool.exe is required on this path.
    const err = await buildBackend(RUN_CONFIG_BCDEV, configFile, "C:/scratch", deploy, {
      alToolPaths: missingAlToolPaths,
    }).catch((e: unknown) => (e instanceof Error ? e.message : String(e)));
    expect(err).not.toContain("altool.exe");
  });

  it("still names both alc.exe and altool.exe on the ordinary ContainerDeployer path (no envToolDeploy)", async () => {
    const err = await buildBackend(
      RUN_CONFIG_BCDEV,
      { bcdev: RESOLVED_BCDEV },
      "C:/scratch",
      undefined,
      {
        alToolPaths: missingAlToolPaths,
      },
    ).catch((e: unknown) => (e instanceof Error ? e.message : String(e)));
    expect(err).toContain("alc.exe/altool.exe");
  });
});

// ————————————————————————————————————————————————————————————————————————
// R18: `--keep-env`/`--allow-expiring-env` are refused OUTRIGHT for `--backend al-runner` on the
// reasoning that a silent no-op is wrong (see parseCliConfig). A whole configured `envTool`
// section being silently ignored on that same backend deserves at least a warning.
// ————————————————————————————————————————————————————————————————————————
describe("runFromCli (R18 — envTool configured but ignored under al-runner)", () => {
  async function writeConfigWithEnvTool(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "lethal-cfgtest-"));
    const path = join(dir, "lethal.config.json");
    await writeFile(path, JSON.stringify({ envTool: { toolPath: "tool.exe" } }), "utf8");
    return path;
  }

  it("warns when envTool is configured but --backend al-runner cannot use it", async () => {
    const configPath = await writeConfigWithEnvTool();
    const parsed: RunCliConfig = {
      ...RUN_CONFIG_BCDEV,
      backendKind: "al-runner",
      configPath,
      dbPath: ":memory:",
    };
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    let warnings: string[];
    try {
      await runFromCli(parsed, {
        validateSelectorIdsForProject: async () => {},
        resolveEnvToolSession: async () => ({ effectiveConfig: {} }),
        buildBackend: async () =>
          new AlRunnerBackend({
            alRunnerPath: "unused",
            instrumentedDir: "unused",
            testDir: "unused",
            selectorObjectId: 1,
          }),
        runSession: async () => FAKE_REPORT,
      });
      // Captured BEFORE mockRestore(), which clears .mock.calls (mirrors harness.test.ts's
      // verifyQuiet — reading .mock.calls after restore sees an empty array).
      warnings = warnSpy.mock.calls.map((c) => String(c[0]));
    } finally {
      warnSpy.mockRestore();
    }
    expect(warnings.some((w) => w.includes("envTool") && w.includes("IGNORED"))).toBe(true);
  });

  it("does not warn under al-runner when no envTool section is configured", async () => {
    const configPath = await writeTempConfig(); // writes "{}" — no envTool key at all
    const parsed: RunCliConfig = {
      ...RUN_CONFIG_BCDEV,
      backendKind: "al-runner",
      configPath,
      dbPath: ":memory:",
    };
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    let warnings: string[];
    try {
      await runFromCli(parsed, {
        validateSelectorIdsForProject: async () => {},
        resolveEnvToolSession: async () => ({ effectiveConfig: {} }),
        buildBackend: async () =>
          new AlRunnerBackend({
            alRunnerPath: "unused",
            instrumentedDir: "unused",
            testDir: "unused",
            selectorObjectId: 1,
          }),
        runSession: async () => FAKE_REPORT,
      });
      warnings = warnSpy.mock.calls.map((c) => String(c[0]));
    } finally {
      warnSpy.mockRestore();
    }
    expect(warnings.some((w) => w.includes("envTool"))).toBe(false);
  });
});

// ————————————————————————————————————————————————————————————————————————
// Task 7 review, Important 4 — `coverageMode` (the env-tool fallback for when bc-dev-mcp cannot
// reach the environment) had no `BcDevConfigSection` field and nothing forwarded one, so `"none"`
// could never actually be selected by a `lethal run`. `bcDevBackendConfig` is the pure seam
// `buildBackend` uses to shape `BcDevMcpBackend`'s config — tested directly, mirroring exactly how
// `port` (an existing, working pass-through) is proven.
// ————————————————————————————————————————————————————————————————————————
describe("bcDevBackendConfig (Important 4 — coverageMode config surface)", () => {
  it("forwards coverageMode when present, exactly like port", () => {
    const c: BcDevConfigSection = { ...RESOLVED_BCDEV, port: 7050, coverageMode: "none" };
    const cfg = bcDevBackendConfig(c, "C:/proj");
    expect(cfg.coverageMode).toBe("none");
    expect(cfg.port).toBe(7050);
  });

  it("omits coverageMode when absent, leaving BcDevMcpBackend's own default in effect", () => {
    const cfg = bcDevBackendConfig(RESOLVED_BCDEV, "C:/proj");
    expect(cfg.coverageMode).toBeUndefined();
    expect("coverageMode" in cfg).toBe(false);
  });
});

// ————————————————————————————————————————————————————————————————————————
// R43: the compiler BUILD is not interchangeable. Measured 2026-07-27 on Continia Document
// Output: `alc 18` writes OPC part names with single-encoded spaces (`Codeunit%206175272%20...`)
// where `alc 17` double-encodes them (`Codeunit%25206175272%2520...`), so BC 28 cannot find the
// parts and refuses the package with "Specified part does not exist in the package." — for any
// project whose source file names contain spaces. With no override, the machine's newest AL
// extension decided which compiler ran, and losing that lottery made a real app unpublishable.
// ————————————————————————————————————————————————————————————————————————
describe("buildBackend (R43 — bcdev.alcPath selects the compiler)", () => {
  const deploy = {
    client: new EnvToolClient(resolveModeCfg("env-4711"), {
      spawn: async () => ({ exitCode: 0, stdout: "{}", stderr: "" }),
    }),
    publishBlock: { command: ["publish"] },
    envId: "env-4711",
  };
  const missingAlToolPaths = async () => undefined;

  it("a configured alcPath satisfies the 'no AL extension installed' gate on the env-tool path", async () => {
    // The gate exists to catch "no AL compiler anywhere". An explicit path IS a compiler, so it
    // must not still refuse — otherwise pinning a compiler would require also installing an
    // extension whose compiler is the wrong one.
    const configFile: LethalConfigFile = {
      bcdev: { ...RESOLVED_BCDEV, alcPath: "C:/pinned/alc.exe" },
      envTool: resolveModeCfg("env-4711"),
    };
    const err = await buildBackend(RUN_CONFIG_BCDEV, configFile, "C:/scratch", deploy, {
      alToolPaths: missingAlToolPaths,
    }).catch((e: unknown) => (e instanceof Error ? e.message : String(e)));
    expect(err).not.toContain("could not locate alc.exe");
  });

  it("without alcPath, a missing AL extension is still refused on the env-tool path", async () => {
    // The counterweight: without it, the test above would pass just as well if the gate had been
    // removed outright rather than made satisfiable.
    const configFile: LethalConfigFile = {
      bcdev: RESOLVED_BCDEV,
      envTool: resolveModeCfg("env-4711"),
    };
    await expect(
      buildBackend(RUN_CONFIG_BCDEV, configFile, "C:/scratch", deploy, {
        alToolPaths: missingAlToolPaths,
      }),
    ).rejects.toThrow(/could not locate alc\.exe under/);
  });

  it("the ContainerDeployer path still requires the extension even with alcPath set (altool comes from it)", async () => {
    // alcPath names a COMPILER, not a publisher. The non-envTool path publishes with altool.exe,
    // which only the extension install provides, so pinning alc must not wave that requirement
    // through and fail later at publish time instead.
    const configFile: LethalConfigFile = {
      bcdev: { ...RESOLVED_BCDEV, alcPath: "C:/pinned/alc.exe" },
    };
    const err = await buildBackend(RUN_CONFIG_BCDEV, configFile, "C:/scratch", undefined, {
      alToolPaths: missingAlToolPaths,
    }).catch((e: unknown) => (e instanceof Error ? e.message : String(e)));
    expect(err).toContain("alc.exe/altool.exe");
  });
});
