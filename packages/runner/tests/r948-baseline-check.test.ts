// R948: the pure pieces: the cross-check's sample and comparison, the cgroup reader and the bound.
// The reader is handed a fake file reader: no test reads the real /sys, /proc or /coord.
import { describe, expect, test } from "bun:test";
import { judgeDaemonBaseline } from "../itest/alrunner-v3-legs";
import {
  baselineSampleIds,
  compareBaselineAnswers,
  durationCouldMoveBudget,
  memoryBoundBytes,
  readCgroupMemory,
} from "../src/al-runner-v3-baseline-check";
import type { V3CoverageRead } from "../src/al-runner-v3-sleep";

describe("R948: legs DB and DBI count every answer as taken or skipped by name", () => {
  const none = {
    served: 0,
    compared: 0,
    skippedTooSlow: [],
    skippedError: [],
    skippedOther: [],
    sampledSkipped: [],
  };
  test("all taken: passes with no notes", () => {
    expect(judgeDaemonBaseline("DB", { ...none, served: 3, compared: 2 }, 3, 2)).toEqual({
      notes: [],
    });
  });
  test("a named skip (too slow, an error, a refusal) is a note, never a failure", () => {
    const j = judgeDaemonBaseline(
      "DB",
      {
        ...none,
        served: 1,
        compared: 2,
        skippedTooSlow: ["A"],
        skippedError: ["B"],
        skippedOther: ["C"],
      },
      4,
      2,
    );
    expect(j.fail).toBeUndefined();
    expect(j.notes.join("\n")).toContain("too slow: A");
    expect(j.notes.join("\n")).toContain("request error: B");
    expect(j.notes.join("\n")).toContain("refused or odd row: C");
  });
  test("a silent drop (nothing taken, nothing named) fails", () => {
    expect(judgeDaemonBaseline("DB", { ...none, compared: 2 }, 3, 2).fail).toContain("silent drop");
  });
  test("a sampled item is compared or skipped by name; otherwise it fails", () => {
    expect(
      judgeDaemonBaseline("DBI", { ...none, served: 3, compared: 1, sampledSkipped: ["T"] }, 3, 2)
        .fail,
    ).toBeUndefined();
    expect(judgeDaemonBaseline("DBI", { ...none, served: 3, compared: 1 }, 3, 2).fail).toContain(
      "sampled compared",
    );
  });
});

describe("R948: the duration a budget will read", () => {
  test("a row's own duration wins; with none, the call's wall time is the duration, as in the verdict", () => {
    expect(durationCouldMoveBudget([{ durationMs: 100 }], 9000, 5000)).toBe(false);
    expect(durationCouldMoveBudget([{}], 3000, 5000)).toBe(true); // 2 x 3000 >= 5000
    expect(durationCouldMoveBudget([{}], 2000, 5000)).toBe(false);
    expect(durationCouldMoveBudget([{ durationMs: 2600 }], 0, 5000)).toBe(true);
    expect(durationCouldMoveBudget([], 9000, 5000)).toBe(false);
  });
});

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
  test("empty; one (nothing else to compare, so that one); two (the 2nd, which is also the last)", () => {
    expect(baselineSampleIds([])).toEqual([]);
    expect(baselineSampleIds([7])).toEqual([7]);
    expect(baselineSampleIds([7, 9])).toEqual([9]);
  });
  test("the 2nd and the last, plus every 10th; never index 0", () => {
    const ids = Array.from({ length: 60 }, (_, i) => 1000 + i);
    expect(baselineSampleIds(ids)).toEqual([1001, 1010, 1020, 1030, 1040, 1050, 1059]);
    expect(baselineSampleIds(ids)).not.toContain(1000);
  });
  test("112 codeunits: 13 samples; at most 16 however many; the 2nd and the last stay; the same every time", () => {
    const k = Array.from({ length: 112 }, (_, i) => i);
    expect(baselineSampleIds(k)).toHaveLength(13);
    const ids = Array.from({ length: 900 }, (_, i) => i);
    const a = baselineSampleIds(ids);
    expect(a.length).toBeLessThanOrEqual(16);
    expect(a[0]).toBe(1);
    expect(a.at(-1)).toBe(899);
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
    expect(compareBaselineAnswers(d({ status: "fail" }), same)).toEqual([
      "a: differs in status (daemon fail; one-shot pass)",
    ]);
    expect(compareBaselineAnswers(d({ notRun: true }), same)).toEqual([
      "a: differs in notRun (daemon pass, not run; one-shot pass)",
    ]);
    expect(compareBaselineAnswers(d({ flagged: true }), same)).toEqual([
      "a: differs in flagged (daemon pass, flagged; one-shot pass)",
    ]);
    // The text itself is never in the message, only the field's name.
    expect(
      compareBaselineAnswers(
        d({ status: "fail", message: "SECRET x" }),
        d({ status: "fail", message: "SECRET y" }),
      ),
    ).toEqual(["a: differs in failText (daemon fail; one-shot fail)"]);
  });
  test("flagged false and flagged absent are the same", () => {
    const f = { ...same, rows: [row("A", { flagged: false }), row("B")] };
    expect(compareBaselineAnswers(f, same)).toEqual([]);
  });
  test("several fields are all named", () => {
    const d = {
      ...same,
      rows: [row("A", { status: "fail", message: "x", flagged: true }), row("B")],
    };
    expect(compareBaselineAnswers(d, same)[0]).toContain("differs in status, flagged, failText");
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
    ).toEqual(["codeunit1.a: coverage differs (daemon only 0; one-shot only 1: /a/t.al:5)"]);
    // Counts, and at most five keys per side: line numbers and file names only, no source text.
    const many = (lines: number[]) => cov({ "Codeunit1.A": lines, "Codeunit1.B": [2] });
    const wide = compareBaselineAnswers(
      { ...same, coverage: many([1]) },
      { ...same, coverage: many([1, 10, 11, 12, 13, 14, 15]) },
    );
    expect(wide).toEqual([
      "codeunit1.a: coverage differs (daemon only 0; one-shot only 6: /a/t.al:10, /a/t.al:11, /a/t.al:12, /a/t.al:13, /a/t.al:14, ...)",
    ]);
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
      "coverage: the whole call differs (daemon only 1: /a/t.al:1; one-shot only 1: /a/t.al:9)",
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
