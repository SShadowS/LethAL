import { beforeAll, describe, expect, it } from "bun:test";
import { ALNodeKind, findAll, findFirst, initParser, parseAL, wrapRoot } from "@lethal/engine";
import type { ALSyntaxNode, MutationSpec } from "@lethal/engine";
import { compileSchemataForFile } from "../src/compile";

/** Builds a MutationSpec matching the shape the existing tests construct by hand. */
function spec(before: ALSyntaxNode, afterText: string, operatorName: string): MutationSpec {
  return {
    operatorName,
    operatorVersion: "1.0.0",
    astNodeId: `${before.startIndex}-${before.endIndex}`,
    before,
    after: { ...before, text: afterText } as never,
    parentContext: "statement-position",
  };
}

describe("compileSchemataForFile", () => {
  beforeAll(async () => {
    await initParser();
  });

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
    // Flat dispatch has no single-mutant "if not ... then" inversion — every
    // component (regardless of member count) is the same uniform
    // if/else-if/else chain, so a lone deletion mutant still gets its own
    // guarded branch rather than the old wrap's negated-condition shortcut.
    expect(output).toContain("if MutationSelector.Active('M0001') then begin");
    expect(output).toContain("end else begin");
    expect(output).toContain("DoThing()");
    // The mutated (deleted) branch itself must not contain the call.
    const mutatedBranch = output.slice(
      output.indexOf("then begin"),
      output.indexOf("end else begin"),
    );
    expect(mutatedBranch).not.toContain("DoThing()");
  });

  it("parentContext no longer gates compile-time routing", () => {
    // `dispatch`'s per-parentContext switch (and its throw on an unknown
    // value) is gone: compileSchemataForFile now routes every spec through
    // `buildComponents`/`resolveSite`, which only look at `spec.before`'s
    // position in the tree. `parentContext` is no longer read during
    // compilation at all, so a bogus value no longer causes a throw here.
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
        after: { ...exit, text: "exit(0);" } as never,
        parentContext: "bogus" as never,
      },
    ];
    const output = compileSchemataForFile(src, root, specs);
    expect(output).toContain("if MutationSelector.Active('M0001') then begin");
    expect(output).toContain("exit(0);");
  });

  it("compiles an expression-position mutation as a flat dispatch chain (lift is no longer routed to)", async () => {
    const src = `codeunit 51820 "L"
{
    procedure Compute(A: Integer): Integer
    var
        Result: Integer;
    begin
        Result := F(A * 2) + G(A);
        exit(Result);
    end;
}`;
    const root = wrapRoot(parseAL(src));
    const mul = findFirst(root, ALNodeKind.multiplicative_expression);
    if (mul === null) throw new Error("no multiplicative");
    const specs: MutationSpec[] = [
      {
        operatorName: "op.lift",
        operatorVersion: "1.0.0",
        astNodeId: `${mul.startIndex}`,
        before: mul,
        after: { ...mul, text: "0" } as never,
        parentContext: "expression-position",
      },
    ];
    const output = compileSchemataForFile(src, root, specs);
    // No lift artifacts: no hoisted temp, no separate conditional-assign.
    expect(output).not.toContain("_m0001");
    // The enclosing assignment statement is the dispatch root: one guard,
    // mutated and original variants of the WHOLE statement as siblings.
    expect(output).toContain("if MutationSelector.Active('M0001') then begin");
    expect(output).toContain("Result := F(0) + G(A)");
    expect(output).toContain("Result := F(A * 2) + G(A)");
  });

  it("an expression-position mutation does not create a var_section (lift is no longer routed to)", async () => {
    const src = `codeunit 51821 "L"
{
    procedure Compute(A: Integer): Integer
    begin
        exit(F(A * 2));
    end;
}`;
    const root = wrapRoot(parseAL(src));
    const mul = findFirst(root, ALNodeKind.multiplicative_expression);
    if (mul === null) throw new Error("no multiplicative");
    const specs: MutationSpec[] = [
      {
        operatorName: "op.lift",
        operatorVersion: "1.0.0",
        astNodeId: `${mul.startIndex}`,
        before: mul,
        after: { ...mul, text: "0" } as never,
        parentContext: "expression-position",
      },
    ];
    const output = compileSchemataForFile(src, root, specs);
    // No var_section is created for the procedure — the procedure body
    // itself becomes the dispatch chain instead of gaining a hoisted local.
    expect(output).not.toMatch(/var\s+_m0001/);
    expect(output).toContain("if MutationSelector.Active('M0001') then begin");
    expect(output).toContain("exit(F(0))");
    expect(output).toContain("exit(F(A * 2))");
  });

  it("composes a duplicate for short-circuit-operand", async () => {
    const src = `codeunit 51830 "D" { procedure P(A: Boolean; B: Boolean) begin if A and B then DoThing(); end; }`;
    const root = wrapRoot(parseAL(src));
    const logical = findFirst(root, ALNodeKind.logical_expression);
    if (logical === null) throw new Error("no logical");
    const specs: MutationSpec[] = [
      {
        operatorName: "op.neg",
        operatorVersion: "1.0.0",
        astNodeId: `${logical.startIndex}`,
        before: logical,
        after: { ...logical, text: "A or B" } as never,
        parentContext: "short-circuit-operand",
      },
    ];
    const output = compileSchemataForFile(src, root, specs);
    expect(output).toContain("if MutationSelector.Active('M0001') then begin");
    expect(output).toContain("if A or B then DoThing()");
    expect(output).toContain("end else begin");
    expect(output).toContain("if A and B then DoThing()");
  });
});

describe("compileSchemataForFile — overlapping specs coalesce", () => {
  it("compiles two nested mutants into one flat chain instead of throwing", async () => {
    await initParser();
    const src = `codeunit 79000 "T"
{
    procedure IsOver(A: Integer; B: Integer): Boolean
    begin
        exit(A > B);
    end;
}
`;
    const root = wrapRoot(parseAL(src));
    const cmp = findAll(root, ALNodeKind.comparison_expression)[0];
    const ex = findAll(root, ALNodeKind.exit_statement)[0];
    if (cmp === undefined || ex === undefined) throw new Error("fixture drift");

    const out = compileSchemataForFile(src, root, [
      spec(cmp, "A >= B", "lethal.conditional-boundary"),
      spec(ex, "exit(false);", "lethal.return-value"),
    ]);

    // Both mutants present, exactly one guard each, no nesting.
    expect(out.match(/MutationSelector\.Active/g)).toHaveLength(2);
    expect(out).toContain("exit(false);");
    // `exit_statement.text` (packages/engine) excludes its own terminating
    // `;` — verified against the parser: the grammar treats it as a sibling
    // token in the block's statement list, not part of the statement node.
    // Both the inner splice (replacing just the comparison) and the
    // untouched original branch are built from that text, so neither reads
    // with a trailing `;` here — the leftover source `;` lands after the
    // whole chain's closing `end;` instead (still valid AL: an extra bare
    // `;` is a no-op empty statement).
    expect(out).toContain("exit(A >= B)");
    expect(out).toContain("exit(A > B)");
  });
});
