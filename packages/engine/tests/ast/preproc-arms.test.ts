import { beforeAll, describe, expect, test } from "bun:test";
import {
  type ALSyntaxNode,
  evaluateArms,
  initParser,
  parseAL,
  startsInInactiveArm,
  wrapRoot,
} from "../../src/index";

beforeAll(async () => {
  await initParser();
});

const run = (src: string, symbols: readonly string[]) =>
  evaluateArms(wrapRoot(parseAL(src)), src, symbols);

/** The code lines (directive lines skipped) of `src` whose first non-blank byte is in an inactive
 *  range, 1-based; or the refusal. */
function inactiveLines(src: string, symbols: readonly string[]): number[] | string {
  const r = run(src, symbols);
  if (r.kind === "undecided") return `undecided: ${r.reason}`;
  const out: number[] = [];
  let start = 0;
  src.split("\n").forEach((line, i) => {
    const code = line.trim() !== "" && !line.trimStart().startsWith("#");
    if (code && startsInInactiveArm(r.inactive, start + line.search(/\S/))) out.push(i + 1);
    start += line.length + 1;
  });
  return out;
}

const body = (directives: string): string =>
  `codeunit 50001 "P"\n{\n    procedure A(X: Integer)\n    begin\n${directives}\n    end;\n}\n`;

/** A two-arm probe as alc was probed: line 6 is ARM1 (`#if`), line 8 is ARM2 (`#else`). */
const twoArm = (cond: string) =>
  body(`#if ${cond}\n        X := 1;\n#else\n        X := 2;\n#endif`);
const built = (cond: string, symbols: readonly string[]): string => {
  const r = inactiveLines(twoArm(cond), symbols);
  if (typeof r === "string") return r;
  if (r.length !== 1) return `bad: ${r.join(",")}`;
  return r[0] === 8 ? "ARM1" : "ARM2";
};

/**
 * The measured table (alc 18.0.41.45789, H:/lethal-scratch/R-214/plan-r2/prec/battery*.txt, and
 * the R-214 plan's table "alc's precedence, measured"): condition, /define set, the arm alc built.
 */
const MEASURED: readonly [string, readonly string[], "ARM1" | "ARM2"][] = [
  ["A", ["A"], "ARM1"],
  ["A", [], "ARM2"],
  ["A", ["a"], "ARM2"],
  ["NOT A", ["A"], "ARM2"],
  ["Not A", [], "ARM1"],
  ["A AND B", ["A", "B"], "ARM1"],
  ["A AND B", ["A"], "ARM2"],
  ["A Or B", ["B"], "ARM1"],
  ["UNDEFINEDSYM", [], "ARM2"],
  ["CLEAN_27x", ["CLEAN_27x"], "ARM1"],
  ["A or B and C", ["A"], "ARM1"],
  ["A or B and C", ["B", "C"], "ARM1"],
  ["A or B and C", ["C"], "ARM2"],
  ["A and B or C", ["C"], "ARM1"],
  ["A and B or C", ["A"], "ARM2"],
  ["not A and B", [], "ARM2"],
  ["not A and B", ["A"], "ARM2"],
  ["not A and B", ["B"], "ARM1"],
  ["not A and B", ["A", "B"], "ARM2"],
  ["not A or B", [], "ARM1"],
  ["not A or B", ["A", "B"], "ARM1"],
  ["A and not B or C", ["A", "B", "C"], "ARM1"],
  ["A and not B or C", ["A"], "ARM1"],
  ["not not A", ["A"], "ARM1"],
  ["not not A", [], "ARM2"],
  ["not (A and B)", [], "ARM1"],
  ["not (A and B)", ["A", "B"], "ARM2"],
  ["(A or B) and C", ["A"], "ARM2"],
  ["(A or B) and C", ["B", "C"], "ARM1"],
  ["((A))", ["A"], "ARM1"],
  ["(A)and(B)", ["A", "B"], "ARM1"],
  ["(A)and(B)", ["A"], "ARM2"],
  ["not(A)", ["A"], "ARM2"],
  ["not(A)", [], "ARM1"],
  ["A and (B or not C)", ["A"], "ARM1"],
  ["A and (B or not C)", ["A", "C"], "ARM2"],
  ["A and (B or not C)", ["A", "B", "C"], "ARM1"],
  ["true", [], "ARM1"],
  ["TRUE", [], "ARM1"],
  ["false", [], "ARM2"],
  ["not true", [], "ARM2"],
  ["true", ["true"], "ARM1"],
  ["X or false", ["X"], "ARM1"],
  ["X or false", [], "ARM2"],
  ["A // note", ["A"], "ARM1"],
  ["A // note", [], "ARM2"],
];

describe("R214: evaluateArms follows alc's measured grammar", () => {
  for (const [cond, symbols, arm] of MEASURED) {
    test(`#if ${cond} under [${symbols.join(",")}] builds ${arm}`, () => {
      expect(built(cond, symbols)).toBe(arm);
    });
  }

  test("refused: every condition alc rejects, and a bare keyword alc accepts without meaning", () => {
    // Some of these the grammar itself cannot parse, and then the file is refused earlier, by the
    // marker cross-check; either way it is refused, never evaluated.
    for (const cond of ["!A", "A == B", "A and", "A or", "A B", "1A"])
      expect(built(cond, ["A", "B"])).toMatch(/^undecided: /);
    // These the grammar parses (measured: `and` gives 3 markers; r1: && and || parse), so the
    // refusal must come from the condition parser itself.
    for (const cond of ["and", "A && B", "A || B"])
      expect(built(cond, ["A", "B"])).toBe("undecided: unparsed-condition at line 5");
  });

  test("#if / #elif / #elif / #else: the first true arm is built, and only it (row 28)", () => {
    const chain = body(
      "#if A\n        X := 1;\n#elif B\n        X := 2;\n#elif C\n        X := 3;\n#else\n        X := 4;\n#endif",
    );
    expect(inactiveLines(chain, [])).toEqual([6, 8, 10]);
    expect(inactiveLines(chain, ["A", "C"])).toEqual([8, 10, 12]);
    expect(inactiveLines(chain, ["B", "C"])).toEqual([6, 10, 12]);
    expect(inactiveLines(chain, ["C"])).toEqual([6, 8, 12]);
  });

  test("nesting: an inner arm counts only inside a built outer arm (row 29)", () => {
    const src = body(
      "#if A\n#if B\n        X := 1;\n#else\n        X := 2;\n#endif\n#else\n#if B\n        X := 3;\n#endif\n        X := 4;\n#endif",
    );
    expect(inactiveLines(src, [])).toEqual([7, 9, 13]);
    expect(inactiveLines(src, ["B"])).toEqual([7, 9]);
    expect(inactiveLines(src, ["A", "B"])).toEqual([9, 13, 15]);
  });

  test("unbalanced markers refuse the file (rows 30, 31), by the reasons the native parser yields", () => {
    // Measured with the native parser: it emits no marker for a stray #endif and only three for an
    // #elif after #else, so the marker cross-check refuses these before the walk sees them.
    expect(
      inactiveLines(
        body("#if A\n        X := 1;\n#else\n        X := 2;\n#elif B\n        X := 3;\n#endif"),
        ["B"],
      ),
    ).toBe("undecided: marker-mismatch (4 directive lines, 3 markers)");
    expect(inactiveLines(body("        X := 1;\n#endif"), [])).toBe(
      "undecided: marker-mismatch (1 directive lines, 0 markers)",
    );
    // An #if never closed reaches the walk. body() puts its first directive on line 5.
    expect(inactiveLines(body("#if A\n        X := 1;"), [])).toBe(
      "undecided: unbalanced at line 5",
    );
  });

  test("#define and #undef count where active, in order, case-sensitively (rows 36 to 41)", () => {
    const src = `#define LOCAL\n#undef DROP\n#if OUTER\n#define LATE\n#endif\n#define l\n${body("#if LOCAL\n        X := 1;\n#endif\n#if DROP\n        X := 2;\n#endif\n#if LATE\n        X := 3;\n#endif\n#if L\n        X := 4;\n#endif")}`;
    expect(inactiveLines(src, ["DROP"])).toEqual([15, 18, 21]);
    expect(inactiveLines(src, ["DROP", "OUTER"])).toEqual([15, 21]);
  });

  test("equal counts at different lines still refuse the file (marker positions, not counts)", () => {
    // Measured with the native parser: a mid-line `#if A` is a marker on line 5 that the
    // directive-line scan does not see, and the `#if B` inside the block comment is a directive
    // line on line 8 that the tree does not mark. Two lines, two markers, different lines.
    const src = body("        X := 1; #if A\n        X := 2;\n/*\n#if B\n*/\n#endif");
    expect(inactiveLines(src, [])).toBe(
      "undecided: marker-mismatch (2 directive lines, 2 markers)",
    );
    // The same with an ERROR: the `#endif` inside a string literal is swallowed by an ERROR node
    // (no marker) and the mid-line `#if A` is a marker inside that ERROR.
    const err = body(
      "        X := 1; #if A\n        X := 2;\n        Message('\n#endif');\n        X := 3;",
    );
    expect(inactiveLines(err, [])).toBe(
      "undecided: marker-mismatch (1 directive lines, 1 markers)",
    );
  });

  test("a directive-looking line in a block comment refuses the file (row 49)", () => {
    expect(inactiveLines(body("/*\n#if A\n*/\n        X := 1;\n/*\n#endif\n*/"), [])).toMatch(
      /^undecided: marker-mismatch \(2 directive lines, 0 markers\)$/,
    );
  });

  test("a BOM before the first #if is still a directive line (six corpus files start so)", () => {
    // Counts only: tree offsets are UTF-16 code units (native/src/lib.rs), so a BOM is one unit; no string index is used.
    const src = `\uFEFF#if A\n${body("        X := 1;")}#endif\n`;
    const off = run(src, []);
    const on = run(src, ["A"]);
    expect(off.kind === "decided" ? off.inactive.length : off.reason).toBe(1);
    expect(on.kind === "decided" ? on.inactive.length : on.reason).toBe(0);
  });

  test("a node that STARTS in active code but contains a compiled-out arm is not in a range", () => {
    const src = body("#if A\n        X := 1;\n#endif");
    const r = run(src, []);
    if (r.kind !== "decided") throw new Error("decided expected");
    expect(startsInInactiveArm(r.inactive, src.indexOf("begin"))).toBe(false);
    expect(startsInInactiveArm(r.inactive, src.indexOf("#if"))).toBe(false);
    expect(startsInInactiveArm(r.inactive, src.indexOf("X := 1"))).toBe(true);
  });

  test("a refused condition inside a compiled-out arm refuses nothing (it is never evaluated)", () => {
    expect(inactiveLines(body("#if A\n#if B && C\n        X := 1;\n#endif\n#endif"), [])).toEqual([
      7,
    ]);
  });

  test("a file with no directive line is never walked (I7)", () => {
    const untouchable = new Proxy({} as ALSyntaxNode, {
      get: () => {
        throw new Error("walked a directive-free file");
      },
    });
    expect(evaluateArms(untouchable, 'codeunit 50001 "P" { }\n', ["A"])).toEqual({
      kind: "decided",
      inactive: [],
    });
  });
});

describe("R214: directive spelling the regexes must keep accepting", () => {
  const two = (a: string, e: string, n: string) =>
    body(`${a} A\n        X := 1;\n${e}\n        X := 2;\n${n}`);
  const armOf = (src: string, symbols: readonly string[]) => {
    const r = inactiveLines(src, symbols);
    return typeof r === "string"
      ? r
      : r.length === 1
        ? r[0] === 8
          ? "ARM1"
          : "ARM2"
        : `bad: ${r.join(",")}`;
  };
  test("directive names in any case, `# if`, and indentation (row 32)", () => {
    for (const src of [
      two("#IF", "#ELSE", "#ENDIF"),
      two("#If", "#Else", "#EndIf"),
      two("# if", "# else", "# endif"),
      two("    #if", "    #else", "    #endif"),
      two("\t# IF", "\t# ELSE", "\t# ENDIF"),
    ]) {
      expect(armOf(src, ["A"])).toBe("ARM1");
      expect(armOf(src, [])).toBe("ARM2");
    }
  });
  test("trailing comments on #else and #endif (row 33)", () => {
    const src = two("#if", "#else // c", "#endif // c");
    expect(armOf(src, ["A"])).toBe("ARM1");
    expect(armOf(src, [])).toBe("ARM2");
  });
  test("#define with a trailing comment (row 44)", () => {
    const src = `#define L // why\n${body("#if L\n        X := 1;\n#endif")}`;
    expect(inactiveLines(src, [])).toEqual([]);
  });
  test("#DEFINE and #Undef in any case (the define regex's i flag)", () => {
    const inner = "#if L\n        X := 1;\n#endif\n#if DROP\n        X := 2;\n#endif";
    const src = `#DEFINE L\n#Undef DROP\n${body(inner)}`;
    expect(inactiveLines(src, ["DROP"])).toEqual([11]);
  });
  test("CRLF line endings decide the same arm as LF", () => {
    const lf = two("#if", "#else", "#endif");
    const crlf = lf.replaceAll("\n", "\r\n");
    for (const s of [["A"], []] as const) expect(armOf(crlf, s)).toBe(armOf(lf, s));
    expect(armOf(crlf, ["A"])).toBe("ARM1");
  });
  test("an empty #if is refused by the marker mismatch (row 26)", () => {
    expect(inactiveLines(body("#if\n        X := 1;\n#endif"), [])).toBe(
      "undecided: marker-mismatch (2 directive lines, 0 markers)",
    );
  });
});
