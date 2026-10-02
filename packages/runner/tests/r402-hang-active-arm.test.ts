import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initParser } from "@lethal/engine";
import { generateMutationSet } from "../src/orchestrator";

/**
 * R402 (plan `docs/superpowers/plans/2026-10-02-R-402-hang-tag-active-arm-operands.md`, r3):
 * - the hang tag reads loop-condition operands in ACTIVE `#if` arms and skips inactive ones;
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
  s14: `#if LETHALX\n        while (B < 5) do\n            B := B + 1;\n#endif\n        A := A + 1;`,
  s4: `${REPEAT_HEAD}\n#if LETHALX\n            or (B > 5)\n#endif\n        ;`,
  s4b: `${REPEAT_HEAD}\n#if LETHALX\n            or (B > 5)\n#else\n#endif\n        ;`,
  s4c: `${REPEAT_HEAD}\n#if LETHALX\n            or (B > 5) or (C > 3)\n#endif\n        ;`,
  s4d: `${REPEAT_HEAD}\n#if LETHALX\n            or (B > 5)\n#if LETHALY\n            or (C > 3)\n#endif\n#endif\n        ;`,
  c7b: `${REPEAT_HEAD} // tail follows\n#if LETHALX\n            or (B > 5)\n#endif\n        ;`,
  c8: `${REPEAT_HEAD}\n#if LETHALX\n            or (B > 5)\n#elif LETHALY\n            or (C > 3)\n#endif\n        ;`,
  s4e: `${REPEAT_HEAD};\n#if LETHALX\n        Foo(B);\n#endif`,
  c1: `        if A < 10 then A := A + 1;\n#if LETHALX\n        Foo(B);\n#endif\n        C := C + 1;`,
  c2: `        A := A + 1\n#if LETHALX\n#endif\n`,
  c2b: `        A := A + 1\n#if LETHALX\n        // nothing here\n#endif\n`,
  c3: `        A := A + 1\n#if LETHALX\n        ; Foo(B)\n#endif\n        ;`,
  c4: `        if A < 10 then\n#if LETHALX\n            Foo(B)\n#else\n            Foo(A)\n#endif\n        ;`,
  c4b: `        if A < 10 then\n            A := 1\n        else\n#if LETHALX\n            Foo(B)\n#else\n            Foo(A)\n#endif\n        ;`,
  c5: `        case A of\n            1:\n#if LETHALX\n                Foo(B);\n#else\n                Foo(A);\n#endif\n        end;`,
  c5b: `        case A of\n            1:\n                Foo(A);\n#if LETHALX\n            2:\n                Foo(B);\n#endif\n        end;`,
  c6: `        A := A + 1;\n#if LETHALX\n        Foo(B);\n#else\n        Foo(A);\n#endif\n        C := C + 1;`,
  c7: `        A := A + 1; // done\n#if LETHALX\n        Foo(B);\n#endif`,
  c7c: `        A := A + 1;\n#pragma warning disable AA0001\n#if LETHALX\n        Foo(B);\n#endif\n#pragma warning restore AA0001`,
  c7d: `        A := A + 1;\n#region R\n#if LETHALX\n        Foo(B);\n#endif\n#endregion`,
} as const;
type Shape = keyof typeof SHAPES;
const BUILDS = { none: [], X: ["LETHALX"], Y: ["LETHALY"] } as const;
type Build = keyof typeof BUILDS;

type Result = {
  /** `remove-assignment` sites by assigned variable: true when hang-tagged. */
  assigns: Map<string, boolean[]>;
  calls: string[];
  undecided: string[];
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
      undecided: set.preprocExcluded
        .filter((e) => e.reason === "preproc-undecided")
        .map((e) => e.detail ?? ""),
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
/** The ONE `remove-assignment` site on `v`, asserted to exist; returns whether it is hang-tagged. */
const tagged = (shape: Shape, build: Build, v: string): boolean => {
  const sites = get(shape, build).assigns.get(v) ?? [];
  expect(sites, `${shape}/${build}: remove-assignment on ${v}`).toHaveLength(1);
  return sites[0] === true;
};

describe("R402: the hang tag reads operands in ACTIVE #if arms of a loop condition", () => {
  test("S1: an `and (B < 5)` tail beside a while condition", () => {
    expect([tagged("s1", "none", "A"), tagged("s1", "none", "B")]).toEqual([true, false]);
    expect([tagged("s1", "X", "A"), tagged("s1", "X", "B")]).toEqual([true, true]);
  });

  test("S2: #if / #elif tails, each arm with its own variable", () => {
    expect([tagged("s2", "X", "B"), tagged("s2", "X", "C")]).toEqual([true, false]);
    expect([tagged("s2", "Y", "B"), tagged("s2", "Y", "C")]).toEqual([false, true]);
    expect([tagged("s2", "none", "B"), tagged("s2", "none", "C")]).toEqual([false, false]);
  });

  test("S3: an `#if not` tail is active in the build WITHOUT the symbol", () => {
    expect(tagged("s3", "none", "B")).toBe(true);
    expect(tagged("s3", "X", "B")).toBe(false);
  });

  test("S3b: a directive condition spelled like a variable is never read as an operand", () => {
    expect(tagged("s3b", "none", "B")).toBe(false);
    expect(tagged("s3b", "none", "C")).toBe(false);
  });

  test("S9-S11: tails inside call arguments, subscripts and list elements are read only when active", () => {
    for (const s of ["s9", "s10", "s11"] as const) {
      expect(tagged(s, "none", "B"), `${s} []`).toBe(false);
      expect(tagged(s, "X", "B"), `${s} [X]`).toBe(true);
    }
  });

  test("S14: a whole loop under a statement-level #if is tagged in its own build", () => {
    expect(tagged("s14", "X", "B")).toBe(true);
    expect(get("s14", "none").assigns.get("B")).toBeUndefined();
  });
});

describe("R402: a statement-level #if that continues an unterminated statement refuses its file", () => {
  test("S4, S4b, S4c, S4d, c7b and c8 are refused in every build, by name", () => {
    for (const s of ["s4", "s4b", "s4c", "s4d", "c7b", "c8"] as const) {
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
    for (const s of ["c2", "c2b"] as const) expect(tagged(s, "X", "A")).toBe(false);
  });
});
