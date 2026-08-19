import { beforeAll, describe, expect, it } from "bun:test";
import type { ALSyntaxNode } from "../../src";
import {
  ALNodeKind,
  findEnclosingCodeBlock,
  findEnclosingProcedure,
  findEnclosingStatement,
  findFirst,
  initParser,
  isStatementPosition,
  isStatementSlot,
  parseAL,
  visit,
  wrapRoot,
} from "../../src";

describe("tree-walks", () => {
  beforeAll(async () => {
    await initParser();
  });

  it("findEnclosingStatement returns narrowest statement ancestor", () => {
    const src = `codeunit 51100 "T" { procedure P(A: Integer) begin if A > 0 then X := A + 1; end; }`;
    const root = wrapRoot(parseAL(src));
    const additive = findFirst(root, ALNodeKind.additive_expression);
    if (additive === null) throw new Error("no additive_expression");
    const stmt = findEnclosingStatement(additive);
    expect(stmt).not.toBeNull();
    expect(stmt?.kind).toBe(ALNodeKind.assignment_statement);
  });

  it("findEnclosingStatement treats call_expression-inside-code_block as a statement", () => {
    const src = `codeunit 51101 "T" { procedure P() begin DoThing(42); end; }`;
    const root = wrapRoot(parseAL(src));
    let integerNode = null as ReturnType<typeof findFirst>;
    visit(root, (n) => {
      if (integerNode === null && n.kind === ALNodeKind.integer_literal && n.text === "42")
        integerNode = n;
    });
    if (integerNode === null) throw new Error("no integer literal");
    const stmt = findEnclosingStatement(integerNode);
    expect(stmt).not.toBeNull();
    expect(stmt?.kind).toBe(ALNodeKind.procedure_call);
    expect(stmt?.text).toBe("DoThing(42)");
  });

  it("findEnclosingProcedure returns the procedure node", () => {
    const src = `codeunit 51102 "T" { procedure P(A: Integer): Integer begin exit(A + 1); end; }`;
    const root = wrapRoot(parseAL(src));
    const additive = findFirst(root, ALNodeKind.additive_expression);
    if (additive === null) throw new Error("no additive_expression");
    const proc = findEnclosingProcedure(additive);
    expect(proc?.kind).toBe(ALNodeKind.procedure);
    expect(proc?.childForFieldName("name")?.text).toBe("P");
  });

  it("findEnclosingCodeBlock returns narrowest code_block ancestor", () => {
    const src = `codeunit 51103 "T" { procedure P(A: Integer) begin if A > 0 then begin X := 1; end; end; }`;
    const root = wrapRoot(parseAL(src));
    const assign = findFirst(root, ALNodeKind.assignment_statement);
    if (assign === null) throw new Error("no assignment");
    const block = findEnclosingCodeBlock(assign);
    expect(block?.kind).toBe(ALNodeKind.block);
    expect(block?.text.trim().startsWith("begin")).toBe(true);
    expect(block?.text).not.toContain("A > 0");
  });

  it("returns null when no ancestor matches", () => {
    const src = `codeunit 51104 "T" { procedure P() begin end; }`;
    const root = wrapRoot(parseAL(src));
    expect(findEnclosingProcedure(root)).toBeNull();
    expect(findEnclosingStatement(root)).toBeNull();
    expect(findEnclosingCodeBlock(root)).toBeNull();
  });

  it("isStatementPosition accepts a call directly inside a block's statement list", async () => {
    const root = wrapRoot(parseAL("codeunit 50000 T { procedure P() begin Foo(); end; }"));
    const calls: ALSyntaxNode[] = [];
    visit(root, (n) => {
      if (n.kind === ALNodeKind.procedure_call) calls.push(n);
    });
    expect(calls.length).toBe(1);
    expect(isStatementPosition(calls[0] as ALSyntaxNode)).toBe(true);
  });

  it("isStatementPosition rejects a call that is an if-branch, not a statement-list member", async () => {
    const root = wrapRoot(
      parseAL("codeunit 50000 T { procedure P() begin if X then Foo(); end; }"),
    );
    const calls: ALSyntaxNode[] = [];
    visit(root, (n) => {
      if (n.kind === ALNodeKind.procedure_call && n.text.startsWith("Foo")) calls.push(n);
    });
    expect(calls.length).toBe(1);
    expect(isStatementPosition(calls[0] as ALSyntaxNode)).toBe(false);
  });
  /**
   * R161. `isStatementSlot` is a STRICT superset of `isStatementPosition`, and the six operators
   * that guard on it gained 1,280 sites on `do-rel2/Cloud` with 0 lost. Each slot below is a
   * grammar field name read off a real parse, not guessed, and each negative is a position where
   * admitting a statement would be wrong.
   */
  const firstNamed = (src: string, text: string): ALSyntaxNode => {
    const root = wrapRoot(parseAL(src));
    const hits: ALSyntaxNode[] = [];
    visit(root, (n) => {
      if (n.kind === ALNodeKind.procedure_call && n.text.startsWith(text)) hits.push(n);
    });
    const first = hits[0];
    if (first === undefined) throw new Error(`no call starting ${text} in ${src}`);
    return first;
  };

  const SLOT_CASES: readonly [string, string][] = [
    ["un-braced then-branch", "codeunit 50001 T { procedure P() begin if X then Foo(); end; }"],
    [
      "un-braced else-branch",
      "codeunit 50002 T { procedure P() begin if X then Bar() else Foo(); end; }",
    ],
    ["case-arm body", "codeunit 50003 T { procedure P() begin case X of 1: Foo(); end; end; }"],
    ["while body", "codeunit 50004 T { procedure P() begin while X do Foo(); end; }"],
    ["for body", "codeunit 50005 T { procedure P() begin for I := 1 to 3 do Foo(); end; }"],
    ["foreach body", "codeunit 50006 T { procedure P() begin foreach I in L do Foo(); end; }"],
  ];

  for (const [name, src] of SLOT_CASES) {
    it(`isStatementSlot accepts a call in a ${name}, where isStatementPosition refuses`, () => {
      const call = firstNamed(src, "Foo");
      expect(isStatementSlot(call)).toBe(true);
      expect(isStatementPosition(call)).toBe(false);
    });
  }

  it("isStatementSlot still accepts an ordinary statement-list member", () => {
    const call = firstNamed("codeunit 50007 T { procedure P() begin Foo(); end; }", "Foo");
    expect(isStatementSlot(call)).toBe(true);
    expect(isStatementPosition(call)).toBe(true);
  });

  const NON_SLOT_CASES: readonly [string, string][] = [
    ["an if condition", "codeunit 50008 T { procedure P() begin if Foo() then Bar(); end; }"],
    ["an argument", "codeunit 50009 T { procedure P() begin Bar(Foo()); end; }"],
    ["an assignment right-hand side", "codeunit 50010 T { procedure P() begin X := Foo(); end; }"],
    [
      "a case pattern",
      "codeunit 50011 T { procedure P() begin case X of Foo(): Bar(); end; end; }",
    ],
    [
      "a repeat until condition",
      "codeunit 50012 T { procedure P() begin repeat Bar(); until Foo(); end; }",
    ],
  ];

  for (const [name, src] of NON_SLOT_CASES) {
    it(`isStatementSlot refuses a call in ${name}`, () => {
      const call = firstNamed(src, "Foo");
      expect(isStatementSlot(call)).toBe(false);
    });
  }
});
