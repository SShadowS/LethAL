import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Env,
  type Heartbeat,
  LEDGER_LINE_MAX,
  LEDGER_STALE_MS,
  type LedgerIo,
  type SlotIo,
  type SlotSignal,
  SlotTimeoutError,
  type SnapState,
  type TestDbReport,
  type TestStepIo,
  VerifyArgsError,
  type VerifyIo,
  type WatchOptions,
  acquireSlot,
  completeness,
  countOverlaps,
  discoverTestFiles,
  execWatched,
  isChildOf,
  ledgerAppend,
  ledgerLine,
  parallelism,
  parseArgs,
  parseJunit,
  parseLedger,
  parseSnapState,
  parseTestSummary,
  pidAlive,
  pressureText,
  readTestDbReports,
  runVerify,
  sentinelEnv,
  slotPath,
  snapChanges,
  stuckWorkers,
  testChildEnv,
  testCommand,
  testDbsLine,
  testStep,
  testTimeout,
} from "./verify.ts";

const KNOWN = ["engine", "runner", "schemata"];
const REPO_ROOT = join(import.meta.dir, "..");
const FULL = { mode: { kind: "full" }, p: 8 } as const;

function tempDir(tag: string): string {
  // Not `lethal-*`: the R358 preload check would read a leftover as this file's leak.
  return mkdtempSync(join(tmpdir(), `verify-${tag}-`));
}

describe("A1 parseArgs", () => {
  test("no args is the FULL mode", () => {
    expect(parseArgs([], KNOWN)).toEqual({ kind: "full" });
  });
  test("package names, with or without the packages/ prefix, are a PARTIAL packages mode", () => {
    expect(parseArgs(["runner", "packages/engine/"], KNOWN)).toEqual({
      kind: "packages",
      paths: ["packages/runner", "packages/engine"],
    });
  });
  test("--changed, with and without a ref", () => {
    expect(parseArgs(["--changed"], KNOWN)).toEqual({ kind: "changed", ref: undefined });
    expect(parseArgs(["--changed=abc"], KNOWN)).toEqual({ kind: "changed", ref: "abc" });
  });
  test("an unknown package or flag, an empty ref, or --changed with packages is refused", () => {
    expect(() => parseArgs(["nope"], KNOWN)).toThrow(VerifyArgsError);
    expect(() => parseArgs(["--watch"], KNOWN)).toThrow(VerifyArgsError);
    expect(() => parseArgs(["--changed="], KNOWN)).toThrow(VerifyArgsError);
    expect(() => parseArgs(["--changed", "runner"], KNOWN)).toThrow(VerifyArgsError);
  });
});

describe("A3 a partial verify is refused under CI, a full one is not", () => {
  for (const env of [{ CI: "true" }, { GITHUB_ACTIONS: "true" }]) {
    const name = Object.keys(env).join("");
    test(`under ${name}`, () => {
      expect(() => parseArgs(["--changed"], KNOWN, env)).toThrow(name);
      expect(() => parseArgs(["runner"], KNOWN, env)).toThrow(VerifyArgsError);
      expect(parseArgs([], KNOWN, env)).toEqual({ kind: "full" });
    });
  }
  test("the snapshot opt-out is refused under CI, and allowed outside it", () => {
    expect(() => parseArgs([], KNOWN, { CI: "1", LETHAL_TEST_ALLOW_SNAPSHOT_CREATE: "1" })).toThrow(
      "LETHAL_TEST_ALLOW_SNAPSHOT_CREATE",
    );
    expect(parseArgs([], KNOWN, { LETHAL_TEST_ALLOW_SNAPSHOT_CREATE: "1" })).toEqual({
      kind: "full",
    });
  });
});

describe("A4 P and the test command", () => {
  test("precedence: explicit beats CI, CI beats the cores rule", () => {
    expect(parallelism({ CI: "true" }, 32).p).toBe(1);
    expect(parallelism({ GITHUB_ACTIONS: "true" }, 32).p).toBe(1);
    expect(parallelism({ CI: "true", LETHAL_VERIFY_PARALLEL: "4" }, 32).p).toBe(4);
    expect(parallelism({}, 32).p).toBe(8);
    expect(parallelism({}, 64).p).toBe(8);
    expect(parallelism({}, 16).p).toBe(4);
    expect(parallelism({}, 4).p).toBe(1);
    expect(parallelism({}, 2).p).toBe(1);
    expect(() => parallelism({ LETHAL_VERIFY_PARALLEL: "0" }, 32)).toThrow(VerifyArgsError);
    expect(() => parallelism({ LETHAL_VERIFY_PARALLEL: "x" }, 32)).toThrow(VerifyArgsError);
  });
  test("full: --parallel=P, no path, no --changed; P=1 is a plain serial run", () => {
    const full = testCommand({ kind: "full" }, 8, undefined, "/j.xml");
    // R622 review I3: the running bun itself, never a `bun` shim whose pid the watchdog cannot match.
    expect(full.slice(0, 3)).toEqual([process.execPath, "test", "--parallel=8"]);
    expect(full.filter((a) => !a.startsWith("--"))).toEqual([process.execPath, "test"]);
    expect(full).toContain("--reporter-outfile=/j.xml");
    const serial = testCommand({ kind: "full" }, 1, undefined, "/j.xml");
    expect(serial.some((a) => a.startsWith("--parallel"))).toBe(false);
  });
  test("--changed: exactly one --changed=<sha>; packages: their paths", () => {
    const c = testCommand({ kind: "changed", ref: undefined }, 8, "abc123", "/j.xml");
    expect(c.filter((a) => a.startsWith("--changed"))).toEqual(["--changed=abc123"]);
    const p = testCommand({ kind: "packages", paths: ["packages/runner"] }, 8, undefined, "/j.xml");
    expect(p).toContain("packages/runner");
    expect(p.some((a) => a.startsWith("--changed"))).toBe(false);
  });
});

describe("A2 a partial run never reads as full, over EVERY line it prints", () => {
  const OUT = " 3 pass\n 0 skip\n 0 fail\nRan 3 tests across 2 files. [1.00s]\n";
  const JUNIT =
    '<testcase name="a" classname="" file="x.test.ts" /><testcase name="b" classname="" file="y.test.ts" />';
  function io(env: Env = {}): VerifyIo {
    let t = 0;
    return {
      packages: KNOWN,
      cores: 32,
      env,
      exec: (cmd) => ({ code: 0, output: cmd[1] === "test" ? OUT : "" }),
      git: (args) => (args[0] === "merge-base" ? "base123\n" : "sha456\n"),
      snapState: () => new Map(),
      log: () => "log",
      junitPath: () => "/j.xml",
      readJunit: () => JUNIT,
      expectedTestFiles: () => ["x.test.ts", "y.test.ts"],
      cleanDist: () => [],
      now: () => {
        t += 1000;
        return t;
      },
      print: () => {},
    };
  }
  for (const argv of [["--changed"], ["--changed=abc"], ["runner"], ["runner", "engine"]]) {
    test(`partial: ${argv.join(" ")}`, async () => {
      const r = await runVerify(argv, io());
      const all = r.lines.join("\n");
      expect(all).not.toContain("test (all)");
      expect(all).not.toContain("VERIFY FULL");
      expect(r.lines[0]).toContain("PARTIAL");
      expect(r.lines[0]).toContain("NOT a submit");
      expect(r.lines.at(-1)).toContain("VERIFY PARTIAL: PASS, exit 4");
      expect(r.lines.at(-1)).toContain("before submit");
    });
  }
  // Orchestrator amendment: `verify && git push` must not push on a subset.
  test("exit codes: an all-pass PARTIAL run exits 4, a failing one 1, an all-pass FULL run 0", async () => {
    for (const argv of [["--changed"], ["--changed=abc"], ["runner"], ["runner", "engine"]]) {
      expect((await runVerify(argv, io())).code, argv.join(" ")).toBe(4);
      const failing = {
        ...io(),
        exec: (cmd: string[]) =>
          cmd[1] === "test" ? { code: 1, output: " 2 pass\n 1 fail\n" } : { code: 0, output: "" },
      };
      expect((await runVerify(argv, failing)).code, `${argv.join(" ")} failing`).toBe(1);
    }
    expect((await runVerify([], io())).code).toBe(0);
  });
  test("--changed names the resolved sha and the blind spot", async () => {
    const all = (await runVerify(["--changed"], io())).lines.join("\n");
    expect(all).toContain("test (changed since sha456)");
    expect(all).toContain("blind spot");
  });
  test("full: test (all) and VERIFY FULL, the file-set check, and the P used", async () => {
    const r = await runVerify([], io());
    const all = r.lines.join("\n");
    expect(all).toContain("test (all)");
    expect(r.lines[0]).toContain("FULL");
    expect(r.lines[0]).toContain("--parallel=8");
    expect(all).toContain("file-set check: ok");
    expect(r.lines.at(-1)).toMatch(/^VERIFY FULL: PASS \(3 pass \/ 0 skip \/ 0 fail\)/);
  });
  test("full with the snapshot opt-out says so in the receipt", async () => {
    const r = await runVerify([], io({ LETHAL_TEST_ALLOW_SNAPSHOT_CREATE: "1" }));
    expect(r.lines.at(-1)).toContain("VERIFY FULL: PASS");
    expect(r.lines.at(-1)).toContain("(snapshot guard OFF)");
  });
  test("full fails when bun ran fewer files than discovery finds, naming the missing one", async () => {
    const base = io();
    const r = await runVerify([], {
      ...base,
      expectedTestFiles: () => ["x.test.ts", "y.test.ts", "z.test.ts"],
    });
    expect(r.code).toBe(1);
    const all = r.lines.join("\n");
    expect(all).toContain("bun ran 2 files, discovery finds 3");
    expect(all).toContain("    z.test.ts");
    expect(r.lines.at(-1)).toContain("VERIFY FULL: FAIL");
  });
});

describe("parseTestSummary", () => {
  test("reads counts, the file count and failing test names", () => {
    const out = [
      "bun test v1.3.14",
      "(pass) a > works [0.10ms]",
      "(fail) store > latest run is the max id [1.23ms]",
      "(fail) report-diff > refuses duplicates",
      "",
      " 40 pass",
      " 2 skip",
      " 2 fail",
      " 99 expect() calls",
      "Ran 44 tests across 3 files. [1.00s]",
    ].join("\r\n");
    expect(parseTestSummary(out)).toEqual({
      pass: 40,
      skip: 2,
      fail: 2,
      todo: 0,
      failing: ["store > latest run is the max id", "report-diff > refuses duplicates"],
      files: 3,
    });
  });
  test("a fail line repeated in the closing recap is listed once", () => {
    const out = "(fail) x [1ms]\n\n1 tests failed:\n(fail) x [1ms]\n 0 pass\n 1 fail\n";
    expect(parseTestSummary(out)?.failing).toEqual(["x"]);
  });
  test("output with no summary is null, never a zero-count pass", () => {
    expect(parseTestSummary("error: Cannot find module './nope'\n")).toBeNull();
    expect(parseTestSummary("")).toBeNull();
  });
  test("A6 a crashed worker is named, though its passes are lost from the count", async () => {
    // bun 1.4.2's real output: c.test.ts had passed k1 before its worker was SIGKILLed.
    const out = [
      "bun test v1.4.2 (744846f84) 2x PARALLEL",
      "",
      "c.test.ts:",
      "✗ c.test.ts (worker crashed: SIGKILL)",
      "",
      " 1 pass",
      " 1 skip",
      " 1 todo",
      " 1 fail",
      " 1 expect() calls",
      "Ran 4 tests across 2 files. [9.00ms]",
    ].join("\n");
    const s = parseTestSummary(out);
    expect(s?.failing).toEqual(["c.test.ts (worker crashed: SIGKILL)"]);
    expect(s?.files).toBe(2);
    const step = await testStep(FULL, {
      exec: () => ({ code: 0, output: out }),
      snapState: () => new Map(),
      env: {},
      log: () => "log",
      junitPath: () => "/j.xml",
      readJunit: () => "",
      expectedTestFiles: () => ["a.test.ts", "c.test.ts"],
    });
    expect(step.code).toBe(1);
    expect(step.lines).toContain("  (fail) c.test.ts (worker crashed: SIGKILL)");
  });
  test("bun exiting non-zero with `0 fail` and no crash line still fails (the exit-code backstop)", async () => {
    const step = await testStep(FULL, {
      exec: () => ({ code: 1, output: " 3 pass\n 0 fail\nRan 3 tests across 2 files. [1.00s]\n" }),
      snapState: () => new Map(),
      env: {},
      log: () => "log",
      junitPath: () => "/j.xml",
      readJunit: () => "",
      expectedTestFiles: () => ["a.test.ts", "b.test.ts"],
    });
    expect(step.code).toBe(1);
    expect(step.lines.join("\n")).toContain("test (all): FAIL");
  });
});

describe("parseJunit and completeness", () => {
  test("cases with file, classname, name and status, entities decoded", () => {
    const xml = [
      '<testsuite name="a.test.ts" file="a.test.ts">',
      '<testcase name="x &amp; &lt;y&gt;" classname="E &gt; D" file="a.test.ts" line="2" />',
      '<testcase name="s" classname="" file="a.test.ts"><skipped /></testcase>',
      '<testcase name="t" classname="" file="a.test.ts"><skipped message="TODO" /></testcase>',
      '<testcase name="f" classname="" file="b.test.ts"><failure type="E" message="m">x</failure></testcase>',
      "</testsuite>",
    ].join("\n");
    expect(parseJunit(xml)).toEqual([
      { file: "a.test.ts", classname: "E > D", name: "x & <y>", status: "pass" },
      { file: "a.test.ts", classname: "", name: "s", status: "skip" },
      { file: "a.test.ts", classname: "", name: "t", status: "todo" },
      { file: "b.test.ts", classname: "", name: "f", status: "fail" },
    ]);
  });
  test("completeness is silent on equal counts and names both directions otherwise", () => {
    expect(completeness(["a", "b"], 2, ["a"])).toEqual([]);
    const gap = completeness(["a", "b"], 3, ["a", "c"]).join("\n");
    expect(gap).toContain("bun ran 3 files, discovery finds 2");
    expect(gap).toContain("    b");
    expect(gap).toContain("    c");
    expect(completeness(["a"], undefined, []).join("\n")).toContain("unknown number");
  });
});

describe("R393 snapshot guards", () => {
  const OK_OUT = " 3 pass\n 0 fail\n";
  function io(over: {
    states?: SnapState[];
    env?: Record<string, string | undefined>;
    seen?: Array<Record<string, string | undefined>>;
  }): TestStepIo {
    const states = over.states ?? [new Map(), new Map()];
    let i = 0;
    return {
      exec: (_cmd, env) => {
        over.seen?.push(env);
        return { code: 0, output: OK_OUT };
      },
      snapState: () => states[Math.min(i++, states.length - 1)] ?? new Map(),
      env: over.env ?? {},
      log: () => "log",
      junitPath: () => "/j.xml",
      readJunit: () => "",
      expectedTestFiles: () => [],
    };
  }
  const PART = { mode: { kind: "packages", paths: ["packages/runner"] }, p: 1 } as const;

  test("(i) the test child gets CI=true, and not when the opt-out is set", async () => {
    const seen: Array<Record<string, string | undefined>> = [];
    const on = await testStep(PART, io({ seen, env: { PATH: "p" } }));
    expect(seen[0]?.CI).toBe("true");
    expect(seen[0]?.PATH).toBe("p");
    expect(on.code).toBe(0);
    expect(on.lines[0]).toContain("CI=true");

    const off = await testStep(PART, io({ seen, env: { LETHAL_TEST_ALLOW_SNAPSHOT_CREATE: "1" } }));
    expect(seen[1]?.CI).toBeUndefined();
    expect(off.lines[0]).toContain("OFF");

    // An inherited CI must not survive the opt-out, or "OFF" would be a lie (review r1 nit).
    await testStep(PART, io({ seen, env: { CI: "true", LETHAL_TEST_ALLOW_SNAPSHOT_CREATE: "1" } }));
    expect(seen[2]?.CI).toBeUndefined();
  });

  test("(ii) the belt fails for a staged, an unstaged and a new .snap changed during the run", async () => {
    const before = parseSnapState(" M a.snap\n", () => "h1");
    const staged = parseSnapState(" M a.snap\nM  b.snap\n", () => "h2");
    const r = await testStep(PART, io({ states: [new Map(), staged] }));
    expect(r.code).toBe(1);
    expect(r.lines.join("\n")).toContain("b.snap");
    for (const status of ["M  ", " M ", "?? "]) {
      const after = parseSnapState(`${status}x.snap\n`, () => "h");
      const res = await testStep(PART, io({ states: [new Map(), after] }));
      expect(res.code).toBe(1);
      expect(res.lines.join("\n")).toContain("x.snap");
      expect(res.lines.join("\n")).toContain("--update-snapshots");
    }
    expect(snapChanges(before, before)).toEqual([]);
  });

  test("(ii) a .snap already dirty before the run is not blamed, unless the run changed it", async () => {
    const dirty = parseSnapState(" M a.snap\n", () => "h1");
    expect((await testStep(PART, io({ states: [dirty, dirty] }))).code).toBe(0);
    const edited = parseSnapState(" M a.snap\n", () => "h2");
    const r = await testStep(PART, io({ states: [dirty, edited] }));
    expect(r.code).toBe(1);
    expect(r.lines.join("\n")).toContain("a.snap");
  });
});

function bunTest(cwd: string, args: string[], env: Env): { code: number; out: string } {
  const r = Bun.spawnSync([process.execPath, "test", ...args], {
    cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: r.exitCode ?? 1, out: `${r.stdout.toString()}${r.stderr.toString()}` };
}

// CI is serial (P=1) on every OS and Windows `bun test --parallel` is unmeasured (R593 follow-up), so
// the two --parallel spawn tests run where verify.ts runs parallel: Linux and macOS.
const parallelOs = test.skipIf(process.platform === "win32");
// On Windows Bun's `process.kill(pid, "SIGTERM")` is libuv's TerminateProcess, which no handler can
// catch, so a file deaf to SIGTERM cannot exist there: the SIGKILL step has nothing to escalate.
const posixSignals = test.skipIf(process.platform === "win32");

describe("spawned bun test (the guards hold inside --parallel workers)", () => {
  parallelOs("A5 a missing snapshot is refused serial AND --parallel=2 under testChildEnv", () => {
    const dir = tempDir("a5");
    try {
      writeFileSync(
        join(dir, "s.test.ts"),
        'import { expect, test } from "bun:test";\ntest("snap", () => expect({ a: 1 }).toMatchSnapshot());\n',
      );
      // No inherited CI, so only testChildEnv can supply it.
      const {
        CI: _c,
        GITHUB_ACTIONS: _g,
        LETHAL_TEST_ALLOW_SNAPSHOT_CREATE: _o,
        ...base
      } = process.env;
      for (const args of [[], ["--parallel=2"]]) {
        rmSync(join(dir, "__snapshots__"), { recursive: true, force: true });
        const r = bunTest(dir, args, testChildEnv(base));
        expect(r.out, `args ${args.join(" ")}`).toContain("Snapshot creation is disabled in CI");
        expect(r.code).not.toBe(0);
        // bun may leave a header-only .snap. It is untracked, so verify's belt fails on it in the
        // repo; what must never appear is an `exports[` entry, i.e. a snapshot actually written.
        const snap = join(dir, "__snapshots__", "s.test.ts.snap");
        const text = existsSync(snap) ? readFileSync(snap, "utf8") : "";
        expect(text, `args ${args.join(" ")}`).not.toContain("exports[");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  parallelOs(
    "A7 R264: under --parallel=2 the preload moves HOME and TMPDIR in EVERY worker",
    () => {
      const root = tempDir("a7");
      try {
        const S = join(root, "sentinel-home");
        const T = join(root, "sentinel-tmp");
        const proj = join(root, "proj");
        for (const d of [S, T, proj]) mkdirSync(d);
        const env = sentinelEnv(process.env, S, T);
        expect(Object.keys(env).filter((k) => k.startsWith("LETHAL_TEST_"))).toEqual([]);
        const preload = JSON.stringify(join(REPO_ROOT, "scripts", "test-preload.ts"));
        const homeTs = JSON.stringify(join(REPO_ROOT, "packages", "runner", "src", "home.ts"));
        // On POSIX bun's os.homedir() keeps the HOME the process started with (R409), so product
        // code reads `homeDir()`; os.homedir() is asserted on Windows only (as real-home-guard does).
        const body = [
          'import { expect, test } from "bun:test";',
          'import { homedir } from "node:os";',
          `import { homeDir } from ${homeTs};`,
          `const S = ${JSON.stringify(S)};`,
          `const T = ${JSON.stringify(T)};`,
          'test("home and tmp are the preload\'s", () => {',
          "  expect(process.env.HOME).not.toBe(S);",
          "  expect(homeDir()).not.toBe(S);",
          '  if (process.platform === "win32") expect(homedir()).not.toBe(S);',
          "  expect(process.env.USERPROFILE).not.toBe(S);",
          "  expect(process.env.TMPDIR).not.toBe(T);",
          "  expect(process.env.LETHAL_TEST_REAL_HOME).toBe(S);",
          "});",
          "",
        ].join("\n");
        const files = ["a.test.ts", "b.test.ts", "c.test.ts"];
        for (const f of files) writeFileSync(join(proj, f), body);
        const run = (bunfig: string): Map<string, string> => {
          writeFileSync(join(proj, "bunfig.toml"), bunfig);
          const xml = join(root, "out.xml");
          rmSync(xml, { force: true });
          const r = bunTest(
            proj,
            ["--parallel=2", "--reporter=junit", `--reporter-outfile=${xml}`],
            env,
          );
          const cases = existsSync(xml) ? parseJunit(readFileSync(xml, "utf8")) : [];
          expect(cases.length, r.out).toBe(3);
          return new Map(cases.map((c) => [c.file, c.status]));
        };
        const withPreload = run(`[test]\npreload = [${preload}]\n`);
        for (const f of files) expect(withPreload.get(f), `${f} with the preload`).toBe("pass");
        // The control: without the preload, each of the three fails BY NAME, so the check can go red.
        const without = run("[test]\n");
        for (const f of files) expect(without.get(f), `${f} without the preload`).toBe("fail");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  test("A8 discoverTestFiles matches what a real bun test runs", () => {
    const dir = tempDir("a8");
    try {
      const one = 'import { test } from "bun:test";\ntest("t", () => {});\n';
      mkdirSync(join(dir, "build"));
      mkdirSync(join(dir, ".hidden"));
      writeFileSync(join(dir, ".gitignore"), "build/\n");
      writeFileSync(join(dir, "x.spec.ts"), one);
      writeFileSync(join(dir, "build", "y.test.ts"), one);
      writeFileSync(join(dir, ".hidden", "z.test.ts"), one);
      writeFileSync(join(dir, "zero.test.ts"), "export {};\n");
      writeFileSync(join(dir, "helper.ts"), one);
      const expected = discoverTestFiles(dir);
      expect(expected).toEqual(["build/y.test.ts", "x.spec.ts", "zero.test.ts"]);
      const r = bunTest(dir, [], process.env);
      expect(parseTestSummary(r.out)?.files, r.out).toBe(expected.length);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("R622 the per-file watchdog", () => {
  const beat = (pid: number, ppid: number, start: number): Heartbeat => ({
    pid,
    ppid,
    start,
    file: `/p/f${pid}.test.ts`,
  });
  // The bun test child is pid 10, verify itself pid 1; the limit is 2 s and "now" is 5 s.
  test("stuckWorkers: an old heartbeat of a worker of the bun test child is stuck", () => {
    expect(stuckWorkers([beat(11, 10, 0)], 5000, 2000, 10, 1)).toEqual([beat(11, 10, 0)]);
  });
  test("stuckWorkers: a fresh heartbeat is not", () => {
    expect(stuckWorkers([beat(11, 10, 4000)], 5000, 2000, 10, 1)).toEqual([]);
  });
  test("stuckWorkers: a heartbeat whose parent is another process is not", () => {
    expect(stuckWorkers([beat(11, 99, 0)], 5000, 2000, 10, 1)).toEqual([]);
  });
  test("stuckWorkers: serial, the child's own heartbeat is stuck, and only with verify as its parent", () => {
    expect(stuckWorkers([beat(10, 1, 0)], 5000, 2000, 10, 1)).toEqual([beat(10, 1, 0)]);
    expect(stuckWorkers([beat(10, 99, 0)], 5000, 2000, 10, 1)).toEqual([]);
  });

  test("isChildOf: a live child of this process is one; this process and a dead child are not", async () => {
    const child = Bun.spawn([process.execPath, "-e", "setTimeout(() => {}, 30000)"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    try {
      expect(isChildOf(child.pid, process.pid)).toBe(true);
      // The direction that keeps the kill off a process verify did not start (a reused pid).
      expect(isChildOf(process.pid, process.pid)).toBe(false);
      expect(isChildOf(child.pid, child.pid)).toBe(false);
    } finally {
      child.kill();
      await child.exited;
    }
    expect(isChildOf(child.pid, process.pid)).toBe(false);
  }, 30_000); // three PowerShell calls on Windows, 1 to 3 s each when cold

  const OK = 'import { test } from "bun:test";\ntest("ok", () => {});\n';
  // Synchronous, so bun's per-test timeout cannot fire; it ends ITSELF after 25 s, so a broken
  // watchdog costs 25 s, never a hang.
  const SPIN =
    'import { test } from "bun:test";\ntest("spins", () => {\n  const end = Date.now() + 25_000;\n  while (Date.now() < end) {}\n}, 60_000);\n';
  // The same, deaf to SIGTERM (review I-A): only the SIGKILL step can stop it before 25 s.
  const STUBBORN = `process.on("SIGTERM", () => {});\n${SPIN}`;
  // About 20 MB on stdout, far more than an OS pipe holds. On Bun 1.4.2 this cannot go red for
  // review I1's reason (reading only after exit): bun buffers an unread pipe itself (measured, see
  // execWatched). It still pins that a big run is captured whole, and not killed.
  const LOUD =
    'import { test } from "bun:test";\ntest("loud", () => {\n  const line = "x".repeat(1023);\n  for (let i = 0; i < 20_000; i++) console.log(line);\n});\n';

  /**
   * The verify test step, watched, on a scratch project that preloads the repo's preload (which
   * writes the heartbeats). Review I2: the inner run gets its own home and temp folder, removed
   * after, so a killed worker's `lethal-unit-run-*` folder cannot land in this run's temp folder.
   */
  async function watched(
    files: Record<string, string>,
    p: number,
    limitS: number,
    opts: Omit<WatchOptions, "print"> = {},
    extraEnv: Env = {},
  ): Promise<{
    code: number;
    text: string;
    seconds: number;
    output: string;
    junit: string;
    printed: Array<{ line: string; childAlive: boolean | undefined }>;
    testDbs: readonly TestDbReport[] | undefined;
  }> {
    const root = tempDir("r622");
    const printed: Array<{ line: string; childAlive: boolean | undefined }> = [];
    // Whether the serial child named in a line is still alive when the line is printed: true
    // proves the line came out while the run was still going, not after it ended.
    const print = (line: string): void => {
      const pid = /the bun test process (\d+)/.exec(line)?.[1];
      printed.push({
        line,
        childAlive: pid === undefined ? undefined : isChildOf(Number(pid), process.pid),
      });
    };
    try {
      const proj = join(root, "proj");
      const home = join(root, "home");
      const tmp = join(root, "tmp");
      for (const d of [proj, home, tmp]) mkdirSync(d);
      const preload = JSON.stringify(join(REPO_ROOT, "scripts", "test-preload.ts"));
      writeFileSync(join(proj, "bunfig.toml"), `[test]\npreload = [${preload}]\n`);
      for (const [name, body] of Object.entries(files)) writeFileSync(join(proj, name), body);
      const junitPath = join(root, "junit.xml");
      let output = "";
      let testDbs: readonly TestDbReport[] | undefined;
      const t0 = Date.now();
      const step = await testStep(
        { mode: { kind: "packages", paths: [] }, p },
        {
          exec: async (cmd, env) => {
            const r = await execWatched(cmd, env, proj, limitS, { ...opts, print });
            output = r.output;
            testDbs = r.testDbs;
            return r;
          },
          snapState: () => new Map(),
          env: { ...sentinelEnv(process.env, home, tmp), ...extraEnv },
          log: () => "log",
          junitPath: () => junitPath,
          readJunit: () => "",
          expectedTestFiles: () => [],
        },
      );
      const seconds = (Date.now() - t0) / 1000;
      const junit = existsSync(junitPath) ? readFileSync(junitPath, "utf8") : "";
      return {
        code: step.code,
        text: step.lines.join("\n"),
        seconds,
        output,
        junit,
        printed,
        testDbs,
      };
    } finally {
      // EBUSY on Windows while a just-killed process still holds a handle: retry, cleanup only.
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  }

  // The file's FAIL line, matched with or without a leading directory: on Windows, bun's path
  // for the file and the temp folder's short (8.3) path may not make a clean relative path.
  const failLines = (text: string, file: string, limitS: number): number =>
    text.match(
      new RegExp(
        `^watchdog: FAIL, (?:.*[\\\\/])?${file.replaceAll(".", "\\.")} ran over ${limitS} s`,
        "gm",
      ),
    )?.length ?? 0;

  // Skipped on Windows for the same reason as A5 and A7 above: Windows `bun test --parallel` is
  // unmeasured. The serial watchdog tests below run there.
  parallelOs(
    "--parallel=2: a file that spins past the limit fails the run in seconds, named once; the other file passes",
    async () => {
      const r = await watched({ "ok.test.ts": OK, "spin.test.ts": SPIN }, 2, 2);
      expect(r.code, r.text).toBe(1);
      expect(failLines(r.text, "spin.test.ts", 2), r.text).toBe(1);
      expect(r.text).not.toContain("ok.test.ts ran over");
      expect(r.seconds, r.text).toBeLessThan(15);
      const ok = parseJunit(r.junit).find((c) => c.file.endsWith("ok.test.ts"));
      expect(ok?.status, r.output).toBe("pass");
    },
    40_000,
  );

  test("serial: a file that spins past the limit stops the run in seconds, named once", async () => {
    const r = await watched({ "ok.test.ts": OK, "spin.test.ts": SPIN }, 1, 2);
    expect(r.code, r.text).toBe(1);
    expect(failLines(r.text, "spin.test.ts", 2), r.text).toBe(1);
    expect(r.seconds, r.text).toBeLessThan(15);
  }, 40_000);

  posixSignals(
    "review I-A: a file deaf to SIGTERM is SIGKILLed after the grace; the FAIL line is printed while it still runs",
    async () => {
      const r = await watched({ "spin.test.ts": STUBBORN }, 1, 2, { graceMs: 2000 });
      expect(r.code, r.text).toBe(1);
      expect(failLines(r.text, "spin.test.ts", 2), r.text).toBe(1);
      // limit 2 s + up to 1 s to notice + 2 s grace + margin, well under the 25 s spin.
      expect(r.seconds, r.text).toBeLessThan(15);
      // The SIGKILL step stopped it, not the backstop (which would also end a serial run).
      expect(r.text).toContain("outlived SIGTERM by 2000 ms; sent SIGKILL");
      expect(r.text).not.toContain("watchdog: backstop");
      const first = r.printed[0];
      expect(failLines(first?.line ?? "", "spin.test.ts", 2), JSON.stringify(r.printed)).toBe(1);
      expect(first?.childAlive, JSON.stringify(r.printed)).toBe(true);
    },
    40_000,
  );

  test("review I-A: a worker that cannot be confirmed as ours stops the whole run through the backstop", async () => {
    const r = await watched({ "spin.test.ts": SPIN }, 1, 2, { isChild: () => false });
    expect(r.code, r.text).toBe(1);
    expect(failLines(r.text, "spin.test.ts", 2), r.text).toBe(1);
    expect(r.text).toContain("watchdog: backstop");
    expect(r.seconds, r.text).toBeLessThan(15);
  }, 40_000);

  parallelOs(
    "review I-A: --parallel=2, the backstop ends the run though the unconfirmed worker may live on",
    async () => {
      const r = await watched({ "ok.test.ts": OK, "spin.test.ts": SPIN }, 2, 2, {
        isChild: () => false,
        graceMs: 1000,
      });
      expect(r.code, r.text).toBe(1);
      expect(failLines(r.text, "spin.test.ts", 2), r.text).toBe(1);
      expect(r.text).toContain("watchdog: backstop");
      expect(r.seconds, r.text).toBeLessThan(15);
    },
    40_000,
  );

  test("review I1: a file that prints 20 MB is drained while it runs, so it is neither killed nor hung", async () => {
    const r = await watched({ "loud.test.ts": LOUD }, 1, 3);
    expect(r.code, r.text).toBe(0);
    expect(r.text).toContain("watchdog: ok");
    expect(r.output.length).toBeGreaterThan(20_000_000);
  }, 40_000);

  // R616: the real preload in a child run reports where its DBs went, and removes its tmpfs folder.
  const SHM = process.platform === "linux" && existsSync("/dev/shm");
  test.skipIf(!SHM)(
    "R616: a child run on Linux puts its DBs on /dev/shm, says so, and leaves no folder there",
    async () => {
      const r = await watched({ "ok.test.ts": OK }, 1, 30);
      expect(r.code, r.text).toBe(0);
      expect(r.text).toContain("test DBs: /dev/shm (tmpfs) in all 1 worker");
      const pid = r.testDbs?.[0]?.pid;
      expect(pid, r.text).toBeDefined();
      const left = readdirSync("/dev/shm").filter((e) => e.startsWith(`lethal-unit-db-${pid}-`));
      expect(left).toEqual([]);
    },
    40_000,
  );
  test("R616: with LETHAL_TEST_DB_ON_DISK=1 a child run's DBs stay on disk, named", async () => {
    const r = await watched({ "ok.test.ts": OK }, 1, 30, {}, { LETHAL_TEST_DB_ON_DISK: "1" });
    expect(r.code, r.text).toBe(0);
    expect(r.text).toContain(
      "test DBs: on disk (fallback: LETHAL_TEST_DB_ON_DISK=1) in all 1 worker",
    );
  }, 40_000);
});

describe("R616 where each worker's test DBs went", () => {
  const shm = { pid: 11, where: "/dev/shm (tmpfs)" };
  const disk = { pid: 12, where: "on disk (fallback: /dev/shm has 9 MB free (under 16))" };
  test("testDbsLine: all workers alike, mixed, and none", () => {
    expect(testDbsLine([shm, { ...shm, pid: 13 }])).toBe(
      "test DBs: /dev/shm (tmpfs) in all 2 workers",
    );
    expect(testDbsLine([shm, disk])).toBe(
      "test DBs: /dev/shm (tmpfs) in 1 of 2 workers; on disk (fallback: /dev/shm has 9 MB free (under 16)) in 1 of 2 workers",
    );
    expect(testDbsLine([])).toBe("test DBs: no worker reported where its DBs went");
  });
  test("testStep names each worker's own choice, not one made at the start", async () => {
    const step = await testStep(FULL, {
      exec: () => ({
        code: 0,
        output: " 1 pass\n 0 fail\nRan 1 test across 1 file.\n",
        testDbs: [shm, disk],
      }),
      snapState: () => new Map(),
      env: {},
      log: () => "log",
      junitPath: () => "/j.xml",
      readJunit: () => '<testcase name="a" classname="" file="x.test.ts" />',
      expectedTestFiles: () => ["x.test.ts"],
    });
    expect(step.lines).toContain(
      "test DBs: /dev/shm (tmpfs) in 1 of 2 workers; on disk (fallback: /dev/shm has 9 MB free (under 16)) in 1 of 2 workers",
    );
  });
  test("readTestDbReports keeps this run's workers (serial child, or children of the bun test process) and drops others", () => {
    const dir = tempDir("r616-dbs");
    try {
      // The bun test child is pid 10, verify itself pid 1.
      writeFileSync(join(dir, "11"), "10\t/dev/shm (tmpfs)");
      writeFileSync(join(dir, "10"), "1\ton disk (fallback: /dev/shm missing)");
      writeFileSync(join(dir, "12"), "11\t/dev/shm (tmpfs)"); // a nested bun test, started by a test
      writeFileSync(join(dir, "13"), "10"); // half-written
      const got = readTestDbReports(dir, 10, 1).sort((a, b) => a.pid - b.pid);
      expect(got).toEqual([
        { pid: 10, where: "on disk (fallback: /dev/shm missing)" },
        { pid: 11, where: "/dev/shm (tmpfs)" },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("R616 pressure stats", () => {
  const IO =
    "some avg10=1.50 avg60=2.00 avg300=3.25 total=100\nfull avg10=0.10 avg60=0.20 avg300=0.30 total=50\n";
  const CPU = "some avg10=0.25 avg60=0.50 avg300=0.75 total=10\n";
  test("both files read: avg10/avg60/avg300 of each line", () => {
    const read = (p: string): string => (p === "/proc/pressure/io" ? IO : CPU);
    expect(pressureText(read)).toBe(
      "io some 1.50/2.00/3.25 full 0.10/0.20/0.30; cpu some 0.25/0.50/0.75",
    );
  });
  test("an absent file is skipped and named; text that does not parse is named too", () => {
    const read = (p: string): string => {
      if (p === "/proc/pressure/io") throw new Error("ENOENT: no such file");
      return "garbage";
    };
    expect(pressureText(read)).toBe(
      "io skipped (cannot read /proc/pressure/io: ENOENT: no such file); cpu skipped (no avg10 line in /proc/pressure/cpu)",
    );
  });
});

describe("R622 the verify ledger", () => {
  const ME = 100;
  const DEAD = 200;
  const alive = (pid: number): boolean => pid !== DEAD;
  // Our run started at T and "now" is T + 60 s.
  const T = Date.parse("2026-10-22T05:33:00.000Z");
  const NOW = T + 60_000;
  const line = (event: "START" | "END", pid: number, start: number, end?: number): string =>
    ledgerLine(
      event,
      { pid, start, p: 8, scope: "full", worktree: `/work/w${pid}` },
      end !== undefined ? { end, ok: true, failed: 0 } : undefined,
    );
  const count = (text: string, until: number): number =>
    countOverlaps(parseLedger(text), { pid: ME, start: T }, until, NOW, alive);

  test("none: only our own START (our pid is never an other)", () => {
    const text = line("START", ME, T);
    expect(count(text, T)).toBe(0);
    expect(count(text, NOW)).toBe(0);
  });
  test("one running at start: a live pid's open START from before ours counts at START and by END", () => {
    const text = [line("START", 7, T - 5000), line("START", ME, T)].join("");
    expect(count(text, T)).toBe(1);
    expect(count(text, NOW)).toBe(1);
  });
  test("one that started and ended during our run counts by END only; one that ended before ours never", () => {
    const text = [
      line("START", ME, T),
      line("START", 8, T + 10_000),
      line("END", 8, T + 10_000, T + 20_000),
      line("START", 9, T - 30_000),
      line("END", 9, T - 30_000, T - 1000),
    ].join("");
    expect(count(text, T)).toBe(0);
    expect(count(text, NOW)).toBe(1);
  });
  test("a dead pid's open START is not counted, though recent", () => {
    const text = [line("START", DEAD, T - 1000), line("START", ME, T)].join("");
    expect(count(text, T)).toBe(0);
    expect(count(text, NOW)).toBe(0);
  });
  test("a live pid's open START past the stale bound is not counted (a reused pid)", () => {
    const text = line("START", 7, NOW - LEDGER_STALE_MS - 1);
    expect(count(text, T)).toBe(0);
    expect(count(text, NOW)).toBe(0);
  });
  test("corrupt lines are skipped and the good ones still read", () => {
    const text = [
      "garbage\n",
      "START\tnot-a-date\t-\t7\t8\t-\t-\tfull\t/w\n",
      "START\t2026-10-22T05:32:00.000Z\t-\tx\t8\t-\t-\tfull\t/w\n",
      "START\t2026-10-22T05:32:00.000Z\t-\t7\n",
      "\n",
      line("START", 7, T - 5000),
      "START\t2026-10-22T05:3", // a line cut short at the end of the file
    ].join("");
    expect(parseLedger(text)).toEqual([{ pid: 7, start: T - 5000, end: undefined }]);
    expect(count(text, T)).toBe(1);
  });
  test("pidAlive: this process is alive, a child that exited is not", async () => {
    expect(pidAlive(process.pid)).toBe(true);
    const child = Bun.spawn([process.execPath, "-e", "0"], { stdout: "ignore", stderr: "ignore" });
    await child.exited;
    expect(pidAlive(child.pid)).toBe(false);
  });

  test("an over-long worktree path is cut so the line stays one line, under LEDGER_LINE_MAX < PIPE_BUF", () => {
    expect(LEDGER_LINE_MAX).toBeLessThan(4096);
    for (const worktree of ["/w/".repeat(5000), "é".repeat(5000), "😀".repeat(3000), "/a\tb\nc"]) {
      const l = ledgerLine(
        "END",
        { pid: 7, start: T, p: 8, scope: "full", worktree },
        { end: NOW, ok: false, failed: 9 },
      );
      expect(Buffer.byteLength(l)).toBeLessThanOrEqual(LEDGER_LINE_MAX);
      expect(l.endsWith("\n")).toBe(true);
      expect(l.slice(0, -1)).not.toContain("\n");
      expect(l.split("\t")).toHaveLength(10);
      expect(parseLedger(l)).toEqual([{ pid: 7, start: T, end: NOW }]);
    }
  });

  test("R616: a 9-column line from a verify before the pressure column still parses, beside a 10-column one", () => {
    const nine = `START\t${new Date(T - 5000).toISOString()}\t-\t7\t8\t-\t-\tfull\t/work/old\n`;
    const ten = ledgerLine(
      "START",
      { pid: 8, start: T - 4000, p: 8, scope: "full", worktree: "/work/new" },
      undefined,
      "io some 1.00/2.00/3.00 full 0.50/0.60/0.70; cpu some 0.10/0.20/0.30",
    );
    expect(ten.split("\t")).toHaveLength(10);
    expect(parseLedger(nine + ten)).toEqual([
      { pid: 7, start: T - 5000, end: undefined },
      { pid: 8, start: T - 4000, end: undefined },
    ]);
    // An 11-column line is not one of ours: skipped.
    expect(parseLedger(`${ten.slice(0, -1)}\textra\n`)).toEqual([]);
  });

  function io(
    ledger: LedgerIo,
    testOut = " 3 pass\n 0 fail\nRan 3 tests across 2 files.\n",
  ): VerifyIo {
    let t = T;
    let reads = 0;
    return {
      pressure: () => `P${++reads}`,
      packages: KNOWN,
      cores: 32,
      env: {},
      exec: (cmd) =>
        cmd[1] === "test"
          ? { code: testOut.includes(" 0 fail") ? 0 : 1, output: testOut }
          : { code: 0, output: "" },
      git: () => "",
      snapState: () => new Map(),
      log: () => "log",
      junitPath: () => "/j.xml",
      readJunit: () =>
        '<testcase name="a" classname="" file="x.test.ts" /><testcase name="b" classname="" file="y.test.ts" />',
      expectedTestFiles: () => ["x.test.ts", "y.test.ts"],
      cleanDist: () => [],
      now: () => {
        t += 1000;
        return t;
      },
      print: () => {},
      ledger,
    };
  }

  test("a verify appends a START line and an END line, with the columns in order", async () => {
    const dir = tempDir("ledger");
    try {
      const path = join(dir, "ledger.tsv");
      // Another verify, still running, was in the ledger before us.
      writeFileSync(path, line("START", 7, T - 5000));
      const ledger = { path, worktree: "/work/me", pid: ME, alive };
      const r = await runVerify([], io(ledger));
      expect(r.code).toBe(0);
      const rows = readFileSync(path, "utf8")
        .split("\n")
        .slice(1, -1)
        .map((l) => l.split("\t"));
      const start = new Date(T + 1000).toISOString();
      // R616: the 10th column is the pressure read at that moment (P1 at start, P2 at end).
      expect(rows[0]).toEqual([
        "START",
        start,
        "-",
        "100",
        "8",
        "-",
        "-",
        "full",
        "/work/me",
        "P1",
      ]);
      const end = rows[1];
      expect(end?.slice(0, 2)).toEqual(["END", start]);
      expect(Date.parse(end?.[2] ?? "")).toBeGreaterThan(T + 1000);
      expect(end?.slice(3)).toEqual(["100", "8", "pass", "0", "full", "/work/me", "P2"]);
      expect(r.lines).toContain(`ledger: 1 other verify running at start (${path})`);
      expect(r.lines).toContain("pressure at start: P1");
      expect(r.lines).toContain("pressure at end: P2");
      expect(r.lines.at(-2)).toBe(
        `ledger: 1 other verify running at start, 1 overlapped by end (${path})`,
      );
      expect(r.lines.at(-1)).toContain("VERIFY FULL: PASS");

      // A failing package run: scope `packages`, result fail, and the failed count.
      const f = await runVerify(["runner"], io(ledger, " 2 pass\n 3 fail\n"));
      expect(f.code).toBe(1);
      const last = readFileSync(path, "utf8").split("\n").at(-2)?.split("\t");
      expect([last?.[0], ...(last?.slice(5, 8) ?? [])]).toEqual(["END", "fail", "3", "packages"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a missing directory or an unwritable ledger never fails a verify: one warning, then the run passes", async () => {
    const dir = tempDir("ledger");
    try {
      // A directory as the path is unwritable for every user, root included.
      for (const path of [join(dir, "no-such-dir", "ledger.tsv"), dir]) {
        const r = await runVerify([], io({ path, worktree: "/work/me", pid: ME, alive }));
        expect(r.code, path).toBe(0);
        const warns = r.lines.filter((l) => l.startsWith("ledger:"));
        expect(warns, path).toHaveLength(1);
        expect(warns[0]).toMatch(/^ledger: unavailable \(.+\); overlap not recorded$/);
        expect(r.lines.at(-1)).toContain("VERIFY FULL: PASS");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("atomicity: 20 processes appending at once write 20 x 50 whole lines, none interleaved", async () => {
    const dir = tempDir("ledger");
    try {
      const path = join(dir, "ledger.tsv");
      const verifyTs = JSON.stringify(join(REPO_ROOT, "scripts", "verify.ts"));
      const go = Date.now() + 1500; // every child waits for the same moment, then writes
      const script = (n: number): string =>
        [
          `const { ledgerAppend } = await import(${verifyTs});`,
          `while (Date.now() < ${go}) {}`,
          `for (let i = 0; i < 50; i++) ledgerAppend(${JSON.stringify(path)}, \`${n}\\t\${i}\\t\${"x".repeat(3000)}\\n\`);`,
        ].join("\n");
      const kids = Array.from({ length: 20 }, (_, n) =>
        Bun.spawn([process.execPath, "-e", script(n)], { stdout: "ignore", stderr: "pipe" }),
      );
      const codes = await Promise.all(kids.map((k) => k.exited));
      expect(codes.every((c) => c === 0)).toBe(true);
      const lines = readFileSync(path, "utf8").split("\n");
      expect(lines.pop()).toBe("");
      expect(lines).toHaveLength(1000);
      const bad = lines.filter((l) => !/^\d+\t\d+\tx{3000}$/.test(l));
      expect(bad.length, `${bad.length} lines not whole`).toBe(0);
      expect(new Set(lines.map((l) => l.split("\t").slice(0, 2).join(" "))).size).toBe(1000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  test("ledgerAppend throws on a bad path (the caller turns it into the warning)", () => {
    expect(() => ledgerAppend(join(tmpdir(), "no-such-dir-r622", "x.tsv"), "a\n")).toThrow();
  });
});

describe("R616b one full verify at a time (the slot lock)", () => {
  const ME = 100;
  const HOLDER = 7;
  type FakeProc = {
    on(sig: SlotSignal, fn: () => void): void;
    off(sig: SlotSignal, fn: () => void): void;
    exit(code: number): void;
    handlers: Map<SlotSignal, () => void>;
    exits: number[];
  };
  function fakeProc(): FakeProc {
    const handlers = new Map<SlotSignal, () => void>();
    const exits: number[] = [];
    return {
      handlers,
      exits,
      on: (sig, fn) => void handlers.set(sig, fn),
      off: (sig) => void handlers.delete(sig),
      exit: (code) => void exits.push(code),
    };
  }
  /** A fake clock: `sleep` moves it, and runs `onSleep(n)` (the nth poll) so a holder can leave. */
  function slotIo(
    dir: string,
    over: { alive?: (pid: number) => boolean; onSleep?: (n: number) => void; waitLimitS?: number },
  ): { io: SlotIo; printed: string[]; sleeps: number[]; proc: FakeProc } {
    const printed: string[] = [];
    const sleeps: number[] = [];
    const proc = fakeProc();
    let t = 0;
    const io: SlotIo = {
      path: join(dir, "verify-slot.lock"),
      pid: ME,
      worktree: "/work/me",
      alive: over.alive ?? (() => true),
      now: () => t,
      sleep: async (ms) => {
        sleeps.push(ms);
        t += ms;
        over.onSleep?.(sleeps.length);
      },
      print: (l) => void printed.push(l),
      proc,
      ...(over.waitLimitS !== undefined ? { waitLimitS: over.waitLimitS } : {}),
    };
    return { io, printed, sleeps, proc };
  }
  const holderText = (pid: number): string => `${pid}\t/work/other\t2026-10-23T00:00:00.000Z`;
  const lockPid = (path: string): string | undefined =>
    existsSync(path) ? readFileSync(path, "utf8").split("\t")[0] : undefined;

  test("the lock lives beside the ledger, never at a fixed /coord path", () => {
    expect(slotPath("/x/y/ledger.tsv")).toBe(join("/x/y", "verify-slot.lock"));
  });

  test("a free slot is taken at once, holds our pid, and is gone after release", async () => {
    const dir = tempDir("slot");
    try {
      const { io } = slotIo(dir, {});
      const slot = await acquireSlot(io);
      expect(slot.line).toBe("took");
      expect(lockPid(io.path)).toBe(String(ME));
      slot.release();
      expect(existsSync(io.path)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a second verify waits while a live holder exists, says so once, and goes when it releases", async () => {
    const dir = tempDir("slot");
    try {
      const path = join(dir, "verify-slot.lock");
      writeFileSync(path, holderText(HOLDER));
      const { io, printed, sleeps } = slotIo(dir, {
        onSleep: (n) => {
          if (n === 3) rmSync(path);
        },
      });
      const slot = await acquireSlot(io);
      expect(sleeps).toEqual([2000, 2000, 2000]);
      expect(printed).toEqual([`verify slot: waiting for pid ${HOLDER} (/work/other)`]);
      expect(slot.line).toBe("waited 6 s");
      expect(lockPid(path)).toBe(String(ME));
      slot.release();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a dead holder's lock is taken over at once and named", async () => {
    const dir = tempDir("slot");
    try {
      writeFileSync(join(dir, "verify-slot.lock"), holderText(HOLDER));
      const { io, sleeps } = slotIo(dir, { alive: (pid) => pid !== HOLDER });
      const slot = await acquireSlot(io);
      expect(sleeps).toEqual([]);
      expect(slot.line).toBe(`took a stale lock from pid ${HOLDER}`);
      expect(lockPid(io.path)).toBe(String(ME));
      slot.release();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("no age-based takeover: a live holder from long ago is still waited for", async () => {
    const dir = tempDir("slot");
    try {
      writeFileSync(
        join(dir, "verify-slot.lock"),
        `${HOLDER}\t/work/other\t2020-01-01T00:00:00.000Z`,
      );
      const { io } = slotIo(dir, { waitLimitS: 10 });
      await expect(acquireSlot(io)).rejects.toThrow(SlotTimeoutError);
      expect(lockPid(io.path)).toBe(String(HOLDER));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the wait limit fails by name and leaves the holder's lock alone", async () => {
    const dir = tempDir("slot");
    try {
      writeFileSync(join(dir, "verify-slot.lock"), holderText(HOLDER));
      const { io, sleeps } = slotIo(dir, { waitLimitS: 10 });
      const err = await acquireSlot(io).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SlotTimeoutError);
      expect((err as Error).message).toContain(`pid ${HOLDER}`);
      expect((err as Error).message).toContain("10 s");
      expect(sleeps.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(10_000);
      expect(lockPid(io.path)).toBe(String(HOLDER));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a signal releases the lock and exits with the signal's code; another pid's lock is left", async () => {
    for (const [sig, code] of [
      ["SIGINT", 130],
      ["SIGTERM", 143],
      ["SIGHUP", 129],
    ] as const) {
      const dir = tempDir("slot");
      try {
        const { io, proc } = slotIo(dir, {});
        await acquireSlot(io);
        expect([...proc.handlers.keys()].sort()).toEqual(["SIGHUP", "SIGINT", "SIGTERM"]);
        proc.handlers.get(sig)?.();
        expect(existsSync(io.path), sig).toBe(false);
        expect(proc.exits, sig).toEqual([code]);
        expect(proc.handlers.size, "handlers removed").toBe(0);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
    const dir = tempDir("slot");
    try {
      const { io, proc } = slotIo(dir, {});
      await acquireSlot(io);
      writeFileSync(io.path, holderText(HOLDER)); // someone took over after we were presumed dead
      proc.handlers.get("SIGINT")?.();
      expect(lockPid(io.path)).toBe(String(HOLDER));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function verifyIo(
    over: Partial<VerifyIo>,
    testResult = { code: 0, output: " 3 pass\n 0 fail\n" },
  ) {
    let t = 0;
    const execs: string[][] = [];
    const io: VerifyIo = {
      packages: KNOWN,
      cores: 32,
      env: {},
      exec: (cmd) => {
        execs.push(cmd);
        return cmd[1] === "test" ? testResult : { code: 0, output: "" };
      },
      git: () => "",
      snapState: () => new Map(),
      log: () => "log",
      junitPath: () => "/j.xml",
      readJunit: () => "",
      expectedTestFiles: () => [],
      cleanDist: () => [],
      now: () => {
        t += 1000;
        return t;
      },
      print: () => {},
      ...over,
    };
    return { io, execs };
  }

  test("runVerify: the slot is released after a failing test step and after a throwing one", async () => {
    const dir = tempDir("slot");
    try {
      const { io: slot } = slotIo(dir, {});
      const failing = verifyIo({ slot }, { code: 1, output: " 2 pass\n 1 fail\n" });
      const r = await runVerify(["runner"], failing.io);
      expect(r.code).toBe(1);
      expect(r.lines).toContain("verify slot: took");
      expect(existsSync(slot.path)).toBe(false);

      const throwing = verifyIo({
        slot,
        exec: (cmd) => {
          if (cmd[1] === "test") throw new Error("boom");
          return { code: 0, output: "" };
        },
      });
      await expect(runVerify(["runner"], throwing.io)).rejects.toThrow("boom");
      expect(existsSync(slot.path)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("runVerify: a slot wait that hits the limit fails by name and never runs the tests", async () => {
    const dir = tempDir("slot");
    try {
      writeFileSync(join(dir, "verify-slot.lock"), holderText(HOLDER));
      const { io: slot } = slotIo(dir, { waitLimitS: 4 });
      const { io, execs } = verifyIo({ slot });
      const r = await runVerify(["runner"], io);
      expect(r.code).toBe(1);
      expect(r.lines.join("\n")).toContain("verify slot: FAIL");
      expect(execs.some((c) => c[1] === "test")).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("runVerify: under CI the slot is skipped and named, even with a live holder", async () => {
    const dir = tempDir("slot");
    try {
      writeFileSync(join(dir, "verify-slot.lock"), holderText(HOLDER));
      const { io: slot, sleeps } = slotIo(dir, {});
      const { io } = verifyIo({ slot, env: { CI: "true" } });
      const r = await runVerify([], io);
      expect(r.lines).toContain("verify slot: skipped (CI)");
      expect(sleeps).toEqual([]);
      expect(lockPid(slot.path)).toBe(String(HOLDER));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("runVerify: a slot folder that cannot be written is named and the run goes on", async () => {
    const dir = tempDir("slot");
    try {
      const { io: slot } = slotIo(join(dir, "no-such-dir"), {});
      const { io, execs } = verifyIo({ slot });
      const r = await runVerify(["runner"], io);
      expect(r.lines.join("\n")).toMatch(/verify slot: unavailable \(.+\); running without it/);
      expect(execs.some((c) => c[1] === "test")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("R616b a longer per-test timeout only under measured io pressure", () => {
  const press = (full: string): string =>
    `io some 9.00/2.00/3.00 full ${full}/0.20/0.30; cpu some 0.25/0.50/0.75`;
  test("io full avg10 12.0 raises the timeout to 15000 and says why", () => {
    const t = testTimeout(press("12.00"));
    expect(t.ms).toBe(15000);
    expect(t.line).toBe("per-test timeout: 15000 ms (io full avg10 12.00 >= 5)");
  });
  test("io full avg10 1.0 keeps the default (the some figure does not count)", () => {
    const t = testTimeout(press("1.00"));
    expect(t.ms).toBe(5000);
    expect(t.line).toBe("per-test timeout: 5000 ms (default)");
    expect(testTimeout(press("5.00")).ms).toBe(15000); // the edge is inclusive
  });
  test("unreadable pressure keeps the default and says so", () => {
    for (const p of [
      undefined,
      "io skipped (cannot read /proc/pressure/io: ENOENT); cpu skipped (x)",
    ]) {
      const t = testTimeout(p);
      expect(t.ms).toBe(5000);
      expect(t.line).toBe("per-test timeout: 5000 ms (default; io pressure unreadable)");
    }
  });
  test("testCommand passes --timeout only when raised", () => {
    const base = testCommand({ kind: "full" }, 8, undefined, "/j.xml");
    expect(base.some((a) => a.startsWith("--timeout"))).toBe(false);
    expect(testCommand({ kind: "full" }, 8, undefined, "/j.xml", 15000)).toContain(
      "--timeout=15000",
    );
  });
  test("testStep runs the child with the raised timeout and prints the line", async () => {
    const seen: string[][] = [];
    const step = await testStep(
      { ...FULL, timeoutMs: 15000 },
      {
        exec: (cmd) => {
          seen.push(cmd);
          return { code: 0, output: " 1 pass\n 0 fail\nRan 1 test across 1 file.\n" };
        },
        snapState: () => new Map(),
        env: {},
        log: () => "log",
        junitPath: () => "/j.xml",
        readJunit: () => '<testcase name="a" classname="" file="x.test.ts" />',
        expectedTestFiles: () => ["x.test.ts"],
      },
    );
    expect(step.code).toBe(0);
    expect(seen[0]).toContain("--timeout=15000");
  });
  test("runVerify prints the timeout line before the test step", async () => {
    let t = 0;
    const r = await runVerify(["runner"], {
      packages: KNOWN,
      cores: 32,
      env: {},
      exec: () => ({ code: 0, output: " 1 pass\n 0 fail\n" }),
      git: () => "",
      snapState: () => new Map(),
      log: () => "log",
      junitPath: () => "/j.xml",
      readJunit: () => "",
      expectedTestFiles: () => [],
      cleanDist: () => [],
      now: () => {
        t += 1000;
        return t;
      },
      print: () => {},
      pressure: () => press("12.00"),
    });
    expect(r.lines).toContain("per-test timeout: 15000 ms (io full avg10 12.00 >= 5)");
  });
  test("a test that never yields still fails under the raised timeout (it is a longer limit, not none)", () => {
    const dir = tempDir("r616b-timeout");
    try {
      writeFileSync(
        join(dir, "hang.test.ts"),
        'import { test } from "bun:test";\ntest("hangs", async () => { await Bun.sleep(25_000); });\n',
      );
      const cmd = testCommand({ kind: "full" }, 1, undefined, join(dir, "j.xml"), 15000);
      const r = bunTest(
        dir,
        cmd.slice(2).filter((a) => !a.startsWith("--reporter")),
        process.env,
      );
      expect(r.code, r.out).not.toBe(0);
      expect(r.out).toContain("timed out after 15000ms");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

describe("R616b the whole-run limit", () => {
  const HANG = [process.execPath, "-e", "setTimeout(() => {}, 30000)"];
  test("a child that never exits is killed at the run limit and fails by name", async () => {
    const printed: string[] = [];
    const t0 = Date.now();
    const r = await execWatched(HANG, process.env, tmpdir(), 180, {
      runLimitS: 2,
      print: (l) => void printed.push(l),
    });
    expect(Date.now() - t0).toBeLessThan(15_000);
    expect(r.watchdog?.fails.join("\n")).toContain(
      "watchdog: FAIL, the bun test run went over 2 s (no file was over its limit)",
    );
    expect(printed.join("\n")).toContain("the bun test run went over 2 s");
    expect(r.code).not.toBe(0);
  }, 40_000);
  test("a normal run prints no run-limit line", async () => {
    const printed: string[] = [];
    const r = await execWatched([process.execPath, "-e", "0"], process.env, tmpdir(), 180, {
      runLimitS: 2,
      print: (l) => void printed.push(l),
    });
    expect(r.code).toBe(0);
    expect(r.watchdog?.fails).toEqual([]);
    expect(printed).toEqual([]);
  });
});
