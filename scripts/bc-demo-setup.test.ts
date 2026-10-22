import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { buildFakeAppWithEntries } from "../packages/runner/tests/helpers/fake-app.ts";
import {
  type AppItem,
  DEMO_PORTS,
  DEMO_SERVER,
  type ExtensionRow,
  SERVERS,
  type ServerOps,
  portsOf,
} from "./bc-app-content.ts";
import {
  DEMO_CONFIG,
  type DemoDeps,
  DemoInPoolError,
  checkNotPooled,
  ownerSteps,
  run,
} from "./bc-demo-setup.ts";
import { GATE_FIXTURES, gitIgnores, parseArgs } from "./bc-linux-setup.ts";

const REPO = join(import.meta.dir, "..");
const PASSWORD = "s3cret-not-printed!";

const pkg = (name: string, version: string, id: string) =>
  buildFakeAppWithEntries({
    "NavxManifest.xml": `<Package><App Id="${id}" Name="${name}" Publisher="LethAL" Version="${version}" /><Build Timestamp="t" /></Package>`,
  });

/** A server that holds what was published to it, and nothing else. */
function fakeServer(): { ops: ServerOps; published: string[] } {
  const held = new Map<string, Buffer>();
  const published: string[] = [];
  const idOf = (b: Buffer) => /App Id="([^"]+)"/.exec(b.toString("latin1"))?.[1] ?? "";
  const verOf = (b: Buffer) => /Version="([^"]+)"/.exec(b.toString("latin1"))?.[1] ?? "";
  const nameOf = (b: Buffer) => /Name="([^"]+)"/.exec(b.toString("latin1"))?.[1] ?? "";
  return {
    published,
    ops: {
      resident: async (_publisher, name) =>
        [...held.values()].find((b) => nameOf(b) === name) ?? null,
      rows: async (appId): Promise<ExtensionRow[]> => {
        const b = held.get(appId);
        if (b === undefined) return [];
        const [ma, mi, bu, re] = verOf(b).split(".").map(Number);
        return [
          {
            packageId: "p",
            displayName: nameOf(b),
            isInstalled: true,
            versionMajor: ma ?? 0,
            versionMinor: mi ?? 0,
            versionBuild: bu ?? 0,
            versionRevision: re ?? 0,
          },
        ];
      },
      publish: async (fileName, bytes) => {
        published.push(fileName);
        held.set(idOf(bytes), bytes);
      },
    },
  };
}

function fakeDeps(over: Partial<DemoDeps> = {}) {
  const calls: string[] = [];
  const written = new Map<string, object>();
  const server = fakeServer();
  const items: AppItem[] = [
    {
      dir: "gift-card",
      local: pkg("Gift Card Demo", "1.0.0.1", "gc"),
      role: "target",
      gateDeploys: true,
    },
    {
      dir: "gift-card-tests",
      local: pkg("Gift Card Demo Tests", "1.0.0.1", "gct"),
      role: "dependent",
      gateDeploys: false,
      targetDir: "gift-card",
    },
  ];
  const deps: DemoDeps = {
    allocation: () => {
      calls.push("allocation");
      return JSON.stringify({ lethal: ["Cronus28", "bc1", "bc2", "bc3"] });
    },
    reachable: async () => {
      calls.push("reachable");
      return true;
    },
    readSecret: () => {
      calls.push("readSecret");
      return { user: "BCRUNNER", password: PASSWORD };
    },
    isIgnored: () => true,
    writeConfig: (path, config) => {
      calls.push("writeConfig");
      written.set(path, config);
    },
    fillSymbols: async () => {
      calls.push("fillSymbols");
      return "/cache/bc-demo/28.4-abcd1234";
    },
    controlBytes: () => pkg("LethAL Control", "1.0.0.23", "ctl"),
    compile: async () => {
      calls.push("compile");
      return items;
    },
    serverOps: () => {
      calls.push("serverOps");
      return server.ops;
    },
    doctor: async (config) => {
      calls.push(`doctor ${config}`);
      return true;
    },
    mcpCommand: () => ["node", "/x/bc-dev-mcp.js"],
    ...over,
  };
  return { deps, calls, written, server };
}

describe("R663: bc-demo is outside every lease pool and every gate", () => {
  test("SERVERS (the lease and gate server list) does not hold bc-demo", () => {
    expect(Object.keys(SERVERS)).toEqual(["bc1", "bc2", "bc3"]);
    expect(Object.keys(SERVERS)).not.toContain(DEMO_SERVER);
  });

  test("bc-linux-setup (the lease path) refuses --server bc-demo, and `all` never reaches it", () => {
    expect(() => parseArgs(["--server", DEMO_SERVER])).toThrow();
    expect(() => parseArgs(["--server", DEMO_SERVER, "--write-config-only"])).toThrow();
    expect(parseArgs(["--server", "all"]).servers).toEqual(["bc1", "bc2", "bc3"]);
  });

  test("bc-demo has its own ports, and every bc server keeps its own", () => {
    expect(portsOf(DEMO_SERVER)).toEqual({ odata: 7348, dev: 7349, api: 7352 });
    for (const [name, p] of Object.entries(SERVERS)) {
      expect(portsOf(name as keyof typeof SERVERS)).toEqual(p);
      for (const port of Object.values(p)) expect(Object.values(DEMO_PORTS)).not.toContain(port);
    }
  });

  test("no gate fixture is the demo, and no itest names bc-demo or its config", () => {
    expect(GATE_FIXTURES.map((f) => f.configDir as string)).not.toContain("gift-card");
    const dir = join(REPO, "packages", "runner", "itest");
    const files = readdirSync(dir).filter((f) => f.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(10);
    for (const f of files) {
      const text = readFileSync(join(dir, f), "utf8");
      expect({ f, hit: /bc-demo|lethal\.config\.demo/.test(text) }).toEqual({ f, hit: false });
    }
  });

  test("checkNotPooled refuses an allocation that lists bc-demo, and accepts one that does not", () => {
    expect(() => checkNotPooled(JSON.stringify({ lethal: ["bc1", "bc-demo"] }))).toThrow(
      DemoInPoolError,
    );
    expect(() => checkNotPooled(JSON.stringify({ other: ["bc-demo"] }))).toThrow(DemoInPoolError);
    expect(() => checkNotPooled(JSON.stringify({ lethal: ["Cronus28", "bc1"] }))).not.toThrow();
    expect(() => checkNotPooled(null)).not.toThrow();
    expect(() => checkNotPooled("{not json")).toThrow();
  });

  test("a pooled bc-demo stops the run before any server call", async () => {
    const { deps, calls } = fakeDeps({
      allocation: () => JSON.stringify({ lethal: ["bc-demo"] }),
    });
    const out: string[] = [];
    expect(await run([], deps, (s) => out.push(s))).toBe(1);
    expect(calls).toEqual([]);
    expect(out.join("\n")).toContain("allocation");
  });
});

describe("R663: bc-demo-setup", () => {
  test("bc-demo not answering: the owner steps are printed and nothing else runs", async () => {
    const { deps, calls } = fakeDeps({ reachable: async () => false });
    const out: string[] = [];
    expect(await run([], deps, (s) => out.push(s))).toBe(2);
    expect(calls).toEqual(["allocation"]);
    const text = out.join("\n");
    for (const step of ownerSteps()) expect(text).toContain(step);
    for (const port of ["7348", "7349", "7352"]) expect(text).toContain(port);
  });

  test("an empty bc-demo: control, then gift-card, then its tests are published; one config; doctor", async () => {
    const { deps, calls, written, server } = fakeDeps();
    const out: string[] = [];
    expect(await run([], deps, (s) => out.push(s))).toBe(0);
    expect(server.published).toEqual([
      "LethAL_LethAL Control_1.0.0.23.app",
      "LethAL_Gift Card Demo_1.0.0.1.app",
      "LethAL_Gift Card Demo Tests_1.0.0.1.app",
    ]);
    expect([...written.keys()]).toEqual([DEMO_CONFIG]);
    const cfg = written.get(DEMO_CONFIG) as {
      selectorIds: object;
      bcdev: { port: number; baseUrl: string; apiBaseUrl: string; packageCachePath: string };
    };
    expect(cfg.selectorIds).toEqual({ selectorId: 90199, controlId: 90198, tableId: 90197 });
    expect(cfg.bcdev.port).toBe(7349);
    expect(cfg.bcdev.baseUrl).toBe("http://192.168.2.157:7348/BC");
    expect(cfg.bcdev.apiBaseUrl).toBe("http://192.168.2.157:7352/BC");
    expect(cfg.bcdev.packageCachePath).toBe("/cache/bc-demo/28.4-abcd1234");
    expect(calls.at(-1)).toBe(`doctor ${DEMO_CONFIG}`);
    expect(out.join("\n")).not.toContain(PASSWORD);
  });

  test("idempotent: a second run against the same bc-demo publishes nothing", async () => {
    const { deps, server } = fakeDeps();
    expect(await run([], deps, () => {})).toBe(0);
    const first = server.published.length;
    expect(await run([], deps, () => {})).toBe(0);
    expect(server.published.length).toBe(first);
  });

  test("the demo config, which holds the login, is git-ignored", () => {
    expect(gitIgnores(DEMO_CONFIG)).toBe(true);
  });

  test("--dry-run prints the plan and calls nothing", async () => {
    const { deps, calls } = fakeDeps();
    const out: string[] = [];
    expect(await run(["--dry-run"], deps, (s) => out.push(s))).toBe(0);
    expect(calls).toEqual(["allocation"]);
    expect(out.join("\n")).toContain("7349");
  });

  test("a failing doctor fails the run", async () => {
    const { deps } = fakeDeps({ doctor: async () => false });
    expect(await run([], deps, () => {})).toBe(1);
  });

  test("an unknown argument is refused", async () => {
    const { deps, calls } = fakeDeps();
    expect(await run(["--server", "bc1"], deps, () => {})).toBe(1);
    expect(calls).toEqual([]);
  });
});
