import { describe, it, expect, beforeAll } from "bun:test";
import { initParser, parseAL } from "../../src/ast/parser";
import { wrapRoot, findFirst, visit } from "../../src/ast/syntax-node";
import { canonicalize, type CanonicalForm } from "../../src/ast/canonicalization";
import { ALNodeKind, isBinaryExpressionKind } from "../../src/ast/node-kinds";
import type { ALSyntaxNode } from "../../src/ast/syntax-node";

describe("canonicalize", () => {
  beforeAll(async () => {
    await initParser();
  });

  function canon(expressionInCodeunit: string): CanonicalForm {
    const src = `codeunit 50200 "T" { procedure P(): Boolean begin exit(${expressionInCodeunit}); end; }`;
    const root = wrapRoot(parseAL(src));
    const exit = findFirst(root, ALNodeKind.exit_statement)!;
    // Find the first expression inside exit that is either a binary-family
    // expression or a unary expression.
    let target: ALSyntaxNode | null = null;
    visit(exit, (n) => {
      if (target !== null) return;
      if (isBinaryExpressionKind(n.kind) || n.kind === ALNodeKind.unary_expression) {
        target = n;
      }
    });
    if (target === null) throw new Error("no binary/unary expression found inside exit");
    return canonicalize(target);
  }

  it("strips parentheses that do not affect precedence", () => {
    const a = canon("(1 + 2)");
    const b = canon("1 + 2");
    expect(a.form).toBe(b.form);
  });

  it("normalizes double-negation", () => {
    const a = canon("not not true");
    const b = canon("not true");
    // a collapses `not not X` to X; b is `not X`. Their canonical forms differ.
    expect(a.form).not.toBe(b.form);
    const c = canon("not not (x > 0)");
    const d = canon("x > 0");
    expect(c.form).toBe(d.form);
  });

  it("treats commutative operators in canonical operand order", () => {
    const a = canon("1 * x");
    const b = canon("x * 1");
    expect(a.form).toBe(b.form);
  });

  it("does NOT reorder operands of `+` (unsound for Text concat)", () => {
    const a = canon("'a' + 'b'");
    const b = canon("'b' + 'a'");
    expect(a.form).not.toBe(b.form);
  });

  it("does NOT equate non-equivalent expressions", () => {
    const a = canon("1 + 2");
    const b = canon("1 + 3");
    expect(a.form).not.toBe(b.form);
  });
});
