import { beforeAll, describe, expect, it } from "bun:test";
import { ALNodeKind } from "../../src/ast/node-kinds";
import { initParser, parseAL } from "../../src/ast/parser";
import { findFirst, wrapRoot } from "../../src/ast/syntax-node";
import type { ALSyntaxNode } from "../../src/ast/syntax-node";
import { buildSymbolTable } from "../../src/semantic/symbol-table";
import { buildTypeTable } from "../../src/semantic/types";

async function typeOfExitExpr(codeunitSrc: string): Promise<string | null> {
  const root = wrapRoot(parseAL(codeunitSrc));
  const symbols = buildSymbolTable([{ path: "t.al", root }]);
  const types = buildTypeTable([{ path: "t.al", root }], symbols);
  const exit = findFirst(root, ALNodeKind.exit_statement);
  if (exit === null) throw new Error("no exit_statement");
  // The exit's argument may be wrapped or be the first non-keyword namedChild.
  // Find the first non-keyword expression-shaped namedChild.
  let inner: ALSyntaxNode | null = null;
  for (const c of exit.namedChildren) {
    if (!c.kind.endsWith("_keyword") && !c.kind.endsWith("_operator") && c.rawKind !== ";") {
      inner = c;
      break;
    }
  }
  if (inner === null) throw new Error("no expression inside exit");
  // If the expression is parenthesized, unwrap
  if (inner.kind === ALNodeKind.parenthesized_expression && inner.namedChildren.length > 0) {
    inner = inner.namedChildren[0] ?? inner;
  }
  return types.typeOf(inner);
}

describe("buildTypeTable", () => {
  beforeAll(async () => {
    await initParser();
  });

  it("types a literal integer expression as Integer", async () => {
    expect(
      await typeOfExitExpr(`codeunit 50300 "T" { procedure P(): Integer begin exit(42); end; }`),
    ).toBe("Integer");
  });

  it("types a decimal literal as Decimal", async () => {
    expect(
      await typeOfExitExpr(`codeunit 50301 "T" { procedure P(): Decimal begin exit(1.5); end; }`),
    ).toBe("Decimal");
  });

  it("types a comparison as Boolean", async () => {
    expect(
      await typeOfExitExpr(`codeunit 50302 "T" { procedure P(): Boolean begin exit(1 > 0); end; }`),
    ).toBe("Boolean");
  });

  // R84. These four pin the WHOLE declared type as the type identity. Reverting `extractType` to
  // its first-token form turns the first three red and leaves the fourth green — the fourth is
  // here to prove the collapse is about SUBTYPES and not about text equality.
  it("keeps a Record's subtype, so two different records are two different types", async () => {
    expect(
      await typeOfExitExpr(
        `codeunit 50304 "T" { procedure P() var SalesHeader: Record "Sales Header"; begin exit(SalesHeader); end; }`,
      ),
    ).toBe('Record "Sales Header"');
  });

  it("keeps a Codeunit's subtype", async () => {
    expect(
      await typeOfExitExpr(
        `codeunit 50305 "T" { procedure P() var Mgt: Codeunit "Sales-Post"; begin exit(Mgt); end; }`,
      ),
    ).toBe('Codeunit "Sales-Post"');
  });

  it("keeps a generic type's parameter, so List of [Text] is not List of [Integer]", async () => {
    expect(
      await typeOfExitExpr(
        `codeunit 50306 "T" { procedure P() var Names: List of [Text]; begin exit(Names); end; }`,
      ),
    ).toBe("List of [Text]");
  });

  it("answers `Label` for a label, whatever its constant text", async () => {
    // Not a special case in `extractType`: the grammar's `type` field for a label declaration is
    // the bare word, and the constant is a sibling. Two labels with different text are the same
    // type, and this pins that they compare equal.
    expect(
      await typeOfExitExpr(
        `codeunit 50307 "T" { procedure P() var Msg: Label 'Posting...'; begin exit(Msg); end; }`,
      ),
    ).toBe("Label");
  });

  it("returns null for unresolvable identifiers", async () => {
    expect(
      await typeOfExitExpr(
        `codeunit 50303 "T" { procedure P(): Integer begin exit(UnknownVar); end; }`,
      ),
    ).toBeNull();
  });
});
