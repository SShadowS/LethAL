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
import { sha256Of } from "./bc-app-content.ts";
import {
  DEMO_CONFIG,
  type DemoDeps,
  DemoInPoolError,
  LAPTOP_BC_DEV_MCP,
  LAPTOP_CONTROL,
  LAPTOP_SYMBOLS,
  LOCAL_CACHE,
  LOCAL_LOGIN,
  type LaptopIo,
  LaptopRefused,
  NATIVE_PARSER,
  REAL_DEPS,
  checkNotPooled,
  laptopDeps,
  laptopLogin,
  laptopTools,
  ownerSteps,
  run,
} from "./bc-demo-setup.ts";
import { CONTROL_APP, GATE_FIXTURES, gitIgnores, parseArgs } from "./bc-linux-setup.ts";
import { SYMBOL_CACHE_ROOT } from "./bc-symbol-cache.ts";
import { laptopPreflight } from "./gift-card-refreeze.ts";

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

describe("R663b: kraken mode is unchanged", () => {
  // Captured from master de7999fc's bc-demo-setup.ts with these same fakes (only the checkout
  // path, `<REPO>`, differs between checkouts).
  const pin = JSON.parse(
    readFileSync(join(import.meta.dir, "testdata", "bc-demo-kraken-pin.json"), "utf8").replaceAll(
      "<REPO>",
      REPO,
    ),
  ) as Record<string, unknown>;
  const cases: [string, string[], Partial<DemoDeps>][] = [
    ["ok", [], {}],
    ["dry", ["--dry-run"], {}],
    ["down", [], { reachable: async () => false }],
    ["unknown", ["--x"], {}],
  ];
  for (const [name, argv, over] of cases) {
    test(`${name}: output, calls and written config equal master's, byte for byte`, async () => {
      const { deps, calls, written } = fakeDeps(over);
      const out: string[] = [];
      const laptop = async (): Promise<DemoDeps> => {
        throw new Error("kraken mode built laptop deps");
      };
      const code = await run(argv, deps, (s) => out.push(s), laptop);
      expect({ code, out, calls, written: Object.fromEntries(written) }).toEqual(
        pin[name] as never,
      );
    });
  }

  test("kraken mode's real deps keep their /coord paths and carry no laptop section", () => {
    expect(REAL_DEPS.laptop).toBeUndefined();
    expect(SYMBOL_CACHE_ROOT).toBe("/coord/cache/bc-symbols");
    expect(CONTROL_APP.startsWith("/coord/handoff/")).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// R663b laptop mode

const FORBIDDEN = ["/coord", "/home/dev", "/work/tools"];
const guard = (p: string) => {
  if (FORBIDDEN.some((f) => p === f || p.startsWith(`${f}/`)))
    throw new Error(`laptop mode touched ${p}`);
};
const HOME = "/home/laptop";
const EXT_ALC = `${HOME}/.vscode/extensions/ms-dynamics-smb.al-18.0.1/bin/linux/alc`;
const CONTROL_BYTES = Buffer.from("pinned control");
const LOGIN_FILE = "BC_DEV_USER=BCRUNNER\nBC_DEV_PASSWORD=from-the-file!\n";

interface IoOver {
  env?: Record<string, string>;
  drop?: string[];
  files?: Record<string, string>;
  ignored?: boolean;
  node?: boolean;
  noExtension?: boolean;
}

/** A laptop: every path read goes through `guard`, which throws on /coord and container paths. */
function fakeIo(over: IoOver = {}) {
  const files = new Map<string, string | Buffer>([
    [join(LAPTOP_BC_DEV_MCP, "package.json"), '{"bin":{"bc-dev-mcp":"dist/index.js"}}'],
    [join(LAPTOP_BC_DEV_MCP, "dist", "index.js"), ""],
    [LAPTOP_CONTROL, CONTROL_BYTES],
    [NATIVE_PARSER, ""],
    [LOCAL_LOGIN, LOGIN_FILE],
    ...Object.entries(over.files ?? {}),
  ]);
  for (const d of over.drop ?? []) files.delete(d);
  const read: string[] = [];
  const io: LaptopIo = {
    env: over.env ?? {},
    exists: (p) => {
      guard(p);
      return files.has(p);
    },
    readText: (p) => {
      guard(p);
      read.push(p);
      const v = files.get(p);
      if (v === undefined) throw new Error(`no ${p}`);
      return v.toString();
    },
    readBytes: (p) => {
      guard(p);
      read.push(p);
      const v = files.get(p);
      if (v === undefined) throw new Error(`no ${p}`);
      return Buffer.from(v);
    },
    isIgnored: (p) => {
      guard(p);
      return over.ignored ?? true;
    },
    which: (cmd) => (cmd === "node" && over.node !== false ? "/usr/bin/node" : null),
    home: HOME,
    alTools: async (dir) => {
      guard(dir);
      return over.noExtension === true || dir !== `${HOME}/.vscode/extensions`
        ? undefined
        : { alcPath: EXT_ALC, altoolPath: `${EXT_ALC.slice(0, -3)}altool` };
    },
  };
  return { io, read };
}

const SHA = sha256Of(CONTROL_BYTES);
const inCheckout = (p: string) => p.startsWith(`${REPO}/`);

describe("R663b laptop mode: paths", () => {
  test("every default resolves inside the checkout or the laptop user's home, never /coord", async () => {
    const { io } = fakeIo();
    const t = await laptopTools(io, SHA);
    expect(t.host).toBe("http://localhost");
    expect(t.symbolRoot).toBe(LAPTOP_SYMBOLS);
    expect(t.controlPath).toBe(LAPTOP_CONTROL);
    expect(t.mcpCommand).toEqual(["node", join(LAPTOP_BC_DEV_MCP, "dist", "index.js")]);
    expect(t.alcPath).toBe(EXT_ALC);
    for (const p of [t.symbolRoot, t.controlPath, LAPTOP_BC_DEV_MCP, NATIVE_PARSER, LOCAL_LOGIN])
      expect({ p, inside: inCheckout(p) }).toEqual({ p, inside: true });
    expect(LAPTOP_SYMBOLS.startsWith(`${LOCAL_CACHE}/`)).toBe(true);
  });

  test("the login file and the cache are git-ignored in this repository", () => {
    expect(gitIgnores(LOCAL_LOGIN)).toBe(true);
    expect(gitIgnores(join(LAPTOP_SYMBOLS, "bc-demo", "x.app.json"))).toBe(true);
    expect(gitIgnores(join(LAPTOP_BC_DEV_MCP, "package.json"))).toBe(true);
  });

  test("LETHAL_DEMO_HOST overrides the host (the container simulation); a non-host refuses", async () => {
    const t = await laptopTools(
      fakeIo({ env: { LETHAL_DEMO_HOST: "http://192.168.2.157" } }).io,
      SHA,
    );
    expect(t.host).toBe("http://192.168.2.157");
    await expect(
      laptopTools(fakeIo({ env: { LETHAL_DEMO_HOST: "localhost:7349" } }).io, SHA),
    ).rejects.toThrow(LaptopRefused);
  });

  test("LETHAL_ALC_DIR and LETHAL_BC_DEV_MCP override the defaults", async () => {
    const { io } = fakeIo({
      env: { LETHAL_ALC_DIR: "/opt/al", LETHAL_BC_DEV_MCP: "/opt/mcp" },
      files: {
        "/opt/al/alc": "",
        "/opt/al/altool": "",
        "/opt/mcp/package.json": '{"bin":{"bc-dev-mcp":"dist/index.js"}}',
        "/opt/mcp/dist/index.js": "",
      },
    });
    const t = await laptopTools(io, SHA);
    expect([t.alcPath, t.altoolPath]).toEqual(["/opt/al/alc", "/opt/al/altool"]);
    expect(t.mcpCommand).toEqual(["node", "/opt/mcp/dist/index.js"]);
  });
});

describe("R663b laptop mode: each missing dependency is refused by name", () => {
  const cases: [string, IoOver, string][] = [
    ["node", { node: false }, "node is not on PATH"],
    ["bc-dev-mcp", { drop: [join(LAPTOP_BC_DEV_MCP, "package.json")] }, "bc-dev-mcp is missing"],
    [
      "bc-dev-mcp build",
      { drop: [join(LAPTOP_BC_DEV_MCP, "dist", "index.js")] },
      "bc-dev-mcp is not built",
    ],
    ["alc (no extension)", { noExtension: true }, "no AL Language extension"],
    [
      "alc (LETHAL_ALC_DIR)",
      { env: { LETHAL_ALC_DIR: "/opt/empty" } },
      "LETHAL_ALC_DIR has no alc",
    ],
    ["control app", { drop: [LAPTOP_CONTROL] }, "LethAL Control is missing"],
    ["control app sha", { files: { [LAPTOP_CONTROL]: "another build" } }, "not the pinned"],
    ["native parser", { drop: [NATIVE_PARSER] }, "native AL parser is missing"],
  ];
  for (const [name, over, message] of cases) {
    test(name, async () => {
      const p = laptopTools(fakeIo(over).io, SHA);
      await expect(p).rejects.toThrow(LaptopRefused);
      await expect(p).rejects.toThrow(message);
      await expect(p).rejects.toThrow("docs/talk-laptop.md");
    });
  }

  test("refreeze's preflight refuses a checkout with no laptop config, naming setup", async () => {
    await expect(laptopPreflight(fakeIo().io, SHA)).rejects.toThrow(
      `${DEMO_CONFIG} does not exist: run bun scripts/bc-demo-setup.ts --laptop first`,
    );
    await laptopPreflight(fakeIo({ files: { [DEMO_CONFIG]: "{}" } }).io, SHA);
  });
});

describe("R663b laptop mode: the login", () => {
  test("from the environment, when both variables are set (the file is not read)", () => {
    const { io, read } = fakeIo({ env: { BC_DEV_USER: "U", BC_DEV_PASSWORD: "P" } });
    expect(laptopLogin(io)).toEqual({ user: "U", password: "P" });
    expect(read).toEqual([]);
  });

  test("from .lethal-demo.env when the environment has neither", () => {
    const { io, read } = fakeIo();
    expect(laptopLogin(io)).toEqual({ user: "BCRUNNER", password: "from-the-file!" });
    expect(read).toEqual([LOCAL_LOGIN]);
  });

  test("a login file that git does not ignore is refused before it is read", () => {
    const { io, read } = fakeIo({ ignored: false });
    expect(() => laptopLogin(io)).toThrow(LaptopRefused);
    expect(() => laptopLogin(io)).toThrow("not ignored by .gitignore");
    expect(read).toEqual([]);
  });

  test("only one variable set is refused, naming the missing one", () => {
    expect(() => laptopLogin(fakeIo({ env: { BC_DEV_USER: "U" } }).io)).toThrow(
      "BC_DEV_PASSWORD is missing",
    );
    expect(() => laptopLogin(fakeIo({ env: { BC_DEV_PASSWORD: "P" } }).io)).toThrow(
      "BC_DEV_USER is missing",
    );
  });

  test("neither the environment nor the file is refused by name", () => {
    expect(() => laptopLogin(fakeIo({ drop: [LOCAL_LOGIN] }).io)).toThrow("no login");
  });
});

describe("R663b laptop mode: a whole setup run", () => {
  test("touches no /coord or container path, and writes a checkout-local, localhost config", async () => {
    const { io } = fakeIo();
    const t = await laptopTools(io, SHA);
    const login = laptopLogin(io);
    const k = fakeDeps();
    // kraken's allocation file is under /coord: laptop mode never reads it.
    expect(laptopDeps(io, t, login).allocation()).toBeNull();
    const throwing = Object.fromEntries(
      Object.keys(k.deps).map((key) => [
        key,
        () => {
          throw new Error(`kraken dep ${key} used in laptop mode`);
        },
      ]),
    ) as unknown as DemoDeps;
    const out: string[] = [];
    const code = await run(
      [LAPTOP_FLAG_ARG],
      throwing,
      (s) => out.push(s),
      async () => ({
        ...laptopDeps(io, t, login),
        // the server, the compile and doctor are faked as in kraken mode
        reachable: k.deps.reachable,
        fillSymbols: async () => join(LAPTOP_SYMBOLS, "bc-demo", "28.4-abcd1234"),
        controlBytes: k.deps.controlBytes,
        compile: k.deps.compile,
        serverOps: k.deps.serverOps,
        doctor: k.deps.doctor,
        writeConfig: k.deps.writeConfig,
      }),
    );
    const text = out.join("\n");
    expect(code).toBe(0);
    expect(text).toContain("bc-demo-setup (laptop)");
    expect(text).not.toContain("from-the-file!");
    const cfg = k.written.get(DEMO_CONFIG) as { bcdev: Record<string, unknown> };
    expect(cfg.bcdev.server).toBe("http://localhost:7349");
    expect(cfg.bcdev.baseUrl).toBe("http://localhost:7348/BC");
    expect(cfg.bcdev.apiBaseUrl).toBe("http://localhost:7352/BC");
    expect(cfg.bcdev.controlSymbolPath).toBe(LAPTOP_CONTROL);
    expect(cfg.bcdev.packageCachePath).toBe(join(LAPTOP_SYMBOLS, "bc-demo", "28.4-abcd1234"));
    expect(cfg.bcdev.alcPath).toBe(EXT_ALC);
    expect(cfg.bcdev.mcpCommand).toEqual(["node", join(LAPTOP_BC_DEV_MCP, "dist", "index.js")]);
    const json = JSON.stringify(cfg);
    for (const f of FORBIDDEN) expect({ f, hit: json.includes(f) }).toEqual({ f, hit: false });
  });

  test("LETHAL_DEMO_HOST reaches every URL of the written config", async () => {
    const { io } = fakeIo({ env: { LETHAL_DEMO_HOST: "http://10.0.0.9" } });
    const k = fakeDeps();
    const code = await run(
      ["--laptop"],
      k.deps,
      () => {},
      async () => ({
        ...laptopDeps(io, await laptopTools(io, SHA), laptopLogin(io)),
        reachable: k.deps.reachable,
        fillSymbols: k.deps.fillSymbols,
        controlBytes: k.deps.controlBytes,
        compile: k.deps.compile,
        serverOps: k.deps.serverOps,
        doctor: k.deps.doctor,
        writeConfig: k.deps.writeConfig,
      }),
    );
    expect(code).toBe(0);
    const { bcdev } = k.written.get(DEMO_CONFIG) as { bcdev: Record<string, unknown> };
    expect([bcdev.server, bcdev.baseUrl, bcdev.apiBaseUrl]).toEqual([
      "http://10.0.0.9:7349",
      "http://10.0.0.9:7348/BC",
      "http://10.0.0.9:7352/BC",
    ]);
  });

  test("not up: the laptop start steps, not kraken's owner steps", async () => {
    const { io } = fakeIo();
    const out: string[] = [];
    const code = await run(
      [LAPTOP_FLAG_ARG],
      fakeDeps().deps,
      (s) => out.push(s),
      async () => ({
        ...laptopDeps(io, await laptopTools(io, SHA), laptopLogin(io)),
        reachable: async () => false,
      }),
    );
    expect(code).toBe(2);
    const text = out.join("\n");
    expect(text).toContain("docker compose -p bc-demo");
    expect(text).not.toContain("/coord");
  });

  test("a refused dependency fails the run before any server call", async () => {
    const out: string[] = [];
    const code = await run(
      [LAPTOP_FLAG_ARG],
      fakeDeps().deps,
      (s) => out.push(s),
      async () =>
        laptopDeps(fakeIo().io, await laptopTools(fakeIo({ node: false }).io, SHA), {
          user: "u",
          password: "p",
        }),
    );
    expect(code).toBe(1);
    expect(out.join("\n")).toContain("node is not on PATH");
  });
});

const LAPTOP_FLAG_ARG = "--laptop";
