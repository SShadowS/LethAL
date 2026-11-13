// R948: the pure pieces: the cross-check's sample and comparison, the cgroup reader and the bound.
// The reader is handed a fake file reader: no test reads the real /sys, /proc or /coord.
import { describe, expect, test } from "bun:test";
import {
  baselineSampleIds,
  compareBaselineAnswers,
  memoryBoundBytes,
  readCgroupMemory,
} from "../src/al-runner-v3-baseline-check";
import type { V3CoverageRead } from "../src/al-runner-v3-sleep";

const row = (method: string, o: Record<string, unknown> = {}) => ({
  method,
  status: "pass",
  notRun: false,
  ...o,
});
const cov = (perTest: Record<string, number[]>): V3CoverageRead => ({
  kind: "doc",
  coverage: [{ file: "/a/T.al", statements: [{ line: 1, hits: 1 }] }],
  perTestCoverage: Object.entries(perTest).map(([test, lines]) => ({
    test,
    coverage: [{ file: "/a/T.al", statements: lines.map((line) => ({ line, hits: 1 })) }],
  })),
});

describe("R948: the cross-check's sample", () => {
  test("empty, one, and two codeunits", () => {
    expect(baselineSampleIds([])).toEqual([]);
    expect(baselineSampleIds([7])).toEqual([7]);
    expect(baselineSampleIds([7, 9])).toEqual([7, 9]);
  });
  test("always the first and the last, plus every 25th", () => {
    const ids = Array.from({ length: 60 }, (_, i) => 1000 + i);
    expect(baselineSampleIds(ids)).toEqual([1000, 1025, 1050, 1059]);
  });
  test("at most eight, still the first and the last, and the same every time", () => {
    const ids = Array.from({ length: 400 }, (_, i) => i);
    const a = baselineSampleIds(ids);
    expect(a.length).toBeLessThanOrEqual(8);
    expect(a[0]).toBe(0);
    expect(a.at(-1)).toBe(399);
    expect(baselineSampleIds(ids)).toEqual(a);
  });
});

describe("R948: comparing a daemon answer with a fresh process's", () => {
  const same = {
    rows: [row("A"), row("B")],
    coverage: cov({ "Codeunit1.A": [1], "Codeunit1.B": [2] }),
  };
  test("equal answers agree (the order of rows and the case of names do not matter)", () => {
    expect(
      compareBaselineAnswers(same, {
        rows: [row("b"), row("A")],
        coverage: cov({ "codeunit1.b": [2], "Codeunit1.A": [1] }),
      }),
    ).toEqual([]);
  });
  test("a status, a notRun, a flag and a fail text each differ", () => {
    const d = (o: Record<string, unknown>) => ({ ...same, rows: [row("A", o), row("B")] });
    expect(compareBaselineAnswers(d({ status: "fail" }), same)).toHaveLength(1);
    expect(compareBaselineAnswers(d({ notRun: true }), same)).toHaveLength(1);
    expect(compareBaselineAnswers(d({ flagged: true }), same)).toHaveLength(1);
    expect(
      compareBaselineAnswers(
        d({ status: "fail", message: "x" }),
        d({ status: "fail", message: "y" }),
      ),
    ).toEqual(["a: the fail text differs"]);
  });
  test("a row only one side has", () => {
    expect(compareBaselineAnswers({ ...same, rows: [row("A")] }, same)[0]).toContain(
      "only the one-shot",
    );
  });
  test("the per-test coverage set, the whole call's set, and a missing document each differ", () => {
    expect(
      compareBaselineAnswers(same, {
        ...same,
        coverage: cov({ "Codeunit1.A": [1, 5], "Codeunit1.B": [2] }),
      }),
    ).toEqual(["codeunit1.a: the per-test coverage set differs"]);
    const wider: V3CoverageRead = {
      kind: "doc",
      coverage: [{ file: "/a/T.al", statements: [{ line: 9, hits: 1 }] }],
      perTestCoverage: [
        {
          test: "Codeunit1.A",
          coverage: [{ file: "/a/T.al", statements: [{ line: 1, hits: 1 }] }],
        },
        {
          test: "Codeunit1.B",
          coverage: [{ file: "/a/T.al", statements: [{ line: 2, hits: 1 }] }],
        },
      ],
    };
    expect(compareBaselineAnswers(same, { ...same, coverage: wider })).toEqual([
      "coverage: the whole call's hit set differs",
    ]);
    expect(
      compareBaselineAnswers(same, { ...same, coverage: { kind: "unavailable", why: "none" } })[0],
    ).toContain("coverage: daemon doc, one-shot unavailable");
  });
  test("a statement with no hits is not coverage", () => {
    const zero: V3CoverageRead = {
      kind: "doc",
      coverage: [],
      perTestCoverage: [
        {
          test: "Codeunit1.A",
          coverage: [{ file: "/a/T.al", statements: [{ line: 4, hits: 0 }] }],
        },
      ],
    };
    const none: V3CoverageRead = {
      kind: "doc",
      coverage: [],
      perTestCoverage: [{ test: "Codeunit1.A", coverage: [] }],
    };
    expect(
      compareBaselineAnswers(
        { rows: [row("A")], coverage: zero },
        { rows: [row("A")], coverage: none },
      ),
    ).toEqual([]);
  });
});

describe("R948: the cgroup reader and the bound", () => {
  const files = (o: Record<string, string>) => (p: string) => {
    const v = o[p];
    if (v === undefined) throw new Error("ENOENT");
    return v;
  };
  test("current less the reclaimable page cache, against memory.max", () => {
    const s = readCgroupMemory(
      files({
        "/c/memory.current": "20000000000\n",
        "/c/memory.stat": "anon 1\ninactive_file 5000000000\nactive_file 7\n",
        "/c/memory.max": "34359738368\n",
      }),
      "/c",
    );
    expect(s).toEqual({ usedBytes: 15000000000, maxBytes: 34359738368, source: "/c/memory.max" });
  });
  test("`max` names no limit; no memory.current means no reading at all", () => {
    expect(
      readCgroupMemory(files({ "/c/memory.current": "5", "/c/memory.max": "max\n" }), "/c")
        ?.maxBytes,
    ).toBeUndefined();
    expect(readCgroupMemory(files({}), "/c")).toBeUndefined();
  });
  test("the bound is the limit less the headroom, never negative", () => {
    expect(memoryBoundBytes(32 * 2 ** 30, 4)).toBe(28 * 2 ** 30);
    expect(memoryBoundBytes(2 ** 30, 4)).toBe(0);
  });
});
