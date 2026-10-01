import { describe, expect, test } from "bun:test";
import {
  type SnapState,
  type TestStepIo,
  VerifyArgsError,
  parseArgs,
  parseSnapState,
  parseTestSummary,
  snapChanges,
  testStep,
} from "./verify.ts";

const KNOWN = ["engine", "runner", "schemata"];

describe("parseArgs", () => {
  test("no args runs the whole suite", () => {
    expect(parseArgs([], KNOWN)).toEqual([]);
  });
  test("package names, with or without the packages/ prefix, become test paths", () => {
    expect(parseArgs(["runner", "packages/engine/"], KNOWN)).toEqual([
      "packages/runner",
      "packages/engine",
    ]);
  });
  test("an unknown package or flag is refused, not silently dropped", () => {
    expect(() => parseArgs(["nope"], KNOWN)).toThrow(VerifyArgsError);
    expect(() => parseArgs(["--watch"], KNOWN)).toThrow(VerifyArgsError);
  });
});

describe("parseTestSummary", () => {
  test("reads counts and failing test names", () => {
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
    };
  }

  test("(i) the test child gets CI=true, and not when the opt-out is set", () => {
    const seen: Array<Record<string, string | undefined>> = [];
    const on = testStep([], io({ seen, env: { PATH: "p" } }));
    expect(seen[0]?.CI).toBe("true");
    expect(seen[0]?.PATH).toBe("p");
    expect(on.code).toBe(0);
    expect(on.lines[0]).toContain("CI=true");

    const off = testStep([], io({ seen, env: { LETHAL_TEST_ALLOW_SNAPSHOT_CREATE: "1" } }));
    expect(seen[1]?.CI).toBeUndefined();
    expect(off.lines[0]).toContain("OFF");
  });

  test("(ii) the belt fails for a staged, an unstaged and a new .snap changed during the run", () => {
    const before = parseSnapState(" M a.snap\n", () => "h1");
    const staged = parseSnapState(" M a.snap\nM  b.snap\n", () => "h2");
    const r = testStep([], io({ states: [new Map(), staged] }));
    expect(r.code).toBe(1);
    expect(r.lines.join("\n")).toContain("b.snap");
    for (const status of ["M  ", " M ", "?? "]) {
      const after = parseSnapState(`${status}x.snap\n`, () => "h");
      const res = testStep([], io({ states: [new Map(), after] }));
      expect(res.code).toBe(1);
      expect(res.lines.join("\n")).toContain("x.snap");
      expect(res.lines.join("\n")).toContain("--update-snapshots");
    }
    expect(snapChanges(before, before)).toEqual([]);
  });

  test("(ii) a .snap already dirty before the run is not blamed, unless the run changed it", () => {
    const dirty = parseSnapState(" M a.snap\n", () => "h1");
    expect(testStep([], io({ states: [dirty, dirty] })).code).toBe(0);
    const edited = parseSnapState(" M a.snap\n", () => "h2");
    const r = testStep([], io({ states: [dirty, edited] }));
    expect(r.code).toBe(1);
    expect(r.lines.join("\n")).toContain("a.snap");
  });
});
