// PR-115: the pure parts of baseline batching (al-runner-v3-baseline-batch.ts): the scan, the plan, the
// exclusion pattern and the decode, step by step. The fill's own behaviour is in al-runner-v3-entries.test.ts.
import { describe, expect, test } from "bun:test";
import { initParser } from "@lethal/engine";
import {
  BASELINE_BATCH_SIZE,
  batchBody,
  decodeBatchAnswer,
  exclusionOf,
  exclusionsFor,
  planBaselineBatches,
  scanTestCodeunits,
  unionCoverage,
} from "../src/al-runner-v3-baseline-batch";
import type { V3CoverageRead } from "../src/al-runner-v3-sleep";

const al = (id: number, body: string, test = true) =>
  `codeunit ${id} "C${id}"\n{\n${test ? "    Subtype = Test;\n" : ""}${body}}\n`;

describe("PR-115: the source scan", () => {
  test("finds Subtype=Test codeunits and OnRun triggers, in any #if arm, ignoring comments and strings", async () => {
    await initParser();
    const scan = scanTestCodeunits([
      al(1, "    trigger OnRun()\n    begin\n    end;\n"),
      al(2, ""),
      al(3, "", false),
      `#if CLEAN\n${al(4, "")}#else\n${al(5, "    trigger OnRun()\n    begin\n    end;\n")}#endif\n`,
      `// codeunit 6 "X" { Subtype = Test; trigger OnRun() }\n${al(7, "    procedure P()\n    begin\n        Message('trigger OnRun');\n    end;\n")}`,
    ]);
    expect([...scan.tests].sort()).toEqual([1, 2, 4, 5, 7]);
    expect([...scan.onRun].sort()).toEqual([1, 5]);
  });
});

describe("PR-115: the exclusion pattern", () => {
  test("the trailing dot: Codeunit1. never hides Codeunit11", () => {
    expect(exclusionOf(1)).toBe("Codeunit1.");
    expect("Codeunit11.Check".includes(exclusionOf(1))).toBe(false);
    expect("Codeunit1.Check".includes(exclusionOf(1))).toBe(true);
    expect(exclusionsFor([1], { tests: new Set([1, 11, 2]) }, [])).toEqual([
      "Codeunit2.",
      "Codeunit11.",
    ]);
  });
  test("the suite's codeunits are excluded too, and the batch's own never", () => {
    expect(exclusionsFor([5, 6], { tests: new Set([5]) }, [5, 6, 9])).toEqual(["Codeunit9."]);
  });
  test("the body keeps every requestBase field and adds only excludeTests and coverage", () => {
    const base = {
      command: "runTests",
      sourcePaths: ["/a", "/b"],
      testIsolation: "test",
      noClient: true,
    };
    expect(batchBody(base, ["Codeunit9."])).toEqual({
      ...base,
      excludeTests: ["Codeunit9."],
      coverage: true,
      perTestCoverage: true,
    });
  });
});

describe("PR-115: the plan", () => {
  const scan = (tests: number[], onRun: number[] = []) => ({
    tests: new Set(tests),
    onRun: new Set(onRun),
  });
  test("the default size is 8", () => expect(BASELINE_BATCH_SIZE).toBe(8));
  test("groups of the batch size, in id order; a short tail goes alone", () => {
    expect(planBaselineBatches([1, 2, 3, 4, 5], 2, scan([1, 2, 3, 4, 5, 9]), [])).toEqual([
      [1, 2],
      [3, 4],
      [5],
    ]);
  });
  test("an empty complement goes singly", () => {
    expect(planBaselineBatches([1, 2], 2, scan([1, 2]), [])).toEqual([[1], [2]]);
    expect(planBaselineBatches([1, 2], 2, scan([1, 2]), [7])).toEqual([[1, 2]]);
  });
  test("an OnRun codeunit and one the scan did not find go alone and break the run", () => {
    expect(planBaselineBatches([1, 2, 3, 4, 5], 8, scan([1, 2, 3, 5, 9], [3]), [])).toEqual([
      [1, 2],
      [3],
      [4],
      [5],
    ]);
  });
});

describe("PR-115: the coverage union", () => {
  test("hits add up per file and line", () => {
    const f = (line: number, hits: number) => [{ file: "/a", statements: [{ line, hits }] }];
    expect(unionCoverage([f(1, 1), f(1, 2), f(3, 1)])).toEqual([
      {
        file: "/a",
        statements: [
          { line: 1, hits: 3 },
          { line: 3, hits: 1 },
        ],
      },
    ]);
  });
});

describe("PR-115: the decode, in order", () => {
  interface R {
    codeunit: number;
    name: string;
    method: string;
  }
  const row = (codeunit: number, method: string): R => ({
    codeunit,
    method,
    name: `Codeunit${codeunit}.${method}`,
  });
  const entry = (test: string, line: number) => ({
    test,
    coverage: [{ file: "/f", statements: [{ line, hits: 1 }] }],
  });
  const doc = (...entries: ReturnType<typeof entry>[]): V3CoverageRead => ({
    kind: "doc",
    coverage: [],
    perTestCoverage: entries,
  });
  const decode = (o: {
    rows: R[];
    coverage?: V3CoverageRead;
    isKept?: (r: R) => boolean;
    ids?: number[];
    have?: (rows: readonly R[], id: number) => boolean;
    withCoverage?: boolean;
  }) =>
    decodeBatchAnswer<R>({
      ids: o.ids ?? [1, 2],
      rows: o.rows,
      coverage: o.coverage ?? doc(),
      isKept: o.isKept ?? (() => true),
      hasEveryRow: o.have ?? (() => true),
      ...(o.withCoverage !== undefined ? { withCoverage: o.withCoverage } : {}),
    });
  const why = (d: ReturnType<typeof decode>) => ("why" in d ? d.why : "ok");

  test("a good answer is sliced per codeunit, by the exact row name, with the coverage union", () => {
    // the same method name in two codeunits: each keeps only its own row and its own entry
    const d = decode({
      rows: [row(1, "Same"), row(2, "Same"), row(2, "Other")],
      coverage: doc(entry("Codeunit1.Same", 4), entry("Codeunit2.Same", 7)),
    });
    if (!d.ok) throw new Error(d.why);
    expect(d.byId.get(1)?.rows.map((r) => r.name)).toEqual(["Codeunit1.Same"]);
    expect(d.byId.get(2)?.rows.map((r) => r.name)).toEqual(["Codeunit2.Same", "Codeunit2.Other"]);
    const c2 = d.byId.get(2)?.coverage;
    if (c2?.kind !== "doc") throw new Error("doc");
    expect(c2.perTestCoverage.map((e) => e.test)).toEqual(["Codeunit2.Same"]);
    expect(c2.coverage[0]?.statements).toEqual([{ line: 7, hits: 1 }]);
  });
  test("2: a row of a codeunit outside the batch discards", () => {
    expect(why(decode({ rows: [row(1, "A"), row(3, "A")] }))).toContain("outside the batch");
  });
  test("3: a test named twice discards (no throw)", () => {
    expect(why(decode({ rows: [row(1, "A"), row(1, "A")] }))).toContain("appears twice");
  });
  test("4: a row R612 does not keep discards", () => {
    expect(
      why(decode({ rows: [row(1, "A"), row(2, "B")], isKept: (r) => r.method !== "B" })),
    ).toContain("R612");
  });
  test("5: unavailable coverage, an entry for a test outside the batch (a hidden run), or two entries for one row discard", () => {
    const rows = [row(1, "A"), row(2, "B")];
    expect(why(decode({ rows, coverage: { kind: "unavailable", why: "x" } }))).toContain(
      "unavailable",
    );
    expect(why(decode({ rows, coverage: doc(entry("Codeunit9.Z", 1)) }))).toContain(
      "no row of the batch",
    );
    expect(
      why(decode({ rows, coverage: doc(entry("Codeunit1.A", 1), entry("Codeunit1.A", 2)) })),
    ).toContain("two coverage entries");
  });
  test("5: a row with NO entry (a test that hit nothing) is kept", () => {
    const d = decode({ rows: [row(1, "A"), row(2, "B")], coverage: doc(entry("Codeunit1.A", 1)) });
    expect(d.ok).toBe(true);
  });
  test("6: a codeunit without a row for one of its tests discards the batch", () => {
    expect(why(decode({ rows: [row(1, "A"), row(2, "B")], have: (_r, id) => id !== 2 }))).toContain(
      "codeunit 2 lacks",
    );
  });
  test("the checks run in order: a duplicate in an outside row is reported as outside first", () => {
    expect(why(decode({ rows: [row(3, "A"), row(3, "A")] }))).toContain("outside the batch");
  });
});

describe("PR-126: the no-coverage decode", () => {
  interface R {
    codeunit: number;
    name: string;
    method: string;
  }
  const row = (codeunit: number, method: string): R => ({
    codeunit,
    method,
    name: `Codeunit${codeunit}.${method}`,
  });
  const unavailable: V3CoverageRead = { kind: "unavailable", why: "x" };
  const ghost: V3CoverageRead = {
    kind: "doc",
    coverage: [],
    perTestCoverage: [{ test: "Codeunit9.Z", coverage: [] }],
  };
  const decode = (o: {
    rows: R[];
    coverage?: V3CoverageRead;
    isKept?: (r: R) => boolean;
    have?: (rows: readonly R[], id: number) => boolean;
    withCoverage?: boolean;
  }) =>
    decodeBatchAnswer<R>({
      ids: [1, 2],
      rows: o.rows,
      coverage: o.coverage ?? unavailable,
      isKept: o.isKept ?? (() => true),
      hasEveryRow: o.have ?? (() => true),
      withCoverage: o.withCoverage ?? false,
    });
  const why = (d: ReturnType<typeof decode>) => ("why" in d ? d.why : "ok");

  test("steps 2-4 and the per-codeunit slice still discard", () => {
    expect(why(decode({ rows: [row(1, "A"), row(3, "A")] }))).toContain("outside the batch");
    expect(why(decode({ rows: [row(1, "A"), row(1, "A")] }))).toContain("appears twice");
    expect(
      why(decode({ rows: [row(1, "A"), row(2, "B")], isKept: (r) => r.method !== "B" })),
    ).toContain("R612");
    expect(why(decode({ rows: [row(1, "A"), row(2, "B")], have: (_r, id) => id !== 2 }))).toContain(
      "codeunit 2 lacks",
    );
  });

  test("missing coverage and a ghost entry do NOT discard", () => {
    const rows = [row(1, "A"), row(2, "B")];
    expect(decode({ rows, coverage: unavailable }).ok).toBe(true);
    expect(decode({ rows, coverage: ghost }).ok).toBe(true);
  });

  test("each answer is sliced by codeunit and carries coverage unavailable with the PR-126 reason", () => {
    const d = decode({ rows: [row(1, "A"), row(2, "B"), row(2, "C")], coverage: ghost });
    if (!d.ok) throw new Error(d.why);
    expect(d.byId.get(1)?.rows.map((r) => r.name)).toEqual(["Codeunit1.A"]);
    expect(d.byId.get(2)?.rows.map((r) => r.name)).toEqual(["Codeunit2.B", "Codeunit2.C"]);
    for (const id of [1, 2])
      expect(d.byId.get(id)?.coverage).toEqual({
        kind: "unavailable",
        why: "PR-126 re-check rows only",
      });
  });

  test("the default mode is unchanged: the same ghost entry discards", () => {
    expect(why(decode({ rows: [row(1, "A")], coverage: ghost, withCoverage: true }))).toContain(
      "no row of the batch",
    );
  });

  test("the no-coverage body leaves out both fields; the default body keeps both true", () => {
    const base = { command: "runTests" };
    const off = batchBody(base, ["Codeunit9."], false);
    expect(off).toEqual({ ...base, excludeTests: ["Codeunit9."] });
    expect(off).not.toHaveProperty("coverage");
    expect(off).not.toHaveProperty("perTestCoverage");
    expect(batchBody(base, ["Codeunit9."])).toMatchObject({
      coverage: true,
      perTestCoverage: true,
    });
  });
});
