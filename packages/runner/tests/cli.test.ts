import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ActivationConfig } from "../src/activation";
import type { BcDevConfigSection } from "../src/cli";
import {
  clearQuarantine,
  leaseSessionFor,
  odataBaseUrl,
  odataCfgFor,
  parseCliConfig,
  performForceResetLease,
  resourceIdentityFor,
  validateAlRunnerConfig,
  validateBcDevConfig,
} from "../src/cli";
import { CONTROL_APP_ID } from "../src/harness";
import { LeaseClient } from "../src/lease";
import { QuarantineStore } from "../src/quarantine-store";
import { quarantineResourceKey } from "../src/resource-key";

describe("parseCliConfig", () => {
  test("missing --project throws a clear error", () => {
    expect(() => parseCliConfig(["run", "--tests", "t", "--backend", "al-runner"])).toThrow(
      "missing required --project",
    );
  });

  test("--dry-run only requires --project (no --tests/--backend)", () => {
    const parsed = parseCliConfig(["run", "--project", "proj", "--dry-run"]);
    expect(parsed).toEqual({ mode: "dry-run", projectDir: "proj" });
  });

  test("missing --tests (non-dry-run) throws a clear error", () => {
    expect(() => parseCliConfig(["run", "--project", "proj", "--backend", "al-runner"])).toThrow(
      "missing required --tests",
    );
  });

  test("missing --backend (non-dry-run) throws a clear error", () => {
    expect(() => parseCliConfig(["run", "--project", "proj", "--tests", "t"])).toThrow(
      "missing required --backend",
    );
  });

  test("unknown --backend value throws a clear error", () => {
    expect(() =>
      parseCliConfig(["run", "--project", "proj", "--tests", "t", "--backend", "nope"]),
    ).toThrow('unknown --backend "nope"');
  });

  test("valid al-runner args fill in defaults for db/config/skip-known-survivors", () => {
    const parsed = parseCliConfig([
      "run",
      "--project",
      "proj",
      "--tests",
      "t",
      "--backend",
      "al-runner",
    ]);
    expect(parsed).toEqual({
      mode: "run",
      projectDir: "proj",
      testDir: "t",
      backendKind: "al-runner",
      dbPath: join("proj", "lethal.sqlite"),
      configPath: join("proj", "lethal.config.json"),
      skipKnownSurvivors: false,
      workers: 1,
    });
  });

  test("explicit --db/--out/--config/--skip-known-survivors are honored", () => {
    const parsed = parseCliConfig([
      "run",
      "--project",
      "proj",
      "--tests",
      "t",
      "--backend",
      "bcdev",
      "--db",
      "custom.sqlite",
      "--out",
      "report.json",
      "--config",
      "custom.config.json",
      "--skip-known-survivors",
    ]);
    expect(parsed).toEqual({
      mode: "run",
      projectDir: "proj",
      testDir: "t",
      backendKind: "bcdev",
      dbPath: "custom.sqlite",
      configPath: "custom.config.json",
      skipKnownSurvivors: true,
      outPath: "report.json",
      workers: 1,
    });
  });

  test("run subcommand is accepted (C1)", () => {
    const parsed = parseCliConfig(["run", "--project", "proj", "--dry-run"]);
    expect(parsed.mode).toBe("dry-run");
  });

  test("unknown subcommand is rejected with a clear error (C1)", () => {
    expect(() => parseCliConfig(["frobnicate", "--project", "proj", "--dry-run"])).toThrow(
      /unknown subcommand: got "frobnicate", expected one of: run/,
    );
  });

  test("missing subcommand is rejected with a clear error (C1)", () => {
    expect(() => parseCliConfig(["--project", "proj", "--dry-run"])).toThrow(
      /unknown subcommand: got none, expected one of: run/,
    );
  });
});

describe("validateBcDevConfig", () => {
  const full = {
    mcpCommand: ["bun", "x", "bc-dev-mcp"],
    server: "http://bc",
    serverInstance: "BC",
    company: "CRONUS",
    username: "u",
    password: "p",
    packageCachePath: "C:/.alpackages",
    controlSymbolPath: "C:/lethal-control.app",
  };

  test("passes through a complete section", () => {
    expect(validateBcDevConfig(full)).toEqual(full);
  });

  test("missing section entirely throws", () => {
    expect(() => validateBcDevConfig(undefined)).toThrow('missing the "bcdev" section');
  });

  test("reports every missing field by name", () => {
    const { username, password, ...partial } = full;
    expect(() => validateBcDevConfig(partial)).toThrow(/username, password/);
  });

  test("empty mcpCommand array counts as missing", () => {
    expect(() => validateBcDevConfig({ ...full, mcpCommand: [] })).toThrow(/mcpCommand/);
  });
});

describe("odataBaseUrl", () => {
  // Verified against a real BC server (2026-07-18): the OData/web-service endpoint listens on
  // port 7048, not whatever port (or none, i.e. 80) `server` carries — 80 returns 404, 7048
  // serves OData. Mirrors bc-mcp's already-working `deriveODataUrl`.
  test("injects port 7048 when the server URL has none", () => {
    expect(odataBaseUrl("http://Cronus28", "BC")).toBe("http://cronus28:7048/BC");
  });

  test("replaces an explicit non-7048 port", () => {
    expect(odataBaseUrl("http://Cronus28:80", "BC")).toBe("http://cronus28:7048/BC");
  });

  test("leaves an already-correct port 7048 alone", () => {
    expect(odataBaseUrl("http://Cronus28:7048", "BC")).toBe("http://cronus28:7048/BC");
  });
});

// t7 (5C-B2): buildBackend's HarnessVerifier and leaseSessionFor's own separate one used to build
// this object inline, independently — the two could silently drift if either grew a field. Both
// now call this single helper; these tests pin its own shape down directly (buildBackend itself
// is not unit-tested — it needs a real alc.exe/AL-extension install — so this is the closest
// direct seam for the extraction).
describe("odataCfgFor (t7: the shared OData config both buildBackend and leaseSessionFor build from)", () => {
  const FULL_SECTION: BcDevConfigSection = {
    mcpCommand: ["bun", "x", "bc-dev-mcp"],
    server: "http://Cronus281",
    serverInstance: "BC",
    tenant: "default",
    company: "CRONUS Danmark A/S",
    username: "u",
    password: "p",
    packageCachePath: "C:/.alpackages",
    controlSymbolPath: "C:/lethal-control.app",
  };

  test("builds baseUrl (via odataBaseUrl) + company/username/password/tenant", () => {
    expect(odataCfgFor(FULL_SECTION)).toEqual({
      baseUrl: "http://cronus281:7048/BC",
      company: "CRONUS Danmark A/S",
      username: "u",
      password: "p",
      tenant: "default",
    });
  });

  test("omits the tenant key entirely when absent (exactOptionalPropertyTypes)", () => {
    const { tenant: _tenant, ...withoutTenant } = FULL_SECTION;
    const cfg = odataCfgFor(withoutTenant);
    expect(cfg).not.toHaveProperty("tenant");
    expect(cfg).toEqual({
      baseUrl: "http://cronus281:7048/BC",
      company: "CRONUS Danmark A/S",
      username: "u",
      password: "p",
    });
  });
});

describe("parseCliConfig — worker flags", () => {
  test("defaults to a single worker", () => {
    const p = parseCliConfig(["run", "--project", "p", "--tests", "t", "--backend", "al-runner"]);
    if (p.mode !== "run") throw new Error("expected a run config");
    expect(p.workers).toBe(1);
  });

  test("accepts --workers and --compile-concurrency", () => {
    const p = parseCliConfig([
      "run",
      "--project",
      "p",
      "--tests",
      "t",
      "--backend",
      "al-runner",
      "--workers",
      "4",
      "--compile-concurrency",
      "2",
    ]);
    if (p.mode !== "run") throw new Error("expected a run config");
    expect(p.workers).toBe(4);
    expect(p.compileConcurrency).toBe(2);
  });

  test("rejects a non-positive worker count with a clear message", () => {
    expect(() =>
      parseCliConfig([
        "run",
        "--project",
        "p",
        "--tests",
        "t",
        "--backend",
        "al-runner",
        "--workers",
        "0",
      ]),
    ).toThrow(/--workers must be a positive integer/);
  });

  test("rejects --backend bcdev with --workers > 1", () => {
    expect(() =>
      parseCliConfig([
        "run",
        "--project",
        "p",
        "--tests",
        "t",
        "--backend",
        "bcdev",
        "--workers",
        "2",
      ]),
    ).toThrow(/--workers > 1 is not supported with --backend bcdev/);
  });

  test("accepts --backend bcdev with --workers 1 (default)", () => {
    const p = parseCliConfig(["run", "--project", "p", "--tests", "t", "--backend", "bcdev"]);
    if (p.mode !== "run") throw new Error("expected a run config");
    expect(p.workers).toBe(1);
  });

  test("accepts --backend bcdev with an explicit --workers 1", () => {
    const p = parseCliConfig([
      "run",
      "--project",
      "p",
      "--tests",
      "t",
      "--backend",
      "bcdev",
      "--workers",
      "1",
    ]);
    if (p.mode !== "run") throw new Error("expected a run config");
    expect(p.workers).toBe(1);
  });
});

describe("validateAlRunnerConfig", () => {
  test("passes through a complete section", () => {
    const section = { alRunnerPath: "al-runner" };
    expect(validateAlRunnerConfig(section)).toEqual(section);
  });

  test("missing section entirely throws", () => {
    expect(() => validateAlRunnerConfig(undefined)).toThrow('missing the "alRunner" section');
  });

  test("missing alRunnerPath throws", () => {
    expect(() => validateAlRunnerConfig({})).toThrow("alRunnerPath");
  });
});

describe("parseCliConfig — clear-quarantine subcommand (Task 13)", () => {
  test("parses --server/--instance", () => {
    const parsed = parseCliConfig([
      "clear-quarantine",
      "--server",
      "http://Cronus281",
      "--instance",
      "BC",
    ]);
    expect(parsed).toEqual({
      mode: "clear-quarantine",
      server: "http://Cronus281",
      serverInstance: "BC",
    });
  });

  test("missing --server throws a clear error", () => {
    expect(() => parseCliConfig(["clear-quarantine", "--instance", "BC"])).toThrow(
      "missing required --server",
    );
  });

  test("missing --instance throws a clear error", () => {
    expect(() => parseCliConfig(["clear-quarantine", "--server", "http://Cronus281"])).toThrow(
      "missing required --instance",
    );
  });
});

// ————————————————————————————————————————————————————————————————————————
// 5C-B2: `lethal force-reset-lease` — design §8 step 2 of the operator recovery procedure
// (fixtures/README.md's "Recovering from container-needs-recycle"). Mirrors clear-quarantine's
// --server/--instance flag handling, plus a --config it needs (unlike clear-quarantine) to
// authenticate the live HarnessInfo/ForceResetLease OData calls.
// ————————————————————————————————————————————————————————————————————————
describe("parseCliConfig — force-reset-lease subcommand (5C-B2)", () => {
  test("parses --server/--instance/--config", () => {
    const parsed = parseCliConfig([
      "force-reset-lease",
      "--server",
      "http://Cronus281",
      "--instance",
      "BC",
      "--config",
      "lethal.config.json",
    ]);
    expect(parsed).toEqual({
      mode: "force-reset-lease",
      server: "http://Cronus281",
      serverInstance: "BC",
      configPath: "lethal.config.json",
    });
  });

  test("missing --server throws a clear error", () => {
    expect(() =>
      parseCliConfig(["force-reset-lease", "--instance", "BC", "--config", "c.json"]),
    ).toThrow("missing required --server");
  });

  test("missing --instance throws a clear error", () => {
    expect(() =>
      parseCliConfig(["force-reset-lease", "--server", "http://Cronus281", "--config", "c.json"]),
    ).toThrow("missing required --instance");
  });

  test("missing --config throws a clear error naming why it's needed", () => {
    expect(() =>
      parseCliConfig(["force-reset-lease", "--server", "http://Cronus281", "--instance", "BC"]),
    ).toThrow(/missing required --config/);
  });
});

// ————————————————————————————————————————————————————————————————————————
// Task 13 folded fix (Task 11 review, Important-1): `runSession`'s quarantine consult only fires
// when `SessionConfig.resourceServer`/`resourceServerInstance` are BOTH present, but `cli.ts` did
// not source them from the loaded config file — so quarantine was silently INERT for every real
// CLI-driven bcdev session (a stranded tier would never be detected, and a new strand could never
// be durably recorded). `resourceIdentityFor` is the smallest separable seam that maps the loaded
// config file to those two `SessionConfig` fields; these tests pin the fix down directly, without
// exercising `main()`/`runFromCli` end to end (which would need a live/mocked backend).
// ————————————————————————————————————————————————————————————————————————
describe("resourceIdentityFor (Task 13 folded fix — cli.ts sources quarantine identity)", () => {
  const bcdevRunConfig = {
    mode: "run" as const,
    projectDir: "proj",
    testDir: "t",
    backendKind: "bcdev" as const,
    dbPath: "db",
    configPath: "cfg",
    skipKnownSurvivors: false,
    workers: 1,
  };

  test("bcdev session sources resourceServer/resourceServerInstance from the bcdev config section", () => {
    const configFile = {
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
    expect(resourceIdentityFor(bcdevRunConfig, configFile)).toEqual({
      resourceServer: "http://Cronus281",
      resourceServerInstance: "BC",
    });
  });

  test("al-runner session has no shared tier — returns no identity fields", () => {
    const configFile = { alRunner: { alRunnerPath: "al-runner" } };
    expect(
      resourceIdentityFor({ ...bcdevRunConfig, backendKind: "al-runner" }, configFile),
    ).toEqual({});
  });

  test("bcdev session with an incomplete bcdev config section throws (same validation as buildBackend)", () => {
    const configFile = { bcdev: { server: "http://Cronus281" } };
    expect(() => resourceIdentityFor(bcdevRunConfig, configFile)).toThrow(/missing required field/);
  });

  // Layer 5C-B1 Task 8: the exact same "wired in the orchestrator but never sourced by cli.ts"
  // shape as the fix above, one layer up — a bcdev session with no `SessionConfig.lease` takes no
  // machine-global lease at all, and `BcDevMcpBackend.run()` then fails loudly on the first
  // mutant ("no lease bound"). al-runner publishes nothing to a shared container and gets none.
  test("bcdev session is given a lease client + serverGeneration reader; al-runner is not", () => {
    const configFile = {
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
      alRunner: { alRunnerPath: "al-runner" },
    };
    const wired = leaseSessionFor(bcdevRunConfig, configFile);
    expect(wired.lease?.client).toBeInstanceOf(LeaseClient);
    expect(typeof wired.lease?.serverGeneration).toBe("function");
    expect(leaseSessionFor({ ...bcdevRunConfig, backendKind: "al-runner" }, configFile)).toEqual(
      {},
    );
  });
});

// ————————————————————————————————————————————————————————————————————————
// Task 13: `clear-quarantine` (spec §10) — operator-proven clear via `store.clear(key, gen)`.
// ————————————————————————————————————————————————————————————————————————
describe("clearQuarantine (Task 13)", () => {
  async function freshStore(): Promise<QuarantineStore> {
    const dir = await mkdtemp(join(tmpdir(), "lethal-cli-quarantine-"));
    return new QuarantineStore(dir);
  }

  test("clearing a recorded tier removes it and reports cleared, then a second run reports not-quarantined", async () => {
    const store = await freshStore();
    const key = quarantineResourceKey({ server: "http://Cronus281", serverInstance: "BC" });
    await store.record({
      resourceKey: key,
      opKind: "test-run",
      detail: "prior strand",
      recordedAtIso: "2026-07-20T10:00:00.000Z",
    });

    expect(await clearQuarantine(store, key)).toBe("cleared");
    expect(await store.read(key)).toBeNull();

    expect(await clearQuarantine(store, key)).toBe("not-quarantined");
  });

  test("a tier that was never quarantined reports not-quarantined", async () => {
    const store = await freshStore();
    const key = quarantineResourceKey({ server: "http://Cronus281", serverInstance: "BC" });
    expect(await clearQuarantine(store, key)).toBe("not-quarantined");
  });

  // The "stale" outcome (a clear computed against a generation the store no longer holds because
  // a NEWER strand was recorded in between) is exercised at the `QuarantineStore.clear` level in
  // quarantine-store.test.ts ("a stale clear (older generation) does NOT erase a newer record")
  // — `clearQuarantine` above is a thin, race-free pass-through of whatever `store.clear` returns
  // (it always clears against the generation it JUST read), so re-asserting that outcome here
  // would only re-test `QuarantineStore` through an extra layer of indirection, not this seam.
});

// ————————————————————————————————————————————————————————————————————————
// 5C-B2: `performForceResetLease` — the actual read-then-reset mechanics behind
// `lethal force-reset-lease` (design §8 step 2). Kept separate from the CLI I/O wrapper (like
// `clearQuarantine`/`clearQuarantineFromCli` above) specifically so THIS — reading the CURRENT
// serverGeneration live and echoing exactly that value into ForceResetLease — is directly
// unit-testable against an injected fetchFn, without a real config file or process.argv.
// ————————————————————————————————————————————————————————————————————————
describe("performForceResetLease (5C-B2)", () => {
  const CFG: ActivationConfig = {
    baseUrl: "http://bc:7048/BC",
    company: "CRONUS Danmark A/S",
    username: "u",
    password: "p",
    tenant: "default",
  };

  /** Routes to a HarnessInfo response carrying `serverGeneration`, or a ForceResetLease response
   *  carrying `resetBody` — mirrors harness.test.ts's `info()` shape (protocol v2, the two fixed
   *  Codeunit/codeunit arrays) so `HarnessVerifier.verify()` inside `performForceResetLease`
   *  actually succeeds. Captures the `expectedGeneration` the ForceResetLease call was sent, so a
   *  test can assert it against the LIVE generation the HarnessInfo leg returned — the exact
   *  property that makes the generation echo meaningful rather than decorative. */
  function routerFetch(opts: {
    serverGeneration: string;
    resetBody: Record<string, unknown>;
    onForceReset?: (expectedGeneration: string) => void;
  }): typeof fetch {
    return (async (url: unknown, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("LethALControl_HarnessInfo")) {
        return new Response(
          JSON.stringify({
            value: JSON.stringify({
              appId: CONTROL_APP_ID,
              protocolVersion: 2,
              serverGeneration: opts.serverGeneration,
              tenantCountReachable: false,
              isolationModes: ["Codeunit"],
              testTypes: ["codeunit"],
            }),
          }),
          { status: 200 },
        );
      }
      if (u.includes("LethALControl_ForceResetLease")) {
        const body = JSON.parse(String(init?.body)) as { expectedGeneration?: unknown };
        opts.onForceReset?.(
          typeof body.expectedGeneration === "string" ? body.expectedGeneration : "",
        );
        return new Response(JSON.stringify({ value: JSON.stringify(opts.resetBody) }), {
          status: 200,
        });
      }
      throw new Error(`performForceResetLease test: unexpected URL ${u}`);
    }) as typeof fetch;
  }

  // THE load-bearing property: ForceResetLease's whole authorization is an echo of the CURRENT
  // serverGeneration, read live immediately before the reset. This is the assertion the
  // red-check must prove is load-bearing (see the task report) — a version that hardcodes or
  // caches the echo instead of threading the HarnessInfo read through would still return a
  // plausible "reset" outcome here (the fake server doesn't validate the echo), but `echoed`
  // would silently diverge from `liveGen`.
  test("echoes the LIVE serverGeneration read from HarnessInfo into ForceResetLease", async () => {
    const liveGen = "a".repeat(32);
    let echoed: string | undefined;
    const fetchFn = routerFetch({
      serverGeneration: liveGen,
      resetBody: { reset: true, serverGeneration: "b".repeat(32), epoch: 9 },
      onForceReset: (g) => {
        echoed = g;
      },
    });
    const result = await performForceResetLease(CFG, fetchFn);
    expect(echoed).toBe(liveGen);
    expect(result).toEqual({
      outcome: "reset",
      oldGeneration: liveGen,
      newGeneration: "b".repeat(32),
      newEpoch: 9,
    });
  });

  test("a refused reset (stale generation) surfaces as a typed 'refused' outcome, not a throw", async () => {
    const liveGen = "c".repeat(32);
    const fetchFn = routerFetch({
      serverGeneration: liveGen,
      resetBody: { reset: false, reason: "generation-changed" },
    });
    const result = await performForceResetLease(CFG, fetchFn);
    expect(result).toEqual({
      outcome: "refused",
      oldGeneration: liveGen,
      reason: "generation-changed",
    });
  });
});
