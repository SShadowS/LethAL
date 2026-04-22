import { describe, it, expect, beforeAll } from "bun:test";
import {
  ALNodeKind,
  findEnclosingCodeBlock,
  findEnclosingProcedure,
  findEnclosingStatement,
  findFirst,
  initParser,
  parseAL,
  visit,
  wrapRoot,
} from "../../src";

describe("tree-walks", () => {
  beforeAll(async () => { await initParser(); });

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
      if (integerNode === null && n.kind === ALNodeKind.integer_literal && n.text === "42") integerNode = n;
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
});
