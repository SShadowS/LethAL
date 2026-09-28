import { beforeAll, describe, expect, it } from "bun:test";
import type { ALSyntaxNode } from "../../src";
import {
  ALNodeKind,
  findEnclosingCodeBlock,
  findEnclosingProcedure,
  findEnclosingStatement,
  findFirst,
  gapBlockOf,
  initParser,
  isObjectContainer,
  isProcedureLike,
  isStatementPosition,
  isStatementSlot,
  objectDeclarationsOf,
  parseAL,
  procedureLikeNameNode,
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

describe("gapBlockOf (C02-09)", () => {
  beforeAll(async () => {
    await initParser();
  });
  const span = (n: ALSyntaxNode) => [n.startIndex, n.endIndex];
  /** The span of `text` in `src`, located by hand; `nth` picks a later occurrence. */
  const at = (src: string, text: string, nth = 0): number[] => {
    let i = -1;
    for (let k = 0; k <= nth; k++) {
      i = src.indexOf(text, i + 1);
      if (i < 0) throw new Error(`no ${text} in source`);
    }
    return [i, i + text.length];
  };
  /** The first node (pre-order) whose text is `text` and, when given, which starts at `start`. */
  const nodeAt = (root: ALSyntaxNode, text: string, start?: number): ALSyntaxNode => {
    let hit: ALSyntaxNode | null = null;
    visit(root, (n) => {
      if (hit === null && n.text === text && (start === undefined || n.startIndex === start))
        hit = n;
    });
    if (hit === null) throw new Error(`no node with text ${text}`);
    return hit;
  };
  const proc = (body: string) => `codeunit 51200 "T" { procedure P() begin ${body} end; }`;
  const LOG_AUDIT = `codeunit 51200 "T" { local procedure LogAudit(Amount: Decimal) begin if Amount <> 0 then begin Amount := Amount; end; end; }`;

  it("an assignment inside a braced then-branch belongs to that begin..end", () => {
    const root = wrapRoot(parseAL(LOG_AUDIT));
    expect(gapBlockOf(nodeAt(root, "Amount := Amount")).text).toBe("begin Amount := Amount; end");
  });
  it("the if condition belongs to the procedure body, not to the branch it guards", () => {
    const root = wrapRoot(parseAL(LOG_AUDIT));
    expect(gapBlockOf(nodeAt(root, "Amount <> 0")).text.startsWith("begin if Amount <> 0")).toBe(
      true,
    );
  });
  it("a block is its own gap block (empty-block on the then-branch)", () => {
    const root = wrapRoot(parseAL(LOG_AUDIT));
    const then = nodeAt(root, "begin Amount := Amount; end");
    expect(span(gapBlockOf(then))).toEqual(span(then));
  });
  it("un-braced then: the single statement is the gap block", () => {
    const src = proc("if A then exit(0);");
    const root = wrapRoot(parseAL(src));
    expect(span(gapBlockOf(nodeAt(root, "0")))).toEqual(at(src, "exit(0)"));
  });
  it("un-braced else: the else statement is the gap block", () => {
    const src = proc("if A then X := 1 else X := 2;");
    const root = wrapRoot(parseAL(src));
    expect(span(gapBlockOf(nodeAt(root, "2")))).toEqual(at(src, "X := 2"));
    expect(span(gapBlockOf(nodeAt(root, "1")))).toEqual(at(src, "X := 1"));
  });
  it("else-if chain: the inner condition belongs to the else slot, its branch to itself", () => {
    const src = proc("if A then X := 1 else if B then X := 2;");
    const root = wrapRoot(parseAL(src));
    expect(span(gapBlockOf(nodeAt(root, "B")))).toEqual(at(src, "if B then X := 2"));
    expect(span(gapBlockOf(nodeAt(root, "X := 2")))).toEqual(at(src, "X := 2"));
  });
  it("case arms: a single-statement arm and a braced arm", () => {
    const src = proc("case A of 1: X := 1; 2: begin X := 2; end; end;");
    const root = wrapRoot(parseAL(src));
    expect(span(gapBlockOf(nodeAt(root, "X := 1")))).toEqual(at(src, "X := 1"));
    expect(span(gapBlockOf(nodeAt(root, "X := 2")))).toEqual(at(src, "begin X := 2; end"));
  });
  it("case else: the else body (case_else_branch.body) is the gap block", () => {
    const src = proc("case A of 1: X := 1; else X := 3; end;");
    const root = wrapRoot(parseAL(src));
    expect(span(gapBlockOf(nodeAt(root, "3")))).toEqual(at(src, "X := 3;"));
  });
  it("loop bodies: while, for, foreach and repeat", () => {
    const w = proc("while A do X := 1;");
    expect(span(gapBlockOf(nodeAt(wrapRoot(parseAL(w)), "1", w.indexOf("1;"))))).toEqual(
      at(w, "X := 1"),
    );
    const f = proc("for I := 1 to 5 do X := 2;");
    expect(span(gapBlockOf(nodeAt(wrapRoot(parseAL(f)), "2")))).toEqual(at(f, "X := 2"));
    const fe = proc("foreach I in L do X := 3;");
    expect(span(gapBlockOf(nodeAt(wrapRoot(parseAL(fe)), "3")))).toEqual(at(fe, "X := 3"));
    const r = proc("repeat X := 4; until X = 4;");
    expect(span(gapBlockOf(nodeAt(wrapRoot(parseAL(r)), "X := 4")))).toEqual(at(r, "X := 4;"));
  });
  it("a trigger body is a gap block", () => {
    const src = `table 51201 "T" { fields { field(1; F; Integer) { trigger OnValidate() begin F := 1; end; } } }`;
    const root = wrapRoot(parseAL(src));
    expect(span(gapBlockOf(nodeAt(root, "F := 1")))).toEqual(at(src, "begin F := 1; end"));
  });
  it("the fallback: a node with no body ancestor returns the root, never null", () => {
    const src = `table 51201 "T" { fields { field(1; F; Integer) { } } }`;
    const root = wrapRoot(parseAL(src));
    const got = gapBlockOf(nodeAt(root, "F"));
    expect(got.parent).toBeNull();
    expect(span(got)).toEqual(span(root));
  });
});

describe("R298: objectDeclarationsOf flattens #if-wrapped objects", () => {
  beforeAll(async () => {
    await initParser();
  });

  const body = `{
    procedure P()
    begin
        Message('x');
    end;
}
`;

  it("b-single: one codeunit_declaration under the wrapper", () => {
    const root = wrapRoot(
      parseAL(`#if not CLEAN27
codeunit 50101 "Repro B"
${body}#endif
`),
    );
    const decls = objectDeclarationsOf(root);
    expect(decls.map((d) => d.rawKind)).toEqual(["codeunit_declaration"]);
    const [wrapper] = root.namedChildren;
    expect(wrapper?.rawKind).toBe("preproc_conditional_object");
    expect(decls[0]?.parent?.rawKind).toBe("preproc_conditional_object");
    const parent = decls[0]?.parent;
    expect(parent !== null && parent !== undefined && isObjectContainer(parent)).toBe(true);
    expect(isObjectContainer(root)).toBe(true);
    expect(isObjectContainer(decls[0] ?? root)).toBe(false);
  });

  it("b-two-arm: both arms' declarations, in source order", () => {
    const src = `#if CLEAN27
codeunit 50103 "Repro B2"
${body.replace("P()", "AIf()")}#else
codeunit 50103 "Repro B2"
${body.replace("P()", "AElse()")}#endif
`;
    const decls = objectDeclarationsOf(wrapRoot(parseAL(src)));
    expect(decls.map((d) => d.rawKind)).toEqual(["codeunit_declaration", "codeunit_declaration"]);
    const [first, second] = decls;
    expect(first?.text).toContain("AIf");
    expect(second?.text).toContain("AElse");
    expect((first?.startIndex ?? 0) < (second?.startIndex ?? 0)).toBe(true);
  });

  it("nested wrapper (BaseApp-like, namespace inside): the inner declaration", () => {
    const src = `#if not CLEAN26
#if not CLEAN27
namespace X.Y;
codeunit 50110 "Nested"
${body}#endif
#endif
`;
    const decls = objectDeclarationsOf(wrapRoot(parseAL(src)));
    expect(decls.map((d) => d.rawKind)).toEqual(["namespace_declaration", "codeunit_declaration"]);
  });

  it("a bare file: the source_file's own named children", () => {
    const src = `codeunit 50104 Plain
${body}#if not CLEAN27
codeunit 50105 Wrapped
${body}#endif
codeunit 50106 After
${body}`;
    const ids = objectDeclarationsOf(wrapRoot(parseAL(src))).map(
      (d) => d.childForFieldName("object_id")?.text,
    );
    expect(ids).toEqual(["50104", "50105", "50106"]);
  });
});

/** R301 (class C): a procedure whose HEADER is split by `#if` shares one var section and one body. */
const SPLIT = `codeunit 50100 "Repro C"
{
#if CLEAN27
    procedure A(X: Integer)
#else
    internal procedure A(X: Integer)
#endif
    var
        L: Integer;
    begin
        L := X;
        Message('%1', L);
    end;

    trigger OnRun()
    begin
    end;
}
`;

describe("R301: split-header procedures", () => {
  beforeAll(async () => {
    await initParser();
  });
  const first = (root: ALSyntaxNode, rawKind: string): ALSyntaxNode => {
    let hit: ALSyntaxNode | null = null;
    visit(root, (n) => {
      if (hit === null && n.rawKind === rawKind) hit = n;
    });
    if (hit === null) throw new Error(`no ${rawKind}`);
    return hit;
  };

  it("isProcedureLike: a procedure and a split procedure, never a trigger or a preamble", () => {
    const root = wrapRoot(parseAL(SPLIT));
    expect(isProcedureLike(first(root, "preproc_split_procedure"))).toBe(true);
    expect(
      isProcedureLike(
        first(wrapRoot(parseAL("codeunit 1 C { procedure P() begin end; }")), "procedure"),
      ),
    ).toBe(true);
    expect(isProcedureLike(first(root, "trigger_declaration"))).toBe(false);
    const preamble = `codeunit 1 C
{
#if CLEAN27
    procedure A()
    var
        L: Integer;
#else
    procedure A()
    var
        M: Integer;
#endif
    begin
    end;
}
`;
    expect(
      isProcedureLike(first(wrapRoot(parseAL(preamble)), "preproc_split_procedure_preamble")),
    ).toBe(false);
  });

  it("gapBlockOf: a top-level statement of the split body belongs to the body, not the root", () => {
    const root = wrapRoot(parseAL(SPLIT));
    const got = gapBlockOf(first(root, "assignment_statement"));
    const begin = SPLIT.indexOf("begin\n        L := X");
    const end = SPLIT.indexOf("end;\n\n    trigger") + "end".length;
    expect([got.startIndex, got.endIndex]).toEqual([begin, end]);
    expect(got.parent?.rawKind).toBe("preproc_split_procedure");
  });

  it("procedureLikeNameNode: the shared name when every arm agrees, null when an arm renames", () => {
    const root = wrapRoot(parseAL(SPLIT));
    expect(procedureLikeNameNode(first(root, "preproc_split_procedure"))?.text).toBe("A");
    const renamed = SPLIT.replace("internal procedure A(", "internal procedure AElse(");
    expect(
      procedureLikeNameNode(first(wrapRoot(parseAL(renamed)), "preproc_split_procedure")),
    ).toBeNull();
    const quoted = SPLIT.replace("internal procedure A(", 'internal procedure "a"(');
    expect(
      procedureLikeNameNode(first(wrapRoot(parseAL(quoted)), "preproc_split_procedure"))?.text,
    ).toBe("A");
  });

  it("findEnclosingProcedure is deliberately unchanged: null inside a split procedure (R302)", () => {
    const root = wrapRoot(parseAL(SPLIT));
    expect(findEnclosingProcedure(first(root, "assignment_statement"))).toBeNull();
  });
});

/**
 * R-297 Task 6: split-directive single-statement slots. BaseApp retires code with `#if` around an
 * `if` header or a case label while the branch body sits after `#endif`, shared by both builds. The
 * parse puts that body in a `<split kind>.<field>` slot; without it in SINGLE_STATEMENT_SLOTS the
 * statement is not a site and its gap is the whole procedure body. Each test asserts the tree kind
 * first, so a grammar that stopped building the split node fails here rather than passing vacuously.
 */
describe("R-297 Task 6: split-directive single-statement slots", () => {
  beforeAll(async () => {
    await initParser();
  });
  const proc = (body: string) =>
    `codeunit 50100 "Repro D"\n{\n    procedure Pick(X: Integer): Integer\n    var\n        L: Integer;\n    begin\n${body}\n        exit(L);\n    end;\n}\n`;
  /** The first node of `kind`, and the first assignment whose text is `text`. */
  const parts = (src: string, kind: string, text: string) => {
    const root = wrapRoot(parseAL(src));
    let split: ALSyntaxNode | null = null;
    let stmt: ALSyntaxNode | null = null;
    visit(root, (n) => {
      if (split === null && n.rawKind === kind) split = n;
      if (stmt === null && n.kind === ALNodeKind.assignment_statement && n.text === text) stmt = n;
    });
    if (split === null) throw new Error(`no ${kind} in source`);
    if (stmt === null) throw new Error(`no ${text} in source`);
    return { split: split as ALSyntaxNode, stmt: stmt as ALSyntaxNode };
  };
  const expectSlot = (src: string, kind: string, text: string) => {
    const { split, stmt } = parts(src, kind, text);
    expect([stmt.parent?.rawKind, stmt.parent?.startIndex]).toEqual([
      split.rawKind,
      split.startIndex,
    ]);
    expect(isStatementSlot(stmt)).toBe(true);
    expect([gapBlockOf(stmt).startIndex, gapBlockOf(stmt).endIndex]).toEqual([
      stmt.startIndex,
      stmt.endIndex,
    ]);
  };

  it("preproc_split_if_statement: the shared then-branch is a slot and its own gap block", () => {
    const src = proc(
      "#if not CLEAN27\n        if X > 1 then\n#else\n        if X < 3 then\n#endif\n            L := 5;",
    );
    expectSlot(src, "preproc_split_if_statement", "L := 5");
  });

  it("preproc_split_if_statement: a shared else-branch after #endif is a slot too", () => {
    const src = proc(
      "#if not CLEAN27\n        if X > 1 then\n#else\n        if X < 3 then\n#endif\n            L := 5\n        else\n            L := 6;",
    );
    expectSlot(src, "preproc_split_if_statement", "L := 5");
    expectSlot(src, "preproc_split_if_statement", "L := 6");
  });

  it("preproc_split_if_else_statement: each arm's then-branch and the shared else-branch", () => {
    const src = proc(
      "#if not CLEAN27\n        if X > 1 then\n            L := 2\n        else\n#else\n        if X < 3 then\n            L := 4\n        else\n#endif\n            L := 5;",
    );
    expectSlot(src, "preproc_split_if_else_statement", "L := 2");
    expectSlot(src, "preproc_split_if_else_statement", "L := 4");
    expectSlot(src, "preproc_split_if_else_statement", "L := 5");
  });

  it("preproc_split_case_extended: the arm body shared after #endif", () => {
    const src = proc(
      "        case X of\n            1:\n                L := 10;\n#if not CLEAN27\n            2:\n#else\n            4:\n#endif\n                L := X + 20;\n            3:\n                L := 30;\n        end;",
    );
    expectSlot(src, "preproc_split_case_extended", "L := X + 20");
  });
});
