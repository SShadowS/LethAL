import { beforeAll, describe, expect, it } from "bun:test";
import {
  ALNodeKind,
  type MutationSpec,
  buildSemanticContext,
  findAll,
  initParser,
  parseAL,
  wrapRoot,
} from "@lethal/engine";
import { swapCallArguments } from "../src/swap-call-arguments";

function specsFor(src: string): readonly MutationSpec[] {
  const root = wrapRoot(parseAL(src));
  const ctx = buildSemanticContext([{ path: "t.al", root }]);
  return findAll(root, ALNodeKind.procedure_call)
    .filter((n) => swapCallArguments.targets(n, ctx))
    .flatMap((n) => swapCallArguments.generate(n, ctx));
}

const inProc = (decls: string, body: string): string =>
  `codeunit 50160 "T" { procedure P() var ${decls} begin ${body} end; }`;

describe("swapCallArguments", () => {
  beforeAll(async () => {
    await initParser();
  });

  it("swaps two same-typed locals and leaves everything else byte-identical", () => {
    const specs = specsFor(inProc("A: Integer; B: Integer;", "Foo(A, B);"));
    expect(specs).toHaveLength(1);
    const [spec] = specs;
    expect(spec?.before.text).toBe("Foo(A, B)");
    expect(spec?.after.text).toBe("Foo(B, A)");
    expect(spec?.operatorName).toBe("lethal.swap-call-arguments");
  });

  // The two-point splice. Names of DIFFERENT lengths are the whole point: splicing the earlier
  // span first shifts the later span's offsets and silently corrupts the output, and equal-length
  // names would hide it.
  it("splices correctly when the two arguments differ in length", () => {
    const specs = specsFor(inProc("Ab: Integer; Cdefghij: Integer;", "Foo(Ab, Cdefghij);"));
    expect(specs[0]?.after.text).toBe("Foo(Cdefghij, Ab)");
  });

  it("carries the text between the arguments through untouched, comments included", () => {
    const specs = specsFor(inProc("A: Integer; B: Integer;", "Foo(A, /* keep me */ B);"));
    expect(specs[0]?.after.text).toBe("Foo(B, /* keep me */ A)");
  });

  it("swaps the first qualifying pair only, one mutant per site", () => {
    // Three same-typed arguments admit three swaps; the counting rule says ONE, on (0, 1).
    const specs = specsFor(inProc("A: Integer; B: Integer; C: Integer;", "Foo(A, B, C);"));
    expect(specs).toHaveLength(1);
    expect(specs[0]?.after.text).toBe("Foo(B, A, C)");
  });

  it("skips a non-matching argument to pair the two that DO match", () => {
    const specs = specsFor(inProc("A: Integer; B: Integer; S: Text;", "Foo(A, S, B);"));
    expect(specs[0]?.after.text).toBe("Foo(B, S, A)");
  });

  it("claims a call in expression position, where most real sites are", () => {
    const specs = specsFor(inProc("A: Integer; B: Integer;", "if InRange(A, B) then exit;"));
    expect(specs).toHaveLength(1);
    expect(specs[0]?.parentContext).toBe("expression-position");
    expect(specs[0]?.after.text).toBe("InRange(B, A)");
  });

  // R84. The type table used to answer `Record` for both of these, and this operator is its first
  // consumer in the shipped pipeline — so THIS is where a truncated type identity would show up,
  // as an artifact that does not compile. Reverting `extractType` must turn this test red.
  it("refuses two records of DIFFERENT subtypes, whose truncated type heads match", () => {
    expect(
      specsFor(
        inProc(
          'Sales: Record "Sales Header"; Purch: Record "Purchase Header";',
          "Foo(Sales, Purch);",
        ),
      ),
    ).toHaveLength(0);
  });

  it("claims two records of the SAME subtype", () => {
    const specs = specsFor(
      inProc('First: Record "Sales Header"; Second: Record "Sales Header";', "Foo(First, Second);"),
    );
    expect(specs[0]?.after.text).toBe("Foo(Second, First)");
  });

  it("refuses two Code fields of different lengths — a runtime overflow, not a type match", () => {
    expect(
      specsFor(inProc("Wide: Code[20]; Narrow: Code[10];", "Foo(Wide, Narrow);")),
    ).toHaveLength(0);
  });

  // The `var`-parameter guard. A literal is not an lvalue, so if the callee's parameter in the
  // other position is `var`, the swapped call does not compile — and the callee is never resolved.
  it("refuses when either argument is a literal", () => {
    expect(specsFor(inProc("A: Integer;", "Foo(A, 1);"))).toHaveLength(0);
    expect(specsFor(inProc("A: Integer;", "Foo(1, A);"))).toHaveLength(0);
  });

  it("refuses when either argument is an expression rather than a bare variable", () => {
    expect(specsFor(inProc("A: Integer; B: Integer;", "Foo(A, B + 1);"))).toHaveLength(0);
    expect(specsFor(inProc("A: Integer; B: Integer;", "Foo(A, Compute(B));"))).toHaveLength(0);
  });

  it("refuses the same variable passed twice — swapped, it is the identical call", () => {
    expect(specsFor(inProc("A: Integer;", "Foo(A, A);"))).toHaveLength(0);
  });

  it("refuses a single-argument call and a no-argument call", () => {
    expect(specsFor(inProc("A: Integer;", "Foo(A);"))).toHaveLength(0);
    expect(specsFor(inProc("A: Integer;", "Foo();"))).toHaveLength(0);
  });

  it("refuses arguments whose type it cannot resolve", () => {
    expect(specsFor(inProc("A: Integer;", "Foo(Unknown1, Unknown2);"))).toHaveLength(0);
  });

  // The two shapes that falsify the doc comment's "two variables are lvalues" wording, pinned
  // because the operator is safe here by a DIFFERENT argument than the one written down, and an
  // adversarial review pointed out that nothing was holding the difference in place.
  //
  // A parameterless procedure called bare is not an lvalue, so it must never enter a `var` slot.
  // It is refused today only because the type table declines to type procedure names — a natural
  // future "improvement" would silently start claiming these. Then this goes red.
  it("refuses two bare parameterless procedure calls — not lvalues, whatever their type", () => {
    const src = `codeunit 50170 "T" { procedure P() begin Foo(GetA, GetB); end; procedure GetA(): Integer begin exit(1); end; procedure GetB(): Integer begin exit(2); end; }`;
    expect(specsFor(src)).toHaveLength(0);
  });

  // A Label is NOT assignable, so it is not an lvalue either — and it IS claimed (labels are 9.7%
  // of the sites the operator claims on a real project). That is correct, by the other half of the
  // safety argument: equal declared types plus "the call compiles today" means neither argument can
  // be sitting in a `var` slot to begin with, since AL would already have rejected the original.
  it("claims two labels, which are not lvalues — safe by the equal-types argument, not by lvalue-ness", () => {
    const src = `codeunit 50171 "T" { procedure P() var MsgA: Label 'Alpha'; MsgB: Label 'Beta'; begin Foo(MsgA, MsgB); end; }`;
    expect(specsFor(src)[0]?.after.text).toBe("Foo(MsgB, MsgA)");
  });

  it("resolves parameters and globals, not just locals", () => {
    const src = `codeunit 50161 "T" { var G: Integer; procedure P(Param: Integer) begin Foo(Param, G); end; }`;
    expect(specsFor(src)[0]?.after.text).toBe("Foo(G, Param)");
  });
});
