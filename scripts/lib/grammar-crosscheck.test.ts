import { beforeAll, describe, expect, test } from "bun:test";
import { initParser, parseAL } from "../../packages/engine/src/ast/parser";
import {
  EXIT_CODE,
  type Site,
  type Span,
  assertUniqueKeys,
  contextKey,
  diffSites,
  parseHealth,
  restrictToComparable,
  siteKey,
  splitArgs,
  verdict,
} from "./grammar-crosscheck";

const v = (
  comparableFiles: number,
  diffs: Parameters<typeof verdict>[0]["diffs"],
  unruledKinds = 0,
) => verdict({ comparableFiles, diffs, unruledKinds });

const site = (file: string, kind: string, start: number, end: number): Site => ({
  file,
  kind,
  start,
  end,
});
const NO_SPANS: ReadonlyMap<string, readonly Span[]> = new Map();

describe("diffSites on hand-made pairs", () => {
  test("identical inputs produce no deltas, and the verdict is agree", () => {
    const s = [site("a.al", "additive_expression", 10, 15)];
    const d = diffSites(s, s, { guardedSpans: NO_SPANS });
    for (const split of [d.onlyCompiler, d.onlyTreeSitter]) {
      expect(split.guarded).toEqual([]);
      expect(split.explained).toEqual([]);
      expect(split.unexplained).toEqual([]);
    }
    expect(v(1, [d])).toBe("agree");
  });

  test("nested same-start chain: `A + B + C` holds two additive nodes starting at A", () => {
    // Phase 1 once keyed on file|kind|start into a Set and printed AGREE here (7c7d7a3).
    const outer = site("a.al", "additive_expression", 0, 9);
    const inner = site("a.al", "additive_expression", 0, 5);
    const d = diffSites([outer, inner], [outer], { guardedSpans: NO_SPANS });
    expect(d.onlyTreeSitter.unexplained).toEqual([{ site: inner, treeSitter: 1, compiler: 0 }]);
    expect(d.onlyCompiler.unexplained).toEqual([]);
    expect(v(1, [d])).toBe("disagree");
  });

  test("multiplicity survives: the same key twice on one side is a delta", () => {
    const x = site("a.al", "call_expression", 3, 8);
    const d = diffSites([x, x], [x], { guardedSpans: NO_SPANS });
    expect(d.onlyTreeSitter.unexplained).toEqual([{ site: x, treeSitter: 2, compiler: 1 }]);
  });

  test("a compiler-only site is a blind spot, a tree-sitter-only site an over-claim", () => {
    const blind = site("a.al", "comparison_expression", 20, 25);
    const over = site("a.al", "call_expression", 40, 44);
    const d = diffSites([over], [blind], { guardedSpans: NO_SPANS });
    expect(d.onlyCompiler.unexplained.map((x) => x.site)).toEqual([blind]);
    expect(d.onlyTreeSitter.unexplained.map((x) => x.site)).toEqual([over]);
  });

  test("a directive span guards BOTH directions, only its own range, only its own file", () => {
    const spans = new Map<string, readonly Span[]>([["a.al", [[100, 200]]]]);
    const tsOnly = site("a.al", "multiplicative_expression", 120, 125);
    const ccOnly = site("a.al", "additive_expression", 150, 155);
    const outsideSpan = site("a.al", "additive_expression", 300, 305);
    const otherFile = site("b.al", "additive_expression", 150, 155);
    const d = diffSites([tsOnly], [ccOnly, outsideSpan, otherFile], { guardedSpans: spans });
    expect(d.onlyTreeSitter.guarded.map((x) => x.site)).toEqual([tsOnly]);
    expect(d.onlyCompiler.guarded.map((x) => x.site)).toEqual([ccOnly]);
    // A file with a directive is NOT set aside whole: a gap outside the span is still a finding.
    expect(d.onlyCompiler.unexplained.map((x) => x.site)).toEqual([outsideSpan, otherFile]);
  });
});

describe("context probes compare POSITIONS, not per-file totals", () => {
  const probe = "call in statement position";
  test("one lost site and one extra site in the same file are two deltas, not agreement", () => {
    // Per-file totals would read 2 vs 2 here. R217 records that cancellation as a real failure.
    const shared = site("a.al", probe, 10, 20);
    const onlyTs = site("a.al", probe, 30, 40);
    const onlyCc = site("a.al", probe, 50, 60);
    const d = diffSites([shared, onlyTs], [shared, onlyCc], {
      guardedSpans: NO_SPANS,
      key: contextKey,
    });
    expect(d.onlyTreeSitter.unexplained.map((x) => x.site)).toEqual([onlyTs]);
    expect(d.onlyCompiler.unexplained.map((x) => x.site)).toEqual([onlyCc]);
    expect(v(1, [d])).toBe("disagree");
  });

  test("context keys ignore the end offset: the compiler's statement span includes the `;`", () => {
    // Measured: `R := 1;` is 231-238 to the compiler, 231-237 to tree-sitter.
    const d = diffSites([site("a.al", probe, 231, 237)], [site("a.al", probe, 231, 238)], {
      guardedSpans: NO_SPANS,
      key: contextKey,
    });
    expect(d.onlyCompiler.unexplained).toEqual([]);
    expect(d.onlyTreeSitter.unexplained).toEqual([]);
  });

  test("only the asserterror POSITION is explained, not a gap that happens to have the same size", () => {
    const inAssertError = site("a.al", probe, 70, 80);
    const unrelated = site("a.al", probe, 90, 95);
    const explained = new Set([contextKey(inAssertError)]);
    const d = diffSites([], [inAssertError, unrelated], {
      guardedSpans: NO_SPANS,
      explained,
      key: contextKey,
    });
    expect(d.onlyCompiler.explained.map((x) => x.site)).toEqual([inAssertError]);
    expect(d.onlyCompiler.unexplained.map((x) => x.site)).toEqual([unrelated]);
  });
});

describe("comparable files and the verdict", () => {
  test("sites in an unhealthy file are removed from BOTH sides before the diff", () => {
    const good = site("good.al", "call_expression", 1, 5);
    const bad = site("bad.al", "call_expression", 1, 5);
    const comparable = new Set(["good.al"]);
    const d = diffSites(
      restrictToComparable([good, bad], comparable),
      restrictToComparable([good], comparable),
      {
        guardedSpans: NO_SPANS,
      },
    );
    expect(d.onlyTreeSitter.unexplained).toEqual([]);
    expect(v(comparable.size, [d])).toBe("agree");
  });

  test("no comparable file is inconclusive, never agree", () => {
    const empty = diffSites([], [], { guardedSpans: NO_SPANS });
    expect(v(0, [empty])).toBe("inconclusive");
    expect(v(0, [empty], 3)).toBe("inconclusive");
  });

  test("an unruled compiler kind is its own verdict, even when every site matches", () => {
    const empty = diffSites([], [], { guardedSpans: NO_SPANS });
    expect(v(5, [empty], 1)).toBe("unruled-mapping");
  });

  test("a guarded-only or explained-only delta is still disagree", () => {
    const x = site("a.al", "call_expression", 1, 5);
    const spans = new Map<string, readonly Span[]>([["a.al", [[0, 10]]]]);
    const guarded = diffSites([x], [], { guardedSpans: spans });
    expect(guarded.onlyTreeSitter.guarded).toHaveLength(1);
    expect(v(1, [guarded])).toBe("disagree");
    const explained = diffSites([], [x], {
      guardedSpans: NO_SPANS,
      explained: new Set([siteKey(x)]),
    });
    expect(explained.onlyCompiler.explained).toHaveLength(1);
    expect(v(1, [explained])).toBe("disagree");
  });

  test("exit codes are distinct per verdict", () => {
    expect(EXIT_CODE).toEqual({ agree: 0, disagree: 1, inconclusive: 2, "unruled-mapping": 3 });
  });
});

describe("duplicate context keys fail loudly", () => {
  test("two sites with one file|probe|start on one side throw, naming the side and key", () => {
    const a = site("a.al", "call in statement position", 10, 20);
    const b = site("a.al", "call in statement position", 10, 25);
    expect(() => assertUniqueKeys([a, b], contextKey, "compiler")).toThrow(
      "compiler: duplicate key a.al|call in statement position|10",
    );
    expect(() => assertUniqueKeys([a], contextKey, "compiler")).not.toThrow();
  });
});

describe("splitArgs: both CLI forms", () => {
  test("without --json the args are unchanged and the target is kept", () => {
    expect(splitArgs(["x.al"])).toEqual({ positional: ["x.al"], jsonOut: undefined });
    expect(splitArgs(["dir", "bin", "g.wasm"])).toEqual({
      positional: ["dir", "bin", "g.wasm"],
      jsonOut: undefined,
    });
  });
  test("with --json the flag and its value are removed wherever they sit", () => {
    expect(splitArgs(["dir", "--json", "o.json"])).toEqual({
      positional: ["dir"],
      jsonOut: "o.json",
    });
    expect(splitArgs(["--json", "o.json", "dir", "", "g.wasm"])).toEqual({
      positional: ["dir", "", "g.wasm"],
      jsonOut: "o.json",
    });
  });
  test("--json with no value is a usage error, not a silent default", () => {
    expect(() => splitArgs(["dir", "--json"])).toThrow("--json needs a path");
  });
});

describe("parseHealth and offsets, on the real vendored grammar", () => {
  beforeAll(async () => {
    await initParser();
  });
  const wrap = (body: string): string =>
    `codeunit 50000 X\n{\n    procedure P()\n    var\n        R: Integer;\n    begin\n${body}\n    end;\n}\n`;

  test("clean AL is healthy", () => {
    expect(parseHealth(parseAL(wrap("        R := 1;")).rootNode)).toEqual({
      errorNodes: 0,
      missingNodes: 0,
    });
  });

  test("a MISSING node with no ERROR node is still unhealthy", () => {
    // Measured 2026-09-27: one MISSING `)`, zero ERROR. An ERROR-only check calls this clean.
    const h = parseHealth(parseAL(wrap("        if (R > 1 then R := 2;")).rootNode);
    expect(h.errorNodes).toBe(0);
    expect(h.missingNodes).toBe(1);
  });

  test("offsets are UTF-16 code units, the same unit as .NET TextSpan", () => {
    const src =
      "codeunit 50000 X\n{\n    // æøå 😀\n    procedure P(): Integer\n    begin\n        exit(1 + 2);\n    end;\n}\n";
    let start = -1;
    const walk = (n: ReturnType<typeof parseAL>["rootNode"]): void => {
      if (n.type === "additive_expression") start = n.startIndex;
      for (const c of n.children) if (c !== null) walk(c);
    };
    walk(parseAL(src).rootNode);
    expect(start).toBe(src.indexOf("1 + 2"));
    expect(start).not.toBe(Buffer.byteLength(src.slice(0, src.indexOf("1 + 2"))));
  });
});
