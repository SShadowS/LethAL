import { beforeAll, describe, expect, it } from "bun:test";
import type { ALSyntaxNode } from "../../src";
import {
  ALNodeKind,
  findAll,
  findEnclosingCodeBlock,
  findEnclosingProcedure,
  findEnclosingStatement,
  findFirst,
  gapBlockOf,
  inMemberBody,
  initParser,
  isObjectContainer,
  isProcedureLike,
  isStatementPosition,
  isStatementSlot,
  memberArms,
  objectDeclarationsOf,
  parseAL,
  procedureLikeArmNames,
  procedureLikeNameNode,
  procedureLikeReturnType,
  renamedMemberCoverageNames,
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

  it("isProcedureLike: a procedure, a split procedure and a preamble (R316), never a trigger", () => {
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
    ).toBe(true);
  });

  it("gapBlockOf: a top-level statement of a preamble's shared body belongs to the body (R316)", () => {
    const src = `codeunit 50100 "Repro P"
{
#if CLEAN27
    procedure A(X: Integer)
    var
        L: Integer;
#else
    procedure A(X: Integer)
    var
        M: Integer;
#endif
    begin
        G := X;
        Message('%1', G);
    end;

    var
        G: Integer;
}
`;
    const got = gapBlockOf(first(wrapRoot(parseAL(src)), "assignment_statement"));
    const begin = src.indexOf("begin\n        G := X");
    const end = src.indexOf("end;\n\n    var") + "end".length;
    expect([got.startIndex, got.endIndex]).toEqual([begin, end]);
    expect(got.parent?.rawKind).toBe("preproc_split_procedure_preamble");
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

  it("findEnclosingProcedure returns the split node, for both split shapes (R302)", () => {
    const root = wrapRoot(parseAL(SPLIT));
    const split = first(root, "preproc_split_procedure");
    expect(findEnclosingProcedure(first(root, "assignment_statement"))?.startIndex).toBe(
      split.startIndex,
    );
    const pre = wrapRoot(parseAL(PREAMBLE));
    const preNode = first(pre, "preproc_split_procedure_preamble");
    const got = findEnclosingProcedure(first(pre, "assignment_statement"));
    expect([got?.rawKind, got?.startIndex]).toEqual([preNode.rawKind, preNode.startIndex]);
  });

  it("memberArms: one arm per #if, #elif and #else, each with its own children (R302)", () => {
    const three = `codeunit 50100 "Repro A"
{
#if CLEAN27
    procedure A(X: Integer)
#elif CLEAN26
    procedure A(Y: Integer)
#else
    procedure A(Z: Integer)
#endif
    begin
    end;
}
`;
    const arms = memberArms(first(wrapRoot(parseAL(three)), "preproc_split_procedure"));
    expect(arms.map((a) => a.find((c) => c.kind === ALNodeKind.parameter_list)?.text)).toEqual([
      "X: Integer",
      "Y: Integer",
      "Z: Integer",
    ]);
    // A plain procedure is one arm: its own children.
    const plain = findFirst(
      wrapRoot(parseAL(`codeunit 50100 "P" { procedure A() begin end; }`)),
      ALNodeKind.procedure,
    );
    if (plain === null) throw new Error("no procedure");
    expect(memberArms(plain)).toHaveLength(1);
  });

  it("procedureLikeReturnType: the agreed type, null when arms disagree or one has none (R302)", () => {
    const withReturn = (a: string, b: string) => `codeunit 50100 "Repro R"
{
#if CLEAN27
    procedure A(X: Integer)${a}
#else
    procedure A(X: Integer)${b}
#endif
    begin
        exit(X);
    end;
}
`;
    const rt = (src: string) =>
      procedureLikeReturnType(first(wrapRoot(parseAL(src)), "preproc_split_procedure"));
    expect(rt(withReturn(": Integer", ":  Integer"))).toBe("Integer");
    // Compared whitespace-normalised, as `extractType` compares.
    expect(rt(withReturn(': Record  "Tab A"', ': Record "Tab A"'))).toBe('Record "Tab A"');
    expect(rt(withReturn(": Decimal", ": Integer"))).toBeNull();
    expect(rt(withReturn(": Integer", ""))).toBeNull();
  });

  it("inMemberBody: true in a split member's body, false in an attribute inside an arm (R302)", () => {
    const src = `codeunit 50100 "Repro T"
{
#if not CLEAN27
    [Obsolete('Gone soon', '27.0')]
    procedure A(): Text
#else
    procedure A(): Text
#endif
    begin
        exit('kept');
    end;
}
`;
    const root = wrapRoot(parseAL(src));
    const strings: ALSyntaxNode[] = [];
    visit(root, (n) => {
      if (n.kind === ALNodeKind.text_literal) strings.push(n);
    });
    const byText = (t: string) => {
      const hit = strings.find((n) => n.text === t);
      if (hit === undefined) throw new Error(`no ${t}`);
      return hit;
    };
    expect(inMemberBody(byText("'kept'"))).toBe(true);
    expect(inMemberBody(byText("'Gone soon'"))).toBe(false);
    expect(inMemberBody(byText("'27.0'"))).toBe(false);
  });

  it("findEnclosingStatement: a split member's body block is its own statement (R302)", () => {
    const root = wrapRoot(parseAL(SPLIT));
    const split = first(root, "preproc_split_procedure");
    const body = split.children.find((c) => c.kind === ALNodeKind.block);
    if (body === undefined) throw new Error("no body");
    const got = findEnclosingStatement(body);
    expect([got?.startIndex, got?.endIndex]).toEqual([body.startIndex, body.endIndex]);
  });
});

const PREAMBLE = `codeunit 50100 "Repro P"
{
#if CLEAN27
    procedure A(X: Integer)
    var
        L: Integer;
#else
    procedure A(X: Integer)
    var
        M: Integer;
#endif
    begin
        G := X;
    end;

    var
        G: Integer;
}
`;

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

describe("R318: renamedMemberCoverageNames", () => {
  beforeAll(async () => {
    await initParser();
  });

  /** Every procedure-like node of `src`, in source order, with its coverage names. */
  const namesOf = (src: string): string[][] => {
    const out: string[][] = [];
    visit(wrapRoot(parseAL(src)), (n) => {
      if (isProcedureLike(n) && n.children.length > 0) out.push(renamedMemberCoverageNames(n));
    });
    return out;
  };
  const obj = (body: string, id = 50100): string => `codeunit ${id} "Repro R${id}"
{
${body}
}
`;
  const split = (a: string, b: string, param = "X: Integer"): string =>
    `#if R318A
    procedure ${a}(${param}): Integer
#else
    procedure ${b}(${param}): Integer
#endif
    begin
        exit(1);
    end;
`;
  const plain = (name: string, param = "T: Text"): string =>
    `    procedure ${name}(${param}): Integer
    begin
        exit(2);
    end;
`;

  it("a plain procedure and an agreeing split member have none", () => {
    expect(namesOf(obj(plain("Solo") + split("Same", "same")))).toEqual([[], []]);
  });

  it("a renamed member lists each arm's name once, in source order, first spelling kept", () => {
    expect(namesOf(obj(split("Pick", "Choose")))).toEqual([["Pick", "Choose"]]);
    const three = `#if R318A
    procedure Pick(X: Integer): Integer
#elif R318B
    procedure Choose(X: Integer): Integer
#else
    procedure PICK(X: Integer): Integer
#endif
    begin
        exit(1);
    end;
`;
    expect(namesOf(obj(three))).toEqual([["Pick", "Choose"]]);
  });

  it("quotes are stripped", () => {
    expect(namesOf(obj(split('"Pick"', '"Choose Me"')))).toEqual([["Pick", "Choose Me"]]);
  });

  it("a named return value is not an arm name (R323)", () => {
    const named = `#if R318A
    procedure Pick(X: Integer) Result: Integer
#else
    procedure Choose(X: Integer) Result: Integer
#endif
    begin
        Result := X;
    end;
`;
    expect(namesOf(obj(named))).toEqual([["Pick", "Choose"]]);
  });

  it("a name a plain overload also uses is dropped, compared case-insensitively", () => {
    expect(namesOf(obj(split("Pick", "Choose") + plain("CHOOSE")))).toEqual([["Pick"], []]);
  });

  it("a name a #if-wrapped procedure uses is dropped", () => {
    const wrapped = `#if R318A
${plain("Choose")}#endif
`;
    expect(namesOf(obj(split("Pick", "Choose") + wrapped))).toEqual([["Pick"], []]);
  });

  it("two renamed members that share a name across builds each drop it", () => {
    expect(namesOf(obj(split("Alpha", "Beta") + split("Beta", "Gamma")))).toEqual([
      ["Alpha"],
      ["Gamma"],
    ]);
  });

  it("a member whose every arm name is taken gets none", () => {
    expect(namesOf(obj(split("Alpha", "Beta") + split("Beta", "Alpha")))).toEqual([[], []]);
  });

  it("a member swallowed by the global var section still sees a later overload (R327)", () => {
    const src = obj(`    var
        Glob: Integer;

${split("Pick", "Choose")}
${plain("Choose")}`);
    expect(namesOf(src)).toEqual([["Pick"], []]);
  });

  it("a trigger's name is taken", () => {
    const src = obj(`    trigger OnRun()
    begin
    end;

${split("OnRun2", "OnRun")}`);
    expect(namesOf(src)).toEqual([["OnRun2"]]);
  });

  it("a quoted trigger name is taken", () => {
    const src = obj(`    trigger "OnRun"()
    begin
    end;

${split("OnRun2", "OnRun")}`);
    expect(namesOf(src)).toEqual([["OnRun2"]]);
  });

  it("an object that did not parse cleanly gives no names", () => {
    const src = obj(`${split("Pick", "Choose")}
    procedure Broken(
    begin
    end;
`);
    expect(namesOf(src)[0]).toEqual([]);
  });

  it("the rule is per object: another object in the same file does not collide", () => {
    const src = obj(split("Pick", "Choose")) + obj(plain("Choose"), 50101);
    expect(namesOf(src)).toEqual([["Pick", "Choose"], []]);
  });

  it("procedureLikeArmNames lists every arm's name, unquoted, as written", () => {
    const found: string[][] = [];
    visit(wrapRoot(parseAL(obj(split('"Pick"', '"Choose Me"')))), (n) => {
      if (isProcedureLike(n) && n.children.length > 0) found.push(procedureLikeArmNames(n));
    });
    expect(found).toEqual([["Pick", "Choose Me"]]);
  });
});

describe("R214: a statement directly inside a statement-level #if", () => {
  const src = `codeunit 50001 "P"
{
    procedure A(X: Integer)
    begin
#if S
        Helper(X);
#if T
        X := 2;
#endif
#endif
        if X > 0 then
#if S
            Helper(X)
#endif
        ;
    end;

    local procedure Helper(V: Integer)
    begin
    end;
}
`;
  const callAt = (root: ALSyntaxNode, needle: string): ALSyntaxNode => {
    const at = src.indexOf(needle);
    const hit = findAll(root, ALNodeKind.procedure_call).find((n) => n.startIndex === at);
    if (hit === undefined) throw new Error(`no call at ${needle}`);
    return hit;
  };
  it("an arm of a #if in a statement list is a statement list, nested arms too", () => {
    const root = wrapRoot(parseAL(src));
    expect(isStatementPosition(callAt(root, "Helper(X);"))).toBe(true);
    const assign = findFirst(root, ALNodeKind.assignment_statement);
    if (assign === null) throw new Error("no assignment");
    expect(isStatementPosition(assign)).toBe(true);
    expect(isStatementSlot(assign)).toBe(true);
  });
  it("an arm of a #if in a single-statement slot is not (a named exclusion, unchanged)", () => {
    const root = wrapRoot(parseAL(src));
    const inSlot = callAt(root, "Helper(X)\n#endif");
    expect(isStatementPosition(inSlot)).toBe(false);
    expect(isStatementSlot(inSlot)).toBe(false);
  });
});
