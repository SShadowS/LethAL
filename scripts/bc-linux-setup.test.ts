import { describe, expect, spyOn, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { itestLaunchName } from "../packages/runner/itest/config-path.ts";
import { MARKER_HOST, MARKER_SERVERS } from "../packages/runner/itest/out-of-use.ts";
import type { FetchFn } from "../packages/runner/src/activation.ts";
import { readAppIdentity } from "../packages/runner/src/published-test-app.ts";
import { buildFakeAppWithEntries } from "../packages/runner/tests/helpers/fake-app.ts";
import { CONTROL_SELECTOR_FILENAME } from "../packages/schemata/src/project.ts";
import { type Conn, type ServerOps, sha256Of } from "./bc-app-content.ts";
import {
  GATE_FIXTURES,
  HOST,
  HeldLeaseUnknownError,
  LaneUnknownError,
  type LeaseDeps,
  LeaseLostError,
  NotIgnoredError,
  PINNED_MICROSOFT_VERSION,
  PUBLISH_PLAN,
  REAL_DEPS,
  type RunDeps,
  SERVERS,
  SecretFileError,
  UnitTestCoordWriteError,
  buildConfig,
  buildLaunch,
  configFileName,
  continiaDependencyProblems,
  decideContinia,
  describeLogin,
  downloadSymbols,
  gitIgnores,
  heldLeaseDeps,
  krakenLeaseFor,
  launchFileName,
  parseArgs,
  parseSecretEnv,
  readSecretFile,
  realContiniaOps,
  resolveLane,
  run,
  withLease,
  writeConfig,
} from "./bc-linux-setup.ts";
import { fillSymbolCache, lookupSymbolCache } from "./bc-symbol-cache.ts";

// R594: a Continia app the server would refuse is caught before anything is published.
describe("continiaDependencyProblems", () => {
  const pkg = buildFakeAppWithEntries({
    "NavxManifest.xml": `<Package><App Id="1" Name="Core" Publisher="Continia Software" Version="28.5.0.1" Application="28.0.0.0" Platform="28.0.0.0" /><Dependencies><Dependency Id="2" Name="Continia System Application" Publisher="Continia Software" MinVersion="28.4.0.0" /><Dependency Id="3" Name="Base Application" Publisher="Microsoft" MinVersion="28.4.0.0" /></Dependencies></Package>`,
  });
  const resident = (base: string | null, system = "28.0.54946.56477") =>
    new Map<string, string | null>([
      ["Base Application", base],
      ["Application", "28.4.53241.56646"],
      ["System", system],
    ]);
  const pinned = new Map([["Continia System Application", "28.5.0.336834"]]);

  test("accepts a server that satisfies every declared minimum", () => {
    expect(continiaDependencyProblems(pkg, resident("28.4.53241.56646"), pinned)).toEqual([]);
  });
  test("names a Microsoft dependency that is absent or below its minimum", () => {
    expect(continiaDependencyProblems(pkg, resident(null), pinned)).toEqual([
      "Core: needs Microsoft Base Application >= 28.4.0.0, absent",
    ]);
    expect(continiaDependencyProblems(pkg, resident("28.3.0.0"), pinned)).toEqual([
      "Core: needs Microsoft Base Application >= 28.4.0.0, has 28.3.0.0",
    ]);
  });
  test("names a platform below the app's Platform and a Continia dependency not pinned", () => {
    expect(continiaDependencyProblems(pkg, resident("28.4.0.0", "27.0.0.0"), new Map())).toEqual([
      "Core: needs Continia Software Continia System Application >= 28.4.0.0, absent",
      "Core: needs System (platform) >= 28.0.0.0, has 27.0.0.0",
    ]);
  });
  test("--accept-build needs --with-continia and a four-part version", () => {
    expect(parseArgs(["--server", "bc3", "--with-continia", "--accept-build", "28.4.1.2"])).toEqual(
      {
        servers: ["bc3"],
        dryRun: false,
        withContinia: true,
        acceptBuild: "28.4.1.2",
      },
    );
    expect(() => parseArgs(["--server", "bc3", "--accept-build", "28.4.1.2"])).toThrow();
    expect(() =>
      parseArgs(["--server", "bc3", "--with-continia", "--accept-build", "28.4"]),
    ).toThrow();
  });
});

// A made-up value: the tests check it never appears in an error.
const SECRET = "Tr0ub4dor=&3!";
const GOOD = `BC_DEV_USER=BCRUNNER\nBC_DEV_PASSWORD=${SECRET}\n`;

function refusal(text: string): string {
  try {
    parseSecretEnv(text);
  } catch (err) {
    expect(err).toBeInstanceOf(SecretFileError);
    return (err as Error).message;
  }
  throw new Error("expected a refusal");
}

describe("parseSecretEnv", () => {
  test("reads both keys and keeps a value ending in ! (and holding =) intact", () => {
    expect(parseSecretEnv(GOOD)).toEqual({ user: "BCRUNNER", password: SECRET });
    expect(parseSecretEnv(GOOD.replace(/\n/g, "\r\n")).password).toBe(SECRET);
  });
  test("a refusal names the file it read (R663: bc-demo.env, not bc-linux.env)", () => {
    const demo = "/coord/secrets/bc-demo.env";
    expect(() => parseSecretEnv("BC_DEV_USER=x\n", demo)).toThrow(
      `${demo}: BC_DEV_PASSWORD is missing`,
    );
    expect(() => parseSecretEnv("nope\n", demo)).toThrow(`${demo}: line 1`);
  });

  test("a missing file is refused by name", () => {
    const path = join(mkdtempSync(join(tmpdir(), "bc-linux-")), "bc-linux.env");
    expect(() => readSecretFile(path)).toThrow(SecretFileError);
    expect(() => readSecretFile(path)).toThrow(path);
  });

  test("a missing key is refused by name", () => {
    expect(refusal("BC_DEV_USER=BCRUNNER\n")).toContain("BC_DEV_PASSWORD is missing");
  });

  test("an extra key is refused by name, without its value", () => {
    const m = refusal(`${GOOD}EXTRA=${SECRET}\n`);
    expect(m).toContain('unexpected key "EXTRA"');
    expect(m).not.toContain(SECRET);
  });

  test("an empty value is refused by name", () => {
    expect(refusal("BC_DEV_USER=BCRUNNER\nBC_DEV_PASSWORD=\n")).toContain(
      "BC_DEV_PASSWORD is empty",
    );
  });

  test("no refusal echoes a value, or part of one", () => {
    const [head] = SECRET.split("=");
    // A bare password line, with and without an `=` in it.
    expect(refusal(`BC_DEV_USER=BCRUNNER\n${SECRET}\n`)).not.toContain(head);
    expect(refusal("BC_DEV_USER=BCRUNNER\nhunter2!\n")).not.toContain("hunter2");
    for (const text of [
      `${GOOD}BC_DEV_PASSWORD=${SECRET}\n`,
      `BC_DEV_USER=BCRUNNER\nBC_DEV_PASSWORD =${SECRET}\nX=${SECRET}\n`,
    ]) {
      expect(refusal(text)).not.toContain(SECRET);
    }
    expect(describeLogin(parseSecretEnv(GOOD))).not.toContain(SECRET);
    expect(describeLogin(parseSecretEnv(GOOD))).toContain(`(${SECRET.length} chars)`);
  });
});

describe("config writer", () => {
  const login = { user: "BCRUNNER", password: SECRET };
  const paths = {
    mcpCommand: ["node", "/x/bc-dev-mcp/dist/index.js"],
    controlSymbolPath: "/x/control.app",
    packageCachePath: "/x/symbols",
  };

  test("bc2's config names bc2's three ports and the W1 company", () => {
    expect(buildConfig("bc2", login, paths, "sandbox-app")).toEqual({
      bcdev: {
        mcpCommand: paths.mcpCommand,
        server: `${HOST}:7149`,
        serverInstance: "BC",
        tenant: "default",
        port: 7149,
        baseUrl: `${HOST}:7148/BC`,
        apiBaseUrl: `${HOST}:7152/BC`,
        company: "CRONUS International Ltd.",
        username: "BCRUNNER",
        password: SECRET,
        packageCachePath: "/x/symbols",
        controlSymbolPath: "/x/control.app",
        env: { BC_DEV_USER: "BCRUNNER", BC_DEV_PASSWORD: SECRET, BC_DEV_API_PORT: "7152" },
      },
    });
  });

  // R596: itest:agreement refuses unless the harden config's selectorIds equal its SELECTOR_IDS.
  test("sandbox-harden's config carries itest:agreement's selectorIds; no other fixture's does", () => {
    const itest = readFileSync(
      join(import.meta.dir, "../packages/runner/itest/verify-agreement.itest.ts"),
      "utf8",
    );
    const m = /const SELECTOR_IDS = \{ selectorId: (\d+), controlId: (\d+), tableId: (\d+) \}/.exec(
      itest,
    );
    if (m === null) throw new Error("verify-agreement.itest.ts: SELECTOR_IDS line not found");
    const wanted = { selectorId: Number(m[1]), controlId: Number(m[2]), tableId: Number(m[3]) };
    for (const f of GATE_FIXTURES) {
      const cfg = buildConfig("bc1", login, paths, f.configDir) as { selectorIds?: unknown };
      if (f.configDir === "sandbox-harden") expect(cfg.selectorIds).toEqual(wanted);
      else expect(cfg.selectorIds).toBeUndefined();
    }
  });

  test("a path git does not ignore is refused and nothing is written", () => {
    const path = join(mkdtempSync(join(tmpdir(), "bc-linux-")), "lethal.config.bc1.json");
    expect(() => writeConfig(path, {}, () => false)).toThrow(NotIgnoredError);
    expect(existsSync(path)).toBe(false);
    writeConfig(path, { a: 1 }, () => true);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ a: 1 });
  });

  // Windows has no POSIX mode bits (chmod there sets only read-only); the script runs in the Linux container.
  test.skipIf(process.platform === "win32")(
    "a re-write onto an existing 644 file leaves it 600 (mode applies on create only)",
    () => {
      const path = join(mkdtempSync(join(tmpdir(), "bc-linux-")), "lethal.config.bc1.json");
      writeFileSync(path, "{}");
      chmodSync(path, 0o644);
      writeConfig(path, { a: 1 }, () => true);
      expect(statSync(path).mode & 0o777).toBe(0o600);
    },
  );

  test("the repo's .gitignore ignores the per-server configs and not app.json", () => {
    expect(gitIgnores("fixtures/sandbox-app/lethal.config.bc1.json")).toBe(true);
    expect(gitIgnores("fixtures/sandbox-harden/lethal.config.bc3.json")).toBe(true);
    expect(gitIgnores("fixtures/sandbox-app/app.json")).toBe(false);
  });

  test("the launch file the script writes is ignored and is the one the itests pair with", () => {
    expect(gitIgnores("fixtures/sandbox-app/.vscode/launch.bc1.json")).toBe(true);
    expect(gitIgnores("fixtures/sandbox-data/.vscode/launch.bc3.json")).toBe(true);
    for (const s of ["bc1", "bc2", "bc3"] as const) {
      expect(launchFileName(s)).toBe(itestLaunchName({ LETHAL_ITEST_CONFIG: configFileName(s) }));
    }
  });

  test("bc2's launch file is OnPrem on bc2's dev port and carries no login", () => {
    const launch = buildLaunch("bc2");
    expect(launch).toMatchObject({
      configurations: [
        {
          environmentType: "OnPrem",
          server: HOST,
          port: 7149,
          tenant: "default",
        },
      ],
    });
    // `authentication: "UserPassword"` names the scheme; no KEY may hold a login.
    const keys = JSON.stringify(launch).match(/"[^"]+":/g) ?? [];
    expect(keys.filter((k) => /password|user/i.test(k))).toEqual([]);
  });
});

describe("publish plan", () => {
  const targets = PUBLISH_PLAN.map((s) => s.target);
  const all = PUBLISH_PLAN.flatMap((s) => [s.target, ...s.dependents]);

  test("sandbox-probes is published, before sandbox-app (itest:bcdev's invariant probes)", () => {
    expect(targets).toContain("sandbox-probes");
    expect(targets.indexOf("sandbox-probes")).toBeLessThan(targets.indexOf("sandbox-app"));
  });

  test("every BC gate's apps are in it, and wrapped is built with WRAPDEF", () => {
    for (const app of [
      "sandbox-app",
      "sandbox-tests",
      "sandbox-data",
      "sandbox-data-tests",
      "sandbox-hang",
      "sandbox-hang-tests",
      "sandbox-harden",
      "sandbox-harden-tests",
      "sandbox-harden-answers",
      "sandbox-wrapped",
      "sandbox-wrapped-tests",
      "sandbox-names",
      "sandbox-names-tests",
    ]) {
      expect(all).toContain(app);
    }
    expect(PUBLISH_PLAN.find((s) => s.target === "sandbox-wrapped")?.defines).toEqual(["WRAPDEF"]);
  });

  test("every app in it is a fixture with an app.json", () => {
    for (const app of all) {
      expect(existsSync(join(import.meta.dir, "..", "fixtures", app, "app.json"))).toBe(true);
    }
  });
});

describe("withLease", () => {
  function fakeLease(calls: string[], recordThrows = false): LeaseDeps {
    return {
      take: async () => {
        calls.push("take");
        return "tok";
      },
      recordToken: (_s, t) => {
        calls.push(`record:${t}`);
        if (recordThrows) throw new Error("disk full");
      },
      heartbeat: async () => {
        calls.push("heartbeat");
      },
      release: async (_s, t) => {
        calls.push(`release:${t}`);
      },
    };
  }

  test("records the token before the body runs, and releases after", async () => {
    const calls: string[] = [];
    await withLease("bc1", fakeLease(calls), async () => {
      calls.push("body");
    });
    expect(calls).toEqual(["take", "record:tok", "body", "release:tok"]);
  });

  test("releases when the body throws", async () => {
    const calls: string[] = [];
    await expect(
      withLease("bc1", fakeLease(calls), async () => {
        throw new Error("publish failed");
      }),
    ).rejects.toThrow("publish failed");
    expect(calls).toEqual(["take", "record:tok", "release:tok"]);
  });

  test("releases when recording the token fails, and never runs the body", async () => {
    const calls: string[] = [];
    await expect(
      withLease("bc1", fakeLease(calls, true), async () => {
        calls.push("body");
      }),
    ).rejects.toThrow("disk full");
    expect(calls).toEqual(["take", "record:tok", "release:tok"]);
  });

  test("heartbeats while the body runs", async () => {
    const calls: string[] = [];
    await withLease(
      "bc1",
      fakeLease(calls),
      async () => {
        await new Promise((r) => setTimeout(r, 35));
      },
      10,
    );
    expect(calls.filter((c) => c === "heartbeat").length).toBeGreaterThan(0);
    expect(calls.at(-1)).toBe("release:tok");
  });

  test("a failed heartbeat fails the run, and the lease is still released", async () => {
    const calls: string[] = [];
    const deps: LeaseDeps = {
      ...fakeLease(calls),
      heartbeat: async () => {
        throw new Error("coord down");
      },
    };
    await expect(
      withLease("bc1", deps, async () => new Promise((r) => setTimeout(r, 35)), 10),
    ).rejects.toThrow(LeaseLostError);
    expect(calls.at(-1)).toBe("release:tok");
  });

  test("a failed release does not replace the body's own error", async () => {
    const deps: LeaseDeps = {
      ...fakeLease([]),
      release: async () => {
        throw new Error("release failed");
      },
    };
    await expect(
      withLease("bc1", deps, async () => {
        throw new Error("publish failed");
      }),
    ).rejects.toThrow("publish failed");
  });
});

describe("R598: the coord lease is taken in the caller's lane, never a fixed one", () => {
  /** The kraken-call seam: records every `kraken coord ...` call, answers a lease with a token. */
  function fakeKraken(): { calls: string[][]; run: (args: readonly string[]) => Promise<string> } {
    const calls: string[][] = [];
    return {
      calls,
      run: async (args) => {
        calls.push([...args]);
        return args[0] === "lease" ? JSON.stringify({ token: "t-1" }) : "{}";
      },
    };
  }

  test("--lane with an agent name (lane-<x>) is refused and names the lane to pass", () => {
    expect(() => resolveLane("lane-preproc", { KRAKEN_AGENT: "lane-preproc" })).toThrow(
      LaneUnknownError,
    );
    expect(() => resolveLane("lane-preproc", {})).toThrow(/pass --lane "preproc"/);
    expect(resolveLane("preproc", {})).toBe("preproc");
  });

  test("R615: a lane that is not a plain word is refused by name (it becomes a file name)", () => {
    for (const bad of ["../../x", "A B", "a/b"])
      expect(() => resolveLane(bad, {})).toThrow(LaneUnknownError);
    expect(() => resolveLane(undefined, { KRAKEN_AGENT: "lane-A B" })).toThrow(LaneUnknownError);
    expect(resolveLane("code", {})).toBe("code");
    expect(resolveLane("preproc", {})).toBe("preproc");
  });

  test("no --lane and no kraken identity: refused by name, before any lease call", () => {
    expect(() => resolveLane(undefined, {})).toThrow(LaneUnknownError);
    expect(() => resolveLane(undefined, {})).toThrow(/--lane/);
    expect(() => resolveLane(undefined, { KRAKEN_AGENT: "" })).toThrow(/KRAKEN_AGENT is not set/);
    expect(() => resolveLane(undefined, { KRAKEN_AGENT: "someone" })).toThrow(/names no lane/);
    expect(() => resolveLane(undefined, { KRAKEN_AGENT: "lane-" })).toThrow(LaneUnknownError);
  });

  test("--lane is passed into the lease call, and wins over the identity", async () => {
    const k = fakeKraken();
    const lane = resolveLane("bugs", { KRAKEN_AGENT: "lane-preproc" });
    expect(lane).toBe("bugs");
    expect(await krakenLeaseFor(lane, k.run).take("bc2")).toBe("t-1");
    expect(k.calls).toEqual([["lease", "bc2", "bugs"]]);
  });

  test("the kraken identity is the fallback: lane-<x> leases as <x>, orchestrator as orchestrator", async () => {
    const k = fakeKraken();
    await krakenLeaseFor(resolveLane(undefined, { KRAKEN_AGENT: "lane-preproc" }), k.run).take(
      "bc1",
    );
    await krakenLeaseFor(resolveLane(undefined, { KRAKEN_AGENT: "orchestrator" }), k.run).take(
      "bc3",
    );
    expect(k.calls).toEqual([
      ["lease", "bc1", "preproc"],
      ["lease", "bc3", "orchestrator"],
    ]);
  });

  test("heartbeat and release go through the same seam with the token", async () => {
    const k = fakeKraken();
    const deps = krakenLeaseFor("preproc", k.run);
    await deps.heartbeat("bc1", "t-1");
    await deps.release("bc1", "t-1");
    expect(k.calls).toEqual([
      ["heartbeat", "bc1", "t-1"],
      ["release", "bc1", "t-1"],
    ]);
  });

  test("the documented command still parses without --lane; --lane takes a name, never a flag", () => {
    // R594's `withContinia` is always present (false unless --with-continia).
    expect(parseArgs(["--server", "bc1"])).toEqual({
      servers: ["bc1"],
      dryRun: false,
      withContinia: false,
    });
    expect(parseArgs(["--server", "all", "--lane", "code"])).toEqual({
      servers: ["bc1", "bc2", "bc3"],
      dryRun: false,
      lane: "code",
      withContinia: false,
    });
    expect(() => parseArgs(["--server", "bc1", "--lane", "--dry-run"])).toThrow(
      /--lane needs a lane name/,
    );
    expect(() => parseArgs(["--server", "bc1", "--lane"])).toThrow(/--lane needs a lane name/);
  });
});

describe("R617: --held-lease never takes or releases a lease", () => {
  /** The kraken-call seam, recording every call; a heartbeat for any token but `live` is refused. */
  function fakeKraken(live = "held-1"): {
    calls: string[][];
    run: (args: readonly string[]) => Promise<string>;
  } {
    const calls: string[][] = [];
    return {
      calls,
      run: async (args) => {
        calls.push([...args]);
        if (args[0] === "lease") return JSON.stringify({ token: "t-new" });
        if (args[0] === "heartbeat" && args[2] !== live) throw new Error("no such lease");
        return "{}";
      },
    };
  }
  const verbs = (calls: string[][]) => calls.map((c) => c[0]);

  test("held: the given token is checked by one heartbeat, then heartbeated; zero lease and zero release calls", async () => {
    const k = fakeKraken();
    let ran = false;
    await withLease(
      "bc2",
      heldLeaseDeps("held-1", k.run),
      async () => {
        ran = true;
        await new Promise((r) => setTimeout(r, 35));
      },
      10,
    );
    expect(ran).toBe(true);
    expect(verbs(k.calls)).not.toContain("lease");
    expect(verbs(k.calls)).not.toContain("release");
    expect(k.calls.length).toBeGreaterThanOrEqual(2);
    for (const c of k.calls) expect(c).toEqual(["heartbeat", "bc2", "held-1"]);
  });

  test("not held: exactly one lease and one release, with the token coord gave", async () => {
    const k = fakeKraken("t-new");
    // recordToken writes the real token file under /coord: a unit test must never touch it.
    const deps = { ...krakenLeaseFor("preproc", k.run), recordToken() {} };
    await withLease("bc2", deps, async () => {});
    expect(k.calls.filter((c) => c[0] === "lease")).toEqual([["lease", "bc2", "preproc"]]);
    expect(k.calls.filter((c) => c[0] === "release")).toEqual([["release", "bc2", "t-new"]]);
  });

  test("a held token coord does not recognise is refused by name before the body runs", async () => {
    const k = fakeKraken("held-1");
    let ran = false;
    await expect(
      withLease("bc2", heldLeaseDeps("stale-9", k.run), async () => {
        ran = true;
      }),
    ).rejects.toThrow(HeldLeaseUnknownError);
    expect(ran).toBe(false);
    expect(verbs(k.calls)).toEqual(["heartbeat"]);
  });

  test("under the unit-test preload, the real recordToken refuses by name and writes no /coord file", () => {
    expect(process.env.LETHAL_TEST_FAKE_HOME).toBeDefined();
    const before = existsSync("/coord/handoff/R-589/lease-bc3-preproc.txt")
      ? readFileSync("/coord/handoff/R-589/lease-bc3-preproc.txt", "utf8")
      : undefined;
    expect(() => krakenLeaseFor("preproc", fakeKraken().run).recordToken("bc3", "t-unit")).toThrow(
      UnitTestCoordWriteError,
    );
    const after = existsSync("/coord/handoff/R-589/lease-bc3-preproc.txt")
      ? readFileSync("/coord/handoff/R-589/lease-bc3-preproc.txt", "utf8")
      : undefined;
    expect(after).toBe(before);
  });

  test("R615: the record is per lane: two lanes on one server keep two files, a lane re-records its own", () => {
    const dir = mkdtempSync(join(tmpdir(), "r615-"));
    const k = fakeKraken();
    krakenLeaseFor("preproc", k.run, dir).recordToken("bc1", "t-a");
    krakenLeaseFor("bugs", k.run, dir).recordToken("bc1", "t-b");
    expect(readdirSync(dir).sort()).toEqual(["lease-bc1-bugs.txt", "lease-bc1-preproc.txt"]);
    expect(readFileSync(join(dir, "lease-bc1-preproc.txt"), "utf8")).toBe("t-a\n");
    expect(readFileSync(join(dir, "lease-bc1-bugs.txt"), "utf8")).toBe("t-b\n");
    krakenLeaseFor("preproc", k.run, dir).recordToken("bc1", "t-c");
    expect(readdirSync(dir)).toHaveLength(2);
    expect(readFileSync(join(dir, "lease-bc1-preproc.txt"), "utf8")).toBe("t-c\n");
    expect(readFileSync(join(dir, "lease-bc1-bugs.txt"), "utf8")).toBe("t-b\n");
  });

  test("R615/B1: under the preload, any folder under /coord is refused (trailing slash too); a temp folder writes", () => {
    const k = fakeKraken();
    for (const d of ["/coord/handoff/R-589/", "/coord/handoff/other", "/coord"])
      expect(() => krakenLeaseFor("x", k.run, d).recordToken("bc1", "t")).toThrow(
        UnitTestCoordWriteError,
      );
    const tmp = mkdtempSync(join(tmpdir(), "r615b-"));
    krakenLeaseFor("x", k.run, tmp).recordToken("bc1", "t");
    expect(existsSync(join(tmp, "lease-bc1-x.txt"))).toBe(true);
  });

  test("R615/B1: the root is compared by path segment: a sibling sharing the prefix is not under it", () => {
    const tmp = mkdtempSync(join(tmpdir(), "r615c-"));
    const sibling = `${tmp}x`;
    mkdirSync(sibling);
    const prev = process.env.LETHAL_COORD_ROOT;
    process.env.LETHAL_COORD_ROOT = tmp;
    try {
      const k = fakeKraken();
      expect(() => krakenLeaseFor("x", k.run, tmp).recordToken("bc1", "t")).toThrow(
        UnitTestCoordWriteError,
      );
      krakenLeaseFor("x", k.run, sibling).recordToken("bc1", "t");
      expect(existsSync(join(sibling, "lease-bc1-x.txt"))).toBe(true);
    } finally {
      if (prev === undefined) Reflect.deleteProperty(process.env, "LETHAL_COORD_ROOT");
      else process.env.LETHAL_COORD_ROOT = prev;
    }
  });

  test("parseArgs: one held token leases one server", () => {
    expect(() => parseArgs(["--server", "all", "--held-lease", "t"])).toThrow();
    expect(parseArgs(["--server", "bc3", "--held-lease", "t"])).toEqual({
      servers: ["bc3"],
      dryRun: false,
      withContinia: false,
      heldLease: "t",
    });
  });
});

describe("--write-config-only: configs from the secret file, no server call, no lease", () => {
  const FIXTURE_DIRS = ["sandbox-app", "sandbox-data", "sandbox-hang", "sandbox-harden"];

  function harness(
    secretText: string | null,
    over: (h: { repo: string; cacheRoot: string }) => Partial<RunDeps> = () => ({}),
  ) {
    const repo = mkdtempSync(join(tmpdir(), "bc-wco-repo-"));
    for (const d of FIXTURE_DIRS) mkdirSync(join(repo, "fixtures", d), { recursive: true });
    // `symbolNames` reads each PUBLISH_PLAN target's app.json under deps.repo, not the real repo.
    for (const s of PUBLISH_PLAN) {
      mkdirSync(join(repo, "fixtures", s.target), { recursive: true });
      writeFileSync(
        join(repo, "fixtures", s.target, "app.json"),
        JSON.stringify({ name: s.target, publisher: "LethAL", version: "1.0.0.0" }),
      );
    }
    const cacheRoot = mkdtempSync(join(tmpdir(), "bc-wco-cache-"));
    const secretPath = join(mkdtempSync(join(tmpdir(), "bc-wco-secret-")), "bc-linux.env");
    const outOfUseDir = mkdtempSync(join(tmpdir(), "bc-wco-out-of-use-"));
    if (secretText !== null) writeFileSync(secretPath, secretText);
    const counts = { connect: 0, lease: 0, fetch: 0, writes: 0 };
    const printed: string[] = [];
    const noServer = (what: string) => () => {
      counts.connect++;
      throw new Error(`the config-only mode must not reach a server (${what})`);
    };
    const deps: RunDeps = {
      readSecret: () => readSecretFile(secretPath),
      connect: noServer("connect"),
      lease: () => {
        counts.lease++;
        throw new Error("the config-only mode must not take a lease");
      },
      isIgnored: () => true,
      repo,
      cacheRoot,
      mcpCommand: () => ["node", "/x/bc-dev-mcp/dist/index.js"],
      env: {},
      writeConfig: (path, config) => {
        counts.writes++;
        writeConfig(path, config, () => true);
      },
      downloadSymbol: noServer("downloadSymbol"),
      serverOps: noServer("serverOps"),
      continiaOps: noServer("continiaOps"),
      continiaFiles: () => [],
      controlBytes: noServer("controlBytes"),
      compile: noServer("compile"),
      checkResident: noServer("checkResident"),
      doctor: noServer("doctor"),
      // R669: never the real /coord; a test plants markers here.
      outOfUseDir,
      ...over({ repo, cacheRoot }),
    };
    // stdout AND stderr are both captured, so a login printed by any path is seen.
    const go = async (argv: string[]) => {
      const log = spyOn(console, "log").mockImplementation((...a: unknown[]) => {
        printed.push(a.join(" "));
      });
      const err = spyOn(console, "error").mockImplementation((...a: unknown[]) => {
        printed.push(a.join(" "));
      });
      // Any fetch resolved at call time is counted and answered 500. (`bcFetch` binds `fetch` when
      // it is imported, so the module's own server paths are counted by `connect` instead: every
      // one of them takes a `Conn`, and `connect` is the only way to get one.)
      const net = spyOn(globalThis, "fetch").mockImplementation((async () => {
        counts.fetch++;
        return new Response("no network in this test", { status: 500 });
      }) as unknown as typeof fetch);
      try {
        return await run(argv, deps, (s) => printed.push(s));
      } finally {
        log.mockRestore();
        err.mockRestore();
        net.mockRestore();
        // a filled build dir is sealed 0555: reopen it so the temp root can be removed
        for (const s of readdirSync(cacheRoot))
          for (const b of readdirSync(join(cacheRoot, s))) chmodSync(join(cacheRoot, s, b), 0o755);
      }
    };
    const written = () =>
      FIXTURE_DIRS.flatMap((d) =>
        [
          join("fixtures", d, "lethal.config.bc3.json"),
          join("fixtures", d, ".vscode", "launch.bc3.json"),
        ].filter((p) => existsSync(join(repo, p))),
      );
    return { repo, cacheRoot, counts, printed, go, written, outOfUseDir };
  }

  const ALL_FILES = FIXTURE_DIRS.flatMap((d) => [
    join("fixtures", d, "lethal.config.bc3.json"),
    join("fixtures", d, ".vscode", "launch.bc3.json"),
  ]);

  test("an empty cache: every file written, 0 server and 0 lease calls, named empty, never gate-ready", async () => {
    const h = harness(GOOD);
    const code = await h.go(["--server", "bc3", "--write-config-only"]);
    expect(h.counts).toMatchObject({ connect: 0, lease: 0, fetch: 0 });
    expect(h.written()).toEqual(ALL_FILES);
    const out = h.printed.join("\n");
    expect(out).toContain("symbol cache empty for bc3: run setup --server bc3 once");
    expect(out).toContain("NOT gate-ready");
    expect(out).not.toContain("ok:");
    expect(code).toBe(1);
    const cfg = JSON.parse(
      readFileSync(join(h.repo, "fixtures", "sandbox-app", "lethal.config.bc3.json"), "utf8"),
    ) as { bcdev: Record<string, unknown> };
    expect(cfg.bcdev).toMatchObject({
      server: `${HOST}:7249`,
      port: 7249,
      baseUrl: `${HOST}:7248/BC`,
      apiBaseUrl: `${HOST}:7252/BC`,
      company: "CRONUS International Ltd.",
      packageCachePath: join(h.cacheRoot, "bc3", "unfilled-run-setup-first"),
      username: "BCRUNNER",
    });
    const launch = JSON.parse(
      readFileSync(join(h.repo, "fixtures", "sandbox-app", ".vscode", "launch.bc3.json"), "utf8"),
    ) as { configurations: { port: number }[] };
    expect(launch.configurations[0]?.port).toBe(7249);
  });

  test("a filled cache: the configs name its build dir, read from its marker, and the run is gate-ready", async () => {
    const h = harness(GOOD);
    const sys = buildFakeAppWithEntries({
      "NavxManifest.xml":
        '<Package><App Id="i" Name="System" Publisher="Microsoft" Version="28.4.53241.56646" /></Package>',
    });
    const filled = await fillSymbolCache({
      root: h.cacheRoot,
      server: "bc3",
      names: ["System"],
      download: async () => sys,
    });
    try {
      const code = await h.go(["--server", "bc3", "--write-config-only"]);
      expect(h.counts).toMatchObject({ connect: 0, lease: 0, fetch: 0 });
      const out = h.printed.join("\n");
      expect(out).toContain(
        `symbol cache for bc3: ${filled.dir} (build 28.4.53241.56646, 1 files: System; verified`,
      );
      expect(out).not.toContain("symbol cache empty");
      // it never asks the server, and says so on the cache line AND on the ok line
      expect(out).toContain("verified; server build not checked (config-only)");
      expect(out).toContain(
        "ok: configs written, symbol cache verified; server build not checked (config-only)",
      );
      expect(code).toBe(0);
      for (const d of FIXTURE_DIRS) {
        const cfg = JSON.parse(
          readFileSync(join(h.repo, "fixtures", d, "lethal.config.bc3.json"), "utf8"),
        ) as { bcdev: { packageCachePath: string } };
        expect(cfg.bcdev.packageCachePath).toBe(filled.dir);
      }
    } finally {
      // the sealed dir is 0555; reopen it so the temp root can be removed
      chmodSync(filled.dir, 0o755);
    }
  });

  test("the required names come from deps.repo's fixtures: a cache lacking one is reported empty", async () => {
    const h = harness(GOOD);
    // one target in THIS repo needs a Microsoft package the cache does not hold
    writeFileSync(
      join(h.repo, "fixtures", "sandbox-names", "app.json"),
      JSON.stringify({
        name: "sandbox-names",
        publisher: "LethAL",
        version: "1.0.0.0",
        dependencies: [{ name: "Base Application", publisher: "Microsoft" }],
      }),
    );
    const sys = buildFakeAppWithEntries({
      "NavxManifest.xml":
        '<Package><App Id="i" Name="System" Publisher="Microsoft" Version="28.4.53241.56646" /></Package>',
    });
    const filled = await fillSymbolCache({
      root: h.cacheRoot,
      server: "bc3",
      names: ["System"],
      download: async () => sys,
    });
    try {
      expect(await h.go(["--server", "bc3", "--write-config-only"])).toBe(1);
      const out = h.printed.join("\n");
      expect(out).toContain("lacks Base Application");
      expect(out).toContain("symbol cache empty for bc3: run setup --server bc3 once");
    } finally {
      chmodSync(filled.dir, 0o755);
    }
  });

  test("no secret file: refused by name, nothing written, no call", async () => {
    const h = harness(null);
    const code = await h.go(["--server", "bc3", "--write-config-only"]);
    expect(code).toBe(1);
    expect(h.printed.join("\n")).toContain("bc-linux.env does not exist");
    expect(h.written()).toEqual([]);
    expect(h.counts).toMatchObject({ connect: 0, lease: 0, fetch: 0 });
  });

  test("a missing key: refused by name, nothing written", async () => {
    const h = harness("BC_DEV_USER=BCRUNNER\n");
    expect(await h.go(["--server", "bc3", "--write-config-only"])).toBe(1);
    expect(h.printed.join("\n")).toContain("BC_DEV_PASSWORD is missing");
    expect(h.written()).toEqual([]);
  });

  test("the login never reaches stdout or stderr (it is only in the gitignored configs)", async () => {
    const h = harness(GOOD);
    await h.go(["--server", "all", "--write-config-only"]);
    const out = h.printed.join("\n");
    expect(out).toContain(`BC_DEV_PASSWORD (${SECRET.length} chars)`);
    expect(out).not.toContain(SECRET);
    expect(out).not.toContain(Buffer.from(`BCRUNNER:${SECRET}`).toString("base64"));
  });

  test("takes only --server: a lane, a held lease, --dry-run or --with-continia is refused", () => {
    expect(parseArgs(["--server", "bc2", "--write-config-only"])).toEqual({
      servers: ["bc2"],
      dryRun: false,
      withContinia: false,
      writeConfigOnly: true,
    });
    for (const extra of [
      ["--lane", "bugs"],
      ["--held-lease", "t"],
      ["--dry-run"],
      ["--with-continia"],
    ]) {
      expect(() => parseArgs(["--server", "bc2", "--write-config-only", ...extra])).toThrow(
        /--write-config-only takes only --server/,
      );
    }
  });

  // -------------------------------------------------------------------------------------------
  // R599: the setup driver decides every app, then acts only if nothing was refused.

  const appPkg = (
    name: string,
    id: string,
    version = "1.0.0.0",
    publisher = "LethAL",
    extra: Record<string, string> = {},
  ) =>
    buildFakeAppWithEntries({
      "NavxManifest.xml": `<Package><App Id="${id}" Name="${name}" Publisher="${publisher}" Version="${version}" /><Build Timestamp="t" CompilerVersion="18.0.43.1464" /></Package>`,
      "src/a.al": name,
      ...extra,
    });
  const rowAt = (version: string) => {
    const [a, b, c, d] = version.split(".").map(Number);
    return {
      packageId: `pkg-${version}`,
      displayName: "x",
      isInstalled: true,
      versionMajor: a ?? 0,
      versionMinor: b ?? 0,
      versionBuild: c ?? 0,
      versionRevision: d ?? 0,
    };
  };

  /**
   * A fake server holding every PUBLISH_PLAN app at the local build's content (each a skip),
   * except `sandbox-probes` (absent: a publish) and, with `refuseLast`, the LAST step's
   * dependent (above its build: a refusal). LethAL Control is absent (a publish).
   */
  function fleet(
    refuseLast: boolean,
    // R-707: `check` stands in for the resident-source compile (it sees the dependent's name and the
    // sha256 of the target bytes it was given); `uninstalled` has no resident row; `states` makes a
    // resident build older ("older": the local build upgrades it) or a newer minted one ("kept").
    opts: {
      check?: (name: string, targetSha: string) => void;
      uninstalled?: string;
      states?: Record<string, "older" | "kept">;
    } = {},
  ) {
    const calls = {
      publish: [] as string[],
      checked: [] as string[],
      targetShas: [] as string[],
      continiaReads: 0,
      doctor: 0,
      take: 0,
    };
    const local = new Map<string, Buffer>();
    const resident = new Map<string, { pkg: Buffer; version: string }>();
    const last = PUBLISH_PLAN.at(-1)?.dependents.at(-1);
    for (const step of PUBLISH_PLAN) {
      for (const dir of [step.target, ...step.dependents]) {
        const b = appPkg(dir, `${dir}-id`);
        local.set(dir, b);
        if (dir === "sandbox-probes" || dir === opts.uninstalled) continue;
        const state = opts.states?.[dir];
        resident.set(
          dir,
          state === "older"
            ? {
                pkg: appPkg(dir, `${dir}-id`, "0.9.0.0", "LethAL", { "src/old.al": "old" }),
                version: "0.9.0.0",
              }
            : state === "kept"
              ? {
                  pkg: appPkg(dir, `${dir}-id`, "1.0.0.9", "LethAL", {
                    [`src/${CONTROL_SELECTOR_FILENAME}`]: "sel",
                  }),
                  version: "1.0.0.9",
                }
              : refuseLast && dir === last
                ? { pkg: appPkg(dir, `${dir}-id`, "1.0.0.9"), version: "1.0.0.9" }
                : { pkg: b, version: "1.0.0.0" },
        );
      }
    }
    const names = new Map<string, string>([["lethal-control-id", "LethAL Control"]]);
    const byId = (id: string) => names.get(id) ?? id.replace(/-id$/, "");
    const ops: ServerOps = {
      resident: async (_p, name) => resident.get(name)?.pkg ?? null,
      rows: async (id) => {
        const r = resident.get(byId(id));
        return r === undefined ? [] : [rowAt(r.version)];
      },
      publish: async (fileName, bytes) => {
        calls.publish.push(fileName);
        const m = /_(.*)_(\d+\.\d+\.\d+\.\d+)\.app$/.exec(fileName);
        resident.set(m?.[1] ?? fileName, { pkg: bytes, version: m?.[2] ?? "?" });
      },
    };
    const continia = appPkg("Continia Core", "cc-id", "28.5.0.1", "Continia Software");
    const over = (): Partial<RunDeps> => ({
      connect: (server) => ({ server, authorization: "Basic test" }),
      lease: () => ({
        take: async () => {
          calls.take++;
          return "tok";
        },
        recordToken: () => {},
        heartbeat: async () => {},
        release: async () => {},
      }),
      downloadSymbol: async () => appPkg("System", "sys", "28.4.1.1", "Microsoft"),
      controlBytes: () => appPkg("LethAL Control", "lethal-control-id", "1.0.0.23"),
      compile: async (_c, step) =>
        [step.target, ...step.dependents].map((dir) => ({
          dir,
          local: local.get(dir) as Buffer,
          role: dir === step.target ? ("target" as const) : ("dependent" as const),
          gateDeploys: dir === step.target && step.gateDeploys === true,
          ...(dir === step.target ? {} : { targetDir: step.target }),
        })),
      serverOps: () => ops,
      checkResident: async (_c, target, pkg) => {
        const name = readAppIdentity(pkg).name;
        const sha = sha256Of(target.bytes);
        calls.checked.push(name);
        calls.targetShas.push(sha);
        opts.check?.(name, sha);
      },
      continiaOps: () => ({
        residentVersion: async (publisher, name) => {
          calls.continiaReads++;
          if (publisher === "Microsoft")
            return name === "System" ? "28.4.1.1" : PINNED_MICROSOFT_VERSION;
          return calls.publish.some((p) => p.includes(name)) ? "28.5.0.1" : null;
        },
        publish: async (fileName) => {
          calls.publish.push(fileName);
        },
      }),
      continiaFiles: () => [{ bytes: continia }],
      doctor: async () => {
        calls.doctor++;
        return true;
      },
    });
    return { calls, over, local, resident };
  }

  test("one refusal in the LAST step: NOTHING is published in any step, Continia included", async () => {
    const f = fleet(true);
    const h = harness(GOOD, f.over);
    const code = await h.go(["--server", "bc3", "--lane", "bugs", "--with-continia"]);
    const out = h.printed.join("\n");
    // first: nothing published (Control first in the act order, so it would be the first one)
    expect(f.calls.publish).toEqual([]);
    expect(f.calls.doctor).toBe(0);
    expect(code).toBe(1);
    expect(out).toContain("refuse    above-build sandbox-names-tests");
    expect(out).toContain("publish   new sandbox-probes"); // decided, never done
    expect(out).toContain("STOPPED   1 app(s) refused: NOTHING was published");
  });

  test("--predict on an EMPTY cache fills it (write-once), publishes nothing, writes no config", async () => {
    const f = fleet(false);
    const h = harness(GOOD, f.over);
    expect(lookupSymbolCache(h.cacheRoot, "bc3").chosen).toBeUndefined();
    const code = await h.go(["--server", "bc3", "--lane", "bugs", "--predict"]);
    const out = h.printed.join("\n");
    expect(out).toContain("predicted: nothing published, no config or launch file written");
    expect(out).toContain("downloaded and sealed");
    const found = lookupSymbolCache(h.cacheRoot, "bc3", ["System"]);
    expect(found.chosen?.marker.build).toBe("28.4.1.1");
    expect(f.calls.publish).toEqual([]);
    expect(h.counts.writes).toBe(0);
    expect(f.calls.doctor).toBe(0);
    expect(f.calls.take).toBe(1);
    expect(code).toBe(0);
    if (found.chosen !== undefined) chmodSync(found.chosen.dir, 0o755);
  });

  test("--predict --with-continia reads the Continia state and publishes nothing", async () => {
    const f = fleet(false);
    const h = harness(GOOD, f.over);
    const code = await h.go(["--server", "bc3", "--lane", "bugs", "--predict", "--with-continia"]);
    const out = h.printed.join("\n");
    expect(out).toContain("P1        Microsoft System: 28.4.1.1");
    expect(out).toContain("publish   Continia Core 28.5.0.1"); // decided, never done
    expect(f.calls.continiaReads).toBeGreaterThan(0);
    expect(f.calls.publish).toEqual([]);
    expect(h.counts.writes).toBe(0);
    expect(code).toBe(0);
  });

  test("no refusal: it acts, control first, then Continia, then the fixtures, then doctor", async () => {
    const f = fleet(false);
    const h = harness(GOOD, f.over);
    const code = await h.go(["--server", "bc3", "--lane", "bugs", "--with-continia"]);
    expect(h.printed.join("\n")).not.toContain("FAILED");
    expect(f.calls.publish).toEqual([
      "LethAL_LethAL Control_1.0.0.23.app",
      "Continia Software_Continia Core_28.5.0.1.app",
      "LethAL_sandbox-probes_1.0.0.0.app",
    ]);
    expect(h.counts.writes).toBe(8);
    expect(f.calls.doctor).toBe(4);
    expect(code).toBe(0);
  });

  describe("R-707: an INSTALLED dependent's resident source is checked before anything is sent", () => {
    const go = async (f: ReturnType<typeof fleet>) => {
      const h = harness(GOOD, f.over);
      const code = await h.go(["--server", "bc3", "--lane", "bugs"]);
      return { code, out: h.printed.join("\n") };
    };
    const AL_ERR = "alc failed on x (exit 1):\nsrc/T.al(7,21): error AL0135: no argument";
    // sandbox-app's resident build is older, so the local one UPGRADES it: the target publishes.
    const publishing = { states: { "sandbox-app": "older" } } as const;

    test("T-cochange: the resident source breaks against the new target: refused, zero publishes", async () => {
      const f = fleet(false, {
        ...publishing,
        check: (name) => {
          if (name === "sandbox-tests") throw new Error(AL_ERR);
        },
      });
      const r = await go(f);
      expect(r.out).toContain("refuse resident-dependent-breaks: sandbox-tests (src/T.al(7,21)");
      expect(r.out).toContain("(1) uninstall and unpublish the dependent");
      expect(f.calls.publish).toEqual([]);
      expect(f.calls.doctor).toBe(0);
      expect(r.code).toBe(1);
    });

    test("T-resident-ok: a publishing target's installed dependent is checked against the NEW target build, and the run publishes", async () => {
      const f = fleet(false, publishing);
      const residentSha = sha256Of(f.resident.get("sandbox-app")?.pkg as Buffer); // before the run replaces it
      const r = await go(f);
      expect(f.calls.checked).toEqual(["sandbox-tests"]);
      expect(f.calls.targetShas).toEqual([sha256Of(f.local.get("sandbox-app") as Buffer)]);
      expect(f.calls.targetShas).not.toContain(residentSha);
      expect(r.out).toContain(
        "  checked   sandbox-tests (resident) against sandbox-app 1.0.0.0: ok",
      );
      expect(f.calls.publish).toContain("LethAL_sandbox-probes_1.0.0.0.app");
      expect(r.code).toBe(0);
    });

    test("T-skipped: a skipped target with a skipped dependent is not checked", async () => {
      const f = fleet(false);
      const r = await go(f);
      expect(f.calls.checked).toEqual([]);
      expect(r.code).toBe(0);
    });

    test("T-kept-breaks: a KEPT target and a dependent that publishes but fails against the resident target: refused, zero publishes", async () => {
      const f = fleet(false, {
        states: { "sandbox-app": "kept", "sandbox-tests": "older" },
        check: () => {
          throw new Error(AL_ERR);
        },
      });
      const r = await go(f);
      expect(r.out).toContain("kept      minted target sandbox-app");
      expect(r.out).toContain("refuse dependent-vs-kept-target: sandbox-tests (src/T.al(7,21)");
      expect(r.out).toContain("--mint");
      expect(f.calls.publish).toEqual([]);
      expect(f.calls.doctor).toBe(0);
      expect(r.code).toBe(1);
    });

    test("T-kept-ok: the same with a compatible dependent publishes; the check ran on the NEW dependent against the RESIDENT target", async () => {
      const f = fleet(false, { states: { "sandbox-app": "kept", "sandbox-tests": "older" } });
      const r = await go(f);
      expect(f.calls.checked).toEqual(["sandbox-tests"]);
      expect(f.calls.targetShas).toEqual([sha256Of(f.resident.get("sandbox-app")?.pkg as Buffer)]);
      expect(r.out).toContain(
        "  checked   sandbox-tests (new build) against kept sandbox-app 1.0.0.9: ok",
      );
      expect(f.calls.publish).toContain("LethAL_sandbox-probes_1.0.0.0.app");
      expect(r.code).toBe(0);
    });

    test("T-kept-skip: a kept target whose dependent is only skipped is not checked", async () => {
      const f = fleet(false, { states: { "sandbox-app": "kept" } });
      await go(f);
      expect(f.calls.checked).toEqual([]);
    });

    test("T-not-installed: a dependent with no resident row is not checked", async () => {
      const f = fleet(false, { ...publishing, uninstalled: "sandbox-tests" });
      const r = await go(f);
      expect(f.calls.checked).toEqual([]);
      expect(r.out).not.toContain("refuse");
    });

    test("T-not-compile: a throw with no AL error line is not called a break, and nothing is sent", async () => {
      const f = fleet(false, {
        ...publishing,
        check: () => {
          throw new Error("the dev endpoint refused the login (HTTP 401)");
        },
      });
      const r = await go(f);
      expect(r.out).toContain("dependent check failed (not a compile result)");
      expect(r.out).not.toContain("dependent-breaks");
      expect(f.calls.publish).toEqual([]);
      expect(r.code).toBe(1);
    });
  });

  describe("R669: a server with an out-of-use marker", () => {
    const MARKER =
      "# bc3 is OUT OF USE\n\n- **Reason:** SYNTH-REASON a stranded op\n\n## How to clear it\n1. SYNTH-CLEAR restart\n";
    function marked(env: Record<string, string>, servers: string[] = ["bc3"]) {
      const f = fleet(false);
      const h = harness(GOOD, () => ({ ...f.over(), env }));
      for (const s of servers) writeFileSync(join(h.outOfUseDir, `${s}.md`), MARKER);
      return { f, h };
    }
    function expectRefused(
      f: ReturnType<typeof fleet>,
      h: ReturnType<typeof harness>,
      code: number,
    ) {
      const out = h.printed.join("\n");
      expect(code).toBe(1);
      expect(out).toContain(`bc3 is OUT OF USE: ${join(h.outOfUseDir, "bc3.md")} exists`);
      expect(out).toContain("SYNTH-REASON a stranded op");
      expect(out).toContain("SYNTH-CLEAR restart");
      expect(f.calls.take).toBe(0);
      expect(h.counts).toMatchObject({ connect: 0, lease: 0, fetch: 0, writes: 0 });
      expect(f.calls.publish).toEqual([]);
    }

    test("no marker: the run goes ahead (the control for every refusal below)", async () => {
      const { f, h } = marked({}, []);
      expect(await h.go(["--server", "bc3", "--lane", "bugs"])).toBe(0);
      expect(f.calls.take).toBe(1);
      expect(h.printed.join("\n")).not.toContain("OUT OF USE");
    });

    test("a marker: refused by name with its reason, before the lease or any server call", async () => {
      const { f, h } = marked({});
      expectRefused(f, h, await h.go(["--server", "bc3", "--lane", "bugs"]));
      expect(h.printed.join("\n")).toContain("set LETHAL_OUT_OF_USE_CLEARING=bc3");
    });

    test("--dry-run and --write-config-only are refused too", async () => {
      for (const argv of [
        ["--server", "bc3", "--lane", "bugs", "--dry-run"],
        ["--server", "bc3", "--write-config-only"],
      ]) {
        const { f, h } = marked({});
        expectRefused(f, h, await h.go(argv));
      }
    });

    test("--server all with only bc3 marked: the WHOLE run is refused, naming bc3", async () => {
      const { f, h } = marked({});
      const code = await h.go(["--server", "all", "--lane", "bugs"]);
      expectRefused(f, h, code);
      expect(h.printed.join("\n")).not.toContain("bc1 is OUT OF USE");
    });

    test("LETHAL_OUT_OF_USE_CLEARING=bc3 lets bc3 through, loudly", async () => {
      const { f, h } = marked({ LETHAL_OUT_OF_USE_CLEARING: "bc3" });
      expect(await h.go(["--server", "bc3", "--lane", "bugs"])).toBe(0);
      expect(f.calls.take).toBe(1);
      const out = h.printed.join("\n");
      expect(out).toContain("!!! bc3 has an out-of-use marker");
      expect(out).toContain("LETHAL_OUT_OF_USE_CLEARING=bc3 overrides it for the clearing step");
      expect(out).toContain("SYNTH-REASON a stranded op");
    });

    test("the clearing override for bc3 does not clear a marked bc2 in an `all` run", async () => {
      const f = fleet(false);
      const h = harness(GOOD, () => ({ ...f.over(), env: { LETHAL_OUT_OF_USE_CLEARING: "bc3" } }));
      writeFileSync(join(h.outOfUseDir, "bc3.md"), MARKER);
      writeFileSync(join(h.outOfUseDir, "bc2.md"), MARKER.replace("bc3", "bc2"));
      expect(await h.go(["--server", "all", "--lane", "bugs"])).toBe(1);
      expect(h.printed.join("\n")).toContain("bc2 is OUT OF USE");
      expect(f.calls.take).toBe(0);
    });

    test("a wrong, empty or bogus clearing value refuses", async () => {
      for (const v of ["bc2", "", "1", "bc3 ", "BC3", "all"]) {
        const { f, h } = marked({ LETHAL_OUT_OF_USE_CLEARING: v });
        expectRefused(f, h, await h.go(["--server", "bc3", "--lane", "bugs"]));
      }
    });

    test("the owner override is the itests' only: setup ignores it", async () => {
      const t = "0f1e2d3c4b5a69788796a5b4c3d2e1f0";
      const { f, h } = marked({ LETHAL_OUT_OF_USE_OWNER: t });
      writeFileSync(join(h.outOfUseDir, "bc3.md"), `${MARKER}owner: ${t}\n`);
      expectRefused(f, h, await h.go(["--server", "bc3", "--lane", "bugs"]));
    });
  });

  test("R783: HOST, MARKER_HOST and the written launch file follow LETHAL_BC_HOST; unset is the default", () => {
    // Both constants are read at import, so each case is a fresh process.
    const read = (host: string | undefined): string => {
      const env: Record<string, string> = Object.fromEntries(
        Object.entries(process.env).filter(
          (e): e is [string, string] => e[0] !== "LETHAL_BC_HOST" && e[1] !== undefined,
        ),
      );
      if (host !== undefined) env.LETHAL_BC_HOST = host;
      const r = Bun.spawnSync(
        [
          process.execPath,
          "-e",
          'import { HOST } from "./scripts/bc-app-content.ts"; import { MARKER_HOST } from "./packages/runner/itest/out-of-use.ts"; import { buildLaunch } from "./scripts/bc-linux-setup.ts"; console.log([HOST, MARKER_HOST, buildLaunch("bc3").configurations[0].server].join(" "));',
        ],
        { cwd: join(import.meta.dir, ".."), env },
      );
      return r.stdout.toString().trim();
    };
    expect(read(undefined)).toBe(`${HOST} ${HOST.slice("http://".length)} ${HOST}`);
    expect(read("http://192.168.2.157")).toBe(
      "http://192.168.2.157 192.168.2.157 http://192.168.2.157",
    );
    expect(read("http://192.168.2.77")).toBe(
      "http://192.168.2.77 192.168.2.77 http://192.168.2.77",
    );
  });

  test("R669: out-of-use.ts's host and dev ports mirror HOST and SERVERS", () => {
    expect(`http://${MARKER_HOST}`).toBe(HOST);
    expect(MARKER_SERVERS).toEqual(
      Object.fromEntries(Object.entries(SERVERS).map(([name, p]) => [p.dev, name])),
    );
    expect(REAL_DEPS.outOfUseDir).toMatch(/machine[\\/]out-of-use$/);
  });

  test("--predict and --dry-run exclude each other", () => {
    expect(() => parseArgs(["--server", "bc3", "--predict", "--dry-run"])).toThrow(/exclude/);
    expect(parseArgs(["--server", "bc3", "--predict"])).toMatchObject({ predict: true });
  });
});

// R624: every reader goes through the one strict `residentPackage`; a 5xx stops, never "absent".
describe("R624: a failed dev/packages read stops every reader by its status", () => {
  /** A Conn answering each read by publisher and app name (never the network). */
  const connBy = (answer: (publisher: string, name: string) => Response): Conn => ({
    server: "bc3",
    authorization: "Basic fake",
    fetch: (async (input: string | URL | Request) => {
      const u = new URL(String(input));
      return answer(u.searchParams.get("publisher") ?? "", u.searchParams.get("appName") ?? "");
    }) as unknown as FetchFn,
  });
  const answering = (status: number) => connBy(() => new Response("x", { status }));
  const pkgOf = (name: string, publisher: string, version: string) =>
    buildFakeAppWithEntries({
      "NavxManifest.xml": `<Package><App Id="${name}-id" Name="${name}" Publisher="${publisher}" Version="${version}" /></Package>`,
    });
  const messageOf = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (err) {
      return (err as Error).message;
    }
    throw new Error("expected a rejection");
  };

  test("downloadSymbols: a 500 for System names HTTP 500, not a missing package (M2)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "r624-dl-"));
    writeFileSync(
      join(dir, "app.json"),
      JSON.stringify({ name: "x", publisher: "LethAL", version: "1.0.0.0" }),
    );
    const msg = await messageOf(downloadSymbols(answering(500), dir, dir));
    expect(msg).toContain("HTTP 500");
    expect(msg).not.toContain("holds no");
  });

  test("the shared cache's real downloadSymbol: a 500 stops the fill by its status, nothing sealed", async () => {
    const root = mkdtempSync(join(tmpdir(), "r624-cache-"));
    const c = answering(500);
    const msg = await messageOf(
      fillSymbolCache({
        root,
        server: "bc3",
        names: ["System"],
        download: (name) => REAL_DEPS.downloadSymbol(c, name),
      }),
    );
    expect(msg).toContain("HTTP 500");
    expect(msg).not.toContain("holds no");
    expect(readdirSync(join(root, "bc3"))).toEqual([]);
  });

  test("realContiniaOps: a 500 rejects naming HTTP 500; a 404 resolves null (I4)", async () => {
    await expect(
      realContiniaOps(answering(500)).residentVersion("Continia Software", "Continia Core"),
    ).rejects.toThrow("HTTP 500");
    expect(
      await realContiniaOps(answering(404)).residentVersion("Continia Software", "Continia Core"),
    ).toBeNull();
  });

  test("decideContinia: Microsoft at the pinned build, a 500 for one Continia app: it throws, never publishes it", async () => {
    const c = connBy((publisher, name) =>
      publisher === "Microsoft"
        ? new Response(pkgOf(name, "Microsoft", PINNED_MICROSOFT_VERSION), { status: 200 })
        : new Response("server error", { status: 500 }),
    );
    const files = [{ bytes: pkgOf("Continia Core", "Continia Software", "28.5.0.1") }];
    const summary: string[] = [];
    await expect(decideContinia(realContiniaOps(c), files, summary, undefined)).rejects.toThrow(
      "HTTP 500",
    );
    expect(summary.join("\n")).toContain(
      "every Continia app's declared dependencies are satisfied",
    );
    expect(summary.join("\n")).not.toContain("publish   Continia Core");
  });

  test("decideContinia (R679): Microsoft on another build stops, naming that build and --accept-build", async () => {
    const c = connBy((publisher, name) =>
      publisher === "Microsoft"
        ? new Response(pkgOf(name, "Microsoft", "28.4.53241.56646"), { status: 200 })
        : new Response("not found", { status: 404 }),
    );
    const files = [{ bytes: pkgOf("Continia Core", "Continia Software", "28.5.0.1") }];
    const summary: string[] = [];
    const r = await decideContinia(realContiniaOps(c), files, summary, undefined);
    expect(r.ok).toBe(false);
    expect(r.toPublish).toEqual([]);
    const stopped = summary.find((l) => l.includes("STOPPED"));
    expect(stopped).toContain("Base Application 28.4.53241.56646");
    expect(stopped).toContain("--accept-build");
  });
});
