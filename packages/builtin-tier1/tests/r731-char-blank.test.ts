import { beforeAll, describe, expect, it } from "bun:test";
import {
  ALNodeKind,
  buildSemanticContext,
  findAll,
  initParser,
  parseAL,
  wrapRoot,
} from "@lethal/engine";
import { toggleBlankString } from "../src/toggle-blank-string";

/** R731: `Ch := ''` and `T[1] := ''` are AL0122 (alc, measured offline 2026-10-24); `Ch = ''` is fine. */
function specsOf(src: string): string[] {
  const root = wrapRoot(parseAL(src));
  const ctx = buildSemanticContext([{ path: "fixture.al", root }]);
  return findAll(root, ALNodeKind.text_literal)
    .filter((n) => toggleBlankString.targets(n, ctx))
    .flatMap((n) => toggleBlankString.generate(n, ctx))
    .map((s) => `${s.before.text} -> ${s.after.text}`);
}

const proc = (vars: string, body: string, extra = ""): string =>
  `codeunit 50731 R731 { ${extra} procedure P(${vars}) begin ${body} end; }`;

describe("R731: no blanking of a one-character literal that may be a Char", () => {
  beforeAll(async () => {
    await initParser();
  });

  it("refuses an element of a Text variable", () => {
    const src = `codeunit 50731 R731 { procedure P() var T: Text[10]; begin T[1] := 'x'; end; }`;
    expect(specsOf(src)).toEqual([]);
  });

  it("refuses an element of a Code variable", () => {
    const src = `codeunit 50731 R731 { procedure P() var C: Code[10]; begin C[1] := 'X'; end; }`;
    expect(specsOf(src)).toEqual([]);
  });

  it("refuses a local Char", () => {
    const src = `codeunit 50731 R731 { procedure P() var Ch: Char; begin Ch := 'x'; end; }`;
    expect(specsOf(src)).toEqual([]);
  });

  it("refuses a Char parameter", () => {
    expect(specsOf(proc("var Ch: Char", "Ch := 'x';"))).toEqual([]);
  });

  it("refuses a global Char", () => {
    const src = `codeunit 50731 R731 { var Ch: Char; procedure P() begin Ch := 'x'; end; }`;
    expect(specsOf(src)).toEqual([]);
  });

  it("refuses a named Char return value", () => {
    const src = `codeunit 50731 R731 { procedure P() Ret: Char begin Ret := 'x'; end; }`;
    expect(specsOf(src)).toEqual([]);
  });

  it("refuses the escaped quote, which is one character", () => {
    const src = `codeunit 50731 R731 { procedure P() var Ch: Char; begin Ch := ''''; end; }`;
    expect(specsOf(src)).toEqual([]);
  });

  it("refuses a target whose type is unknown (fail closed)", () => {
    const src = `codeunit 50731 R731 { procedure P() begin Unknown := 'x'; end; }`;
    expect(specsOf(src)).toEqual([]);
  });

  it("still blanks a one-character literal assigned to a Text (over-refusal guard)", () => {
    const src = `codeunit 50731 R731 { procedure P() var T: Text[10]; begin T := 'x'; end; }`;
    expect(specsOf(src)).toEqual(["'x' -> ''"]);
  });

  it("still blanks a one-character literal assigned to a Code", () => {
    const src = `codeunit 50731 R731 { procedure P() var C: Code[10]; begin C := 'X'; end; }`;
    expect(specsOf(src)).toEqual(["'X' -> ''"]);
  });

  it("still blanks a longer literal assigned to a Text and to a Code", () => {
    const src = `codeunit 50731 R731 { procedure P() var T: Text[10]; C: Code[10]; begin T := 'xy'; C := 'AB'; end; }`;
    expect(specsOf(src)).toEqual(["'xy' -> ''", "'AB' -> ''"]);
  });

  it("still blanks a two-character literal even when the target's type is unknown (cannot be a Char)", () => {
    const src = `codeunit 50731 R731 { procedure P() begin Unknown := 'xy'; end; }`;
    expect(specsOf(src)).toEqual(["'xy' -> ''"]);
  });

  it("still un-blanks '' assigned to a Text (the other direction)", () => {
    const src = `codeunit 50731 R731 { procedure P() var T: Text[10]; begin T := ''; end; }`;
    expect(specsOf(src)).toEqual(["'' -> 'x'"]);
  });

  it("still blanks a one-character literal assigned to a record field (a field is never Char: AL0156)", () => {
    const src = `codeunit 50731 R731 { procedure P() var R: Record Customer; begin R.Name := 'x'; end; }`;
    expect(specsOf(src)).toEqual(["'x' -> ''"]);
  });

  it("still blanks a comparison against a Char: alc accepts `Ch = ''` (measured)", () => {
    const src = `codeunit 50731 R731 { procedure P() var Ch: Char; T: Text[5]; begin if Ch = 'x' then exit; if T[1] = 'y' then exit; end; }`;
    expect(specsOf(src)).toEqual(["'x' -> ''", "'y' -> ''"]);
  });
});

/** R752: several files in one project; the specs of every file, in file order. */
function specsOfFiles(srcs: string[]): string[] {
  const files = srcs.map((s, i) => ({ path: `f${i}.al`, root: wrapRoot(parseAL(s)) }));
  const ctx = buildSemanticContext(files);
  return files.flatMap((f) =>
    findAll(f.root, ALNodeKind.text_literal)
      .filter((n) => toggleBlankString.targets(n, ctx))
      .flatMap((n) => toggleBlankString.generate(n, ctx))
      .map((s) => `${s.before.text} -> ${s.after.text}`),
  );
}

const TBL = (extra = "") =>
  `table 50752 T752 { fields { field(1; "No."; Code[20]) { } field(2; Name; Text[30]) { } } ${extra} }`;

describe("R752: a bare field of the implicit project record is never a Char", () => {
  beforeAll(async () => {
    await initParser();
  });

  it("T1: blanks a bare own field in a table trigger and a table procedure", () => {
    const src = TBL(
      `trigger OnInsert() begin "No." := 'Z'; end; procedure P() begin Name := 'Y'; end;`,
    );
    expect(specsOfFiles([src])).toEqual(["'Z' -> ''", "'Y' -> ''"]);
  });

  it("T2: a Char local with the field's name still wins: refused", () => {
    const src = TBL(`trigger OnInsert() var Name: Char; begin Name := 'Z'; end;`);
    expect(specsOfFiles([src])).toEqual([]);
  });

  // typeOf is null in these two (a `with` body; a page global under an implicit record), so only
  // rule 3 (the name is provably undeclared) keeps a Char of the field's name refused.
  it("T2w: a Char local with the field's name inside `with R do`: refused", () => {
    const cu = `codeunit 50758 C758 { procedure P() var R: Record T752; Name: Char; begin with R do Name := 'Z'; end; }`;
    expect(specsOfFiles([TBL(), cu])).toEqual([]);
  });

  it("T3p: a page global Char with the field's name: refused", () => {
    const page = `page 50755 P755 { SourceTable = T752; layout { } var Name: Char; trigger OnOpenPage() begin Name := 'Z'; end; }`;
    expect(specsOfFiles([TBL(), page])).toEqual([]);
  });

  it("T2b: a Char parameter with the field's name: refused", () => {
    const src = TBL(`procedure P(Name: Char) begin Name := 'Z'; end;`);
    expect(specsOfFiles([src])).toEqual([]);
  });

  it("T3: a table global Char with the field's name: refused", () => {
    const src = TBL(`var Name: Char; procedure P() begin Name := 'Z'; end;`);
    expect(specsOfFiles([src])).toEqual([]);
  });

  it("T4a: a tableextension on a project table blanks an added and a base field", () => {
    const ext = `tableextension 50753 E752 extends T752 { fields { field(50000; Extra; Code[10]) { } } trigger OnInsert() begin Extra := 'Z'; Name := 'Y'; end; }`;
    expect(specsOfFiles([TBL(), ext])).toEqual(["'Z' -> ''", "'Y' -> ''"]);
  });

  it("T4b: a tableextension on a table outside the project: refused", () => {
    const ext = `tableextension 50754 E754 extends Customer { fields { field(50000; Extra; Code[10]) { } } trigger OnInsert() begin Extra := 'Z'; end; }`;
    expect(specsOfFiles([ext])).toEqual([]);
  });

  it("T4c: the base table declares a global with the field's name: refused", () => {
    const base = TBL("var Extra: Char;");
    const ext = `tableextension 50753 E752 extends T752 { fields { field(50000; Extra; Code[10]) { } } trigger OnInsert() begin Extra := 'Z'; end; }`;
    expect(specsOfFiles([base, ext])).toEqual([]);
  });

  it("T5a: a page with a project SourceTable blanks a bare field", () => {
    const page = `page 50755 P755 { SourceTable = T752; layout { } trigger OnOpenPage() begin Name := 'Z'; end; }`;
    expect(specsOfFiles([TBL(), page])).toEqual(["'Z' -> ''"]);
  });

  it("T5b: a page global Char that is not a field: refused", () => {
    const page = `page 50755 P755 { SourceTable = T752; layout { } var Ch: Char; trigger OnOpenPage() begin Ch := 'Z'; end; }`;
    expect(specsOfFiles([TBL(), page])).toEqual([]);
  });

  it("T5c: a pageextension (table unknown): refused", () => {
    const pe = `pageextension 50756 PE756 extends P755 { trigger OnOpenPage() begin Name := 'Z'; end; }`;
    const page = "page 50755 P755 { SourceTable = T752; layout { } }";
    expect(specsOfFiles([TBL(), page, pe])).toEqual([]);
  });

  it("T6a: a TableNo codeunit's OnRun blanks a bare field", () => {
    const cu = `codeunit 50757 C757 { TableNo = T752; trigger OnRun() begin Name := 'Z'; end; }`;
    expect(specsOfFiles([TBL(), cu])).toEqual(["'Z' -> ''"]);
  });

  it("T6b: a global Char in another procedure of that codeunit: refused", () => {
    const cu = `codeunit 50757 C757 { TableNo = T752; var Ch: Char; procedure P() begin Ch := 'Z'; end; }`;
    expect(specsOfFiles([TBL(), cu])).toEqual([]);
  });
});
