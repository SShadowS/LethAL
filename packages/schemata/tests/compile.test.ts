import { beforeAll, describe, expect, it } from "bun:test";
import {
  ALNodeKind,
  FileRefusedError,
  declarationMembers,
  findAll,
  findEnclosingStatement,
  findFirst,
  formatRefusal,
  initParser,
  parseAL,
  visit,
  wrapRoot,
} from "@lethal/engine";
import type { ALSyntaxNode, MutationSpec } from "@lethal/engine";
import {
  canCarryMutationSelectorVar,
  compileSchemataForFile,
  latchAnchorInVarSection,
} from "../src/compile";
import { buildComponents } from "../src/components";
import {
  REACH_LATCH,
  REACH_MARKER,
  preambleArmHeaderEnds,
  reachGrainOf,
  reachLatchRefusedOwner,
  splitVarHoistAnchor,
  varSectionUnparsed,
} from "../src/dispatch";
import { assignMutantIds } from "../src/ids";
import { instrumentOneFile } from "../src/project";

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
    // R307: a per-file refusal, typed, with the file's own object and the guarded line.
    expect(thrown).toBeInstanceOf(FileRefusedError);
    if (!(thrown instanceof FileRefusedError)) return;
    expect(thrown.file).toBe("MyPort.XmlPort.al");
    expect(thrown.shape).toBe("unsupported-kind");
    expect(thrown.site).toBe("compile.unsupported-kind");
    expect(thrown.objects).toEqual([{ type: "xmlport", id: 50100, name: "My Port" }]);
    expect(thrown.lines).toEqual([11, 11]);
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
      for (const m of c.members) out.set(m.mutantId, reachGrainOf(m, c.root, s.src));
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
/**
 * R297. The grammar lets a `#if` block holding a procedure, an attribute or a split procedure sit
 * inside the object's `var_body`. The injector used to REPLACE the whole var section and append the
 * selector at its end, so an edit inside the swallowed procedure overlapped the replace, and when
 * nothing overlapped the selector landed after a procedure or between an attribute and its
 * procedure. Each test first pins the parse shape it relies on, so a grammar change cannot make it
 * vacuous. The byte-identity of ordinary var sections is pinned through the full pipeline in
 * `packages/runner/tests/preproc-instrumentation.test.ts`.
 */
describe("R297: the selector var is inserted after the leading declarations", () => {
  const SELECTOR = 'MutationSelector: Codeunit "Mutation Selector";';

  beforeAll(async () => {
    await initParser();
  });

  /** The object's own var_body children. */
  function objectVarBody(root: ALSyntaxNode): readonly ALSyntaxNode[] {
    const section = findFirst(root, ALNodeKind.var_section);
    const body = section?.children.find((c) => c.rawKind === "var_body");
    if (body === undefined) throw new Error("fixture drift: no object var_body");
    return body.namedChildren;
  }

  function holds(n: ALSyntaxNode, rawKind: string): boolean {
    return n.namedChildren.some((c) => c.rawKind === rawKind);
  }

  function assignment(root: ALSyntaxNode, text: string): ALSyntaxNode {
    const a = findAll(root, ALNodeKind.assignment_statement).find((n) => n.text === text);
    if (a === undefined) throw new Error(`fixture drift: no assignment ${text}`);
    return a;
  }

  function selectorAt(out: string): number {
    expect(out.split(SELECTOR).length - 1).toBe(1);
    return out.indexOf(SELECTOR);
  }

  it("a-swallow: a #if holding a procedure after the declarations is not replaced", () => {
    const src = `codeunit 50100 "Repro A"
{
    var
        G: Integer;
#if not CLEAN27
    procedure A()
    var
        L: Integer;
    begin
        L := 1;
        G := L;
        Message('%1', L);
    end;
#endif

    procedure B()
    begin
        G := 2;
        Message('%1', G);
    end;
}
`;
    const root = wrapRoot(parseAL(src));
    const body = objectVarBody(root);
    expect(body.map((c) => c.rawKind)).toEqual(["variable_declaration", "preproc_conditional_var"]);
    const [, cond] = body;
    if (cond === undefined) throw new Error("fixture drift");
    expect(holds(cond, "procedure")).toBe(true);
    const out = compileSchemataForFile(src, root, [
      spec(assignment(root, "L := 1"), "L := 2", "lethal.op"),
    ]);
    const at = selectorAt(out);
    expect(at).toBeGreaterThan(out.indexOf("G: Integer;"));
    expect(at).toBeLessThan(out.indexOf("#if"));
  });

  it("a-only-swallow: a var section holding only a swallowed procedure gets the selector right after `var`", () => {
    const src = `codeunit 50100 "Repro A"
{
    var
#if not CLEAN27
    procedure A()
    var
        L: Integer;
    begin
        L := 1;
        Message('%1', L);
    end;
#endif

    procedure B()
    var
        G: Integer;
    begin
        G := 2;
        Message('%1', G);
    end;
}
`;
    const root = wrapRoot(parseAL(src));
    const body = objectVarBody(root);
    expect(body.map((c) => c.rawKind)).toEqual(["preproc_conditional_var"]);
    const [cond] = body;
    if (cond === undefined) throw new Error("fixture drift");
    expect(holds(cond, "procedure")).toBe(true);
    const out = compileSchemataForFile(src, root, [
      spec(assignment(root, "L := 1"), "L := 2", "lethal.op"),
    ]);
    const at = selectorAt(out);
    expect(out.slice(0, at)).toMatch(/\{\s*var\s*$/);
  });

  it("a-mixed: a #if holding a declaration AND a procedure ends the run, so the selector precedes it", () => {
    const src = `codeunit 50100 "Repro A"
{
    var
        G: Integer;
#if not CLEAN27
        H: Integer;

    procedure A()
    var
        L: Integer;
    begin
        L := 1;
        H := L;
        Message('%1', H);
    end;
#endif

    procedure B()
    begin
        G := 2;
        Message('%1', G);
    end;
}
`;
    const root = wrapRoot(parseAL(src));
    const body = objectVarBody(root);
    expect(body.map((c) => c.rawKind)).toEqual(["variable_declaration", "preproc_conditional_var"]);
    const [, cond] = body;
    if (cond === undefined) throw new Error("fixture drift");
    expect(holds(cond, "variable_declaration") && holds(cond, "procedure")).toBe(true);
    const out = compileSchemataForFile(src, root, [
      spec(assignment(root, "L := 1"), "L := 2", "lethal.op"),
    ]);
    const at = selectorAt(out);
    expect(at).toBeGreaterThan(out.indexOf("G: Integer;"));
    expect(at).toBeLessThan(out.indexOf("#if"));
    expect(at).toBeLessThan(out.indexOf("H: Integer;"));
  });

  it("a-attr: a #if holding only an attribute belongs to the next procedure, so the selector precedes it", () => {
    const src = `codeunit 50100 "Repro A"
{
    var
        G: Integer;
#if not CLEAN27
    [Obsolete('x', '27.0')]
#endif
    procedure A()
    var
        L: Integer;
    begin
        L := 1;
        G := L;
        Message('%1', L);
    end;

    procedure B()
    begin
        G := 2;
        Message('%1', G);
    end;
}
`;
    const root = wrapRoot(parseAL(src));
    const body = objectVarBody(root);
    expect(body.map((c) => c.rawKind)).toEqual(["variable_declaration", "preproc_conditional_var"]);
    const [, cond] = body;
    if (cond === undefined) throw new Error("fixture drift");
    expect(holds(cond, "attribute_item")).toBe(true);
    const out = compileSchemataForFile(src, root, [
      spec(assignment(root, "L := 1"), "L := 2", "lethal.op"),
    ]);
    const at = selectorAt(out);
    expect(at).toBeGreaterThan(out.indexOf("G: Integer;"));
    expect(at).toBeLessThan(out.indexOf("#if"));
  });

  it("an attribute plus an empty procedure in a #if (ContactSyncProcessor's shape) is not followed by the selector", () => {
    // No spec sits inside the swallowed procedure, so nothing overlapped at HEAD: the selector was
    // appended after `#endif`, after a procedure, which alc rejects in the `#if`'s active arm.
    const src = `codeunit 50100 "Repro A"
{
    var
        G: Integer;
#if not CLEAN27
    [Obsolete('x', '27.0')]
    procedure A(X: Integer)
    begin
    end;
#endif
    procedure A()
    var
        L: Integer;
    begin
        L := 1;
        G := L;
        Message('%1', L);
    end;
}
`;
    const root = wrapRoot(parseAL(src));
    const body = objectVarBody(root);
    expect(body.map((c) => c.rawKind)).toEqual(["variable_declaration", "preproc_conditional_var"]);
    const [, cond] = body;
    if (cond === undefined) throw new Error("fixture drift");
    expect(holds(cond, "attribute_item") && holds(cond, "procedure")).toBe(true);
    const out = compileSchemataForFile(src, root, [
      spec(assignment(root, "L := 1"), "L := 2", "lethal.op"),
    ]);
    const at = selectorAt(out);
    expect(at).toBeGreaterThan(out.indexOf("G: Integer;"));
    expect(at).toBeLessThan(out.indexOf("#if"));
  });

  it("a-bare-split: a split procedure directly under var_body ends the run", () => {
    const src = `codeunit 50100 "Repro A"
{
    var
        G: Integer;
#if CLEAN27
    procedure A(X: Integer)
#else
    procedure A(X: Integer; Y: Integer)
#endif
    var
        L: Integer;
    begin
        L := X;
        G := L;
        Message('%1', L);
    end;

    procedure B()
    begin
        G := 2;
        Message('%1', G);
    end;
}
`;
    const root = wrapRoot(parseAL(src));
    expect(objectVarBody(root).map((c) => c.rawKind)).toEqual([
      "variable_declaration",
      "preproc_split_procedure",
    ]);
    // The spec sits in B; a spec inside the split procedure is R301's test below.
    const out = compileSchemataForFile(src, root, [
      spec(assignment(root, "G := 2"), "G := 3", "lethal.op"),
    ]);
    const at = selectorAt(out);
    expect(at).toBeGreaterThan(out.indexOf("G: Integer;"));
    expect(at).toBeLessThan(out.indexOf("#if"));
  });

  const PREAMBLE = `codeunit 50100 "Repro A"
{
    var
        G: Integer;
#if CLEAN27
    procedure A()
    var
        L: Integer;
#else
    procedure A()
    var
        L: Integer;
        M: Integer;
#endif
    begin
        L := 1;
        G := L;
        Message('%1', L);
    end;

    procedure B()
    begin
        G := 2;
        Message('%1', G);
    end;
}
`;

  it("a-preamble, in isolation: a spec outside the preamble puts the selector before the #if (position only)", () => {
    // The preamble parses as a SIBLING of the var section, not inside var_body, so this shape never
    // reaches the allowlist and this test is green at HEAD too; only the position is claimed.
    const root = wrapRoot(parseAL(PREAMBLE));
    expect(objectVarBody(root).map((c) => c.rawKind)).toEqual(["variable_declaration"]);
    const out = compileSchemataForFile(PREAMBLE, root, [
      spec(assignment(root, "G := 2"), "G := 3", "lethal.op"),
    ]);
    expect(selectorAt(out)).toBeLessThan(out.indexOf("#if"));
  });

  it("a-preamble: a spec inside the preamble procedure takes a latch in each arm (R316)", () => {
    const root = wrapRoot(parseAL(PREAMBLE));
    const s = spec(assignment(root, "L := 1"), "L := 2", "lethal.op");
    expect(reachLatchRefusedOwner(s.before)).toBeNull();
    const out = compileSchemataForFile(PREAMBLE, root, [s]);
    expect(out.split(`    procedure A() var ${REACH_LATCH}: Boolean;`).length - 1).toBe(2);
    expect(out.split("MutationSelector.Reached(").length - 1).toBe(1);
    expect(selectorAt(out)).toBeLessThan(out.indexOf("#if"));
  });

  it("R251: specs for one object from two separate tree walks yield exactly one selector", () => {
    const src = `codeunit 50100 "Repro A"
{
    var
        G: Integer;

    procedure A()
    begin
        G := 1;
    end;

    procedure B()
    begin
        G := 2;
    end;
}
`;
    const first = wrapRoot(parseAL(src));
    const second = wrapRoot(parseAL(src));
    const out = compileSchemataForFile(src, first, [
      spec(assignment(first, "G := 1"), "G := 5", "lethal.op"),
      spec(assignment(second, "G := 2"), "G := 6", "lethal.op"),
    ]);
    selectorAt(out);
  });
});

describe("R298: #if-wrapped objects are instrumented (one object-container rule)", () => {
  const SELECTOR = 'MutationSelector: Codeunit "Mutation Selector";';
  const body = (name: string): string => `{
    procedure ${name}()
    var
        L: Integer;
    begin
        L := 1;
        Message('%1', L);
    end;
}
`;
  const B_SINGLE = `#if not CLEAN27\ncodeunit 50101 "Repro B"\n${body("P")}#endif\n`;
  const B_TWO_ARM = `#if CLEAN27\ncodeunit 50103 "Repro B2"\n${body("AIf")}#else\ncodeunit 50103 "Repro B2"\n${body("AElse")}#endif\n`;

  beforeAll(async () => {
    await initParser();
  });

  /** Every node of ONE walk, so specs share a traversal the way the real pipeline's do. */
  function nodesOf(root: ALSyntaxNode): ALSyntaxNode[] {
    const out: ALSyntaxNode[] = [];
    visit(root, (n) => {
      out.push(n);
    });
    return out;
  }

  const count = (text: string, needle: string): number => text.split(needle).length - 1;

  it("b-single: one selector line, inside the codeunit's braces", () => {
    const root = wrapRoot(parseAL(B_SINGLE));
    const nodes = nodesOf(root);
    const assign = nodes.find((n) => n.kind === ALNodeKind.assignment_statement);
    if (assign === undefined) throw new Error("fixture drift: no assignment");
    const out = compileSchemataForFile(B_SINGLE, root, [spec(assign, "L := 2", "lethal.op")]);
    expect(count(out, SELECTOR)).toBe(1);
    const at = out.indexOf(SELECTOR);
    expect(at).toBeGreaterThan(out.indexOf("{"));
    expect(at).toBeLessThan(out.indexOf("procedure P"));
    expect(at).toBeLessThan(out.indexOf("#endif"));
  });

  it("b-two-arm: specs in both arms, one walk, one selector per arm", () => {
    const root = wrapRoot(parseAL(B_TWO_ARM));
    const assigns = nodesOf(root).filter((n) => n.kind === ALNodeKind.assignment_statement);
    expect(assigns).toHaveLength(2);
    const out = compileSchemataForFile(
      B_TWO_ARM,
      root,
      assigns.map((a) => spec(a, "L := 2", "lethal.op")),
    );
    expect(count(out, SELECTOR)).toBe(2);
    const elseAt = out.indexOf("#else");
    const first = out.indexOf(SELECTOR);
    const second = out.indexOf(SELECTOR, first + 1);
    expect(first).toBeGreaterThan(out.indexOf("{"));
    expect(first).toBeLessThan(out.indexOf("procedure AIf"));
    expect(second).toBeGreaterThan(elseAt);
    expect(second).toBeLessThan(out.indexOf("procedure AElse"));
  });

  it("b-single: a statement-grain spec emits the reach latch", () => {
    const root = wrapRoot(parseAL(B_SINGLE));
    const nodes = nodesOf(root);
    const block = nodes.find(
      (n) => n.kind === ALNodeKind.block && n.parent?.kind === ALNodeKind.procedure,
    );
    const assign = nodes.find((n) => n.kind === ALNodeKind.assignment_statement);
    if (block === undefined || assign === undefined) throw new Error("fixture drift");
    const out = compileSchemataForFile(B_SINGLE, root, [
      spec(block, "begin end", "lethal.empty-block"),
      spec(assign, "", "lethal.remove-assignment"),
    ]);
    expect(out).toContain(`${REACH_LATCH}: Boolean;`);
    expect(count(out, SELECTOR)).toBe(1);
  });
});

/** R301 (class C) repros, hand-written: a procedure whose HEADER is split by `#if`. */
const C_SPLIT_HEADER = (ifArm: string, elseArm: string): string => `codeunit 50100 "Repro C"
{
    procedure First()
    var
        L: Integer;
    begin
        L := 1;
        Message('%1', L);
    end;

#if CLEAN27
    ${ifArm}
#else
    ${elseArm}
#endif
    var
        L: Integer;
    begin
        L := X;
        Message('%1', L);
    end;
}
`;
const C_SPLIT = C_SPLIT_HEADER("procedure A(X: Integer)", "internal procedure A(X: Integer)");

describe("R301: a split-header procedure owns its reach latch", () => {
  beforeAll(async () => {
    await initParser();
  });

  function assignment(root: ALSyntaxNode, text: string): ALSyntaxNode {
    const a = findAll(root, ALNodeKind.assignment_statement).find((n) => n.text === text);
    if (a === undefined) throw new Error(`fixture drift: no assignment ${text}`);
    return a;
  }

  it("c-split: a spec in the split body does not throw and declares the latch in the shared var section", () => {
    const root = wrapRoot(parseAL(C_SPLIT));
    const out = compileSchemataForFile(C_SPLIT, root, [
      spec(assignment(root, "L := X"), "L := 0", "lethal.op"),
    ]);
    expect(out).toContain(`L: Integer; ${REACH_LATCH}: Boolean;`);
    expect(out.split(`${REACH_LATCH}: Boolean;`).length - 1).toBe(1);
    // Declared in the split procedure (after its #endif), not in First.
    expect(out.indexOf(`${REACH_LATCH}: Boolean;`)).toBeGreaterThan(out.indexOf("#endif"));
  });

  it("a-bare-split: a spec inside a split procedure directly under var_body instruments", () => {
    const src = `codeunit 50100 "Repro A"
{
    var
        G: Integer;
#if CLEAN27
    procedure A(X: Integer)
#else
    procedure A(X: Integer; Y: Integer)
#endif
    var
        L: Integer;
    begin
        L := X;
        G := L;
        Message('%1', L);
    end;

    procedure B()
    begin
        G := 2;
        Message('%1', G);
    end;
}
`;
    const root = wrapRoot(parseAL(src));
    const out = compileSchemataForFile(src, root, [
      spec(assignment(root, "L := X"), "L := 0", "lethal.op"),
    ]);
    expect(out).toContain(`L: Integer; ${REACH_LATCH}: Boolean;`);
  });

  it("latchNameFor: a split procedure's locals are not in another procedure's scope", () => {
    // The split procedure declares a local named like the latch; First cannot see it, so First's
    // latch keeps the plain name. Walking into the split procedure would suffix it to `...2`.
    const src = C_SPLIT.replace(
      "        L: Integer;\n    begin\n        L := X;",
      `        L: Integer;\n        ${REACH_LATCH}: Integer;\n    begin\n        L := X;`,
    );
    expect(src).not.toBe(C_SPLIT);
    const root = wrapRoot(parseAL(src));
    const out = compileSchemataForFile(src, root, [
      spec(assignment(root, "L := 1"), "L := 0", "lethal.op"),
    ]);
    expect(out).toContain(`L: Integer; ${REACH_LATCH}: Boolean;`);
    expect(out).not.toContain(`${REACH_LATCH}2`);
  });
});

/** R303 repro, hand-written: members whose `var` section sits inside `#if`, beside a plain one. */
const R303_SRC = `codeunit 50100 "Repro D"
{
    trigger OnRun()
#if not CLEAN27
    var
        L: Integer;
#else
    var
        M: Integer;
#endif
    begin
        Glob := Glob + 1;
    end;

    procedure Pick(X: Integer): Integer
#if not CLEAN27
    var
        K: Integer;
#endif
    begin
        Glob := X + 1;
        exit(0);
    end;

    procedure Plain(X: Integer): Integer
    var
        P: Integer;
    begin
        P := X + 2;
        exit(P);
    end;

    var
        Glob: Integer;
}
`;

/** tree-sitter-al's ERROR count for one nested `#if` inside an ordinary var section's `#if`: a
 *  grammar gap, filed upstream as SShadowS/tree-sitter-al #30. */
const NESTED_IF_IN_VAR_ERRORS = 3;

/** Re-parsed emitted text: declarations named `latch` directly in a var section, those nested
 *  deeper (inside an #if), and how many split var blocks are left. */
function latchShape(
  out: string,
  latch: string,
): { direct: number; nested: number; blocks: number } {
  const root = wrapRoot(parseAL(out));
  let direct = 0;
  let nested = 0;
  let blocks = 0;
  visit(root, (n) => {
    if (n.rawKind === "preproc_conditional_var_block") blocks++;
    if (n.rawKind !== "variable_declaration") return;
    if (n.childForFieldName("name")?.text !== latch) return;
    if (n.parent?.rawKind === "var_body") direct++;
    else nested++;
  });
  return { direct, nested, blocks };
}

/**
 * `parseErrors`: ERROR nodes tree-sitter-al gives the EMITTED text. Non-zero only where the
 * grammar cannot parse the result at all, pinned by the grammar control below (a nested `#if`
 * inside an ordinary var section, hand-written, gives the same count). alc is the authority there.
 */
const HOIST_CASES: { name: string; src: string; header: string; parseErrors?: number }[] = [
  {
    name: "S1 procedure with a return type, #if arm only",
    header: "    procedure Pick(X: Integer): Integer",
    src: `codeunit 50100 "Repro H"
{
    procedure Pick(X: Integer): Integer
#if not CLEAN27
    var
        K: Integer;
#endif
    begin
        Glob := X + 1;
    end;

    var
        Glob: Integer;
}
`,
  },
  {
    name: "S2 trigger, #if and #else arms",
    header: "    trigger OnRun()",
    src: `codeunit 50100 "Repro H"
{
    trigger OnRun()
#if not CLEAN27
    var
        L: Integer;
#else
    var
        M: Integer;
#endif
    begin
        Glob := Glob + 1;
    end;

    var
        Glob: Integer;
}
`,
  },
  {
    name: "S3 header ending in ; and a // comment, nested #if in the arm",
    parseErrors: NESTED_IF_IN_VAR_ERRORS,
    header: "    procedure Pick(X: Integer);",
    src: `codeunit 50100 "Repro H"
{
    procedure Pick(X: Integer); // header note
#if not CLEAN27
    var
        K: Integer;
#if A
        N: Integer;
#endif
#endif
    begin
        Glob := X + 1;
    end;

    var
        Glob: Integer;
}
`,
  },
  {
    name: "S4 named return, empty #if arm, var only in #else",
    // No object var section, so R-297 writes the selector's section before this member, which
    // takes the member's indentation with it.
    header: "local procedure Named(X: Integer) R: Integer",
    src: `codeunit 50100 "Repro H"
{
    local procedure Named(X: Integer) R: Integer
#if CLEAN27
#else
    var
        K: Integer;
#endif
    begin
        R := X + 1;
    end;
}
`,
  },
  {
    name: "S5 #elif chain with an empty middle arm and an attribute",
    header: "    procedure E(X: Integer)",
    src: `codeunit 50100 "Repro H"
{
    procedure E(X: Integer)
#if A
    var K: Integer;
#elif B
#else
    var
        [NonDebuggable]
        M: Text;
#endif
    begin
        Glob := X + 1;
    end;

    var
        Glob: Integer;
}
`,
  },
  {
    name: "S8 a // comment on its own line between the header and #if",
    header: "    procedure C(X: Integer)",
    src: `codeunit 50100 "Repro H"
{
    procedure C(X: Integer)
    // own-line note
#if not CLEAN27
    var
        K: Integer;
#endif
    begin
        Glob := X + 1;
    end;

    var
        Glob: Integer;
}
`,
  },
  {
    name: "S9 an attribute before the member",
    header: "    procedure Pick(X: Integer): Integer",
    src: `codeunit 50100 "Repro H"
{
    [Scope('OnPrem')]
    procedure Pick(X: Integer): Integer
#if not CLEAN27
    var
        K: Integer;
#endif
    begin
        Glob := X + 1;
    end;

    var
        Glob: Integer;
}
`,
  },
  {
    name: "S11 #elif chain where every arm declares",
    header: "    procedure E(X: Integer)",
    src: `codeunit 50100 "Repro H"
{
    procedure E(X: Integer)
#if A
    var K: Integer;
#elif B
    var N: Integer;
#else
    var
        M: Text;
#endif
    begin
        Glob := X + 1;
    end;

    var
        Glob: Integer;
}
`,
  },
  {
    name: "S10 parameters spanning lines: the latch goes on the header's LAST line",
    header: "        Z: Text): Integer",
    src: `codeunit 50100 "Repro H"
{
    procedure Pick(X: Integer;
        Y: Integer;
        Z: Text): Integer
#if not CLEAN27
    var
        K: Integer;
#else
    var
        M: Integer;
#endif
    begin
        Glob := X + 1;
    end;

    var
        Glob: Integer;
}
`,
  },
  {
    // R-303 final review M5. A single #if arm (no #else) whose own var section ends in a NESTED
    // #if of more declarations, one level deeper than R312's own INBODY shape: the shape
    // `splitVarHoistAnchor`/`varSectionUnparsed` admit from the INPUT parse (0 ERROR nodes there,
    // same as S3's nested #if above), so it gets a latch, not a refusal. The EMITTED text's
    // re-parse hits the same tree-sitter-al gap S3 does, hence `parseErrors` below; alc is the
    // authority there, and alc-proved this exact shape under every subset of A and B
    // (`fr-nested-arm`, local, no BC container), plus a local al-runner run under every subset:
    // both PASS, `reachGrain=statement` on all 4 mutants in every subset, 0 errors.
    name: "S12 a nested #if inside the arm's own var section, no #else",
    parseErrors: NESTED_IF_IN_VAR_ERRORS,
    header: "    procedure Pick(X: Integer): Integer",
    src: `codeunit 50100 "Repro H"
{
    procedure Pick(X: Integer): Integer
#if A
    var
        K: Integer;
#if B
        M: Integer;
#endif
#endif
    begin
        Glob := X + 1;
    end;

    var
        Glob: Integer;
}
`,
  },
  {
    // alc and al-runner proved this as `s6-empty-var-arm` (scratch evidence, run 001).
    name: "S6 an #if arm holding a bare var with no declarations",
    header: "    procedure P(X: Integer)",
    src: `codeunit 50100 "Repro H"
{
    procedure P(X: Integer)
#if A
    var
#else
    var
        K: Integer;
#endif
    begin
        Glob := X + 1;
    end;

    var
        Glob: Integer;
}
`,
  },
  {
    // R-303 run 002, `d8-split-then-pragma`: a `#pragma` between the split block and `begin`.
    name: "D8 a #pragma after the split var block",
    header: "    procedure Split(X: Integer)",
    src: `codeunit 50100 "Repro H"
{
    procedure Split(X: Integer)
#if not CLEAN27
    var
        K: Integer;
#endif
#pragma warning disable AL0432
    begin
        Glob := X + 1;
    end;

    var
        Glob: Integer;
}
`,
  },
];

describe("R303: a member whose var section is split by #if gets one unconditional latch", () => {
  beforeAll(async () => {
    await initParser();
  });

  const firstAssignment = (root: ALSyntaxNode): ALSyntaxNode => {
    const a = findAll(root, ALNodeKind.assignment_statement)[0];
    if (a === undefined) throw new Error("fixture drift: no assignment");
    return a;
  };
  const instrument = (src: string) => {
    const root = wrapRoot(parseAL(src));
    const specs = [spec(firstAssignment(root), "Glob := 0", "lethal.op")];
    const ided = assignMutantIds(new Map([["f.al", specs]])).get("f.al") ?? [];
    const grains = buildComponents(ided).flatMap((c) =>
      c.members.map((m) => reachGrainOf(m, c.root, src)),
    );
    return { grains, out: compileSchemataForFile(src, root, specs, ided) };
  };

  const [s1] = HOIST_CASES;
  if (s1 === undefined) throw new Error("fixture drift: no S1 case");
  for (const c of [
    ...HOIST_CASES,
    { ...s1, name: "S1-crlf", src: s1.src.replace(/\n/g, "\r\n") },
  ]) {
    it(`${c.name}: statement grain, latch on the header line, every arm's var blanked, no line moved`, () => {
      const { grains, out } = instrument(c.src);
      expect(grains).toEqual(["statement"]);
      expect(out).toContain(`${c.header} var ${REACH_LATCH}: Boolean;`);
      expect(latchShape(out, REACH_LATCH)).toEqual({ direct: 1, nested: 0, blocks: 0 });
      // Every arm's own `var` is blanked: between the header and `begin` the only `var` left is the
      // latch's. The re-parse above cannot see this: tree-sitter-al accepts a repeated `var`
      // inside an #if arm of one section, while alc rejects it (AL0104).
      const head = out.indexOf(c.header);
      const section = out.slice(head, out.indexOf("\n    begin", head));
      expect(section.match(/\bvar\b/gi)?.length).toBe(1);
      expect(out.split("MutationSelector.Reached(").length - 1).toBe(1);
      expect(directiveLinesClean(out)).toBe(true);
      expect(linesWithoutInstrumentation(out)).toBe(c.src.split("\n").length);
      expect(countErrorNodes(out)).toBe(c.parseErrors ?? 0);
    });
  }

  it("grammar control: a nested #if inside an ordinary var section is a tree-sitter-al gap", () => {
    const src = `codeunit 50100 "Repro G"
{
    procedure Pick(X: Integer)
    var
        L: Boolean;
#if not CLEAN27
        K: Integer;
#if A
        N: Integer;
#endif
#endif
    begin
    end;
}
`;
    expect(countErrorNodes(src)).toBe(NESTED_IF_IN_VAR_ERRORS);
  });

  it("S7: an arm that declares the default name pushes the latch to a free one", () => {
    const src = `codeunit 50100 "Repro H"
{
    procedure P(X: Integer)
#if A
    var
        ${REACH_LATCH}: Integer;
#endif
    begin
        Glob := X + 1;
    end;

    var
        Glob: Integer;
}
`;
    const { out } = instrument(src);
    expect(out).toContain(`    procedure P(X: Integer) var ${REACH_LATCH}2: Boolean;`);
    expect(latchShape(out, `${REACH_LATCH}2`)).toEqual({ direct: 1, nested: 0, blocks: 0 });
  });

  it("M1: R-297's selector anchor and both latch insertions in one emitted file", () => {
    const src = `codeunit 50100 "Repro M"
{
    var
        G: Integer;
#if not CLEAN27
        H: Integer;
#endif

    procedure Pick(X: Integer): Integer
#if not CLEAN27
    var
        K: Integer;
#endif
    begin
        G := X + 1;
    end;

    procedure Keep(X: Integer): Integer
    var
#if not CLEAN27
        L: Integer;
#endif
    begin
        G := X + 2;
    end;

    procedure Plain(X: Integer): Integer
    var
        P: Integer;
    begin
        G := X + 3;
    end;
}
`;
    const root = wrapRoot(parseAL(src));
    const specs = findAll(root, ALNodeKind.assignment_statement).map((n) =>
      spec(n, "G := 0", "lethal.op"),
    );
    const ided = assignMutantIds(new Map([["f.al", specs]])).get("f.al") ?? [];
    const out = compileSchemataForFile(src, root, specs, ided);
    expect(out.split(SELECTOR_DECL).length - 1).toBe(1);
    // R-297's real behaviour: an #if block holding only declarations is declaration-only, so the
    // selector goes after its #endif, on a line of its own (as in a-ordinary-ifdecl's HEAD_EMIT).
    expect(out).toContain(
      `        G: Integer;\n#if not CLEAN27\n        H: Integer;\n#endif\n        ${SELECTOR_DECL}\n`,
    );
    expect(out).toContain(`    procedure Pick(X: Integer): Integer var ${REACH_LATCH}: Boolean;`);
    expect(out).toContain(`    var ${REACH_LATCH}: Boolean;\n#if not CLEAN27\n        L: Integer;`);
    expect(out).toContain(`P: Integer; ${REACH_LATCH}: Boolean;`);
    expect(out.split(`${REACH_LATCH}: Boolean;`).length - 1).toBe(3);
    expect(directiveLinesClean(out)).toBe(true);
    expect(linesWithoutInstrumentation(out)).toBe(src.split("\n").length);
    expect(countErrorNodes(out)).toBe(0);
  });

  it("R303_SRC: all three members get a latch; none is refused", () => {
    const root = wrapRoot(parseAL(R303_SRC));
    const specs = findAll(root, ALNodeKind.assignment_statement)
      .filter((n) => ["Glob := Glob + 1", "Glob := X + 1", "P := X + 2"].includes(n.text))
      .map((n) => spec(n, "Glob := 0", "lethal.op"));
    const ided = assignMutantIds(new Map([["f.al", specs]])).get("f.al") ?? [];
    const out = compileSchemataForFile(R303_SRC, root, specs, ided);
    expect(out.split(`${REACH_LATCH}: Boolean;`).length - 1).toBe(3);
    expect(out).toContain(`    trigger OnRun() var ${REACH_LATCH}: Boolean;`);
    expect(out).toContain(`    procedure Pick(X: Integer): Integer var ${REACH_LATCH}: Boolean;`);
    expect(out).toContain(`P: Integer; ${REACH_LATCH}: Boolean;`);
    expect(latchShape(out, REACH_LATCH).blocks).toBe(0);
    expect(countErrorNodes(out)).toBe(0);
  });

  it("a token of a header-end kind that is not the header's end is no anchor", () => {
    // `);;`: the second `;` sits after an ERROR node, not directly after `)`. alc rejects this
    // source too (AL0519); it is here because it is the one parse found whose token before the
    // block has a header-end KIND without being the header's END, which a kind check would admit.
    const src = `codeunit 50100 "Repro X"
{
    procedure P(X: Integer);;
#if not CLEAN27
    var
        K: Integer;
#endif
    begin
    end;
}
`;
    const blocks: ALSyntaxNode[] = [];
    visit(wrapRoot(parseAL(src)), (n) => {
      if (n.rawKind === "preproc_conditional_var_block") blocks.push(n);
    });
    const owner = blocks[0]?.parent;
    if (owner === undefined || owner === null) throw new Error("fixture drift: no block owner");
    expect(owner.children.map((k) => k.rawKind).slice(4, 7)).toEqual([")", "ERROR", ";"]);
    expect(splitVarHoistAnchor(owner)).toBeNull();
  });

  // tree-sitter-al puts both of these under ERROR nodes, so the owner has no
  // `preproc_conditional_var_block` child for the hoist to see. Before the refusal, two-blocks
  // got its latch in the second block's section (alc AL0118 under [A]) and nested-wrap got a new
  // `var` before `begin` (alc AL0104 under [A,B]).
  const UNPARSED: { name: string; member: string }[] = [
    {
      name: "two #if var blocks in a row",
      member: `    procedure E(X: Integer)
#if A
    var K: Integer;
#endif
#if not A
    var N: Integer;
#endif
    begin
        Glob := X + 1;
    end;
`,
    },
    {
      name: "a nested #if wrapping the whole var section",
      member: `    procedure E(X: Integer)
#if A
#if B
    var K: Integer;
#endif
#endif
    begin
        Glob := X + 1;
    end;
`,
    },
  ];
  for (const u of UNPARSED) {
    it(`${u.name}: the var section does not parse, so the member is refused and gets no latch`, () => {
      const src = `codeunit 50100 "Repro U"
{
${u.member}
    procedure Plain(X: Integer)
    var
        P: Integer;
    begin
        Glob := X + 3;
    end;

    var
        Glob: Integer;
}
`;
      const root = wrapRoot(parseAL(src));
      const specs = findAll(root, ALNodeKind.assignment_statement).map((n) =>
        spec(n, "Glob := 0", "lethal.op"),
      );
      const [e, plain] = specs;
      if (e === undefined || plain === undefined) throw new Error("fixture drift: two assignments");
      const owner = reachLatchRefusedOwner(e.before);
      if (owner === null) throw new Error("expected the member to be refused");
      expect(owner.text.startsWith("procedure E(")).toBe(true);
      expect(owner.children.some((c) => c.rawKind === "preproc_conditional_var_block")).toBe(false);
      expect(varSectionUnparsed(owner)).toBe(true);
      expect(reachLatchRefusedOwner(plain.before)).toBeNull();
      const ided = assignMutantIds(new Map([["f.al", specs]])).get("f.al") ?? [];
      const grains = buildComponents(ided).flatMap((c) =>
        c.members.map((m) => reachGrainOf(m, c.root, src)),
      );
      expect(grains).toEqual(["unplaced", "statement"]);
      const out = compileSchemataForFile(src, root, specs, ided);
      expect(out.split(`${REACH_LATCH}: Boolean;`).length - 1).toBe(1);
      expect(out).toContain(`P: Integer; ${REACH_LATCH}: Boolean;`);
    });
  }

  it("a missing node (no ERROR) in the var section also counts as unparsed; a clean one does not", () => {
    const member = (decl: string) => {
      const src = `codeunit 50100 "Repro M"
{
    procedure P(X: Integer)
    var
        ${decl}
    begin
        K := X;
    end;
}
`;
      const root = wrapRoot(parseAL(src));
      const p = findAll(root, ALNodeKind.procedure)[0];
      if (p === undefined) throw new Error("fixture drift: no procedure");
      return { p, errors: countErrorNodes(src) };
    };
    // `K: Integer` without its `;`: tree-sitter-al inserts a zero-width missing `;`, no ERROR.
    const missing = member("K: Integer");
    expect(missing.errors).toBe(0);
    expect(varSectionUnparsed(missing.p)).toBe(true);
    expect(varSectionUnparsed(member("K: Integer;").p)).toBe(false);
  });

  it("a pragma-only #if before the block, and a split header, stay refused", () => {
    const src = `codeunit 50100 "Repro R"
{
    procedure Prag(X: Integer)
#if not CLEAN27
#pragma warning disable AL0432
#endif
#if not CLEAN27
    var
        K: Integer;
#endif
    begin
        Glob := X + 1;
    end;

#if A
    procedure S(X: Integer)
#else
    procedure S(X: Integer; Y: Integer)
#endif
#if not CLEAN27
    var
        K: Integer;
#endif
    begin
        Glob := X + 2;
    end;

    var
        Glob: Integer;
}
`;
    const root = wrapRoot(parseAL(src));
    const blocks: ALSyntaxNode[] = [];
    visit(root, (n) => {
      if (n.rawKind === "preproc_conditional_var_block") blocks.push(n);
    });
    expect(blocks.map((b) => b.parent?.rawKind)).toEqual(["procedure", "preproc_split_procedure"]);
    for (const b of blocks) {
      const owner = b.parent;
      if (owner === null) throw new Error("fixture drift: block without owner");
      expect(splitVarHoistAnchor(owner)).toBeNull();
      expect(reachLatchRefusedOwner(b)?.startIndex).toBe(owner.startIndex);
    }
    const specs = findAll(root, ALNodeKind.assignment_statement).map((n) =>
      spec(n, "Glob := 0", "lethal.op"),
    );
    const ided = assignMutantIds(new Map([["f.al", specs]])).get("f.al") ?? [];
    const grains = buildComponents(ided).flatMap((c) =>
      c.members.map((m) => reachGrainOf(m, c.root, src)),
    );
    expect(grains).toEqual(["unplaced", "unplaced"]);
    const out = compileSchemataForFile(src, root, specs, ided);
    expect(out).not.toContain(REACH_LATCH);
  });
});

/** R312: a member var section whose LAST child is `#if` of declarations. Hand-written. */
const INBODY_SRC = `codeunit 50100 "Repro K"
{
    procedure Pick(X: Integer): Integer
    var
#if not CLEAN27
        K: Integer;
#endif
    begin
        Glob := X + 1;
    end;

    trigger OnRun()
    var // note
        A: Integer;
#if not CLEAN27
        L: Integer;
#else
        M: Integer;
#endif
    begin
        Glob := Glob + 2;
    end;

    var
        Glob: Integer;
}
`;

/** No code after a directive on its line (alc AL0631), and no latch inside one. */
function directiveLinesClean(text: string): boolean {
  return text.split("\n").every((raw) => {
    const l = raw.replace(/\r$/, "");
    if (/^\s*#(if|elif)\b/.test(l)) return !l.includes(";");
    if (/^\s*#(else|endif)\b/.test(l)) return /^\s*#(else|endif)\s*(\/\/.*)?$/.test(l);
    // R-303 run 002: text after `#pragma`/`#region`/`#endregion` is part of the directive.
    if (/^\s*#(pragma|region|endregion)\b/.test(l)) return !l.includes(REACH_LATCH);
    return true;
  });
}

const SELECTOR_DECL = 'MutationSelector: Codeunit "Mutation Selector";';

/** Line count with the lines the rest of the instrumentation adds by design undone, so what is
 *  left measures whether the LATCH edits moved a line. Two things are undone:
 *  - R-297's object-level selector declaration (`\n        <decl>` appended to a var section, or
 *    `    var\n        <decl>\n\n` before the first member), once;
 *  - each ONE-BRANCH `emitDispatch` guard chain,
 *    `if MutationSelector.Active('id') then begin\n  <branch>\nend else begin\n  <original>\nend;`,
 *    folded back to `<original>`.
 *  Only that shape: a chain with several branches, or an original statement containing `\nend`,
 *  is not folded correctly and the count comes out wrong. That fails the test, never passes it. */
function linesWithoutInstrumentation(text: string): number {
  return text
    .replace(`    var\n        ${SELECTOR_DECL}\n\n`, "")
    .replace(`\n        ${SELECTOR_DECL}`, "")
    .replace(
      /if MutationSelector\.Active\('[^']+'\) then begin\n {2}[\s\S]*?\nend else begin\n {2}([\s\S]*?)\nend(;?)/g,
      "$1$2",
    )
    .split("\n").length;
}

describe("R312: a member var section ending in #if gets its latch after the var keyword", () => {
  beforeAll(async () => {
    await initParser();
  });

  it("writes the latch on the var line, never on the #endif line, and moves no line", () => {
    const root = wrapRoot(parseAL(INBODY_SRC));
    const at = (text: string): ALSyntaxNode => {
      const a = findAll(root, ALNodeKind.assignment_statement).find((n) => n.text === text);
      if (a === undefined) throw new Error(`fixture drift: no assignment ${text}`);
      return a;
    };
    const specs = [
      spec(at("Glob := X + 1"), "Glob := 0", "lethal.op"),
      spec(at("Glob := Glob + 2"), "Glob := 0", "lethal.op"),
    ];
    const ided = assignMutantIds(new Map([["f.al", specs]])).get("f.al") ?? [];
    const out = compileSchemataForFile(INBODY_SRC, root, specs, ided);
    expect(out).toContain(`    var ${REACH_LATCH}: Boolean;\n#if not CLEAN27\n        K: Integer;`);
    expect(out).toContain(`    var ${REACH_LATCH}: Boolean; // note\n        A: Integer;`);
    // Same-line only: `\s` alone would also match the newline before `begin` a few lines later,
    // making this unsatisfiable for any real emission. `[ \t]*` stays on the `#endif` line.
    expect(out).not.toMatch(/#endif[ \t]*\S/);
    expect(directiveLinesClean(out)).toBe(true);
    expect(linesWithoutInstrumentation(out)).toBe(INBODY_SRC.split("\n").length);
    expect(countErrorNodes(out)).toBe(0);
  });
});

/**
 * R-303 run 002: `#pragma`, `#region` and `#endregion` around a member's var section. Grammar
 * extras, hand-written (the `d1`..`d10` scratch repros, each alc-compiled under every symbol subset
 * and run through al-runner). tree-sitter-al 4.4.1 attaches a TRAILING directive to the member,
 * not to the var section, so the latch stays on the last declaration's line, before the directive.
 */
const DIRECTIVE_SRC = `codeunit 50100 "Repro P"
{
    procedure P1(X: Integer)
    var
        A1: Integer;
#pragma warning disable AL0432
    begin
        Glob := X + 1;
    end;

    procedure P2(X: Integer)
    var
#region Locals
        A2: Integer;
#endregion
    begin
        Glob := X + 2;
    end;

    procedure P3(X: Integer)
    var
        A3: Integer;
#region Body
    begin
        Glob := X + 3;
    end;
#endregion

    procedure P4(X: Integer)
    var
        A4: Integer;
#if not CLEAN27
        K4: Integer;
#endif
#pragma warning disable AL0432
    begin
        Glob := X + 4;
    end;

    procedure P5(X: Integer)
    var
        A5: Integer;
#pragma warning disable AL0432
#if not CLEAN27
        K5: Integer;
#endif
    begin
        Glob := X + 5;
    end;

    procedure P6(X: Integer)
#pragma warning disable AL0432
    var
        A6: Integer;
    begin
        Glob := X + 6;
    end;

    procedure P7(X: Integer)
    var
#pragma warning disable AL0432
        A7: Integer;
    begin
        Glob := X + 7;
    end;

    procedure P10(X: Integer)
#pragma warning disable AL0432
    begin
        Glob := X + 10;
    end;

    procedure P9(X: Integer)
#region Locals
#if not CLEAN27
    var
        K9: Integer;
#endif
#endregion
    begin
        Glob := X + 9;
    end;

    var
        Glob: Integer;
}
`;

describe("R-303 run 002: a directive around a member's var section never carries the latch", () => {
  beforeAll(async () => {
    await initParser();
  });

  it("puts each latch on a declaration or var line, never on a directive line, and moves no line", () => {
    const root = wrapRoot(parseAL(DIRECTIVE_SRC));
    const specs = findAll(root, ALNodeKind.assignment_statement).map((a) =>
      spec(a, "Glob := 0", "lethal.op"),
    );
    expect(specs.length).toBe(9);
    const ided = assignMutantIds(new Map([["f.al", specs]])).get("f.al") ?? [];
    const out = compileSchemataForFile(DIRECTIVE_SRC, root, specs, ided);
    const L = `${REACH_LATCH}: Boolean;`;
    expect(out).toContain(`        A1: Integer; ${L}\n#pragma warning disable AL0432\n    begin`);
    expect(out).toContain(`#region Locals\n        A2: Integer; ${L}\n#endregion`);
    expect(out).toContain(`        A3: Integer; ${L}\n#region Body`);
    expect(out).toContain(`    var ${L}\n        A4: Integer;\n#if not CLEAN27\n        K4`);
    expect(out).toContain(`    var ${L}\n        A5: Integer;\n#pragma`);
    expect(out).toContain(`#pragma warning disable AL0432\n    var\n        A6: Integer; ${L}`);
    expect(out).toContain(`    var\n#pragma warning disable AL0432\n        A7: Integer; ${L}`);
    // P9: `#region` between the header and the split block is not the header's end: refused.
    expect(out).toContain(
      "    procedure P9(X: Integer)\n#region Locals\n#if not CLEAN27\n    var\n",
    );
    // P10: no var section, so a new one directly before `begin`, after the directive's line.
    expect(out).toContain(`#pragma warning disable AL0432
    var ${L} begin`);
    expect(out.split(L).length - 1).toBe(8);
    expect(directiveLinesClean(out)).toBe(true);
    expect(linesWithoutInstrumentation(out)).toBe(DIRECTIVE_SRC.split("\n").length);
  });

  it("a var section whose last child is a directive anchors after the var keyword", () => {
    // Not reachable through tree-sitter-al 4.4.1 (see DIRECTIVE_SRC), so the node is built by
    // hand: P1's own var section with its trailing #pragma moved inside the var body.
    const root = wrapRoot(parseAL(DIRECTIVE_SRC));
    const p1 = findAll(root, ALNodeKind.procedure).find((p) => p.text.includes("P1("));
    const vars = p1?.children.find((n) => n.kind === ALNodeKind.var_section);
    const pragma = p1?.children.find((n) => n.rawKind === "pragma");
    const [keyword, body] = vars?.children ?? [];
    if (vars === undefined || pragma === undefined || keyword === undefined || body === undefined)
      throw new Error("fixture drift: P1 is not var_keyword, var_body, then #pragma");
    const fake = (n: ALSyntaxNode, children: ALSyntaxNode[]): ALSyntaxNode => ({
      kind: n.kind,
      rawKind: n.rawKind,
      text: n.text,
      startIndex: n.startIndex,
      endIndex: n.endIndex,
      startPosition: n.startPosition,
      endPosition: n.endPosition,
      parent: n.parent,
      children,
      namedChildren: children,
      fieldName: null,
      isMissing: n.isMissing,
      hasError: n.hasError,
      childForFieldName: () => null,
    });
    const moved = fake(vars, [keyword, fake(body, [...body.children, pragma])]);
    expect(latchAnchorInVarSection(moved)?.rawKind).toBe("var_keyword");
    // Control: the real, unmoved section anchors on its declaration.
    expect(latchAnchorInVarSection(vars)?.rawKind).toBe("variable_declaration");
  });
});

/** R309, R316: split-header procedures whose #if arms each hold their own header and var section. Hand-written. */
const PREAMBLE_BODY = `    begin
        Glob := X + 1;
        Glob := Glob + 2;
        exit(Glob);
    end;

    var
        Glob: Integer;
}
`;

const PREAMBLE_CASES: { name: string; src: string }[] = [
  {
    name: "P1 #if and #else arms, an attribute in the #else arm",
    src: `codeunit 50100 "Repro P"
{
#if CLEAN27
    procedure Pick(X: Integer): Integer
    var
        K: Integer;
#else
    [Obsolete('Old', '27.0')]
    procedure Pick(X: Integer): Integer
    var
        K: Integer;
        M: Integer;
#endif
${PREAMBLE_BODY}`,
  },
  {
    name: "P2 #if, #elif and #else arms",
    src: `codeunit 50100 "Repro P"
{
#if A
    procedure Pick(X: Integer): Integer
    var
        K: Integer;
#elif B
    procedure Pick(X: Integer): Integer
    var
        M: Integer;
#else
    procedure Pick(X: Integer): Integer
    var
        N: Text;
#endif
${PREAMBLE_BODY}`,
  },
  {
    name: "P3 #if and #elif, no #else",
    src: `codeunit 50100 "Repro P"
{
#if A
    procedure Pick(X: Integer): Integer
    var
        K: Integer;
#elif not A
    [Scope('OnPrem')]
    procedure Pick(X: Integer): Integer
    var
        M: Integer;
#endif
${PREAMBLE_BODY}`,
  },
  {
    name: "P4 one arm with no var section",
    src: `codeunit 50100 "Repro P"
{
#if CLEAN27
    procedure Pick(X: Integer): Integer
    var
        K: Integer;
#else
    procedure Pick(X: Integer): Integer
#endif
${PREAMBLE_BODY}`,
  },
  {
    name: "P8 an arm whose own var section is itself inside #if",
    src: `codeunit 50100 "Repro P"
{
#if A
    procedure Pick(X: Integer): Integer
#if B
    var
        K: Integer;
#endif
#else
    procedure Pick(X: Integer): Integer
    var
        M: Integer;
#endif
${PREAMBLE_BODY}`,
  },
  {
    name: "P11 a named return value, and a ; after one arm's header (R316)",
    src: `codeunit 50100 "Repro P"
{
#if CLEAN27
    procedure Pick(X: Integer) R: Integer;
    var
        K: Integer;
#else
    procedure Pick(X: Integer) R: Integer
    // a comment after the header
    var
        M: Integer;
#endif
${PREAMBLE_BODY}`,
  },
  {
    name: "P10 arms that rename the procedure",
    src: `codeunit 50100 "Repro P"
{
#if CLEAN27
    procedure Pick(X: Integer): Integer
    var
        K: Integer;
#else
    procedure Choose(X: Integer): Integer
    var
        M: Integer;
#endif
${PREAMBLE_BODY}`,
  },
];

describe("R316: a split-header procedure whose arms each have their own var section takes one reach latch per arm", () => {
  beforeAll(async () => {
    await initParser();
  });

  const instrumentAll = (src: string) => {
    const root = wrapRoot(parseAL(src));
    const specs = findAll(root, ALNodeKind.assignment_statement).map((n) =>
      spec(n, "Glob := 0", "lethal.op"),
    );
    const ided = assignMutantIds(new Map([["f.al", specs]])).get("f.al") ?? [];
    const grains = buildComponents(ided).flatMap((c) =>
      c.members.map((m) => reachGrainOf(m, c.root, src)),
    );
    return { specs, grains, out: compileSchemataForFile(src, root, specs, ided) };
  };

  const [first] = PREAMBLE_CASES;
  if (first === undefined) throw new Error("fixture drift: no preamble case");
  const cases = [
    ...PREAMBLE_CASES,
    { name: "P6 P1 saved with CRLF", src: first.src.replace(/\n/g, "\r\n") },
  ];
  const lf = (t: string): string => t.replace(/\r\n/g, "\n");
  for (const c of cases) {
    it(`${c.name}: one latch per arm on its header line, every arm's var blanked, all statement, no line moved`, () => {
      const { specs, grains, out } = instrumentAll(c.src);
      expect(specs).toHaveLength(2);
      for (const s of specs) expect(reachLatchRefusedOwner(s.before)).toBeNull();
      expect(grains).toEqual(["statement", "statement"]);
      const text = lf(out);
      const headers = text.split("\n").filter((l) => l.startsWith("    procedure "));
      const arms = lf(c.src)
        .split("\n")
        .filter((l) => l.startsWith("    procedure ")).length;
      expect(headers).toHaveLength(arms);
      for (const h of headers) expect(h.endsWith(` var ${REACH_LATCH}: Boolean;`)).toBe(true);
      expect(text.split(`${REACH_LATCH}: Boolean;`).length - 1).toBe(arms);
      // Every arm's own `var` keyword is blanked: no line between the first #if and begin is `var`.
      const region = text.slice(text.indexOf("#if"), text.indexOf("    begin"));
      expect(region.split("\n").filter((l) => l.trim() === "var")).toEqual([]);
      expect(text.split("MutationSelector.Reached(").length - 1).toBe(2);
      expect(text.split(SELECTOR_DECL).length - 1).toBe(1);
      expect(directiveLinesClean(out)).toBe(true);
      expect(linesWithoutInstrumentation(text)).toBe(lf(c.src).split("\n").length);
    });
  }

  // Task 1 review minor: a preamble is procedure-like since R316, so `latchNameFor` skips it as
  // ANOTHER member: a local it declares is not in a different procedure's scope and forces no
  // suffix there. Its own arms still see it, so the preamble's latch is suffixed.
  it("latchNameFor: a preamble's locals are not in another procedure's scope, but are in its own", () => {
    const src = `codeunit 50100 "Repro P"
{
    procedure Other(X: Integer): Integer
    var
        O: Integer;
    begin
        O := X + 9;
        exit(O);
    end;

#if CLEAN27
    procedure Pick(X: Integer): Integer
    var
        K: Integer;
#else
    procedure Pick(X: Integer): Integer
    var
        ${REACH_LATCH}: Integer;
#endif
${PREAMBLE_BODY}`;
    const { grains, out } = instrumentAll(src);
    expect(grains).toEqual(["statement", "statement", "statement"]);
    expect(out).toContain(`O: Integer; ${REACH_LATCH}: Boolean;`);
    expect(
      out.split(`    procedure Pick(X: Integer): Integer var ${REACH_LATCH}2: Boolean;`).length - 1,
    ).toBe(2);
    expect(out.split(`${REACH_LATCH}: Boolean;`).length - 1).toBe(1);
  });

  // R316 review r1, I2: a parse error in ANY arm's header, even before the first arm's `)`, where
  // R313's scan used to start, refuses the latch. tree-sitter-al keeps the preamble shape and one
  // `)` per arm here, so the arm-header rule alone would admit it.
  const P1_SRC = PREAMBLE_CASES.find((c) => c.name.startsWith("P1 "))?.src ?? "";
  const MALFORMED_FIRST_ARM: { name: string; header: string }[] = [
    {
      name: "an ERROR inside the parameter list",
      header: "procedure Pick(X: Integer; @@ Y: Integer): Integer",
    },
    { name: "an ERROR before the first arm's )", header: "procedure Pick(X: Integer;): Integer" },
    {
      name: "an ERROR right after the first arm's (",
      header: "procedure Pick(X: Integer Y: Integer): Integer",
    },
  ];
  for (const m of MALFORMED_FIRST_ARM) {
    it(`P16 ${m.name}: refused by R313's predicate, all unplaced, no latch`, () => {
      const src = P1_SRC.replace("procedure Pick(X: Integer): Integer", m.header);
      expect(src).not.toBe(P1_SRC);
      const { specs, grains, out } = instrumentAll(src);
      expect(specs).toHaveLength(2);
      for (const s of specs) {
        const owner = reachLatchRefusedOwner(s.before);
        expect(owner?.rawKind).toBe("preproc_split_procedure_preamble");
        if (owner === null) throw new Error("unreachable");
        expect(preambleArmHeaderEnds(owner)).not.toBeNull();
        expect(varSectionUnparsed(owner)).toBe(true);
      }
      expect(grains).toEqual(["unplaced", "unplaced"]);
      expect(out).not.toContain(REACH_LATCH);
      expect(out).not.toContain("MutationSelector.Reached(");
    });
  }

  it("M1: a plain member, a preamble, an R303 hoist, an R301 split header and R-297's selector anchor in one file", () => {
    const src = `codeunit 50100 "Repro P"
{
    var
        Glob: Integer;
#if not CLEAN27
        Old: Integer;
#endif

    procedure Plain(X: Integer): Integer
    var
        P: Integer;
    begin
        P := X + 3;
        exit(P);
    end;

#if CLEAN27
    procedure Pick(X: Integer): Integer
    var
        K: Integer;
#else
    [Obsolete('Old', '27.0')]
    procedure Pick(X: Integer): Integer
    var
        K: Integer;
        M: Integer;
#endif
    begin
        Glob := X + 1;
        exit(Glob);
    end;

    procedure Hoist(X: Integer): Integer
#if not CLEAN27
    var
        H: Integer;
#endif
    begin
        Glob := X + 4;
        exit(Glob);
    end;

#if CLEAN27
    procedure Split(X: Integer): Integer
#else
    [Obsolete('Old', '27.0')]
    procedure Split(X: Integer): Integer
#endif
    var
        S: Integer;
    begin
        S := X + 5;
        exit(S);
    end;
}
`;
    const root = wrapRoot(parseAL(src));
    const assignments = findAll(root, ALNodeKind.assignment_statement);
    expect(
      assignments.map((n) => `${n.text} -> ${reachLatchRefusedOwner(n)?.rawKind ?? "latch"}`),
    ).toEqual([
      "P := X + 3 -> latch",
      "Glob := X + 1 -> latch",
      "Glob := X + 4 -> latch",
      "S := X + 5 -> latch",
    ]);
    const specs = assignments.map((n) => spec(n, "Glob := 0", "lethal.op"));
    const ided = assignMutantIds(new Map([["f.al", specs]])).get("f.al") ?? [];
    const out = compileSchemataForFile(src, root, specs, ided);
    expect(out).toContain(`P: Integer; ${REACH_LATCH}: Boolean;`);
    expect(out).toContain(`    procedure Hoist(X: Integer): Integer var ${REACH_LATCH}: Boolean;`);
    expect(out).toContain(`S: Integer; ${REACH_LATCH}: Boolean;`);
    // R316: the preamble's two arms each take the latch on their own header line.
    expect(
      out.split(`    procedure Pick(X: Integer): Integer var ${REACH_LATCH}: Boolean;`).length - 1,
    ).toBe(2);
    expect(out.split(`${REACH_LATCH}: Boolean;`).length - 1).toBe(5);
    expect(out.split("MutationSelector.Reached(").length - 1).toBe(4);
    // R-297: the selector goes after a declaration-only #if block's #endif, on a line of its own.
    expect(out).toContain(
      `        Glob: Integer;\n#if not CLEAN27\n        Old: Integer;\n#endif\n        ${SELECTOR_DECL}\n`,
    );
    expect(directiveLinesClean(out)).toBe(true);
    expect(linesWithoutInstrumentation(out)).toBe(src.split("\n").length);
  });
});

describe("The injector's guard: a statement marker with no owning member still throws", () => {
  // Hand-built, not parsed: no real AL statement sits outside every procedure, trigger and
  // preamble, so this shape is built directly, the same way the R309 review's label tests build a
  // preamble owner by hand (packages/runner/tests/preproc-instrumentation.test.ts). `parent: null`
  // means the owner walk in `injectReachLatches` never finds a procedure, a trigger or a preamble:
  // the one shape none of R303, R309 or R313's refusals cover, because none of them applies here.
  function fakeDetachedStatement(text: string): ALSyntaxNode {
    return {
      kind: ALNodeKind.assignment_statement,
      rawKind: "assignment_statement",
      text,
      startIndex: 0,
      endIndex: text.length,
      startPosition: { row: 0, column: 0 },
      endPosition: { row: 0, column: text.length },
      parent: null,
      children: [],
      namedChildren: [],
      fieldName: null,
      isMissing: false,
      hasError: false,
      childForFieldName: () => null,
    };
  }

  it("a component root reachable from no procedure, trigger or preamble throws the guard message", () => {
    const before = fakeDetachedStatement("L := 1");
    const s = spec(before, "L := 2", "lethal.op");
    expect(() => compileSchemataForFile("L := 1", before, [s])).toThrow(
      "a reach marker sits outside any procedure or trigger body",
    );
    // R307: a per-file refusal, typed. No enclosing object, so no `objects`.
    let thrown: unknown;
    try {
      compileSchemataForFile("L := 1", before, [s], undefined, "src/Detached.al");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(FileRefusedError);
    if (!(thrown instanceof FileRefusedError)) return;
    expect(thrown.file).toBe("src/Detached.al");
    expect(thrown.shape).toBe("latch-owner");
    expect(thrown.site).toBe("compile.latch-owner");
    expect(thrown.objects).toBeUndefined();
    expect(thrown.lines).toEqual([1, 1]);
  });
});

describe("R307 T4b: refusals no real AL reaches, driven through instrumentOneFile", () => {
  beforeAll(async () => {
    await initParser();
  });

  const SRC = [
    'codeunit 79390 "Probe"', // 1
    "{", // 2
    "    procedure P()", // 3
    "    var", // 4
    "        X: Integer;", // 5
    "    begin", // 6
    "        X := 1;", // 7
    "        X := 2;", // 8
    "    end;", // 9
    "}", // 10
    "",
  ].join("\n");

  function refusalOf(fn: () => unknown): FileRefusedError {
    try {
      fn();
    } catch (e) {
      if (e instanceof FileRefusedError) return e;
      throw e;
    }
    throw new Error("expected a FileRefusedError, got none");
  }

  function ctx(): { root: ALSyntaxNode } {
    return { root: wrapRoot(parseAL(SRC)) };
  }

  it("latch-owner: a statement marker with no owning member refuses the file", () => {
    const { root } = ctx();
    const before = {
      kind: ALNodeKind.assignment_statement,
      rawKind: "assignment_statement",
      text: "L := 1",
      startIndex: 0,
      endIndex: 6,
      startPosition: { row: 0, column: 0 },
      endPosition: { row: 0, column: 6 },
      parent: null,
      children: [],
      namedChildren: [],
      fieldName: null,
      isMissing: false,
      hasError: false,
      childForFieldName: () => null,
    } as ALSyntaxNode;
    const s = spec(before, "L := 2", "lethal.op");
    const ided = assignMutantIds(new Map([["src/P.al", [s]]])).get("src/P.al") ?? [];
    const err = refusalOf(() =>
      instrumentOneFile({ path: "src/P.al", source: SRC, root }, [s], ided),
    );
    expect(err.shape).toBe("latch-owner");
    expect(err.site).toBe("compile.latch-owner");
    expect(err.file).toBe("src/P.al");
    expect(err.objects).toBeUndefined();
    expect(err.lines).toEqual([1, 1]);
    expect(formatRefusal(err)).toBe(
      "latch-owner in src/P.al: a reach marker sits outside any member that could declare its latch; lines 1-1",
    );
  });

  it("overlap: two partially overlapping rewrites refuse the file, last line from the last covered character", () => {
    const { root } = ctx();
    const a = findFirst(root, ALNodeKind.assignment_statement);
    const body = a?.parent?.parent;
    if (a === null || a === undefined || body === null || body === undefined)
      throw new Error("fixture shape");
    // Real AL ranges are laminar, so two partially overlapping rewrite roots are hand-built: two
    // copies of the procedure body block (each its own component root). The second one ends just
    // AFTER the newline that closes line 8, so its exclusive end offset reads as line 9 while the
    // last character it covers is the newline on line 8.
    const end2 = SRC.indexOf("\n", SRC.indexOf("X := 2")) + 1;
    expect(SRC[end2 - 1]).toBe("\n");
    const withSpan = (start: number, end: number): ALSyntaxNode =>
      Object.create(body, { startIndex: { value: start }, endIndex: { value: end } });
    const first = withSpan(body.startIndex, a.endIndex + 3);
    const second = withSpan(a.startIndex + 2, end2);
    const sa = spec(first, "begin end", "lethal.op");
    const sb = spec(second, "begin end", "lethal.op");
    const ided = assignMutantIds(new Map([["src/P.al", [sa, sb]]])).get("src/P.al") ?? [];
    const err = refusalOf(() =>
      instrumentOneFile({ path: "src/P.al", source: SRC, root }, [sa, sb], ided),
    );
    expect(err.shape).toBe("overlap");
    expect(err.site).toBe("rewrite.overlap");
    expect(err.file).toBe("src/P.al");
    expect(err.objects).toBeUndefined();
    expect(err.lines).toEqual([6, 8]);
    expect(formatRefusal(err)).toBe(
      "overlap in src/P.al: two rewrites of this file overlap; lines 6-8",
    );
  });
});
