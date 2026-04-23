import { describe, it, expect, beforeAll } from "bun:test";
import { ALNodeKind, findFirst, initParser, parseAL, wrapRoot } from "@lethal/engine";
import type { MutationSpec } from "@lethal/engine";
import { compileSchemataForFile } from "../src/compile";

describe("compileSchemataForFile", () => {
  beforeAll(async () => { await initParser(); });

  it("wraps a single statement-position mutation", () => {
    const src = `codeunit 51030 "C" { procedure P() begin X := 1; end; }`;
    const root = wrapRoot(parseAL(src));
    const assign = findFirst(root, ALNodeKind.assignment_statement);
    if (assign === null) throw new Error("no assignment");
    const specs: MutationSpec[] = [
      {
        operatorName: "op.flip",
        operatorVersion: "1.0.0",
        astNodeId: `${assign.startIndex}`,
        before: assign,
        after: { ...assign, text: "X := 2;" } as never,
        parentContext: "statement-position",
      },
    ];
    const output = compileSchemataForFile(src, root, specs);
    expect(output).toContain("if MutationSelector.Active('M0001') then");
    expect(output).toContain("X := 2;");
    expect(output).toContain("X := 1");
  });

  it("wraps at the enclosing statement when before is a sub-expression", async () => {
    const src = `codeunit 51810 "C" { procedure P(A: Integer) begin if A > 0 then exit(1); end; }`;
    const root = wrapRoot(parseAL(src));
    const cmp = findFirst(root, ALNodeKind.comparison_expression);
    if (cmp === null) throw new Error("no comparison");
    const specs: MutationSpec[] = [
      {
        operatorName: "op.flip",
        operatorVersion: "1.0.0",
        astNodeId: `${cmp.startIndex}`,
        before: cmp,
        after: { ...cmp, text: "A >= 0" } as never,
        parentContext: "statement-position",
      },
    ];
    const output = compileSchemataForFile(src, root, specs);
    expect(output).toContain("if MutationSelector.Active('M0001') then");
    expect(output).toContain("if A >= 0 then exit(1)");
    expect(output).toContain("if A > 0 then exit(1)");
  });

  it("deletes a statement when after.text is empty (VoidMethodCall semantics)", async () => {
    const src = `codeunit 51811 "C" { procedure P() begin DoThing(); end; }`;
    const root = wrapRoot(parseAL(src));
    const call = findFirst(root, ALNodeKind.procedure_call);
    if (call === null) throw new Error("no call");
    const specs: MutationSpec[] = [
      {
        operatorName: "op.void",
        operatorVersion: "1.0.0",
        astNodeId: `${call.startIndex}`,
        before: call,
        after: { ...call, text: "" } as never,
        parentContext: "statement-position",
      },
    ];
    const output = compileSchemataForFile(src, root, specs);
    expect(output).toContain("if not MutationSelector.Active('M0001') then");
    expect(output).toContain("DoThing()");
  });

  it("throws on unsupported parentContext", () => {
    const src = `codeunit 51031 "C" { procedure P(): Integer begin exit(1); end; }`;
    const root = wrapRoot(parseAL(src));
    const exit = findFirst(root, ALNodeKind.exit_statement);
    if (exit === null) throw new Error("no exit");
    const specs: MutationSpec[] = [
      {
        operatorName: "op.lift",
        operatorVersion: "1.0.0",
        astNodeId: `${exit.startIndex}`,
        before: exit,
        after: exit,
        parentContext: "expression-position",
      },
    ];
    expect(() => compileSchemataForFile(src, root, specs)).toThrow(/requires Task 12\/13/);
  });
});
