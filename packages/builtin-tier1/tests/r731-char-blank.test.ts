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
