import { describe, expect, it } from "bun:test";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EnvToolClient } from "../src/env-tool";
import type { EnvToolConfigSection } from "../src/env-tool";
import { startEnvToolSession } from "../src/env-tool-session";

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
    deleteEnv: { command: ["env", "delete", "{envId}"] },
    ...restOver,
  };
  const client = new EnvToolClient(cfg, {
    spawn: async (argv) => {
      calls.push([...argv]);
      const key = Object.keys(out).find((k) => argv.join(" ").includes(k));
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
      if (harnessCalls === 1) throw new Error("no harness yet");
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

  it("a failing deleteEnv does not throw out of teardown", async () => {
    const h = harness({ envId: undefined });
    const failing = new EnvToolClient(h.cfg, {
      spawn: async (argv) => {
        h.calls.push([...argv]);
        if (argv.includes("delete")) return { exitCode: 1, stdout: "", stderr: "gone" };
        const out = resolveOut();
        const key = Object.keys(out).find((k) => argv.join(" ").includes(k));
        return { exitCode: 0, stdout: key === undefined ? "{}" : (out[key] ?? "{}"), stderr: "" };
      },
    });
    const session = await startEnvToolSession({
      cfg: h.cfg,
      bcdevRaw: BCDEV_RAW,
      projectDir: "C:/proj",
      testDir: "C:/tests",
      runId: "r2",
      client: failing,
      makePublisher: () => ({ publishFile: async () => {} }),
      verifyHarness: async () => {},
      stateDir: await mkdtemp(join(tmpdir(), "lethal-envstate-")),
    });
    await session.teardown({ keepEnv: false, quarantined: false }); // must not reject
  });
});
