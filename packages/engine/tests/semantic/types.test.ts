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

  it("returns null for unresolvable identifiers", async () => {
    expect(
      await typeOfExitExpr(
        `codeunit 50303 "T" { procedure P(): Integer begin exit(UnknownVar); end; }`,
      ),
    ).toBeNull();
  });
});
