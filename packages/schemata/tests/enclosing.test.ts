import { beforeAll, describe, expect, it } from "bun:test";
import { ALNodeKind, findFirst, initParser, parseAL, wrapRoot } from "@lethal/engine";
import { resolveSite } from "../src/enclosing";

describe("resolveSite", () => {
  beforeAll(async () => {
    await initParser();
  });

  it("when before is itself a statement, site equals before", () => {
    const src = `codeunit 51800 "E" { procedure P() begin X := 1; end; }`;
    const root = wrapRoot(parseAL(src));
    const assign = findFirst(root, ALNodeKind.assignment_statement);
    if (assign === null) throw new Error("no assignment");
    const site = resolveSite(assign, "X := 2");
    expect(site.statement).toBe(assign);
    expect(site.mutatedText).toBe("X := 2");
  });

  it("when before is a sub-expression, site is enclosing stmt with spliced text", () => {
    const src = `codeunit 51801 "E" { procedure P(A: Integer) begin if A > 0 then exit(1); end; }`;
    const root = wrapRoot(parseAL(src));
    const cmp = findFirst(root, ALNodeKind.comparison_expression);
    if (cmp === null) throw new Error("no comparison");
    const site = resolveSite(cmp, "A >= 0");
    expect(site.statement.kind).toBe(ALNodeKind.if_statement);
    expect(site.mutatedText).toContain("if A >= 0 then");
    expect(site.mutatedText).toContain("exit(1)");
    // original operator must not leak into mutated text
    expect(site.mutatedText).not.toContain("A > 0");
  });

  it("throws if node has no enclosing statement", () => {
    const src = `codeunit 51802 "E" { procedure P() begin end; }`;
    const root = wrapRoot(parseAL(src));
    expect(() => resolveSite(root, "x")).toThrow(/no enclosing statement/);
  });
});
