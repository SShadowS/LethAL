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

  // R295: Z is the SECOND name of `Y1, Z: Record T1`. Read as the global `Z: Record T2`, it looked
  // like Q's type and the swap was emitted; `alc` 18.0 rejects the mutated source with AL0133
  // (census synthetic app, both arguments).
  it("R295: refuses Take(Q, Z) when the later local name Z differs in type from Q", () => {
    const src = `codeunit 50172 "T" {
      var Z: Record "T2";
      procedure P() var Q: Record "T2"; Y1, Z: Record "T1"; begin Take(Q, Z); end; }`;
    expect(specsFor(src).map((s) => s.after.text)).toEqual([]);
  });

  // The positive half, so a fix that refuses every later name goes red.
  it("R295: swaps Take(Q, Z) when the later local name Z truly equals Q's type", () => {
    const src = `codeunit 50173 "T" {
      var Z: Text;
      procedure P() var Q: Integer; Y1, Z: Integer; begin Take(Q, Z); end; }`;
    expect(specsFor(src).map((s) => s.after.text)).toEqual(["Take(Z, Q)"]);
  });
});

// R455. In a record builtin's field-designator argument the receiver's FIELD wins over a local of
// the same name (alc 18.0.43: `R.SetRange(Amount, Value)` compiles and its swap is AL0166). So such
// an argument is never swapped, by method name and argument POSITION; value arguments still are.
describe("swapCallArguments: field-designator arguments (R455)", () => {
  beforeAll(async () => {
    await initParser();
  });

  const TABLE = `table 92800 "R455 T" { fields { field(1; Code; Code[20]) { } field(2; Amount; Decimal) { } field(3; Name; Text[50]) { } } keys { key(PK; Code) { Clustered = true; } } }`;
  const withTable = (decls: string, body: string): string =>
    `${TABLE}\ncodeunit 92800 "R455 C" { procedure P() var R: Record "R455 T"; ${decls} begin ${body} end; }`;
  const swaps = (decls: string, body: string): string[] =>
    specsFor(withTable(decls, body)).map((s) => s.after.text);

  // Same-typed locals, so only the field-designator rule refuses it: `Name` binds to the Text field.
  it("pin: R.Validate(Name, Other) with Integer locals is not swapped", () => {
    expect(swaps("Name: Integer; Other: Integer;", "R.Validate(Name, Other);")).toEqual([]);
  });

  it("pin: R.SetRange(Amount, Value) with Integer locals is not swapped", () => {
    expect(swaps("Amount: Integer; Value: Integer;", "R.SetRange(Amount, Value);")).toEqual([]);
  });

  // Documents the binding only: Integer `Name` and Text `T` already fail the same-type check.
  it("R.Validate(Name, T) with an Integer local Name: no swap (binding documentation)", () => {
    expect(swaps("Name: Integer; T: Text;", "R.Validate(Name, T);")).toEqual([]);
  });

  it("control: the two VALUE arguments of R.SetRange(F, A, B) are still swapped", () => {
    expect(swaps("F: Integer; A: Integer; B: Integer;", "R.SetRange(F, A, B);")).toEqual([
      "R.SetRange(F, B, A)",
    ]);
  });

  // Positions count over every argument expression: a quoted first argument is position 1.
  it('positions: R.SetRange("Field Name", A, B) swaps A and B', () => {
    expect(swaps("A: Integer; B: Integer;", 'R.SetRange("Field Name", A, B);')).toEqual([
      'R.SetRange("Field Name", B, A)',
    ]);
  });

  it("positions: a comment inside the arguments does not advance the count", () => {
    expect(swaps("F: Integer; A: Integer; B: Integer;", "R.SetRange(/* c */ F, A, B);")).toEqual([
      "R.SetRange(/* c */ F, B, A)",
    ]);
  });

  it("positions: a nested call is one argument, and is mutated on its own", () => {
    expect(
      swaps(
        "F: Integer; Fmt: Text; A: Integer; B: Integer; C: Integer; D: Integer;",
        "R.SetFilter(F, StrSubstNo(Fmt, A, B), C, D);",
      ),
    ).toEqual(["R.SetFilter(F, StrSubstNo(Fmt, A, B), D, C)", "StrSubstNo(Fmt, B, A)"]);
  });

  it("CopyFilter names a field at positions 1 AND 3", () => {
    expect(
      swaps('F: Integer; Dest: Record "R455 T"; G: Integer;', "R.CopyFilter(F, Dest, G);"),
    ).toEqual([]);
  });

  // Every listed method, called with three same-typed locals. A position-1 method keeps the
  // (2, 3) swap; an every-position method loses all of them. Method names compare without case.
  const FIRST = [
    "SetRange",
    "SetFilter",
    "Validate",
    "TestField",
    "FieldError",
    "FieldNo",
    "FieldCaption",
    "FieldName",
    "FieldActive",
    "GetFilter",
    "GetRangeMin",
    "GetRangeMax",
    "ModifyAll",
    "setrange",
  ];
  const EVERY = [
    "CalcFields",
    "CalcSums",
    "SetLoadFields",
    "AddLoadFields",
    "SetCurrentKey",
    "SetAutoCalcFields",
  ];
  for (const m of FIRST) {
    it(`table: ${m} names a field at position 1 only`, () => {
      expect(swaps("A: Integer; B: Integer; C: Integer;", `R.${m}(A, B, C);`)).toEqual([
        `R.${m}(A, C, B)`,
      ]);
    });
  }
  for (const m of EVERY) {
    it(`table: ${m} names a field at every position`, () => {
      expect(swaps("A: Integer; B: Integer; C: Integer;", `R.${m}(A, B, C);`)).toEqual([]);
    });
  }

  // By name, so an unqualified call against an implicit record is covered too.
  it("an unqualified SetRange(Amount, Value) in a page with SourceTable is not swapped", () => {
    const src = `${TABLE}\npage 92800 "R455 P" { SourceTable = "R455 T"; procedure P() var Amount: Integer; Value: Integer; begin SetRange(Amount, Value); end; }`;
    expect(specsFor(src).map((s) => s.after.text)).toEqual([]);
  });

  it("control: a non-builtin call Take(A, B) still swaps", () => {
    expect(swaps("A: Integer; B: Integer;", "Take(A, B);")).toEqual(["Take(B, A)"]);
  });

  // AL names ignore case: `ID` and `Id` are one variable, so the swap is the identical call. A
  // non-builtin callee, so the field table cannot be what refuses it.
  it("case: Take(ID, Id) is not swapped", () => {
    expect(swaps("ID: Integer;", "Take(ID, Id);")).toEqual([]);
  });

  it("quoted arguments stay ineligible", () => {
    expect(swaps('"My A": Integer; "My B": Integer;', 'Take("My A", "My B");')).toEqual([]);
  });
});
