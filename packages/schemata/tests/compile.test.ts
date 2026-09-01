import { beforeAll, describe, expect, it } from "bun:test";
import {
  ALNodeKind,
  declarationMembers,
  findAll,
  findFirst,
  initParser,
  parseAL,
  visit,
  wrapRoot,
} from "@lethal/engine";
import type { ALSyntaxNode, MutationSpec } from "@lethal/engine";
import { canCarryMutationSelectorVar, compileSchemataForFile } from "../src/compile";

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
    expect(out).toContain("if A <> 0 then begin end;\n        A := 2;");
    expect(out).not.toMatch(/begin end\s*\n\s*A := 2;/);
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

    expect(out).toContain("if A <> 0 then begin end;\n            A := 2;");
    expect(out).not.toMatch(/begin end\s*\n\s*A := 2;/);
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
    expect(out).toContain("if X > 0 then begin end\n        else\n            Y := 2\n");
    expect(out).not.toMatch(/begin end;\s*else/);
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
