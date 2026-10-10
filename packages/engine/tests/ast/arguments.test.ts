import { beforeAll, describe, expect, it } from "bun:test";
/**
 * R567: `argumentList` and `argumentsReadable`, the ONE comment-aware argument reader every
 * consumer that reads a call's or an attribute's arguments goes through.
 */
import { argumentList, argumentsReadable, countArguments } from "../../src/ast/arguments";
import { initParser, parseAL } from "../../src/ast/parser";
import { type ALSyntaxNode, visit, wrapRoot } from "../../src/ast/syntax-node";

beforeAll(async () => {
  await initParser();
});

/** The first node of raw kind `kind` in a codeunit whose procedure body is `body`. */
function first(body: string, kind: string, attribute = ""): ALSyntaxNode {
  const src = `codeunit 50100 X\n{\n${attribute}\n    procedure P()\n    begin\n${body}\n    end;\n}\n`;
  let hit: ALSyntaxNode | undefined;
  visit(wrapRoot(parseAL(src)), (n: ALSyntaxNode) => {
    if (hit === undefined && n.rawKind === kind) hit = n;
  });
  if (hit === undefined) throw new Error(`no ${kind}`);
  return hit;
}
const texts = (ns: readonly ALSyntaxNode[]): string[] => ns.map((n) => n.text);

describe("R567: argumentList", () => {
  it("no trivia: every argument", () => {
    const c = first("F(A, B);", "call_expression");
    expect(texts(argumentList(c))).toEqual(["A", "B"]);
    expect(argumentsReadable(c)).toBe(true);
  });
  it("a block comment before an argument is removed", () => {
    const c = first("F(/*c*/ A, B);", "call_expression");
    expect(texts(argumentList(c))).toEqual(["A", "B"]);
    expect(argumentsReadable(c)).toBe(true);
  });
  it("a trailing block comment is removed", () => {
    const c = first("F(xRec /*c*/);", "call_expression");
    expect(texts(argumentList(c))).toEqual(["xRec"]);
    expect(argumentsReadable(c)).toBe(true);
  });
  it("a line comment is removed", () => {
    const c = first("F(A, // why\n B);", "call_expression");
    expect(texts(argumentList(c))).toEqual(["A", "B"]);
    expect(argumentsReadable(c)).toBe(true);
  });
  it("a comment-only list is empty and readable", () => {
    const c = first("F(/*c*/);", "call_expression");
    expect(argumentList(c)).toEqual([]);
    expect(argumentsReadable(c)).toBe(true);
  });
  it("a pragma among the arguments stays in, and the list is unreadable", () => {
    const c = first("F(A,\n#pragma warning disable AA0001\n B);", "call_expression");
    expect(texts(argumentList(c))).toEqual(["A", "#pragma warning disable AA0001", "B"]);
    expect(countArguments(c)).toBe(2);
    expect(argumentsReadable(c)).toBe(false);
  });
  it("a call with no argument list (a call_statement) is empty and readable", () => {
    const c = first("F;", "call_statement");
    expect(argumentList(c)).toEqual([]);
    expect(argumentsReadable(c)).toBe(true);
  });
  it("the list node itself is read too", () => {
    const c = first("F(/*c*/ A, B);", "argument_list");
    expect(texts(argumentList(c))).toEqual(["A", "B"]);
    expect(countArguments(c)).toBe(2);
  });
  it("an attribute is read through its attribute_argument_list node", () => {
    const attr =
      "    [EventSubscriber(ObjectType::Table, /*c*/ Database::Customer, 'OnAfterInsertEvent', '', false, false)]";
    const l = first("", "attribute_argument_list", attr);
    expect(texts(argumentList(l))).toEqual([
      "ObjectType::Table",
      "Database::Customer",
      "'OnAfterInsertEvent'",
      "''",
      "false",
      "false",
    ]);
    expect(countArguments(l)).toBe(6);
    expect(argumentsReadable(l)).toBe(true);
  });
  it("an attribute with a pragma among its arguments is unreadable", () => {
    const attr =
      "    [EventSubscriber(ObjectType::Table,\n#pragma warning disable AL0432\n Database::Customer, 'OnAfterInsertEvent', '', false, false)]";
    expect(argumentsReadable(first("", "attribute_argument_list", attr))).toBe(false);
  });
});
