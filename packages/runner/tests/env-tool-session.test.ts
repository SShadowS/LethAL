import { describe, expect, it, spyOn } from "bun:test";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EnvToolClient, EnvToolError } from "../src/env-tool";
import type { EnvToolConfigSection } from "../src/env-tool";
import { startEnvToolSession } from "../src/env-tool-session";
import {
  HarnessAuthError,
  HarnessVerificationError,
  MultiTenantContainerError,
} from "../src/harness";

const FAR_FUTURE = "2099-01-01T00:00:00Z";

// `exactOptionalPropertyTypes` forbids assigning `undefined` to `Partial<EnvToolConfigSection>`'s
// `envId?: string` (that type means "absent, or a string", never "explicitly undefined"). Several
// tests below need exactly that — `{ envId: undefined }` to force create-mode by overriding the
// harness default — so this widens just that one field to `string | undefined`.
type EnvToolConfigOverride = Partial<Omit<EnvToolConfigSection, "envId" | "publishApps">> & {
  envId?: string | undefined;
  // Explicit `| undefined` so a test can say "this config has NO publishApps" — the same
  // override-to-absent affordance `envId` already needed, which R19 made necessary here too.
  publishApps?: readonly string[] | undefined;
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
  // `publishApps` gets the same treatment as `envId` and for the same reason (R19 added the
  // override-to-absent case: a config with no test apps at all must still yield a callable
  // `publishTestApps`).
  const { envId: envIdOverride, publishApps: publishAppsOverride, ...restOver } = cfgOver;
  const envId = "envId" in cfgOver ? envIdOverride : "env-4711";
  const publishApps = "publishApps" in cfgOver ? publishAppsOverride : ["tests.app"];
  const cfg: EnvToolConfigSection = {
    toolPath: "tool.exe",
    ...(envId !== undefined ? { envId } : {}),
    ...(publishApps !== undefined ? { publishApps } : {}),
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

  it("does NOT republish the control app on an AUTH failure (R20)", async () => {
    // The catch here treats a HarnessVerificationError as "the control app is missing" and
    // republishes. Republishing runs LethAL Control's install/upgrade codeunits, and the
    // machine-global lease lives in that app's own tables — so answering a transient 401 with a
    // republish disturbs a concurrent session's lease to fix something a republish cannot fix.
    // The surrounding comment already named auth as a case it intended to exclude; before R20 the
    // code could not, because auth failures WERE HarnessVerificationErrors.
    await expect(
      start({
        verifyHarness: async () => {
          throw new HarnessAuthError("HTTP 401: nope");
        },
      }),
    ).rejects.toBeInstanceOf(HarnessAuthError);
  });

  // R19: provisioning no longer publishes the TEST apps at all. They are deferred to
  // `publishTestApps`, which the caller runs while HOLDING THE LEASE — pre-lease, a concurrent
  // session can republish one mid-run and the attestation fence cannot see it (it covers the
  // TARGET artifact, not the test app).
  it("does NOT publish publishApps during provisioning", async () => {
    const { published } = await start();
    expect(published).not.toContain("tests.app");
  });

  it("publishes them when publishTestApps is called, in configured order", async () => {
    const { session, published } = await start();
    expect(published).not.toContain("tests.app");
    await session.publishTestApps();
    expect(published).toContain("tests.app");
  });

  // Absent config must still give the caller a callable — otherwise every caller has to branch on
  // config shape to decide whether the lease window contains a publish.
  it("publishTestApps is a no-op, not a throw, when no publishApps are configured", async () => {
    const { session, published } = await start({}, { publishApps: undefined });
    const before = published.length;
    await session.publishTestApps();
    expect(published.length).toBe(before);
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
    // R19: the test-app publish is deferred, so provisioning itself publishes nothing here (the
    // control app is only republished when the harness check FAILS, and it passes in this test).
    // The property under test survives the move: readiness still gates the publish, it is just
    // now gated at the point the caller runs it.
    expect(seen.some((s) => s.startsWith("publish:"))).toBe(false);
    await session.publishTestApps();
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

  // R17: `recordCreatedEnv`/`removeRecordedEnv` had a writer and no reader — the whole
  // crash-recovery story for a leaked environment was a file nothing ever listed. A session start
  // must now scan `stateDir` and warn on whatever it finds, naming the envId and the exact delete
  // command already recorded — never deleting anything itself.
  it("warns on a stale crash-recovery record left by an earlier run, naming its envId and delete command (R17)", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "lethal-envstate-"));
    await writeFile(
      join(stateDir, "some-other-run.json"),
      JSON.stringify({
        runId: "some-other-run",
        envId: "env-orphan",
        deleteArgv: ["tool.exe", "env", "delete", "env-orphan"],
        startedAtMs: Date.now(),
      }),
      "utf8",
    );
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    let warnings: string[];
    try {
      await start({ stateDir });
      // Captured BEFORE mockRestore(), which clears .mock.calls (mirrors harness.test.ts's
      // verifyQuiet — reading .mock.calls after restore sees an empty array).
      warnings = warnSpy.mock.calls.map((c) => String(c[0]));
    } finally {
      warnSpy.mockRestore();
    }
    expect(
      warnings.some(
        (w) => w.includes("env-orphan") && w.includes("tool.exe env delete env-orphan"),
      ),
    ).toBe(true);
  });

  it("does not warn about a record matching the CURRENT run's own id, or when stateDir has none at all (R17)", async () => {
    const emptyDir = await mkdtemp(join(tmpdir(), "lethal-envstate-"));
    const warnSpy1 = spyOn(console, "warn").mockImplementation(() => {});
    let warnings1: string[];
    try {
      await start({ stateDir: emptyDir });
      warnings1 = warnSpy1.mock.calls.map((c) => String(c[0]));
    } finally {
      warnSpy1.mockRestore();
    }
    expect(warnings1.some((w) => w.includes("stale env-tool crash-recovery"))).toBe(false);

    // `start()` always uses runId "r1" — pre-seed a record under that SAME id (as if this run
    // were retrying after already recording itself) and prove it is never reported back as stale.
    const ownDir = await mkdtemp(join(tmpdir(), "lethal-envstate-"));
    await writeFile(
      join(ownDir, "r1.json"),
      JSON.stringify({ runId: "r1", envId: "env-4711", deleteArgv: [], startedAtMs: Date.now() }),
      "utf8",
    );
    const warnSpy2 = spyOn(console, "warn").mockImplementation(() => {});
    let warnings2: string[];
    try {
      await start({ stateDir: ownDir });
      warnings2 = warnSpy2.mock.calls.map((c) => String(c[0]));
    } finally {
      warnSpy2.mockRestore();
    }
    expect(warnings2.some((w) => w.includes("stale env-tool crash-recovery"))).toBe(false);
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

    // R22e: `.rejects.toThrow(/readyWhen/)` / `.toThrow(/startEnv/)` each independently survived
    // a revert to a SINGLE combined message naming both blocks regardless of which was actually
    // missing — the earlier "requires the whole create-mode block set" combined message contains
    // both substrings too. Capture the real error and assert it names the missing block AND does
    // NOT name the other one, which a merged message would fail.
    const { readyWhen: _readyWhen2, ...cfgWithoutReadyWhen } = h.cfg;
    const readyWhenErr = await startEnvToolSession({
      cfg: cfgWithoutReadyWhen,
      bcdevRaw: BCDEV_RAW,
      projectDir: "C:/proj",
      testDir: "C:/tests",
      runId: "r-missing-ready",
      client: h.client,
      makePublisher: () => ({ publishFile: async () => {} }),
      verifyHarness: async () => {},
      stateDir: await mkdtemp(join(tmpdir(), "lethal-envstate-")),
    }).catch((e: unknown) => (e instanceof Error ? e.message : String(e)));
    expect(readyWhenErr).toMatch(/envTool\.readyWhen is required/);
    expect(readyWhenErr).not.toContain("envTool.startEnv");

    const { startEnv: _startEnv2, ...cfgWithoutStartEnv } = h.cfg;
    const startEnvErr = await startEnvToolSession({
      cfg: cfgWithoutStartEnv,
      bcdevRaw: BCDEV_RAW,
      projectDir: "C:/proj",
      testDir: "C:/tests",
      runId: "r-missing-start",
      client: h.client,
      makePublisher: () => ({ publishFile: async () => {} }),
      verifyHarness: async () => {},
      stateDir: await mkdtemp(join(tmpdir(), "lethal-envstate-")),
    }).catch((e: unknown) => (e instanceof Error ? e.message : String(e)));
    expect(startEnvErr).toMatch(/envTool\.startEnv is required/);
    expect(startEnvErr).not.toContain("envTool.readyWhen");
  });

  // ————————————————————————————————————————————————————————————————————————
  // R34: a REUSED environment that has idled to a not-ready status resolved fine, handed back a
  // dead endpoint, and aborted minutes later inside the transport. Observed live 2026-07-26 on the
  // gate environment (`Stopped`, needing a manual start plus a ~420s wait). LethAL refuses instead
  // of starting it: the environment belongs to whoever configured it.
  // ————————————————————————————————————————————————————————————————————————
  describe("a reused environment that is not ready (R34)", () => {
    const statusResolve = [
      {
        command: ["env", "get", "{envId}", "--json"],
        reads: { baseUrl: "url", expiresUtc: "expiresUtc", status: "status" },
      },
      {
        command: ["env", "users", "{envId}", "--json"],
        reads: { username: "0.username", password: "0.password" },
      },
    ];
    const outWithStatus = (status: string): Record<string, string> => ({
      ...resolveOut(),
      "env get": `{"url":"https://host/env-4711","expiresUtc":"${FAR_FUTURE}","status":"${status}"}`,
    });

    /**
     * Runs a session against the given config/output and settles it HERE, returning the outcome
     * either way. The session promise is never handed back unsettled: a rejection that crosses an
     * `await` boundary before the test attaches its handler surfaces as an unhandled rejection.
     */
    async function run(cfgOver: EnvToolConfigOverride, out: Record<string, string>) {
      const h = harness(cfgOver, out);
      const outcome = await startEnvToolSession({
        cfg: h.cfg,
        bcdevRaw: BCDEV_RAW,
        projectDir: "C:/proj",
        testDir: "C:/tests",
        runId: "r-status",
        client: h.client,
        makePublisher: () => ({
          publishFile: async (p: string) => {
            h.published.push(p);
          },
        }),
        verifyHarness: async () => {},
        sleep: async () => {},
        stateDir: await mkdtemp(join(tmpdir(), "lethal-envstate-")),
      }).then(
        (session) => ({ session, error: undefined as unknown }),
        (error: unknown) => ({ session: undefined, error }),
      );
      return { ...h, ...outcome };
    }

    it("refuses a stopped environment, naming the status, before publishing anything", async () => {
      const { error, published } = await run(
        { resolve: statusResolve, requireStatus: { equals: "Running" } },
        outWithStatus("Stopped"),
      );
      expect(error).toBeInstanceOf(EnvToolError);
      const message = error instanceof Error ? error.message : String(error);
      // The status the TOOL reported must appear: R34's whole complaint was an obscure transport
      // error that never said what was actually wrong.
      expect(message).toContain('"Stopped"');
      expect(message).toContain('"Running"');
      expect(message).toMatch(/start it with your own environment tool/);
      // And the refusal must land BEFORE any publish — the point is not to pay for a deploy into
      // a dead endpoint.
      expect(published).toEqual([]);
    });

    it("proceeds when the reused environment reports the configured ready status", async () => {
      const { session, error } = await run(
        { resolve: statusResolve, requireStatus: { equals: "Running" } },
        outWithStatus("Running"),
      );
      expect(error).toBeUndefined();
      expect(session?.bcdev.baseUrl).toBe("https://host/env-4711");
    });

    it("uses the CONFIGURED ready value, not a hardcoded vendor string", async () => {
      // Vendor-agnostic: a tool whose ready status is spelled "Active" must be accepted on
      // "Active" and refused on "Running" — the exact inverse of Continia's vocabulary. A
      // hardcoded "Running" anywhere in LethAL fails both halves of this.
      const ok = await run(
        { resolve: statusResolve, requireStatus: { equals: "Active" } },
        outWithStatus("Active"),
      );
      expect(ok.error).toBeUndefined();
      expect(ok.session?.bcdev.baseUrl).toBe("https://host/env-4711");

      const refused = await run(
        { resolve: statusResolve, requireStatus: { equals: "Active" } },
        outWithStatus("Running"),
      );
      expect(
        refused.error instanceof Error ? refused.error.message : String(refused.error),
      ).toMatch(/reports status "Running", not "Active"/);
    });

    it("does not check a status when no expectation is declared (pre-R34 configs unaffected)", async () => {
      // The tool reports `Stopped` and a resolve block even reads it — but nothing declared that
      // it MATTERS, so behaviour is exactly as before R34: resolve, then carry on.
      const { session, error } = await run({ resolve: statusResolve }, outWithStatus("Stopped"));
      expect(error).toBeUndefined();
      expect(session?.bcdev.baseUrl).toBe("https://host/env-4711");
    });

    it("does not apply to an environment this run created", async () => {
      // Create-mode already ran startEnv and polled readyWhen to ready; the reuse guard must not
      // fire a second time against whatever `resolve` happens to report.
      const { session, error } = await run(
        { envId: undefined, resolve: statusResolve, requireStatus: { equals: "Running" } },
        outWithStatus("Stopped"),
      );
      expect(error).toBeUndefined();
      expect(session?.createdEnvId).toBe("env-new");
    });
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
