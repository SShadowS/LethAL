import { beforeAll, describe, expect, it } from "bun:test";
import {
  ALNodeKind,
  declarationMembers,
  findAll,
  findEnclosingStatement,
  findFirst,
  initParser,
  parseAL,
  visit,
  wrapRoot,
} from "@lethal/engine";
import type { ALSyntaxNode, MutationSpec } from "@lethal/engine";
import { canCarryMutationSelectorVar, compileSchemataForFile } from "../src/compile";
import { buildComponents } from "../src/components";
import { REACH_LATCH, REACH_MARKER, reachGrainOf } from "../src/dispatch";
import { assignMutantIds } from "../src/ids";

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

/** Finds the first call in the fixture and builds a void-method-call deletion spec for it. */
function specAtFirstCall(root: ALSyntaxNode): MutationSpec {
  const call = findFirst(root, ALNodeKind.procedure_call);
  if (call === null) throw new Error("no call in fixture");
  return spec(call, "", "lethal.void-method-call");
}

/**
 * Re-parse emitted AL and count tree-sitter ERROR nodes — 0 means it still
 * parses. CAVEAT (verified against the real parser): tree-sitter-al
 * false-positives an ERROR on any bare nested block (`begin begin ... end
 * end`), a shape the real AL compiler accepts and that every block-ROOTED
 * dispatch chain contains (each branch's text is itself `begin ... end`).
 * So this oracle is only used on emissions whose component root is NOT a
 * block — the exact-string assertions carry the block-rooted cases.
 */
function countErrorNodes(source: string): number {
  const r = wrapRoot(parseAL(source));
  let n = 0;
  visit(r, (node) => {
    if (node.rawKind === "ERROR") n++;
  });
  return n;
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
    // Proves the chain is actually FLAT (siblings in one if/else-if chain) —
    // a count of 2 alone would pass equally for a nested emission.
    expect(out).toContain("end else if MutationSelector.Active");
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

describe("compileSchemataForFile — bare branch positions keep the enclosing else attached", () => {
  it("wraps a mutated then-branch in begin/end so a following else still binds to the outer if", async () => {
    await initParser();
    const src = `codeunit 51900 "E"
{
    procedure P(X: Boolean)
    var
        Y: Integer;
    begin
        if X then
            Y := 1
        else
            Y := 2;
    end;
}
`;
    const root = wrapRoot(parseAL(src));
    const assign = findFirst(root, ALNodeKind.assignment_statement);
    if (assign === null) throw new Error("no assignment");

    const out = compileSchemataForFile(src, root, [
      spec(assign, "Y := 3;", "lethal.some-operator"),
    ]);

    // `assign` (`Y := 1`) is the bare then-branch of the outer `if X then
    // ... else ...` — its parent is the `if_statement`, not a `code_block`.
    // Splicing the flat chain in unwrapped would embed a complete nested
    // if/else-if/else construct (itself ending in its own `;`) directly as
    // the outer if's then-branch: the inner `;` closes the OUTER if before
    // its `else` is reached (AL0110 "Orphaned ELSE statement" — the exact
    // failure wrap.ts already defends against one level down), and even
    // without a following `else`, an unwrapped chain is itself an `if`,
    // creating a dangling-else ambiguity regardless. The fix wraps the
    // whole chain in `begin ... end` so it reads as a single statement.
    expect(out).toMatch(/if X then\s*begin\b/);
    // No `;` immediately precedes the outer `else` — that stray `;` is
    // exactly what orphans it. (A bare `/end\s*else/` alone would be inert:
    // it also matches the chain's own internal `end else begin`, which is
    // present regardless of whether the outer wrap bug is fixed — anchoring
    // on the untouched else-branch's own text makes this actually
    // discriminate the outer transition from the internal one.)
    expect(out).not.toMatch(/end;\s*else/);
    expect(out).toMatch(/end\s*else\s*Y := 2;/);
  });

  it("wraps a mutated empty-block if-branch without adding a terminator when an else follows", async () => {
    await initParser();
    const src = `codeunit 51901 "E2"
{
    procedure P(X: Boolean)
    var
        Y: Integer;
    begin
        if X then
        begin
            Y := 1;
        end
        else
            Y := 2;
    end;
}
`;
    const root = wrapRoot(parseAL(src));
    // The SECOND block in pre-order is the inner if-branch's own block (the
    // first is the whole procedure body, which contains it).
    const inner = findAll(root, ALNodeKind.block)[1];
    if (inner === undefined) throw new Error("no inner block");

    const out = compileSchemataForFile(src, root, [spec(inner, "begin end", "lethal.empty-block")]);

    // `inner` (the `begin Y := 1; end` if-branch) is a `code_block` whose
    // parent is the `if_statement` — `packages/builtin-tier1`'s
    // `empty-block` operator targets exactly this shape, not just whole
    // procedure/trigger bodies. Because an `else` follows directly in
    // source, `inner.text` does NOT include a trailing `;` (unlike a
    // procedure body's `begin ... end;`), so the wrap must not add one
    // either — a `kind === block` special case that unconditionally
    // appended `;` would reopen the exact orphaned-else bug this fix set
    // out to close, just through the other branch of the same function.
    expect(out).toMatch(/if X then\s*begin\b/);
    expect(out).not.toMatch(/end;\s*else/);
    expect(out).toMatch(/end\s*else\s*Y := 2;/);
  });

  it("preserves a nested if's own terminator when it is a bare while-body branch", async () => {
    await initParser();
    const src = `codeunit 51902 "W2"
{
    procedure P(X: Boolean; Y: Boolean)
    var
        Z: Integer;
        W: Integer;
    begin
        while X do
            if Y then
                Z := 1;
        W := 2;
    end;
}
`;
    const root = wrapRoot(parseAL(src));
    const innerIf = findFirst(root, ALNodeKind.if_statement);
    if (innerIf === null) throw new Error("no if");

    const out = compileSchemataForFile(src, root, [
      spec(innerIf, "if not Y then\n                Z := 1;", "lethal.some-operator"),
    ]);

    // `innerIf` (`if Y then Z := 1;`) is the bare body of the `while` —
    // its parent is `while_statement`, not a `code_block` — but UNLIKE a
    // bare `assignment_statement`/`exit_statement`, a nested `if_statement`
    // already includes its own trailing `;` in `.text`. Before this fix,
    // the wrap unconditionally omitted a trailing `;` for any non-block
    // bare branch, which here drops the terminator the following
    // `W := 2;` statement needs — a new regression this fix must not
    // reintroduce. The wrap's own closing `end` must reproduce a `;`
    // because the consumed `innerIf.text` had one.
    expect(out).toMatch(/while X do\s*begin\b/);
    expect(out).toMatch(/end;\s*W := 2;/);
  });
});

describe("compileSchemataForFile — member splice reproduces a consumed terminator (C1)", () => {
  it("an inner-block member followed by a sibling statement keeps its ';' (reviewer probe shape)", async () => {
    await initParser();
    // The shape the sandbox fixture structurally lacks: an inner block that
    // is NOT body-final — a sibling statement follows it. The body-level
    // empty-block spec roots the component, making the inner block a MEMBER,
    // so its edit goes through `spliceIntoRoot`, not the root wrap.
    const src = `codeunit 51903 "T3"
{
    procedure P(A: Integer)
    begin
        if A <> 0 then begin
            A := A;
        end;
        A := 2;
    end;
}
`;
    const root = wrapRoot(parseAL(src));
    const blocks = findAll(root, ALNodeKind.block);
    const body = blocks[0];
    const inner = blocks[1];
    if (body === undefined || inner === undefined) throw new Error("fixture drift");

    const out = compileSchemataForFile(src, root, [
      spec(body, "begin end", "lethal.empty-block"),
      spec(inner, "begin end", "lethal.empty-block"),
    ]);

    // Exact strings, not toContain-on-fragments: the inner mutant's branch
    // must read `... begin end;` before the sibling `A := 2;` — the consumed
    // span (`begin ... end;`, ';' included per the grammar) ended in ';' and
    // `begin end` does not, so the splice has to reproduce it. Without it the
    // branch reads `... begin end\n        A := 2;` — invalid AL.
    // GH-24: the inner block is a nested statement-grain member, so its branch carries its marker
    // after the `begin` (P1); the terminator rule is unchanged.
    expect(out).toContain(`if A <> 0 then begin ${REACH_MARKER("M0002")} end;\n        A := 2;`);
    expect(out).not.toMatch(/Reached\('M0002'\); end\s*\n\s*A := 2;/);
  });

  it("emits a fully re-parseable file when the component root is a statement (0 ERROR nodes)", async () => {
    await initParser();
    // Same C1 shape (inner-block member with consumed ';' + sibling), but
    // the component root is the OUTER if_statement (via a condition mutant),
    // not a block — no branch contains a bare nested block, so tree-sitter's
    // ERROR count is a sound parse oracle here: this is the probe that
    // caught C1 (0 ERROR nodes before instrumentation, 5 after).
    const src = `codeunit 51905 "T5"
{
    procedure P(A: Integer)
    begin
        if A > 0 then begin
            if A <> 0 then begin
                A := A;
            end;
            A := 2;
        end;
    end;
}
`;
    const root = wrapRoot(parseAL(src));
    const cmp = findFirst(root, ALNodeKind.comparison_expression);
    const inner = findAll(root, ALNodeKind.block)[2];
    if (
      cmp === null ||
      inner === undefined ||
      !inner.text.startsWith("begin\n                A := A;")
    ) {
      throw new Error("fixture drift");
    }

    const out = compileSchemataForFile(src, root, [
      spec(cmp, "A >= 0", "lethal.conditional-boundary"),
      spec(inner, "begin end", "lethal.empty-block"),
    ]);

    expect(out).toContain(
      `if A <> 0 then begin ${REACH_MARKER("M0002")} end;\n            A := 2;`,
    );
    expect(out).not.toMatch(/Reached\('M0002'\); end\s*\n\s*A := 2;/);
    expect(countErrorNodes(src)).toBe(0);
    expect(countErrorNodes(out)).toBe(0);
  });

  it("an inner-block member directly followed by 'else' gains no ';'", async () => {
    await initParser();
    // Same splice path, opposite direction: the consumed block text has NO
    // trailing ';' (an `else` follows), and appending one inside the branch
    // would orphan that else (AL0110). The discriminator must be the
    // consumed TEXT, not the node kind — the member here is the same
    // `code_block` kind as the case above, only its text differs.
    const src = `codeunit 51904 "T4"
{
    procedure P(X: Integer)
    var
        Y: Integer;
    begin
        if X > 0 then begin
            Y := 1;
        end
        else
            Y := 2;
    end;
}
`;
    const root = wrapRoot(parseAL(src));
    const cmp = findFirst(root, ALNodeKind.comparison_expression);
    const inner = findAll(root, ALNodeKind.block)[1];
    if (
      cmp === null ||
      inner === undefined ||
      !inner.text.startsWith("begin\n            Y := 1;")
    ) {
      throw new Error("fixture drift");
    }

    const out = compileSchemataForFile(src, root, [
      spec(cmp, "X >= 0", "lethal.conditional-boundary"),
      spec(inner, "begin end", "lethal.empty-block"),
    ]);

    // Grammar 4.0.0: the outer if_statement's span no longer includes its
    // trailing `;` (the terminator re-parented outside every statement node),
    // so the branch text ends at `Y := 2` and the source's own `;` survives
    // after the spliced chain. A `;` before `end` is optional in AL.
    expect(out).toContain(
      `if X > 0 then begin ${REACH_MARKER("M0002")} end\n        else\n            Y := 2\n`,
    );
    expect(out).not.toMatch(/Reached\('M0002'\); end;\s*else/);
    expect(out).not.toContain(";;");
    expect(countErrorNodes(out)).toBe(0);
  });
});

describe("compileSchemataForFile — selector var reuses an existing object-level var_section", () => {
  it("appends the selector var to the codeunit's existing var_section instead of inserting a second one", async () => {
    await initParser();
    // Under v3, a codeunit's members (var_section, procedure) sit inside a
    // `declaration_body` container rather than being direct namedChildren of
    // the codeunit. Reading `codeunit.namedChildren` straight (the bug this
    // test guards against) never finds this existing `var_section`, so the
    // selector var falls through to the "no existing var_section" path and
    // gets inserted as a SECOND, separate object-level `var` block ahead of
    // this one instead of being appended to it.
    const src = `codeunit 51906 "G"
{
    var
        GlobalVar: Integer;

    procedure P()
    begin
        GlobalVar := 1;
    end;
}
`;
    const root = wrapRoot(parseAL(src));
    const assign = findFirst(root, ALNodeKind.assignment_statement);
    if (assign === null) throw new Error("no assignment");

    const out = compileSchemataForFile(src, root, [
      spec(assign, "GlobalVar := 2;", "lethal.some-operator"),
    ]);

    expect(out).toContain("if MutationSelector.Active('M0001') then begin");
    expect(out).toContain("GlobalVar := 2;");
    // `assignment_statement.text` excludes its own terminating `;` (same
    // quirk `exit_statement` has — see the "overlapping specs" test above),
    // so the untouched original branch reads without a trailing `;` here.
    expect(out).toContain("GlobalVar := 1");

    // Structural check, not just string-matching: re-parse the emitted file
    // and count the codeunit's OWN object-level var_section members. A
    // second, separately-inserted var_section — the exact shape the reuse
    // branch exists to prevent — would still contain valid AL and would
    // still satisfy `toContain` checks on either declaration in isolation,
    // so only counting members through `declarationMembers` (the v3-aware
    // walk) actually discriminates "reused" from "duplicated".
    const outRoot = wrapRoot(parseAL(out));
    let errorCount = 0;
    visit(outRoot, (node) => {
      if (node.rawKind === "ERROR") errorCount++;
    });
    expect(errorCount).toBe(0);

    const outCodeunit = findFirst(outRoot, ALNodeKind.codeunit);
    if (outCodeunit === null) throw new Error("no codeunit in output");
    const varSections = declarationMembers(outCodeunit).filter(
      (c) => c.kind === ALNodeKind.var_section,
    );
    expect(varSections).toHaveLength(1);
    const [varSection] = varSections;
    if (varSection === undefined) throw new Error("fixture drift");
    expect(varSection.text).toContain("GlobalVar: Integer;");
    expect(varSection.text).toContain('MutationSelector: Codeunit "Mutation Selector";');
  });
});

/**
 * R38. AL requires an object's PROPERTIES before any `var` section, so anchoring the selector var
 * at `members[0]` emits `{ var MutationSelector … Permissions = …` — and `alc` then reads
 * `Permissions` as a variable name and never recovers (AL0104/AL0107/AL0105). Measured on the real
 * Continia Document Output app: 19 of 162 instrumented files, 246 errors, whole-app compile fails.
 * Every fixture codeunit here declared no properties, which is why `members[0]` looked safe.
 *
 * These assert POSITION rather than re-parsing, deliberately: tree-sitter recovers from the bad
 * ordering without an ERROR node, so `countErrorNodes` is blind to exactly this defect. The
 * authoritative check is an offline `alc` compile.
 */
describe("compileSchemataForFile — selector var injection past codeunit properties", () => {
  it("inserts the selector var AFTER a codeunit property, not before it", () => {
    const source = `codeunit 50100 "P"
{
    Permissions = tabledata "Sales Header" = rm;

    procedure Go()
    begin
        DoThing();
    end;
}`;
    const root = wrapRoot(parseAL(source));
    const out = compileSchemataForFile(source, root, [specAtFirstCall(root)]);
    const varAt = out.indexOf("MutationSelector: Codeunit");
    expect(varAt).toBeGreaterThan(out.indexOf("Permissions ="));
    expect(varAt).toBeLessThan(out.indexOf("procedure Go"));
  });

  it("inserts the selector var after the LAST of several properties", () => {
    const source = `codeunit 50101 "Q"
{
    Access = Internal;
    SingleInstance = true;
    EventSubscriberInstance = Manual;
    TableNo = 18;

    procedure Go()
    begin
        DoThing();
    end;
}`;
    const root = wrapRoot(parseAL(source));
    const out = compileSchemataForFile(source, root, [specAtFirstCall(root)]);
    const varAt = out.indexOf("MutationSelector: Codeunit");
    expect(varAt).toBeGreaterThan(out.indexOf("TableNo = 18;"));
    expect(varAt).toBeLessThan(out.indexOf("procedure Go"));
  });

  it("still reuses an existing var_section that sits after a property", () => {
    // The real-world shape this most often takes: `Subtype = Test;` followed by the codeunit's
    // own globals. Reuse must win over insertion, or the emission carries two var sections.
    const source = `codeunit 50102 "R"
{
    Subtype = Test;

    var
        Flag: Boolean;

    procedure Go()
    begin
        DoThing();
    end;
}`;
    const root = wrapRoot(parseAL(source));
    const out = compileSchemataForFile(source, root, [specAtFirstCall(root)]);
    const outRoot = wrapRoot(parseAL(out));
    const outCodeunit = findFirst(outRoot, ALNodeKind.codeunit);
    if (outCodeunit === null) throw new Error("no codeunit in output");
    const varSections = declarationMembers(outCodeunit).filter(
      (c) => c.kind === ALNodeKind.var_section,
    );
    expect(varSections).toHaveLength(1);
    const [varSection] = varSections;
    if (varSection === undefined) throw new Error("fixture drift");
    expect(varSection.text).toContain("Flag: Boolean;");
    expect(varSection.text).toContain('MutationSelector: Codeunit "Mutation Selector";');
  });

  it("keeps inserting before the first member when a codeunit declares no properties", () => {
    // The pre-R38 behaviour, which was correct for this shape and must not regress.
    const source = `codeunit 50103 "S"
{
    procedure Go()
    begin
        DoThing();
    end;
}`;
    const root = wrapRoot(parseAL(source));
    const out = compileSchemataForFile(source, root, [specAtFirstCall(root)]);
    expect(out.indexOf("MutationSelector: Codeunit")).toBeLessThan(out.indexOf("procedure Go"));
  });

  it("inserts after a trailing property when a codeunit's only members are properties and a trigger", () => {
    // An install/upgrade codeunit: properties, then an object-level trigger and no procedure.
    const source = `codeunit 50104 "T"
{
    Subtype = Install;
    Access = Internal;

    trigger OnInstallAppPerCompany()
    begin
        DoThing();
    end;
}`;
    const root = wrapRoot(parseAL(source));
    const out = compileSchemataForFile(source, root, [specAtFirstCall(root)]);
    const varAt = out.indexOf("MutationSelector: Codeunit");
    expect(varAt).toBeGreaterThan(out.indexOf("Access = Internal;"));
    expect(varAt).toBeLessThan(out.indexOf("trigger OnInstallAppPerCompany"));
  });
});

describe("compileSchemataForFile — selector var injection into table objects", () => {
  it("injects the selector var into a table, after its sections and before its triggers", () => {
    const source = `table 50100 "T"
{
    fields { field(1; "No."; Code[20]) { } }
    keys { key(PK; "No.") { Clustered = true; } }

    trigger OnInsert()
    begin
        DoThing();
    end;
}`;
    const root = wrapRoot(parseAL(source));
    const out = compileSchemataForFile(source, root, [specAtFirstCall(root)]);
    const varAt = out.indexOf("MutationSelector: Codeunit");
    expect(varAt).toBeGreaterThan(out.indexOf("keys"));
    expect(varAt).toBeLessThan(out.indexOf("trigger OnInsert"));
    expect(countErrorNodes(out)).toBe(0);
  });

  it("injects the selector var at the end when a table has only a field-level trigger", () => {
    const source = `table 50101 "U"
{
    fields
    {
        field(1; "No."; Code[20])
        {
            trigger OnValidate()
            begin
                DoThing();
            end;
        }
    }
    keys { key(PK; "No.") { Clustered = true; } }
}`;
    const root = wrapRoot(parseAL(source));
    const out = compileSchemataForFile(source, root, [specAtFirstCall(root)]);
    expect(out.indexOf("MutationSelector: Codeunit")).toBeGreaterThan(out.indexOf("keys"));
    expect(countErrorNodes(out)).toBe(0);
  });

  it("throws, naming the object kind and the file, for an object kind it cannot instrument", () => {
    // R40 made page and report legal carriers (measured: the var compiles inside both). An
    // `xmlport` is still refused — and the property under test is unchanged: the guard calls are
    // emitted BEFORE the selector var is injected, so returning silently here would ship
    // `MutationSelector.Active(...)` with no declaration in scope (AL0118 -> AlcCompileError ->
    // bisection halves the mutant set and blames an innocent mutant). Refuse instead.
    const source = `xmlport 50100 "My Port"
{
    schema
    {
        textelement(Root)
        {
            tableelement(Cust; Customer)
            {
                trigger OnAfterGetRecord()
                begin
                    DoThing();
                end;
            }
        }
    }
}`;
    const root = wrapRoot(parseAL(source));
    let thrown: unknown;
    try {
      compileSchemataForFile(source, root, [specAtFirstCall(root)], undefined, "MyPort.XmlPort.al");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    const message = thrown instanceof Error ? thrown.message : "";
    expect(message).toContain("MyPort.XmlPort.al");
    expect(message).toContain("AL0118");
  });

  it("does NOT throw when there are no specs — an unmutated page emits no guards to strand", () => {
    // The throw is conditioned on guards having been emitted (`specs.length > 0`). A page LethAL
    // found nothing to mutate in is passed through untouched, exactly as before.
    const source = `page 50101 "Quiet Page" { PageType = Card; }`;
    const root = wrapRoot(parseAL(source));
    expect(compileSchemataForFile(source, root, [], undefined, "QuietPage.Page.al")).toBe(source);
  });

  it("reuses a table's existing var section rather than adding a second", () => {
    const source = `table 50102 "V"
{
    fields { field(1; "No."; Code[20]) { } }
    var
        Existing: Integer;
    trigger OnInsert() begin DoThing(); end;
}`;
    const root = wrapRoot(parseAL(source));
    const out = compileSchemataForFile(source, root, [specAtFirstCall(root)]);
    expect(out.match(/^\s*var\s*$/gm)?.length ?? 0).toBe(1);
    expect(countErrorNodes(out)).toBe(0);
  });
});

// ————————————————————————————————————————————————————————————————————————
// R40: pages and reports CAN carry the selector var — measured against `alc 17.0.29`, which
// accepts the declaration inside both with realistic sections present. The old refusal
// ("only a codeunit or a table can carry it, AL0118 otherwise") was wrong about the reason, and
// cost 41% of a real app's mutation sites: on Continia Document Output, 6,492 of the 8,259
// skipped sites are pages and reports. The real constraint is anchor POSITION, exactly as R38
// turned out to be — the var must follow the object's structural sections.
// ————————————————————————————————————————————————————————————————————————
describe("compileSchemataForFile — selector var injection into pages and reports (R40)", () => {
  it("injects into a page, after its layout and actions", () => {
    const source = `page 50200 "P"
{
    PageType = Card;
    SourceTable = Customer;
    layout { area(Content) { field(Name; Rec.Name) { } } }
    actions { area(Processing) { action(Go) { trigger OnAction() begin DoThing(); end; } } }
}`;
    const root = wrapRoot(parseAL(source));
    const out = compileSchemataForFile(source, root, [specAtFirstCall(root)]);
    const varAt = out.indexOf("MutationSelector: Codeunit");
    expect(varAt).toBeGreaterThan(out.indexOf("layout"));
    expect(varAt).toBeGreaterThan(out.indexOf("actions"));
  });

  it("injects into a report, after its dataset", () => {
    const source = `report 50201 "R"
{
    dataset { dataitem(Cust; Customer) { trigger OnAfterGetRecord() begin DoThing(); end; } }
}`;
    const root = wrapRoot(parseAL(source));
    const out = compileSchemataForFile(source, root, [specAtFirstCall(root)]);
    expect(out.indexOf("MutationSelector: Codeunit")).toBeGreaterThan(out.indexOf("dataset"));
  });

  it("reuses a page's existing var section rather than adding a second", () => {
    const source = `page 50202 "Q"
{
    PageType = Card;
    layout { area(Content) { field(F; 1) { } } }
    actions { area(Processing) { action(Go) { trigger OnAction() begin DoThing(); end; } } }

    var
        Existing: Integer;
}`;
    const root = wrapRoot(parseAL(source));
    const out = compileSchemataForFile(source, root, [specAtFirstCall(root)]);
    const outRoot = wrapRoot(parseAL(out));
    const page = findFirst(outRoot, ALNodeKind.page);
    if (page === null) throw new Error("no page in output");
    const varSections = declarationMembers(page).filter((c) => c.kind === ALNodeKind.var_section);
    expect(varSections).toHaveLength(1);
    expect(varSections[0]?.text).toContain("Existing: Integer;");
    expect(varSections[0]?.text).toContain('MutationSelector: Codeunit "Mutation Selector";');
  });

  it("canCarryMutationSelectorVar accepts page and report, still refuses xmlport", () => {
    const kinds: Array<[string, boolean]> = [
      ['page 1 "A" { PageType = Card; }', true],
      ['report 2 "B" { dataset { } }', true],
      ['codeunit 3 "C" { }', true],
      ['table 4 "D" { fields { } }', true],
      ['xmlport 5 "E" { schema { } }', false],
    ];
    for (const [src, expected] of kinds) {
      expect(canCarryMutationSelectorVar(wrapRoot(parseAL(src)))).toBe(expected);
    }
  });
});

describe("compileSchemataForFile — selector var injection into extension objects (R40)", () => {
  it("injects into a tableextension, after its fields", () => {
    const source = `tableextension 50300 "TE" extends Customer
{
    fields { field(50; "X"; Integer) { } }

    procedure Bump()
    begin
        DoThing();
    end;
}`;
    const root = wrapRoot(parseAL(source));
    const out = compileSchemataForFile(source, root, [specAtFirstCall(root)]);
    expect(out.indexOf("MutationSelector: Codeunit")).toBeGreaterThan(out.indexOf("fields"));
  });

  it("injects into a pageextension, after its layout", () => {
    const source = `pageextension 50301 "PE" extends "Customer Card"
{
    layout { addlast(Content) { field(X; 1) { } } }

    procedure Bump()
    begin
        DoThing();
    end;
}`;
    const root = wrapRoot(parseAL(source));
    const out = compileSchemataForFile(source, root, [specAtFirstCall(root)]);
    expect(out.indexOf("MutationSelector: Codeunit")).toBeGreaterThan(out.indexOf("layout"));
  });

  it("canCarryMutationSelectorVar accepts both extension kinds", () => {
    for (const src of [
      'tableextension 1 "A" extends Customer { fields { } }',
      'pageextension 2 "B" extends "Customer Card" { layout { } }',
    ]) {
      expect(canCarryMutationSelectorVar(wrapRoot(parseAL(src)))).toBe(true);
    }
  });
  /**
   * R161. Six operators now claim the un-braced body of a branch, so the compiler emits a dispatch
   * chain whose component root is the enclosing `if`/`case`/loop. Two things have to hold and
   * neither is obvious from reading the emitter.
   *
   * Compilation itself is proven separately and for real by `scripts/r161-emit-proof.ts`, which runs
   * `alc` over the emitted artifact for all four slot shapes and keeps a negative control that must
   * be REJECTED. These tests pin the SHAPE so a regression names itself here in milliseconds rather
   * than in a live run.
   */
  describe("R161 branch-slot sites", () => {
    const deletionAtFoo = (src: string): string => {
      const root = wrapRoot(parseAL(src));
      const calls = findAll(root, ALNodeKind.procedure_call).filter((c) =>
        c.text.startsWith("Foo"),
      );
      const call = calls[0];
      if (call === undefined) throw new Error("no Foo() call in fixture");
      return compileSchemataForFile(src, root, [spec(call, "", "lethal.void-method-call")]);
    };

    it("fills an emptied then-branch with an empty statement, not nothing", () => {
      const out = deletionAtFoo(
        `codeunit 51040 "C" { procedure P(Cond: Boolean) begin if Cond then Foo(); end; }`,
      );
      // Without the filler this reads `if Cond then` immediately followed by the chain's `end`,
      // which alc rejects with AL0224 "Expression expected".
      expect(out).toContain("if Cond then ;");
      expect(out).toContain("if Cond then Foo()");
    });

    it("fills an emptied then-branch with an empty BLOCK when an else follows, never `; else`", () => {
      // The shape the four measured ones missed. `if Cond then ; else Bar()` is AL0110's own
      // example ("an unnecessary semicolon placed just before the ELSE keyword"): the empty
      // statement's `;` closes the `if` before its `else`. The R175 re-run of `do rung1` emitted
      // it at three sites of one codeunit and every mutant of the run scored `error`.
      const out = deletionAtFoo(
        `codeunit 51045 "C" { procedure P(Cond: Boolean) begin if Cond then Foo() else Bar(); end; }`,
      );
      expect(out).toContain("if Cond then begin end else Bar()");
      expect(out).not.toMatch(/then\s*;\s*else/);
      expect(countErrorNodes(out)).toBe(0);
    });

    it("fills an emptied else-branch the same way", () => {
      const out = deletionAtFoo(
        `codeunit 51041 "C" { procedure P(Cond: Boolean) begin if Cond then Bar() else Foo(); end; }`,
      );
      expect(out).toContain("else ;");
    });

    it("does NOT double the separator in a case arm, whose own `;` survives the splice", () => {
      const out = deletionAtFoo(
        `codeunit 51042 "C" { procedure P(W: Integer) begin case W of 1: Foo(); 2: Bar(); end; end; }`,
      );
      expect(out).toContain("case W of 1: ; 2: Bar(); end");
      expect(out).not.toContain(";;");
    });

    it("adds no filler for an ordinary statement-list deletion", () => {
      const out = deletionAtFoo(`codeunit 51043 "C" { procedure P() begin Foo(); Bar(); end; }`);
      // The chain replaces the call's own span; a filler here would be a stray empty statement.
      expect(out).not.toContain("; ;");
    });

    it("still parses when the site is a branch body", () => {
      const out = deletionAtFoo(
        `codeunit 51044 "C" { procedure P(Cond: Boolean) begin if Cond then Foo(); Bar(); end; }`,
      );
      expect(countErrorNodes(out)).toBe(0);
    });
  });
});
/**
 * GH-24. Each scenario is parsed for real, because the grain rule reads `parent` and `fieldName`,
 * which the fake nodes in `dispatch.test.ts` do not have. Every AST shape a test relies on is read
 * off the parse and asserted, rather than assumed from what the grammar ought to produce.
 */
describe("GH-24: reach grain and marker placement", () => {
  beforeAll(async () => {
    await initParser();
  });

  interface Scenario {
    readonly src: string;
    readonly root: ALSyntaxNode;
    readonly specs: readonly MutationSpec[];
    /** Mutant ids whose marker is a P3 wrap, so the strip below also removes `begin `/` end`. */
    readonly wrapped: readonly string[];
  }

  const parse = (src: string): ALSyntaxNode => wrapRoot(parseAL(src));

  // Every node of a scenario comes from ONE traversal. The wrapper objects a traversal hands out
  // carry their own parent chain, and `injectMutationSelectorVar` keys the enclosing object by
  // identity, so specs found by two separate `findAll` walks inject the selector var twice. The
  // real pipeline walks each file once.
  const walked = new WeakMap<ALSyntaxNode, ALSyntaxNode[]>();
  const all = (root: ALSyntaxNode, kind: string): ALSyntaxNode[] => {
    let nodes = walked.get(root);
    if (nodes === undefined) {
      const collected: ALSyntaxNode[] = [];
      visit(root, (n) => {
        collected.push(n);
      });
      nodes = collected;
      walked.set(root, nodes);
    }
    return nodes.filter((n) => n.kind === kind);
  };

  const nth = (root: ALSyntaxNode, kind: string, i: number, startsWith = ""): ALSyntaxNode => {
    const hit = all(root, kind).filter((n) => n.text.startsWith(startsWith))[i];
    if (hit === undefined)
      throw new Error(`no ${kind} #${i} starting ${JSON.stringify(startsWith)}`);
    return hit;
  };

  const bodyOf = (root: ALSyntaxNode, procName: string): ALSyntaxNode => {
    const body = all(root, ALNodeKind.block).find(
      (b) =>
        b.parent?.kind === ALNodeKind.procedure &&
        b.parent.childForFieldName("name")?.text === procName,
    );
    if (body === undefined) throw new Error(`no body for ${procName}`);
    return body;
  };

  /** Grain of every mutant, keyed by id, computed from the same components the compiler builds. */
  const grains = (s: Scenario): Map<string, string> => {
    const ided = assignMutantIds(new Map([["<file>", s.specs]])).get("<file>") ?? [];
    const out = new Map<string, string>();
    for (const c of buildComponents(ided)) {
      for (const m of c.members) out.set(m.mutantId, reachGrainOf(m, c.root));
    }
    return out;
  };

  const compile = (s: Scenario): string => compileSchemataForFile(s.src, s.root, s.specs);

  const words = (text: string, word: string): number =>
    (text.match(new RegExp(`\\b${word}\\b`, "gi")) ?? []).length;

  // The scenarios, one per test below, and all of them again in the no-line test.

  const thenCall = (): Scenario => {
    const src = `codeunit 51901 "R" { procedure P(Amount: Integer) begin if Amount > 100 then Touch(); end; local procedure Touch() begin end; }`;
    const root = parse(src);
    const call = nth(root, ALNodeKind.procedure_call, 0, "Touch");
    return { src, root, specs: [spec(call, "", "lethal.void-method-call")], wrapped: [] };
  };

  const thenExit = (): Scenario => {
    const src = `codeunit 51902 "R" { procedure P(Amount: Integer): Integer begin if Amount < 0 then exit(0); if Amount < 1 then Error('neg'); exit(1); end; }`;
    const root = parse(src);
    // The comparison makes the whole if the component root, so the exit is a NESTED member. Alone,
    // the exit would be its own root, already braced by `wrapIfSingleStatementSlot`, and P0.
    const guard = nth(root, ALNodeKind.comparison_expression, 0, "Amount < 0");
    const exit0 = nth(root, ALNodeKind.exit_statement, 0);
    const neg = nth(root, ALNodeKind.text_literal, 0, "'neg'");
    return {
      src,
      root,
      specs: [
        spec(guard, "Amount >= 0", "lethal.negate-conditional"),
        spec(exit0, "exit(1)", "lethal.return-value"),
        spec(neg, "''", "lethal.toggle-blank-string"),
      ],
      wrapped: ["M0002"],
    };
  };

  const listPrefix = (): Scenario => {
    const src = `codeunit 51903 "R" { procedure P() var X: Integer; Y: Integer; begin X := 1; Y := 2; end; }`;
    const root = parse(src);
    const second = nth(root, ALNodeKind.assignment_statement, 0, "Y := 2");
    return {
      src,
      root,
      specs: [
        spec(bodyOf(root, "P"), "begin end", "lethal.empty-block"),
        spec(second, "", "lethal.remove-assignment"),
      ],
      wrapped: [],
    };
  };

  const ifBody = (): Scenario => {
    const src = `codeunit 51904 "R" { procedure P(Amount: Integer) var Seen: Integer; begin if Amount > 100 then begin Seen := Amount; end; Seen := 0; end; }`;
    const root = parse(src);
    const thenBlock = nth(root, ALNodeKind.if_statement, 0).childForFieldName("then_branch");
    if (thenBlock === null) throw new Error("no then_branch");
    return {
      src,
      root,
      specs: [
        spec(bodyOf(root, "P"), "begin end", "lethal.empty-block"),
        spec(thenBlock, "begin end", "lethal.empty-block"),
      ],
      wrapped: [],
    };
  };

  const repeatBody = (): Scenario => {
    const src = `codeunit 51905 "R" { procedure P() var I: Integer; begin repeat begin I += 1; end until I >= 3; end; }`;
    const root = parse(src);
    const inner = all(root, ALNodeKind.block).find((b) => b.text.startsWith("begin I += 1"));
    if (inner === undefined) throw new Error("no repeat body block");
    return {
      src,
      root,
      specs: [
        spec(bodyOf(root, "P"), "begin end", "lethal.empty-block"),
        spec(inner, "begin end", "lethal.empty-block"),
      ],
      wrapped: [],
    };
  };

  const caseArms = (): Scenario => {
    const src = `codeunit 51906 "R" { procedure P(W: Integer) var X: Integer; begin case W of 1: begin X := 1; end; 2: Touch(); end; end; local procedure Touch() begin end; }`;
    const root = parse(src);
    const armBlock = all(root, ALNodeKind.block).find((b) => b.text.startsWith("begin X := 1"));
    if (armBlock === undefined) throw new Error("no arm block");
    const call = nth(root, ALNodeKind.procedure_call, 0, "Touch");
    const assign = nth(root, ALNodeKind.assignment_statement, 0, "X := 1");
    return {
      src,
      root,
      specs: [
        spec(armBlock, "begin end", "lethal.empty-block"),
        spec(assign, "", "lethal.remove-assignment"),
        spec(call, "", "lethal.void-method-call"),
      ],
      wrapped: [],
    };
  };

  it("GH-24: an unbraced then-call is enclosing grain and gets no marker", () => {
    const s = thenCall();
    const [callSpec] = s.specs;
    if (callSpec === undefined) throw new Error("no spec");
    // Measured shape: the call sits in the if's then_branch slot, not a statement list, so the
    // resolved statement is the whole if.
    expect(callSpec.before.parent?.kind).toBe(ALNodeKind.if_statement);
    expect(callSpec.before.fieldName).toBe("then_branch");
    expect(findEnclosingStatement(callSpec.before)?.kind).toBe(ALNodeKind.if_statement);
    expect(grains(s).get("M0001")).toBe("enclosing");
    expect(compile(s)).not.toContain(REACH_MARKER("M0001"));
  });

  it("GH-24: an own statement in a then-slot is wrapped (P3)", () => {
    const s = thenExit();
    const [, exitSpec, negSpec] = s.specs;
    if (exitSpec === undefined || negSpec === undefined) throw new Error("no spec");
    expect(exitSpec.before.parent?.kind).toBe(ALNodeKind.if_statement);
    expect(exitSpec.before.fieldName).toBe("then_branch");
    const g = grains(s);
    expect(g.get("M0001")).toBe("statement"); // the comparison: its statement is the root (P0)
    expect(g.get("M0002")).toBe("statement");
    const out = compile(s);
    // The marker sits AFTER `if Amount < 0 then`, so a skipped branch never reaches it.
    expect(out).toContain(`if Amount < 0 then begin ${REACH_MARKER("M0002")} exit(1) end`);
    expect(words(out, "begin")).toBe(words(out, "end"));
    // Measured: `Error('neg')` in the same slot parses as a CALL (`call_expression`), not an
    // `error_statement`, so a literal inside it resolves to the whole if and is enclosing grain.
    const errorCall = negSpec.before.parent?.parent;
    expect(errorCall?.kind).toBe(ALNodeKind.procedure_call);
    expect(errorCall?.fieldName).toBe("then_branch");
    expect(findEnclosingStatement(negSpec.before)?.kind).toBe(ALNodeKind.if_statement);
    expect(g.get("M0003")).toBe("enclosing");
    expect(out).not.toContain(REACH_MARKER("M0003"));
  });

  it("GH-24: a nested statement in a list gets a plain prefix (P2)", () => {
    const s = listPrefix();
    const g = grains(s);
    expect(g.get("M0001")).toBe("statement"); // the body block, the component root (P0)
    expect(g.get("M0002")).toBe("statement");
    const out = compile(s);
    expect(out).toContain(`then begin\n  ${REACH_MARKER("M0001")} begin end`);
    expect(out).toContain(`X := 1; ${REACH_MARKER("M0002")} ;`);
  });

  it("GH-24: an if-body block gets the marker after its begin (P1)", () => {
    const s = ifBody();
    const [, blockSpec] = s.specs;
    expect(blockSpec?.before.parent?.kind).toBe(ALNodeKind.if_statement);
    expect(grains(s).get("M0002")).toBe("statement");
    const out = compile(s);
    expect(out).toContain(`then begin ${REACH_MARKER("M0002")} end;`);
    expect(words(out, "begin")).toBe(words(out, "end"));
  });

  it("GH-24: a repeat body block is enclosing, because the grammar puts it in the repeat's statement list", () => {
    // The plan expected this block's parent to be the repeat_statement (P1's repeat case). MEASURED
    // on the vendored grammar it is not: a repeat's body is a `statement_block`, and a
    // `begin ... end` inside it is one statement of that list, so the resolved statement is the
    // whole repeat. `lethal.empty-block` targets only a block whose parent IS a repeat_statement,
    // so no operator emits this spec (R244); it is built by hand to prove the shape is decided,
    // not thrown.
    const s = repeatBody();
    const [, inner] = s.specs;
    if (inner === undefined) throw new Error("no spec");
    expect(inner.before.parent?.kind).toBe(ALNodeKind.statement_block);
    expect(inner.before.parent?.parent?.kind).toBe(ALNodeKind.repeat_statement);
    expect(findEnclosingStatement(inner.before)?.kind).toBe(ALNodeKind.repeat_statement);
    expect(grains(s).get("M0002")).toBe("enclosing");
    const out = compile(s);
    expect(out).not.toContain(REACH_MARKER("M0002"));
    expect(words(out, "begin")).toBe(words(out, "end"));
  });

  it("GH-24: a case-arm block and a case-arm call are enclosing", () => {
    const s = caseArms();
    const [armSpec, , callSpec] = s.specs;
    expect(armSpec?.before.parent?.rawKind).toBe("case_branch");
    expect(callSpec?.before.parent?.rawKind).toBe("case_branch");
    const g = grains(s);
    // Ids follow start position: the arm block, the assignment inside it, then the call.
    expect(g.get("M0001")).toBe("enclosing");
    expect(g.get("M0002")).toBe("statement");
    expect(g.get("M0003")).toBe("enclosing");
    const out = compile(s);
    expect(out).not.toContain(REACH_MARKER("M0001"));
    expect(out).not.toContain(REACH_MARKER("M0003"));
    expect(out).toContain(`1: begin ${REACH_MARKER("M0002")} ; end;`);
  });

  // R246: a marker inside a loop ran two calls per iteration and turned a 4.4 s overflow kill into
  // a timeout. After its first hit the marker must cost one test of a local Boolean, and that
  // Boolean must be the enclosing procedure's own local, so it starts false on every call and can
  // never carry a hit from one test into the next.
  it("R246: the marker is latched by a procedure-local Boolean, tested first and set after the call", () => {
    expect(REACH_MARKER("M0002")).toBe(
      `if not ${REACH_LATCH} then begin MutationSelector.Reached('M0002'); ${REACH_LATCH} := true; end;`,
    );
  });

  it("R246: a procedure with a marker declares the latch once, on an existing line", () => {
    // Existing var section: appended after its last declaration.
    const list = compile(listPrefix());
    expect(list).toContain(`var X: Integer; Y: Integer; ${REACH_LATCH}: Boolean; begin`);
    expect(list.split(`${REACH_LATCH}: Boolean;`).length - 1).toBe(1); // two markers, one procedure
    // No var section: one is added after the header, before `begin`.
    const exit = compile(thenExit());
    expect(exit).toContain(
      `procedure P(Amount: Integer): Integer var ${REACH_LATCH}: Boolean; begin`,
    );
    // No statement-grain marker in the file: no latch at all.
    expect(compile(thenCall())).not.toContain(REACH_LATCH);
    // `Touch` carries no marker, so only `P` declares it.
    expect(compile(caseArms()).split(`${REACH_LATCH}: Boolean;`).length - 1).toBe(1);
  });

  // R246 fix round 1: a comment is a node of its own, so "the node before begin" can be a comment,
  // and text inserted after a `//` comment is commented out (AL0118 at alc, every mutant error).
  const latchOut = (src: string): string => {
    const root = parse(src);
    const target = nth(root, ALNodeKind.assignment_statement, 0, "X := 2");
    return compile({
      src,
      root,
      specs: [spec(target, "", "lethal.remove-assignment")],
      wrapped: [],
    });
  };

  it("R246 fix 1: a trailing // on the last variable does not swallow the latch", () => {
    // A trailing `//` on the last variable: the declaration goes after the variable, before it.
    expect(
      latchOut(
        `codeunit 51908 "R" { procedure P() var X: Integer; // note\n begin X := 1; X := 2; end; }`,
      ),
    ).toContain(`var X: Integer; ${REACH_LATCH}: Boolean; // note\n begin`);
  });

  it("R246 fix 1: a // after the header, with no var section, does not swallow the latch", () => {
    // A `//` after the header and no var section: a new section right before `begin`.
    expect(
      latchOut(`codeunit 51909 "R" { procedure P(X: Integer) // hdr\n    begin X := 2; end; }`),
    ).toContain(`procedure P(X: Integer) // hdr\n    var ${REACH_LATCH}: Boolean; begin`);
  });

  it("R246 fix 1: with no var section, the declaration lands before a body-rooted chain", () => {
    // The insertion and the chain start at the same index; the insertion must print first.
    const src = `codeunit 51911 "R" { procedure P(X: Integer) begin X := 2; end; }`;
    const root = parse(src);
    const out = compile({
      src,
      root,
      specs: [spec(bodyOf(root, "P"), "begin end", "lethal.empty-block")],
      wrapped: [],
    });
    expect(out).toContain(`procedure P(X: Integer) var ${REACH_LATCH}: Boolean; begin\n`);
  });

  it("R246 fix 1: a // line and a /* */ block before begin keep one var section", () => {
    // A `//` line and a `/* */` block between the var section and `begin`: still one var section.
    const between = latchOut(
      `codeunit 51910 "R" { procedure P() var X: Integer;\n /* blk */\n // line\n begin X := 1; X := 2; end; }`,
    );
    expect(between).toContain(
      `var X: Integer; ${REACH_LATCH}: Boolean;\n /* blk */\n // line\n begin`,
    );
    expect(between.split(/\bvar\b/).length - 1).toBe(2); // the object's MutationSelector var, and P's
  });

  it("R246: a trigger with a marker declares the latch too", () => {
    const src = `codeunit 51907 "R" { trigger OnRun() var X: Integer; begin X := 1; X := 2; end; }`;
    const root = parse(src);
    const first = nth(root, ALNodeKind.assignment_statement, 0, "X := 1");
    const second = nth(root, ALNodeKind.assignment_statement, 0, "X := 2");
    const out = compile({
      src,
      root,
      // Two separate components in one trigger: still one declaration.
      specs: [
        spec(first, "", "lethal.remove-assignment"),
        spec(second, "", "lethal.remove-assignment"),
      ],
      wrapped: [],
    });
    expect(out).toContain(`var X: Integer; ${REACH_LATCH}: Boolean; begin`);
    expect(out.split(`${REACH_LATCH}: Boolean;`).length - 1).toBe(1);
    expect(out).toContain(REACH_MARKER("M0001"));
    expect(out).toContain(REACH_MARKER("M0002"));
  });

  // GH-24 review r1: the latch is a new local, so a name already in scope would be shadowed (an
  // object global, which even the ORIGINAL branch would then read) or redeclared (a parameter or a
  // local: no compile). The name is chosen per procedure from the parsed object's identifiers.
  const latchOf = (out: string): string | undefined =>
    /if not (\S+) then begin MutationSelector\.Reached\(/.exec(out)?.[1];

  it("GH-24: an object global named like the latch keeps the original branch reading the global", () => {
    const src = `codeunit 51920 "R" { var LethALReachLatch: Boolean; procedure P() var X: Integer; begin if LethALReachLatch then X := 2; end; }`;
    const root = parse(src);
    const body = bodyOf(root, "P");
    const out = compile({
      src,
      root,
      specs: [spec(body, "begin end", "lethal.empty-block")],
      wrapped: [],
    });
    expect(latchOf(out)).toBe(`${REACH_LATCH}2`);
    expect(out).toContain(REACH_MARKER("M0001", `${REACH_LATCH}2`));
    expect(out).toContain(`var X: Integer; ${REACH_LATCH}2: Boolean; begin`);
    expect(out.split(`${REACH_LATCH}: Boolean;`).length - 1).toBe(1); // the global only
    // The unmutated branch is the un-instrumented body, byte for byte, still reading the global.
    expect(out).toContain(`end else begin\n  ${body.text}\nend`);
  });

  it("GH-24: a parameter named like the latch, in any case, gets a different latch", () => {
    for (const name of ["LethALReachLatch", "lethalreachlatch"]) {
      const out = latchOut(
        `codeunit 51921 "R" { procedure P(${name}: Integer) var X: Integer; begin X := 1; X := 2; end; }`,
      );
      expect(latchOf(out)).toBe(`${REACH_LATCH}2`);
      expect(out).toContain(`var X: Integer; ${REACH_LATCH}2: Boolean; begin`);
      expect(out).toContain(REACH_MARKER("M0001", `${REACH_LATCH}2`));
    }
  });

  it("GH-24: a local named like the latch (quoted too) gets a different latch, suffixed until free", () => {
    const out = latchOut(
      `codeunit 51922 "R" { procedure P() var X: Integer; "LethALReachLatch": Integer; LethALReachLatch2: Integer; begin X := 1; X := 2; end; }`,
    );
    expect(latchOf(out)).toBe(`${REACH_LATCH}3`);
    expect(out).toContain(`LethALReachLatch2: Integer; ${REACH_LATCH}3: Boolean; begin`);
  });

  it("GH-24: another procedure's local of that name is not in scope and forces no rename", () => {
    const out = latchOut(
      `codeunit 51924 "R" { procedure P() var X: Integer; begin X := 1; X := 2; end; procedure Q() var LethALReachLatch: Integer; begin LethALReachLatch := 1; end; }`,
    );
    expect(latchOf(out)).toBe(REACH_LATCH);
  });

  it("GH-24: the latch name in a comment or a string forces no rename", () => {
    const out = latchOut(
      `codeunit 51923 "R" { procedure P() var X: Integer; T: Text; begin // LethALReachLatch\n T := 'LethALReachLatch'; X := 1; X := 2; end; }`,
    );
    expect(latchOf(out)).toBe(REACH_LATCH);
    expect(out).toContain(`T: Text; ${REACH_LATCH}: Boolean; begin`);
  });

  it("GH-24: the marker adds no line and appears only in its own branch", () => {
    for (const make of [thenCall, thenExit, listPrefix, ifBody, repeatBody, caseArms]) {
      const s = make();
      const out = compile(s);
      for (const [id, grain] of grains(s)) {
        const count = out.split(REACH_MARKER(id)).length - 1;
        expect(`${id}:${count}`).toBe(`${id}:${grain === "statement" ? 1 : 0}`);
      }
      // Each segment runs from one guard to the next. A marker may only name its own guard's id,
      // and only BEFORE that branch ends, never in the original branch.
      for (const seg of out.split(/(?=MutationSelector\.Active\(')/).slice(1)) {
        const id = /^MutationSelector\.Active\('(M\d+)'\)/.exec(seg)?.[1];
        const branchEnd = seg.indexOf("end else");
        expect(branchEnd).toBeGreaterThan(0);
        for (const m of seg.matchAll(/MutationSelector\.Reached\('(M\d+)'\)/g)) {
          expect(m[1]).toBe(id);
          expect(m.index).toBeLessThan(branchEnd);
        }
      }
      let stripped = out;
      for (const id of s.wrapped) {
        const open = `begin ${REACH_MARKER(id)} `;
        const at = stripped.indexOf(open);
        if (at < 0) continue; // absence is the count check's job, above
        const close = stripped.indexOf(" end", at + open.length);
        stripped =
          stripped.slice(0, at) +
          stripped.slice(at + open.length, close) +
          stripped.slice(close + " end".length);
      }
      // R246: the marker is latched, and the latch is declared in the procedure's var section.
      for (const id of grains(s).keys()) {
        stripped = stripped
          .replaceAll(` ${REACH_MARKER(id)} `, " ")
          .replaceAll(`${REACH_MARKER(id)} `, "");
      }
      stripped = stripped
        .replaceAll(` var ${REACH_LATCH}: Boolean;`, "")
        .replaceAll(` ${REACH_LATCH}: Boolean;`, "");
      expect(stripped).not.toContain("Reached(");
      expect(out.split("\n").length).toBe(stripped.split("\n").length);
      // The pre-GH-24 output, recorded before the marker existed.
      expect(stripped).toMatchSnapshot();
    }
  });
});
