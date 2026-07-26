import { describe, expect, it } from "bun:test";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EnvToolClient, EnvToolError } from "../src/env-tool";
import type { EnvToolConfigSection } from "../src/env-tool";
import { startEnvToolSession } from "../src/env-tool-session";
import { HarnessVerificationError, MultiTenantContainerError } from "../src/harness";

const FAR_FUTURE = "2099-01-01T00:00:00Z";

// `exactOptionalPropertyTypes` forbids assigning `undefined` to `Partial<EnvToolConfigSection>`'s
// `envId?: string` (that type means "absent, or a string", never "explicitly undefined"). Several
// tests below need exactly that — `{ envId: undefined }` to force create-mode by overriding the
// harness default — so this widens just that one field to `string | undefined`.
type EnvToolConfigOverride = Partial<Omit<EnvToolConfigSection, "envId">> & {
  envId?: string | undefined;
};

/** Canned tool output, parameterised by expiry so no test mutates shared state. */
function resolveOut(expiresUtc: string = FAR_FUTURE): Record<string, string> {
  return {
    "env get": `{"url":"https://host/env-4711","expiresUtc":"${expiresUtc}"}`,
    "env users": '[{"username":"admin","password":"hunter2"}]',
    "env create": '{"id":"env-new"}',
  };
}

function harness(cfgOver: EnvToolConfigOverride = {}, out: Record<string, string> = resolveOut()) {
  const calls: string[][] = [];
  const published: string[] = [];
  // `envId` is handled separately from the rest of `cfgOver`: under `exactOptionalPropertyTypes`,
  // an object literal spread cannot carry an explicit `envId: undefined` into a target whose
  // `envId?: string` disallows it, so it's applied via a conditional spread instead — `"envId" in
  // cfgOver` with an undefined value means "override to absent" (create-mode); its total absence
  // from `cfgOver` means "keep the default".
  const { envId: envIdOverride, ...restOver } = cfgOver;
  const envId = "envId" in cfgOver ? envIdOverride : "env-4711";
  const cfg: EnvToolConfigSection = {
    toolPath: "tool.exe",
    ...(envId !== undefined ? { envId } : {}),
    publishApps: ["tests.app"],
    resolve: [
      {
        command: ["env", "get", "{envId}", "--json"],
        reads: { baseUrl: "url", expiresUtc: "expiresUtc" },
      },
      {
        command: ["env", "users", "{envId}", "--json"],
        reads: { username: "0.username", password: "0.password" },
      },
    ],
    publish: { command: ["publish", "{envId}", "{appFile}"] },
    createEnv: { command: ["env", "create", "--json"], reads: { envId: "id" } },
    // Create-mode unconditionally requires both (env-tool-session.ts item 1 fix, mirroring
    // validateEnvToolConfig's own unconditional requirement) — every create-mode test needs a
    // working default for these unless it's specifically testing their absence, in which case it
    // destructures them back out of `.cfg` itself. `pollSeconds: 0` + the spawn below returning the
    // ready status on the FIRST poll keeps every other test's runtime near-zero.
    startEnv: { command: ["env", "start", "{envId}"] },
    readyWhen: {
      command: ["env", "status", "{envId}", "--json"],
      reads: { status: "status" },
      equals: "Running",
      pollSeconds: 0,
    },
    deleteEnv: { command: ["env", "delete", "{envId}"] },
    ...restOver,
  };
  const client = new EnvToolClient(cfg, {
    spawn: async (argv) => {
      calls.push([...argv]);
      const line = argv.join(" ");
      if (line.includes("env status")) {
        return { exitCode: 0, stdout: '{"status":"Running"}', stderr: "" };
      }
      const key = Object.keys(out).find((k) => line.includes(k));
      return { exitCode: 0, stdout: key === undefined ? "{}" : (out[key] ?? "{}"), stderr: "" };
    },
  });
  return { calls, published, cfg, client };
}

const BCDEV_RAW = {
  company: "CRONUS",
  tenant: "default",
  mcpCommand: ["bun", "mcp"],
  packageCachePath: "C:/pkg",
  controlSymbolPath: "C:/lethal-control.app",
};

async function start(
  over: Record<string, unknown> = {},
  cfgOver: EnvToolConfigOverride = {},
  out: Record<string, string> = resolveOut(),
) {
  const h = harness(cfgOver, out);
  let harnessCalls = 0;
  const session = await startEnvToolSession({
    cfg: h.cfg,
    bcdevRaw: BCDEV_RAW,
    projectDir: "C:/proj",
    testDir: "C:/tests",
    runId: "r1",
    client: h.client,
    makePublisher: () => ({
      publishFile: async (p: string) => {
        h.published.push(p);
      },
    }),
    verifyHarness: async () => {
      harnessCalls += 1;
      // A real first-deploy failure: HarnessInfo answers with no matching app yet. Typed as
      // `HarnessVerificationError` (not a bare `Error`) because item 3's fix only republishes for
      // this specific type — a bare `Error` here would no longer exercise the republish path.
      if (harnessCalls === 1) throw new HarnessVerificationError("HarnessInfo failed: HTTP 404");
    },
    stateDir: await mkdtemp(join(tmpdir(), "lethal-envstate-")),
    ...over,
  });
  return { ...h, session, harnessCalls: () => harnessCalls };
}

describe("startEnvToolSession", () => {
  it("resolves a config-supplied env into a complete bcdev section", async () => {
    const { session } = await start();
    expect(session.bcdev.baseUrl).toBe("https://host/env-4711");
    expect(session.bcdev.server).toBe("https://host");
    expect(session.bcdev.serverInstance).toBe("env-4711");
    expect(session.bcdev.username).toBe("admin");
    expect(session.bcdev.company).toBe("CRONUS");
    expect(session.createdEnvId).toBeUndefined();
    expect(session.envId).toBe("env-4711");
  });

  // Final review item 2: `session.envId` is the real, resolved envId a publish call must target —
  // it must never be conflated with `bcdev.serverInstance`, which only coincidentally matches it
  // when `serverInstance` is itself derived from `baseUrl`'s first path segment AND that segment
  // happens to be the envId. A portal whose URL is `https://host/tenants/{envId}`
  // (fixtures/README.md's own worked example) derives `serverInstance` to `"tenants"` instead.
  it("resolves envId independently of a serverInstance derived from an unrelated URL path segment", async () => {
    const { session } = await start(
      {},
      {},
      {
        ...resolveOut(),
        "env get": '{"url":"https://host/tenants/env-4711","expiresUtc":"2099-01-01T00:00:00Z"}',
      },
    );
    expect(session.bcdev.serverInstance).toBe("tenants");
    expect(session.envId).toBe("env-4711");
  });

  it("derives port 443 from an https baseUrl carrying no port of its own", async () => {
    // The corrected Probe result (above): bc-dev-mcp's OnPrem mode defaults to port 7049 unless
    // `port` is supplied, and Continia's path-routed HTTPS portal listens on 443, not 7049 — a
    // resolved `baseUrl` with no explicit port must still produce a usable `port`.
    const { session } = await start();
    expect(session.bcdev.port).toBe(443);
  });

  it("derives port 80 from an http baseUrl carrying no port of its own", async () => {
    const { session } = await start(
      {},
      {},
      {
        ...resolveOut(),
        "env get": '{"url":"http://host/env-4711","expiresUtc":"2099-01-01T00:00:00Z"}',
      },
    );
    expect(session.bcdev.port).toBe(80);
  });

  it("takes an explicit port from the baseUrl itself over the protocol default", async () => {
    const { session } = await start(
      {},
      {},
      {
        ...resolveOut(),
        "env get": '{"url":"https://host:8443/env-4711","expiresUtc":"2099-01-01T00:00:00Z"}',
      },
    );
    expect(session.bcdev.port).toBe(8443);
  });

  it("verifies the harness BEFORE publishing the control app, and again after", async () => {
    const { published, harnessCalls } = await start();
    expect(published).toContain("C:/lethal-control.app");
    expect(harnessCalls()).toBe(2); // failed probe, publish, successful probe
  });

  it("does NOT publish the control app when the harness already answers", async () => {
    const { published } = await start({ verifyHarness: async () => {} });
    expect(published).not.toContain("C:/lethal-control.app");
  });

  it("publishes publishApps before the control app", async () => {
    const { published } = await start();
    expect(published[0]).toBe("tests.app");
  });

  it("creates an env when none is configured and records it to state before use", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "lethal-envstate-"));
    const { session } = await start({ stateDir }, { envId: undefined });
    expect(session.createdEnvId).toBe("env-new");
    expect(session.envId).toBe("env-new");
    const files = await readdir(stateDir);
    expect(files).toHaveLength(1);
    const rec = JSON.parse(await readFile(join(stateDir, files[0] ?? ""), "utf8")) as {
      envId: string;
      deleteArgv: string[];
    };
    expect(rec.envId).toBe("env-new");
    expect(rec.deleteArgv).toEqual(["tool.exe", "env", "delete", "env-new"]);
  });

  it("starts a created env and waits until readyWhen matches before publishing anything", async () => {
    // Measured 2026-07-26: create yields Draft, start is async, ~390s to Running. Assert the
    // ORDER with call counters, never timing: start must precede every publish, and no publish
    // may happen while the status is still Starting.
    const seen: string[] = [];
    const statuses = ["Draft", "Starting", "Starting", "Running"];
    let poll = 0;
    const cfg = harness({ envId: undefined }).cfg;
    const client = new EnvToolClient(
      {
        ...cfg,
        startEnv: { command: ["env", "start", "{envId}"] },
        readyWhen: {
          command: ["env", "get", "{envId}", "--status-json"],
          reads: { status: "status" },
          equals: "Running",
          pollSeconds: 0,
        },
      },
      {
        spawn: async (argv) => {
          const line = argv.join(" ");
          if (line.includes("--status-json")) {
            const s = statuses[Math.min(poll, statuses.length - 1)];
            poll += 1;
            seen.push(`poll:${s ?? ""}`);
            return { exitCode: 0, stdout: JSON.stringify({ status: s }), stderr: "" };
          }
          if (line.includes("env start")) seen.push("start");
          if (line.includes("env create")) seen.push("create");
          const out = resolveOut();
          const key = Object.keys(out).find((k) => line.includes(k));
          return {
            exitCode: 0,
            stdout: key === undefined ? "{}" : (out[key] ?? "{}"),
            stderr: "",
          };
        },
      },
    );
    const session = await startEnvToolSession({
      cfg: {
        ...cfg,
        startEnv: { command: ["env", "start", "{envId}"] },
        readyWhen: {
          command: ["env", "get", "{envId}", "--status-json"],
          reads: { status: "status" },
          equals: "Running",
          pollSeconds: 0,
        },
      },
      bcdevRaw: BCDEV_RAW,
      projectDir: "C:/proj",
      testDir: "C:/tests",
      runId: "r3",
      client,
      makePublisher: () => ({
        publishFile: async (p: string) => {
          seen.push(`publish:${p}`);
        },
      }),
      verifyHarness: async () => {},
      sleep: async () => {},
      stateDir: await mkdtemp(join(tmpdir(), "lethal-envstate-")),
    });
    expect(session.createdEnvId).toBe("env-new");
    expect(seen[0]).toBe("create");
    expect(seen[1]).toBe("start");
    expect(seen.filter((s) => s.startsWith("poll:")).at(-1)).toBe("poll:Running");
    const firstPublish = seen.findIndex((s) => s.startsWith("publish:"));
    const lastPoll = seen.map((s) => s.startsWith("poll:")).lastIndexOf(true);
    expect(firstPublish).toBeGreaterThan(lastPoll);
  });

  it("throws when the env never reaches the ready status inside its budget", async () => {
    const cfg = harness({ envId: undefined }).cfg;
    const readyWhen = {
      command: ["env", "get", "{envId}", "--status-json"],
      reads: { status: "status" },
      equals: "Running",
      pollSeconds: 0,
      timeoutSeconds: 1,
    };
    let clock = 0;
    const client = new EnvToolClient(
      { ...cfg, startEnv: { command: ["env", "start", "{envId}"] }, readyWhen },
      {
        spawn: async (argv) => {
          const line = argv.join(" ");
          if (line.includes("--status-json")) {
            clock += 1000; // one simulated second per poll
            return { exitCode: 0, stdout: '{"status":"Starting"}', stderr: "" };
          }
          const out = resolveOut();
          const key = Object.keys(out).find((k) => line.includes(k));
          return {
            exitCode: 0,
            stdout: key === undefined ? "{}" : (out[key] ?? "{}"),
            stderr: "",
          };
        },
      },
    );
    await expect(
      startEnvToolSession({
        cfg: { ...cfg, startEnv: { command: ["env", "start", "{envId}"] }, readyWhen },
        bcdevRaw: BCDEV_RAW,
        projectDir: "C:/proj",
        testDir: "C:/tests",
        runId: "r4",
        client,
        makePublisher: () => ({ publishFile: async () => {} }),
        verifyHarness: async () => {},
        now: () => clock,
        sleep: async () => {},
        stateDir: await mkdtemp(join(tmpdir(), "lethal-envstate-")),
      }),
    ).rejects.toThrow(/did not reach status "Running"/);
  });

  // Final review item 1: a provisioned environment used to leak whenever ANYTHING after
  // `createEnv` succeeded threw — a `readyWhen` timeout, a symbols failure, a `publishApps` typo,
  // a control-app publish rejection — because the object carrying `teardown` was only constructed
  // at the very end, so a throw anywhere in between escaped with no teardown ever attempted. A
  // `downloadSymbols` failure is the most likely first-run failure mode (a wrong/expired token, a
  // typo'd command) and exercises exactly that window.
  it("a downloadSymbols failure in create-mode attempts the delete and still propagates the original error (item 1)", async () => {
    const h = harness({ envId: undefined });
    const cfg = {
      ...h.cfg,
      downloadSymbols: { command: ["deps", "download", "{envId}", "{projectDir}"] },
    };
    const deleteCalls: string[][] = [];
    const failing = new EnvToolClient(cfg, {
      spawn: async (argv) => {
        const line = argv.join(" ");
        if (argv.includes("delete")) {
          deleteCalls.push([...argv]);
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (line.includes("deps download")) {
          return { exitCode: 1, stdout: "", stderr: "symbols download failed: HTTP 403" };
        }
        if (line.includes("env status")) {
          return { exitCode: 0, stdout: '{"status":"Running"}', stderr: "" };
        }
        const out = resolveOut();
        const key = Object.keys(out).find((k) => line.includes(k));
        return { exitCode: 0, stdout: key === undefined ? "{}" : (out[key] ?? "{}"), stderr: "" };
      },
    });
    const stateDir = await mkdtemp(join(tmpdir(), "lethal-envstate-"));
    await expect(
      startEnvToolSession({
        cfg,
        bcdevRaw: BCDEV_RAW,
        projectDir: "C:/proj",
        testDir: "C:/tests",
        runId: "r-leak",
        client: failing,
        makePublisher: () => ({ publishFile: async () => {} }),
        verifyHarness: async () => {},
        stateDir,
      }),
    ).rejects.toThrow(/symbols download failed/);
    // The leak-prevention path: the environment THIS call created is attempted for delete BEFORE
    // the original error propagates — never left billing with no teardown ever attempted.
    expect(deleteCalls).toHaveLength(1);
    expect(deleteCalls[0]).toEqual(["tool.exe", "env", "delete", "env-new"]);
  });

  it("when the delete attempt ALSO fails after a startup failure, the ORIGINAL error still wins (item 1)", async () => {
    const h = harness({ envId: undefined });
    const cfg = {
      ...h.cfg,
      downloadSymbols: { command: ["deps", "download", "{envId}", "{projectDir}"] },
    };
    const failing = new EnvToolClient(cfg, {
      spawn: async (argv) => {
        const line = argv.join(" ");
        if (argv.includes("delete")) {
          return { exitCode: 1, stdout: "", stderr: "delete also failed" };
        }
        if (line.includes("deps download")) {
          return { exitCode: 1, stdout: "", stderr: "symbols download failed: HTTP 403" };
        }
        if (line.includes("env status")) {
          return { exitCode: 0, stdout: '{"status":"Running"}', stderr: "" };
        }
        const out = resolveOut();
        const key = Object.keys(out).find((k) => line.includes(k));
        return { exitCode: 0, stdout: key === undefined ? "{}" : (out[key] ?? "{}"), stderr: "" };
      },
    });
    await expect(
      startEnvToolSession({
        cfg,
        bcdevRaw: BCDEV_RAW,
        projectDir: "C:/proj",
        testDir: "C:/tests",
        runId: "r-leak-2",
        client: failing,
        makePublisher: () => ({ publishFile: async () => {} }),
        verifyHarness: async () => {},
        stateDir: await mkdtemp(join(tmpdir(), "lethal-envstate-")),
      }),
      // Never "delete also failed" — a failing delete attempt must never mask the real error.
    ).rejects.toThrow(/symbols download failed/);
  });

  it("refuses to start when the env expires within the hour", async () => {
    const soon = new Date(Date.now() + 10 * 60_000).toISOString();
    await expect(start({}, {}, resolveOut(soon))).rejects.toThrow(/expires/);
  });

  it("proceeds on an imminent expiry when explicitly allowed", async () => {
    const soon = new Date(Date.now() + 10 * 60_000).toISOString();
    const { session } = await start({ allowExpiring: true }, {}, resolveOut(soon));
    expect(session.bcdev.baseUrl).toBe("https://host/env-4711");
  });

  it("never deletes a config-supplied env", async () => {
    const { session, calls } = await start();
    await session.teardown({ keepEnv: false, quarantined: false });
    expect(calls.some((c) => c.includes("delete"))).toBe(false);
  });

  it("deletes a created env, unless --keep-env or a quarantine", async () => {
    const a = await start({}, { envId: undefined });
    await a.session.teardown({ keepEnv: true, quarantined: false });
    expect(a.calls.some((c) => c.includes("delete"))).toBe(false);

    const b = await start({}, { envId: undefined });
    await b.session.teardown({ keepEnv: false, quarantined: true });
    expect(b.calls.some((c) => c.includes("delete"))).toBe(false);

    const c = await start({}, { envId: undefined });
    await c.session.teardown({ keepEnv: false, quarantined: false });
    expect(c.calls.some((cc) => cc.includes("delete"))).toBe(true);
  });

  it("unlinks the crash-recovery record after a successful delete, but keeps it when the env survives (item 4)", async () => {
    const keptDir = await mkdtemp(join(tmpdir(), "lethal-envstate-"));
    const kept = await start({ stateDir: keptDir }, { envId: undefined });
    expect(await readdir(keptDir)).toHaveLength(1);
    await kept.session.teardown({ keepEnv: true, quarantined: false });
    expect(await readdir(keptDir)).toHaveLength(1); // still there — this IS the recovery hint

    const quarantinedDir = await mkdtemp(join(tmpdir(), "lethal-envstate-"));
    const quarantined = await start({ stateDir: quarantinedDir }, { envId: undefined });
    expect(await readdir(quarantinedDir)).toHaveLength(1);
    await quarantined.session.teardown({ keepEnv: false, quarantined: true });
    expect(await readdir(quarantinedDir)).toHaveLength(1);

    const deletedDir = await mkdtemp(join(tmpdir(), "lethal-envstate-"));
    const deleted = await start({ stateDir: deletedDir }, { envId: undefined });
    expect(await readdir(deletedDir)).toHaveLength(1);
    await deleted.session.teardown({ keepEnv: false, quarantined: false });
    expect(await readdir(deletedDir)).toHaveLength(0); // gone — the env itself is gone too
  });

  it("a failing deleteEnv does not throw out of teardown, and keeps the crash-recovery record", async () => {
    const h = harness({ envId: undefined });
    const failing = new EnvToolClient(h.cfg, {
      spawn: async (argv) => {
        h.calls.push([...argv]);
        const line = argv.join(" ");
        if (argv.includes("delete")) return { exitCode: 1, stdout: "", stderr: "gone" };
        if (line.includes("env status")) {
          return { exitCode: 0, stdout: '{"status":"Running"}', stderr: "" };
        }
        const out = resolveOut();
        const key = Object.keys(out).find((k) => line.includes(k));
        return { exitCode: 0, stdout: key === undefined ? "{}" : (out[key] ?? "{}"), stderr: "" };
      },
    });
    const stateDir = await mkdtemp(join(tmpdir(), "lethal-envstate-"));
    const session = await startEnvToolSession({
      cfg: h.cfg,
      bcdevRaw: BCDEV_RAW,
      projectDir: "C:/proj",
      testDir: "C:/tests",
      runId: "r2",
      client: failing,
      makePublisher: () => ({ publishFile: async () => {} }),
      verifyHarness: async () => {},
      stateDir,
    });
    expect(await readdir(stateDir)).toHaveLength(1);
    await session.teardown({ keepEnv: false, quarantined: false }); // must not reject
    // A failed delete means the environment may still exist — the crash-recovery record must
    // survive so an operator can find it later (item 4).
    expect(await readdir(stateDir)).toHaveLength(1);
  });

  it("bcdevRaw missing fields (item 2)", async () => {
    const { mcpCommand: _mcpCommand, ...withoutMcpCommand } = BCDEV_RAW;
    await expect(start({ bcdevRaw: withoutMcpCommand })).rejects.toThrow(/mcpCommand/);

    const { company: _company, ...withoutCompany } = BCDEV_RAW;
    await expect(start({ bcdevRaw: withoutCompany })).rejects.toThrow(/company/);

    const { controlSymbolPath: _controlSymbolPath, ...withoutControlSymbolPath } = BCDEV_RAW;
    await expect(start({ bcdevRaw: withoutControlSymbolPath })).rejects.toThrow(
      /controlSymbolPath/,
    );

    // All three missing at once: every field is named, not just the first found.
    await expect(start({ bcdevRaw: { packageCachePath: "C:/pkg" } })).rejects.toThrow(
      /mcpCommand.*company.*controlSymbolPath/,
    );
  });

  it("does NOT republish the control app for a multi-tenant refusal, and rethrows it unwrapped (item 3)", async () => {
    const h = harness();
    const published: string[] = [];
    await expect(
      startEnvToolSession({
        cfg: h.cfg,
        bcdevRaw: BCDEV_RAW,
        projectDir: "C:/proj",
        testDir: "C:/tests",
        runId: "r-multitenant",
        client: h.client,
        makePublisher: () => ({
          publishFile: async (p: string) => {
            published.push(p);
          },
        }),
        verifyHarness: async () => {
          throw new MultiTenantContainerError(
            "5C-B1 refuses a multi-tenant/shared-publication container",
          );
        },
        stateDir: await mkdtemp(join(tmpdir(), "lethal-envstate-")),
      }),
    ).rejects.toThrow(MultiTenantContainerError);
    // The differentiator: a MultiTenantContainerError must never trigger the "republish the
    // control app" fallback — republishing runs install/upgrade codeunits that can disturb a
    // concurrent session's lease, and this refusal isn't something a republish can fix anyway.
    expect(published).not.toContain(BCDEV_RAW.controlSymbolPath);
  });

  it("requires startEnv and readyWhen once an environment is created, naming whichever is missing (items 1 + 5)", async () => {
    const h = harness({ envId: undefined });

    const { startEnv: _startEnv, readyWhen: _readyWhen, ...cfgWithoutEither } = h.cfg;
    await expect(
      startEnvToolSession({
        cfg: cfgWithoutEither,
        bcdevRaw: BCDEV_RAW,
        projectDir: "C:/proj",
        testDir: "C:/tests",
        runId: "r-missing-both",
        client: h.client,
        makePublisher: () => ({ publishFile: async () => {} }),
        verifyHarness: async () => {},
        stateDir: await mkdtemp(join(tmpdir(), "lethal-envstate-")),
      }),
    ).rejects.toThrow(EnvToolError);

    const { readyWhen: _readyWhen2, ...cfgWithoutReadyWhen } = h.cfg;
    await expect(
      startEnvToolSession({
        cfg: cfgWithoutReadyWhen,
        bcdevRaw: BCDEV_RAW,
        projectDir: "C:/proj",
        testDir: "C:/tests",
        runId: "r-missing-ready",
        client: h.client,
        makePublisher: () => ({ publishFile: async () => {} }),
        verifyHarness: async () => {},
        stateDir: await mkdtemp(join(tmpdir(), "lethal-envstate-")),
      }),
    ).rejects.toThrow(/readyWhen/);

    const { startEnv: _startEnv2, ...cfgWithoutStartEnv } = h.cfg;
    await expect(
      startEnvToolSession({
        cfg: cfgWithoutStartEnv,
        bcdevRaw: BCDEV_RAW,
        projectDir: "C:/proj",
        testDir: "C:/tests",
        runId: "r-missing-start",
        client: h.client,
        makePublisher: () => ({ publishFile: async () => {} }),
        verifyHarness: async () => {},
        stateDir: await mkdtemp(join(tmpdir(), "lethal-envstate-")),
      }),
    ).rejects.toThrow(/startEnv/);
  });

  it("throws when the resolved baseUrl has no path segment to use as serverInstance (item 5)", async () => {
    await expect(
      start(
        {},
        {},
        {
          ...resolveOut(),
          "env get": '{"url":"https://host","expiresUtc":"2099-01-01T00:00:00Z"}',
        },
      ),
    ).rejects.toThrow(/no path segment/);
  });
});
