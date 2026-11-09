import { beforeAll, describe, expect, it } from "bun:test";
import { type ALSyntaxNode, type SemanticContext, findAll, initParser } from "@lethal/engine";
import { swapEnumMember } from "../src/swap-enum-member";
import { contextFor, parseClean } from "./parse-clean";

/**
 * R883 A: an enum member named like an AL keyword was written back unquoted (`Kind::or`), which
 * alc rejects (AL0107/AL0224/AL0104). Invented AL only.
 */
function afters(sourceAL: string): string[] {
  const root = parseClean(sourceAL);
  const ctx: SemanticContext = contextFor(root);
  const nodes: ALSyntaxNode[] = findAll(root, "identifier").concat(
    findAll(root, "qualified_enum_value" as never),
  );
  return nodes
    .filter((n) => swapEnumMember.targets(n, ctx))
    .flatMap((n) => swapEnumMember.generate(n, ctx))
    .map((s) => s.after.text);
}

describe("swapEnumMember quotes a keyword member", () => {
  beforeAll(async () => {
    await initParser();
  });

  it('emits Kind::"or" and Kind::"and", never the bare keyword', () => {
    const got = afters(
      `enum 50400 "Kind" { value(0; "and") { } value(1; "or") { } }
codeunit 50401 "C" { procedure P(): Enum "Kind" begin exit("Kind"::"and"); end; procedure Q(): Enum "Kind" begin exit("Kind"::"or"); end; }`,
    );
    expect(got).toEqual(['"Kind"::"or"', '"Kind"::"and"']);
  });

  it("quotes a member declared bare when it is a keyword, and one with a space", () => {
    const got = afters(
      `enum 50402 "K2" { value(0; Plain) { } value(1; or) { } value(2; "Two Words") { } }
codeunit 50403 "C" { procedure P(): Enum "K2" begin exit("K2"::Plain); end; }`,
    );
    expect(got).toEqual(['"K2"::"or"']);
  });

  it("keeps a plain member unquoted", () => {
    const got = afters(
      `enum 50404 "K3" { value(0; A) { } value(1; B) { } }
codeunit 50405 "C" { procedure P(): Enum "K3" begin exit("K3"::A); end; }`,
    );
    expect(got).toEqual(['"K3"::B']);
  });
});
