import { describe, expect, spyOn, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { itestLaunchName } from "../packages/runner/itest/config-path.ts";
import { buildFakeAppWithEntries } from "../packages/runner/tests/helpers/fake-app.ts";
import {
  GATE_FIXTURES,
  LaneUnknownError,
  type LeaseDeps,
  LeaseLostError,
  NotIgnoredError,
  PUBLISH_PLAN,
  type RunDeps,
  SecretFileError,
  buildConfig,
  buildLaunch,
  configFileName,
  continiaDependencyProblems,
  describeLogin,
  gitIgnores,
  krakenLeaseFor,
  launchFileName,
  parseArgs,
  parseSecretEnv,
  readSecretFile,
  resolveLane,
  run,
  withLease,
  writeConfig,
} from "./bc-linux-setup.ts";
import { fillSymbolCache } from "./bc-symbol-cache.ts";

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
        server: "http://192.168.2.157:7149",
        serverInstance: "BC",
        tenant: "default",
        port: 7149,
        baseUrl: "http://192.168.2.157:7148/BC",
        apiBaseUrl: "http://192.168.2.157:7152/BC",
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
          server: "http://192.168.2.157",
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

describe("--write-config-only: configs from the secret file, no server call, no lease", () => {
  const FIXTURE_DIRS = ["sandbox-app", "sandbox-data", "sandbox-hang", "sandbox-harden"];

  function harness(secretText: string | null) {
    const repo = mkdtempSync(join(tmpdir(), "bc-wco-repo-"));
    for (const d of FIXTURE_DIRS) mkdirSync(join(repo, "fixtures", d), { recursive: true });
    const cacheRoot = mkdtempSync(join(tmpdir(), "bc-wco-cache-"));
    const secretPath = join(mkdtempSync(join(tmpdir(), "bc-wco-secret-")), "bc-linux.env");
    if (secretText !== null) writeFileSync(secretPath, secretText);
    const counts = { connect: 0, lease: 0 };
    const printed: string[] = [];
    const deps: RunDeps = {
      readSecret: () => readSecretFile(secretPath),
      connect: () => {
        counts.connect++;
        throw new Error("the config-only mode must not reach a server");
      },
      lease: () => {
        counts.lease++;
        throw new Error("the config-only mode must not take a lease");
      },
      isIgnored: () => true,
      repo,
      cacheRoot,
      mcpCommand: () => ["node", "/x/bc-dev-mcp/dist/index.js"],
      env: {},
    };
    // stdout AND stderr are both captured, so a login printed by any path is seen.
    const go = async (argv: string[]) => {
      const log = spyOn(console, "log").mockImplementation((...a: unknown[]) => {
        printed.push(a.join(" "));
      });
      const err = spyOn(console, "error").mockImplementation((...a: unknown[]) => {
        printed.push(a.join(" "));
      });
      try {
        return await run(argv, deps, (s) => printed.push(s));
      } finally {
        log.mockRestore();
        err.mockRestore();
      }
    };
    const written = () =>
      FIXTURE_DIRS.flatMap((d) =>
        [
          join("fixtures", d, "lethal.config.bc3.json"),
          join("fixtures", d, ".vscode", "launch.bc3.json"),
        ].filter((p) => existsSync(join(repo, p))),
      );
    return { repo, cacheRoot, counts, printed, go, written };
  }

  const ALL_FILES = FIXTURE_DIRS.flatMap((d) => [
    join("fixtures", d, "lethal.config.bc3.json"),
    join("fixtures", d, ".vscode", "launch.bc3.json"),
  ]);

  test("an empty cache: every file written, 0 server and 0 lease calls, named empty, never gate-ready", async () => {
    const h = harness(GOOD);
    const code = await h.go(["--server", "bc3", "--write-config-only"]);
    expect(h.counts).toEqual({ connect: 0, lease: 0 });
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
      server: "http://192.168.2.157:7249",
      port: 7249,
      baseUrl: "http://192.168.2.157:7248/BC",
      apiBaseUrl: "http://192.168.2.157:7252/BC",
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
      expect(h.counts).toEqual({ connect: 0, lease: 0 });
      const out = h.printed.join("\n");
      expect(out).toContain(
        `symbol cache for bc3: ${filled.dir} (build 28.4.53241.56646, 1 files: System; verified`,
      );
      expect(out).not.toContain("symbol cache empty");
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

  test("no secret file: refused by name, nothing written, no call", async () => {
    const h = harness(null);
    const code = await h.go(["--server", "bc3", "--write-config-only"]);
    expect(code).toBe(1);
    expect(h.printed.join("\n")).toContain("bc-linux.env does not exist");
    expect(h.written()).toEqual([]);
    expect(h.counts).toEqual({ connect: 0, lease: 0 });
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
});
