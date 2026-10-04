import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initParser } from "@lethal/engine";
import { generateMutationSet } from "../src/orchestrator";

/**
 * R402 (plan `docs/superpowers/plans/2026-10-02-R-402-hang-tag-active-arm-operands.md`, r3):
 * - the hang detector reads loop-condition operands in ACTIVE `#if` arms and skips inactive ones
 *   (R196: what it names is now refused, so a hang-capable site has no `remove-assignment` spec);
 * - a statement-level `#if` that continues an unterminated statement (the misparsed
 *   `repeat ... until ... #if or (...)` tail, whose artifact alc refuses) refuses its file.
 * Every shape's source and instrumented artifact were compiled with alc under every build by
 * `scripts/r402-shape-sweep.ts`; these tests pin the generation side.
 */

const wrap = (body: string) => `codeunit 79600 "R402 Shape"
{
    procedure Loop()
    var
        A: Integer;
        B: Integer;
        C: Integer;
        Arr: array[20] of Integer;
    begin
${body}
    end;

    local procedure Check(P: Integer; Q: Integer): Boolean
    begin
        exit(P < Q);
    end;

    local procedure Foo(P: Integer)
    begin
    end;
}
`;
const LOOP_BODY = `        do begin
            A := A + 1;
            B := B + 1;
            C := C + 1;
        end;`;
const REPEAT_HEAD = `        repeat
            A := A + 1;
            B := B + 1;
            C := C + 1;
        until (A > 10)`;

const SHAPES = {
  s1: `        while (A < 10)\n#if LETHALX\n            and (B < 5)\n#endif\n${LOOP_BODY}`,
  s2: `        while (A < 10)\n#if LETHALX\n            and (B < 5)\n#elif LETHALY\n            and (C < 7)\n#endif\n${LOOP_BODY}`,
  s3: `        while (A < 10)\n#if not LETHALX\n            and (B < 5)\n#endif\n${LOOP_BODY}`,
  // The directive symbol is also spelled like a variable: the walk must not read directive conditions.
  s3b: `        while (A < 10)\n#if B\n            and (C < 5)\n#endif\n${LOOP_BODY}`,
  s9: `        while Check(A\n#if LETHALX\n            + B\n#endif\n            , 10)\n${LOOP_BODY}`,
  s10: `        while Arr[1\n#if LETHALX\n            + B\n#endif\n            ] < 10\n${LOOP_BODY}`,
  s11: `        while A in [1, 2\n#if LETHALX\n            , B\n#endif\n            ]\n${LOOP_BODY}`,
  s14: "#if LETHALX\n        while (B < 5) do\n            B := B + 1;\n#endif\n        A := A + 1;",
  s4: `${REPEAT_HEAD}\n#if LETHALX\n            or (B > 5)\n#endif\n        ;`,
  s4b: `${REPEAT_HEAD}\n#if LETHALX\n            or (B > 5)\n#else\n#endif\n        ;`,
  s4c: `${REPEAT_HEAD}\n#if LETHALX\n            or (B > 5) or (C > 3)\n#endif\n        ;`,
  s4d: `${REPEAT_HEAD}\n#if LETHALX\n            or (B > 5)\n#if LETHALY\n            or (C > 3)\n#endif\n#endif\n        ;`,
  c7b: `${REPEAT_HEAD} // tail follows\n#if LETHALX\n            or (B > 5)\n#endif\n        ;`,
  c7e: `${REPEAT_HEAD}\n#pragma warning disable AA0001\n#if LETHALX\n            or (B > 5)\n#endif\n        ;\n#pragma warning restore AA0001`,
  c7f: `${REPEAT_HEAD}\n#region R\n#if LETHALX\n            or (B > 5)\n#endif\n#endregion\n        ;`,
  c8: `${REPEAT_HEAD}\n#if LETHALX\n            or (B > 5)\n#elif LETHALY\n            or (C > 3)\n#endif\n        ;`,
  s4e: `${REPEAT_HEAD};\n#if LETHALX\n        Foo(B);\n#endif`,
  c1: "        if A < 10 then A := A + 1;\n#if LETHALX\n        Foo(B);\n#endif\n        C := C + 1;",
  c2: "        A := A + 1\n#if LETHALX\n#endif\n",
  c2b: "        A := A + 1\n#if LETHALX\n        // nothing here\n#endif\n",
  c3: "        A := A + 1\n#if LETHALX\n        ; Foo(B)\n#endif\n        ;",
  c4: "        if A < 10 then\n#if LETHALX\n            Foo(B)\n#else\n            Foo(A)\n#endif\n        ;",
  c4b: "        if A < 10 then\n            A := 1\n        else\n#if LETHALX\n            Foo(B)\n#else\n            Foo(A)\n#endif\n        ;",
  c5: "        case A of\n            1:\n#if LETHALX\n                Foo(B);\n#else\n                Foo(A);\n#endif\n        end;",
  c5b: "        case A of\n            1:\n                Foo(A);\n#if LETHALX\n            2:\n                Foo(B);\n#endif\n        end;",
  c6: "        A := A + 1;\n#if LETHALX\n        Foo(B);\n#else\n        Foo(A);\n#endif\n        C := C + 1;",
  c7: "        A := A + 1; // done\n#if LETHALX\n        Foo(B);\n#endif",
  c7c: "        A := A + 1;\n#pragma warning disable AA0001\n#if LETHALX\n        Foo(B);\n#endif\n#pragma warning restore AA0001",
  c7d: "        A := A + 1;\n#region R\n#if LETHALX\n        Foo(B);\n#endif\n#endregion",
  // Already undecided under R214 (marker-mismatch): an operand prefix, a nested tail, and an
  // #if/#else choosing the whole loop header.
  s8: `        while\n#if LETHALX\n            (B < 5) and\n#endif\n            (A < 10)\n${LOOP_BODY}`,
  s12: `        while (A < 10)\n#if LETHALX\n            and (B < 5)\n#if LETHALY\n            and (C < 7)\n#endif\n#endif\n${LOOP_BODY}`,
  s13: `#if LETHALX\n        while (B < 5)\n#else\n        while (A < 10)\n#endif\n${LOOP_BODY}`,
  // Expression tails beside an assignment and an if condition: not statement-level containers.
  s15: "        A := A\n#if LETHALX\n            + B\n#endif\n        ;",
  s16: "        if (A < 10)\n#if LETHALX\n            and (B < 5)\n#endif\n        then\n            A := A + 1;",
  // R239: a boolean literal in a loop condition's `#if` tail, and the same tail outside a loop.
  t1: `        while (A < 10)\n#if LETHALX\n            or false\n#endif\n${LOOP_BODY}`,
  t2: "        if (A < 10)\n#if LETHALX\n            or false\n#endif\n        then\n            Foo(A);",
} as const;
type Shape = keyof typeof SHAPES;
const BUILDS = {
  none: [],
  X: ["LETHALX"],
  Y: ["LETHALY"],
  XY: ["LETHALX", "LETHALY"],
} as const;
type Build = keyof typeof BUILDS;

type Result = {
  /** `remove-assignment` sites by assigned variable (R196: a hang-capable one is refused). */
  assigns: Map<string, boolean[]>;
  calls: string[];
  /** `flip-boolean-literal` sites, by literal text. */
  flips: string[];
  /** Every spec's original text, whitespace collapsed. */
  texts: string[];
  undecided: string[];
  /** Every generated spec, to check an admitted shape keeps all its sites. */
  specs: number;
};
const results = new Map<string, Result>();

async function run(shape: Shape, build: Build): Promise<Result> {
  const dir = await mkdtemp(join(tmpdir(), "lethal-r402-"));
  try {
    await Bun.write(join(dir, "app.json"), JSON.stringify({ name: "p" }));
    await Bun.write(join(dir, "src", "Shape.Codeunit.al"), wrap(SHAPES[shape]));
    const set = await generateMutationSet(dir, {
      preprocessorSymbols: BUILDS[build],
      emit: () => {},
    });
    const specs = set.files.flatMap((f) => f.specs);
    const assigns = new Map<string, boolean[]>();
    for (const s of specs.filter((x) => x.operatorName === "lethal.remove-assignment")) {
      const target = s.before.text.split(":=")[0]?.trim() ?? "";
      assigns.set(target, [...(assigns.get(target) ?? []), s.hangCapable !== undefined]);
    }
    return {
      assigns,
      calls: specs
        .filter((x) => x.operatorName === "lethal.void-method-call")
        .map((x) => x.before.text.replace(/\s+/g, " ")),
      flips: specs
        .filter((x) => x.operatorName === "lethal.flip-boolean-literal")
        .map((x) => x.before.text),
      texts: specs.map((x) => x.before.text.replace(/\s+/g, " ")),
      undecided: set.preprocExcluded
        .filter((e) => e.reason === "preproc-undecided")
        .map((e) => e.detail ?? ""),
      specs: specs.length,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

beforeAll(async () => {
  await initParser();
  for (const shape of Object.keys(SHAPES) as Shape[]) {
    for (const build of Object.keys(BUILDS) as Build[]) {
      results.set(`${shape}/${build}`, await run(shape, build));
    }
  }
}, 120_000);

const get = (shape: Shape, build: Build): Result => {
  const r = results.get(`${shape}/${build}`);
  if (r === undefined) throw new Error(`no result for ${shape}/${build}`);
  return r;
};
/**
 * Is the `remove-assignment` site on `v` REFUSED as hang-capable (R196: zero sites) rather than
 * claimed (exactly one)? Every statement in these shapes compiles in every build except S14's loop,
 * which its test checks separately, so an absent site here is the refusal, not a missing statement.
 */
const refused = (shape: Shape, build: Build, v: string): boolean => {
  const sites = get(shape, build).assigns.get(v) ?? [];
  expect(sites.length, `${shape}/${build}: remove-assignment on ${v}`).toBeLessThanOrEqual(1);
  return sites.length === 0;
};

describe("R402: the hang refusal reads operands in ACTIVE #if arms of a loop condition", () => {
  test("S1: an `and (B < 5)` tail beside a while condition", () => {
    expect([refused("s1", "none", "A"), refused("s1", "none", "B")]).toEqual([true, false]);
    expect([refused("s1", "X", "A"), refused("s1", "X", "B")]).toEqual([true, true]);
  });

  test("S2: #if / #elif tails, each arm with its own variable", () => {
    expect([refused("s2", "X", "B"), refused("s2", "X", "C")]).toEqual([true, false]);
    expect([refused("s2", "Y", "B"), refused("s2", "Y", "C")]).toEqual([false, true]);
    expect([refused("s2", "none", "B"), refused("s2", "none", "C")]).toEqual([false, false]);
  });

  test("S3: an `#if not` tail is active in the build WITHOUT the symbol", () => {
    expect(refused("s3", "none", "B")).toBe(true);
    expect(refused("s3", "X", "B")).toBe(false);
  });

  test("S3b: a directive condition spelled like a variable is never read as an operand", () => {
    expect(refused("s3b", "none", "B")).toBe(false);
    expect(refused("s3b", "none", "C")).toBe(false);
  });

  test("S9-S11: tails inside call arguments, subscripts and list elements are read only when active", () => {
    for (const s of ["s9", "s10", "s11"] as const) {
      expect(refused(s, "none", "B"), `${s} []`).toBe(false);
      expect(refused(s, "X", "B"), `${s} [X]`).toBe(true);
    }
  });

  test("S14: a whole loop under a statement-level #if is refused in its own build", () => {
    // The loop exists under [X] (its condition draws mutants) and its counter step is refused;
    // without X the loop is compiled out, so neither appears.
    expect(get("s14", "X").texts).toContain("B < 5");
    expect(refused("s14", "X", "B")).toBe(true);
    expect(get("s14", "none").texts).not.toContain("B < 5");
    expect(get("s14", "none").assigns.get("B")).toBeUndefined();
  });

  test("R239: a boolean `#if` tail of a loop condition is never flipped; outside a loop it is, when active", () => {
    // t1's tail literal sits beside a while condition: refused when active, absent when not.
    // The file is admitted and keeps its other sites, so the empty flips are the refusal, not a
    // refused file.
    for (const b of Object.keys(BUILDS) as Build[]) {
      expect(get("t1", b).flips, `t1/${b}`).toEqual([]);
      expect(get("t1", b).undecided, `t1/${b}`).toEqual([]);
      expect(get("t1", b).texts, `t1/${b}`).toContain("A < 10");
      expect([refused("t1", b, "B"), refused("t1", b, "C")], `t1/${b}`).toEqual([false, false]);
    }
    // t2 is the same tail beside an `if` outside any loop: flipped exactly in the builds with X.
    expect(get("t2", "none").flips).toEqual([]);
    expect(get("t2", "Y").flips).toEqual([]);
    expect(get("t2", "X").flips).toEqual(["false"]);
    expect(get("t2", "XY").flips).toEqual(["false"]);
  });
});

describe("R402: a statement-level #if that continues an unterminated statement refuses its file", () => {
  test("S4, S4b, S4c, S4d, c7b, c7e, c7f and c8 are refused in every build, by name", () => {
    // c7b, c7e and c7f put a comment, a pragma and a region between the statement and the #if:
    // the trivia skip is what reaches the unterminated statement behind them.
    for (const s of ["s4", "s4b", "s4c", "s4d", "c7b", "c7e", "c7f", "c8"] as const) {
      for (const b of Object.keys(BUILDS) as Build[]) {
        const r = get(s, b);
        expect(r.undecided, `${s}/${b}`).toHaveLength(1);
        expect(r.undecided[0], `${s}/${b}`).toStartWith("directive-continues-statement at line");
        expect(r.assigns.size, `${s}/${b}`).toBe(0);
      }
    }
  });

  test("S4e: a terminated repeat then `#if Foo(B)` is admitted; Foo(B) is a site only under [X]", () => {
    expect(get("s4e", "none").undecided).toEqual([]);
    expect(get("s4e", "X").undecided).toEqual([]);
    expect(get("s4e", "X").calls).toContain("Foo(B)");
    expect(get("s4e", "none").calls).not.toContain("Foo(B)");
  });

  test("the admitted controls get no refusal, and keep their measured sites", () => {
    for (const s of [
      "c1",
      "c2",
      "c2b",
      "c3",
      "c4",
      "c4b",
      "c5",
      "c5b",
      "c6",
      "c7",
      "c7c",
      "c7d",
    ] as const) {
      for (const b of Object.keys(BUILDS) as Build[]) {
        expect(get(s, b).undecided, `${s}/${b}`).toEqual([]);
      }
    }
    // Sites the shape sweep listed on master, per build (void-method-call).
    for (const s of ["c1", "c3", "c7", "c7c", "c7d"] as const) {
      expect(get(s, "X").calls, `${s} [X]`).toContain("Foo(B)");
      expect(get(s, "none").calls, `${s} []`).not.toContain("Foo(B)");
    }
    expect(get("c5b", "X").calls).toEqual(["Foo(A)", "Foo(B)"]);
    expect(get("c6", "X").calls).toEqual(["Foo(B)"]);
    expect(get("c6", "none").calls).toEqual(["Foo(A)"]);
    // A unterminated statement before an empty or trivia-only #if still has its own site.
    for (const s of ["c2", "c2b"] as const) expect(refused(s, "X", "A")).toBe(false);
  });

  test("the admitted shapes keep EVERY site master generated, per build", () => {
    // Spec counts measured on master 0ef6652f ([] / [X] / [Y] / [X,Y]); the same numbers are the
    // expectations of scripts/r402-shape-sweep.ts. A rule that refused or dropped any of these
    // sites changes a count.
    const retained: Partial<Record<Shape, readonly [number, number, number, number]>> = {
      c1: [9, 10, 9, 10],
      c2: [6, 6, 6, 6],
      c2b: [6, 6, 6, 6],
      c3: [6, 7, 6, 7],
      c4: [5, 5, 5, 5],
      c4b: [7, 7, 7, 7],
      c5: [4, 4, 4, 4],
      c5b: [5, 6, 5, 6],
      c6: [9, 9, 9, 9],
      c7: [6, 7, 6, 7],
      c7c: [6, 7, 6, 7],
      c7d: [6, 7, 6, 7],
      // s4e here has a three-assignment repeat body; the sweep fixture's two-assignment s4e is the
      // one whose master count is checked (scripts/fixtures/r402/expected.json).
      s15: [5, 5, 5, 5],
      s16: [7, 8, 7, 8],
    };
    for (const [s, counts] of Object.entries(retained) as [Shape, readonly number[]][]) {
      const got = (Object.keys(BUILDS) as Build[]).map((b) => get(s, b).specs);
      expect(got, s).toEqual([...counts]);
    }
  });

  test("scope: only a statement-level container is judged; expression tails are never refused", () => {
    // A `preproc_conditional_expression_tail` follows an expression whose last leaf is not `;`
    // and its arm opens with `and`/`+`, so the rule WOULD refuse these if it judged every
    // container (the while, if and assignment tails; the call-argument, subscript and list ones).
    for (const s of ["s1", "s2", "s3", "s9", "s10", "s11", "s15", "s16"] as const) {
      for (const b of Object.keys(BUILDS) as Build[]) {
        expect(get(s, b).undecided, `${s}/${b}`).toEqual([]);
      }
    }
  });
});

describe("R402: the shapes R214 already refuses keep their marker-mismatch refusal", () => {
  test("S8 (operand prefix), S12 (nested tail) and S13 (#if/#else whole header)", () => {
    for (const s of ["s8", "s12", "s13"] as const) {
      for (const b of Object.keys(BUILDS) as Build[]) {
        const r = get(s, b);
        expect(r.undecided, `${s}/${b}`).toHaveLength(1);
        expect(r.undecided[0], `${s}/${b}`).toStartWith("marker-mismatch");
        expect(r.specs, `${s}/${b}`).toBe(0);
      }
    }
  });
});
