import { describe, expect, test } from "bun:test";
import { VerifyArgsError, parseArgs, parseTestSummary } from "./verify.ts";

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
