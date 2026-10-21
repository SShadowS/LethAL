import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Env,
  type SnapState,
  type TestStepIo,
  VerifyArgsError,
  type VerifyIo,
  completeness,
  discoverTestFiles,
  parallelism,
  parseArgs,
  parseJunit,
  parseSnapState,
  parseTestSummary,
  runVerify,
  sentinelEnv,
  snapChanges,
  testChildEnv,
  testCommand,
  testStep,
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
    expect(full.slice(0, 3)).toEqual(["bun", "test", "--parallel=8"]);
    expect(full.filter((a) => !a.startsWith("--"))).toEqual(["bun", "test"]);
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
    test(`partial: ${argv.join(" ")}`, () => {
      const r = runVerify(argv, io());
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
  test("exit codes: an all-pass PARTIAL run exits 4, a failing one 1, an all-pass FULL run 0", () => {
    for (const argv of [["--changed"], ["--changed=abc"], ["runner"], ["runner", "engine"]]) {
      expect(runVerify(argv, io()).code, argv.join(" ")).toBe(4);
      const failing = {
        ...io(),
        exec: (cmd: string[]) =>
          cmd[1] === "test" ? { code: 1, output: " 2 pass\n 1 fail\n" } : { code: 0, output: "" },
      };
      expect(runVerify(argv, failing).code, `${argv.join(" ")} failing`).toBe(1);
    }
    expect(runVerify([], io()).code).toBe(0);
  });
  test("--changed names the resolved sha and the blind spot", () => {
    const all = runVerify(["--changed"], io()).lines.join("\n");
    expect(all).toContain("test (changed since sha456)");
    expect(all).toContain("blind spot");
  });
  test("full: test (all) and VERIFY FULL, the file-set check, and the P used", () => {
    const r = runVerify([], io());
    const all = r.lines.join("\n");
    expect(all).toContain("test (all)");
    expect(r.lines[0]).toContain("FULL");
    expect(r.lines[0]).toContain("--parallel=8");
    expect(all).toContain("file-set check: ok");
    expect(r.lines.at(-1)).toMatch(/^VERIFY FULL: PASS \(3 pass \/ 0 skip \/ 0 fail\)/);
  });
  test("full with the snapshot opt-out says so in the receipt", () => {
    const r = runVerify([], io({ LETHAL_TEST_ALLOW_SNAPSHOT_CREATE: "1" }));
    expect(r.lines.at(-1)).toContain("VERIFY FULL: PASS");
    expect(r.lines.at(-1)).toContain("(snapshot guard OFF)");
  });
  test("full fails when bun ran fewer files than discovery finds, naming the missing one", () => {
    const base = io();
    const r = runVerify([], {
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
  test("A6 a crashed worker is named, though its passes are lost from the count", () => {
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
    const step = testStep(FULL, {
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
  test("bun exiting non-zero with `0 fail` and no crash line still fails (the exit-code backstop)", () => {
    const step = testStep(FULL, {
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

  test("(i) the test child gets CI=true, and not when the opt-out is set", () => {
    const seen: Array<Record<string, string | undefined>> = [];
    const on = testStep(PART, io({ seen, env: { PATH: "p" } }));
    expect(seen[0]?.CI).toBe("true");
    expect(seen[0]?.PATH).toBe("p");
    expect(on.code).toBe(0);
    expect(on.lines[0]).toContain("CI=true");

    const off = testStep(PART, io({ seen, env: { LETHAL_TEST_ALLOW_SNAPSHOT_CREATE: "1" } }));
    expect(seen[1]?.CI).toBeUndefined();
    expect(off.lines[0]).toContain("OFF");

    // An inherited CI must not survive the opt-out, or "OFF" would be a lie (review r1 nit).
    testStep(PART, io({ seen, env: { CI: "true", LETHAL_TEST_ALLOW_SNAPSHOT_CREATE: "1" } }));
    expect(seen[2]?.CI).toBeUndefined();
  });

  test("(ii) the belt fails for a staged, an unstaged and a new .snap changed during the run", () => {
    const before = parseSnapState(" M a.snap\n", () => "h1");
    const staged = parseSnapState(" M a.snap\nM  b.snap\n", () => "h2");
    const r = testStep(PART, io({ states: [new Map(), staged] }));
    expect(r.code).toBe(1);
    expect(r.lines.join("\n")).toContain("b.snap");
    for (const status of ["M  ", " M ", "?? "]) {
      const after = parseSnapState(`${status}x.snap\n`, () => "h");
      const res = testStep(PART, io({ states: [new Map(), after] }));
      expect(res.code).toBe(1);
      expect(res.lines.join("\n")).toContain("x.snap");
      expect(res.lines.join("\n")).toContain("--update-snapshots");
    }
    expect(snapChanges(before, before)).toEqual([]);
  });

  test("(ii) a .snap already dirty before the run is not blamed, unless the run changed it", () => {
    const dirty = parseSnapState(" M a.snap\n", () => "h1");
    expect(testStep(PART, io({ states: [dirty, dirty] })).code).toBe(0);
    const edited = parseSnapState(" M a.snap\n", () => "h2");
    const r = testStep(PART, io({ states: [dirty, edited] }));
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
