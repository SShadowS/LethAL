import { beforeAll, describe, expect, it } from "bun:test";
/**
 * R-364 (A): inside an object the symbol table cannot index (wrapped whole in `#if`, R343) no
 * variable resolves, so R196's hang check used to return null and the four operators deployed
 * hang-capable mutants there. The check now falls back to a NAME match, only when declaration
 * resolution fails AND the assignment's own enclosing object is unindexed.
 */
import {
  ALNodeKind,
  type ALSyntaxNode,
  type MutationOperator,
  buildSemanticContext,
  evaluateArms,
  initParser,
  parseAL,
  resolveVarRef,
  wrapRoot,
} from "@lethal/engine";
import { flipBooleanLiteral } from "../src/flip-boolean-literal";
import {
  type NameTarget,
  assignmentTargetOf,
  classifyHangCapable,
  loopConditionReadsByName,
} from "../src/loop-hazard";
import { removeAssignment } from "../src/remove-assignment";
import { shiftInteger } from "../src/shift-integer";
import { swapAdditive } from "../src/swap-additive";

/** One file, built under `symbols` (an arm map, as `generateMutationSet` builds it), or with no
 *  arm map when `symbols` is undefined. */
function load(src: string, symbols?: readonly string[]) {
  const root = wrapRoot(parseAL(src));
  const arms =
    symbols === undefined ? undefined : new Map([[root, evaluateArms(root, src, symbols)]]);
  return { root, ctx: buildSemanticContext([{ path: "t.al", root }], arms) };
}

/** `#if not CLEANX` around `body`, built under `[]`: the object is in `unindexedObjects`. */
const wrapped = (body: string): string => `#if not CLEANX\n${body}\n#endif\n`;

/** The first node of `kind` (text exactly `text`, when given) inside a node whose text is
 *  `within`, when given. */
function nodeAt(root: ALSyntaxNode, kind: string, text?: string, within?: string): ALSyntaxNode {
  const out: ALSyntaxNode[] = [];
  const walk = (n: ALSyntaxNode, inside: boolean): void => {
    const now = inside || within === undefined || n.text === within;
    if (now && n.rawKind === kind && (text === undefined || n.text === text)) out.push(n);
    for (const c of n.children) walk(c, now);
  };
  walk(root, false);
  const first = out[0];
  if (first === undefined) throw new Error(`no ${kind} "${text}"`);
  return first;
}

const assignment = (root: ALSyntaxNode, text: string) =>
  nodeAt(root, ALNodeKind.assignment_statement, text);

describe("R-364: loopConditionReadsByName (the matcher alone)", () => {
  beforeAll(async () => {
    await initParser();
  });

  const SRC = `codeunit 50364 "R" { procedure P() begin
    while (I < 10) and (R.Amount < 10) and not "Line Done" do begin
      I := 0; Amount := 0; R.Amount := 0; R2.Amount := 0; "LINE DONE" := true; R.Other := 0;
    end;
    J := 0;
  end; }`;
  const at = (text: string, target: NameTarget) => {
    const { root, ctx } = load(SRC);
    return loopConditionReadsByName(assignment(root, text), target, ctx);
  };

  it("a PLAIN target matches a plain condition identifier, case and quotes ignored", () => {
    expect(at("I := 0", { receiver: null, member: "I" })).toBe(true);
    expect(at('"LINE DONE" := true', { receiver: null, member: '"line done"' })).toBe(true);
  });

  it("a PLAIN target never matches the MEMBER half of R.Amount", () => {
    expect(at("Amount := 0", { receiver: null, member: "Amount" })).toBe(false);
  });

  it("a PLAIN target matches a member read's RECEIVER (R294's shape)", () => {
    expect(at("I := 0", { receiver: null, member: "R" })).toBe(true);
  });

  it("a MEMBER target matches the (receiver, member) pair, not another receiver or member", () => {
    expect(at("R.Amount := 0", { receiver: "r", member: "amount" })).toBe(true);
    expect(at("R2.Amount := 0", { receiver: "R2", member: "Amount" })).toBe(false);
    expect(at("R.Other := 0", { receiver: "R", member: "Other" })).toBe(false);
  });

  it('compares the pair structurally: "A.B".C is not A."B.C"', () => {
    const { root, ctx } = load(`codeunit 50365 "R" { procedure P() begin
      repeat "A.B".C := true; A."B.C" := true; until A."B.C"; end; }`);
    const a = assignment(root, '"A.B".C := true');
    expect(loopConditionReadsByName(a, { receiver: '"A.B"', member: "C" }, ctx)).toBe(false);
    expect(loopConditionReadsByName(a, { receiver: "A", member: '"B.C"' }, ctx)).toBe(true);
  });

  it("walks OUTER loops to the scope boundary, and no further", () => {
    const { root, ctx } = load(`codeunit 50366 "R" {
      procedure P() begin while Outer < 3 do while Inner < 1 do X := 0; end;
      procedure Q() begin Outer := 7; end; }`);
    const inner = assignment(root, "X := 0");
    expect(loopConditionReadsByName(inner, { receiver: null, member: "Outer" }, ctx)).toBe(true);
    expect(loopConditionReadsByName(inner, { receiver: null, member: "Nope" }, ctx)).toBe(false);
    // The SIBLING procedure's assignment of the very name P's loop reads: Q is not inside P's loop.
    const sibling = assignment(root, "Outer := 7");
    let proc: ALSyntaxNode | null = sibling;
    while (proc !== null && proc.kind !== ALNodeKind.procedure) proc = proc.parent;
    expect(proc?.text).toContain("procedure Q");
    expect(loopConditionReadsByName(sibling, { receiver: null, member: "Outer" }, ctx)).toBe(false);
  });

  it("skips a condition tail in an arm the build compiles out, reads it when active", () => {
    const src = `codeunit 50367 "R" { procedure P() begin
      while (A < 10)
#if LETHALX
        and (B < 5)
#endif
      do A := 0;
    end; }`;
    for (const [symbols, want] of [
      [[], false],
      [["LETHALX"], true],
    ] as const) {
      const { root, ctx } = load(src, symbols);
      expect(
        loopConditionReadsByName(assignment(root, "A := 0"), { receiver: null, member: "B" }, ctx),
      ).toBe(want);
    }
  });

  // R-458 (lethal-bugs) reuses this matcher for an implicit receiver (`Rec`).
  describe("implicitReceiver", () => {
    const IMPLICIT = `codeunit 50368 "R" { procedure P() begin
      while (Rec.Amount < 10) and (Qty < 5) and (Other.Total < 1) do X := 0;
    end; }`;
    const ask = (target: NameTarget) => {
      const { root, ctx } = load(IMPLICIT);
      return loopConditionReadsByName(assignment(root, "X := 0"), target, ctx);
    };

    it("a PLAIN target also matches <implicitReceiver>.<member>", () => {
      expect(ask({ receiver: null, member: "Amount", implicitReceiver: "Rec" })).toBe(true);
    });

    it("a target ON the implicit receiver also matches a PLAIN condition identifier", () => {
      expect(ask({ receiver: "Rec", member: "Qty", implicitReceiver: "rec" })).toBe(true);
    });

    it("control: a DIFFERENT receiver (Other.Total) does not match either way", () => {
      expect(ask({ receiver: null, member: "Total", implicitReceiver: "Rec" })).toBe(false);
      expect(ask({ receiver: "Other", member: "Qty", implicitReceiver: "Rec" })).toBe(false);
    });

    it("without the field, neither shape matches", () => {
      expect(ask({ receiver: null, member: "Amount" })).toBe(false);
      expect(ask({ receiver: "Rec", member: "Qty" })).toBe(false);
    });
  });
});

describe("R-364: classifyHangCapable in an UNINDEXED object (name fallback)", () => {
  beforeAll(async () => {
    await initParser();
  });

  const unit = (body: string, vars = "I: Integer; J: Integer; N: Integer; Done: Boolean;") =>
    wrapped(`codeunit 50370 "W" { procedure P() var ${vars} begin ${body} end; }`);

  it("the wrapped object is unindexed and its local does NOT resolve (the fallback is needed)", () => {
    const { root, ctx } = load(unit("while I < N do I := 0;"), []);
    expect(ctx.symbols.unindexedObjects.length).toBe(1);
    const target = assignmentTargetOf(assignment(root, "I := 0"));
    if (target === null) throw new Error("no target");
    expect(resolveVarRef(target, ctx)).toBeNull();
  });

  it("CLAIMS while I < N do I := 0, and repeat Done := ...; until Done", () => {
    const { root, ctx } = load(
      unit("while I < N do I := 0; repeat Done := true; until J > 0 or Done;"),
      [],
    );
    expect(classifyHangCapable(assignment(root, "I := 0"), ctx)).toBe("loop-condition-target");
    expect(classifyHangCapable(assignment(root, "Done := true"), ctx)).toBe(
      "loop-condition-target",
    );
  });

  it("DECLINES a name no enclosing loop condition reads (not a blanket refusal)", () => {
    const { root, ctx } = load(unit("while I < N do J := 0;"), []);
    expect(classifyHangCapable(assignment(root, "J := 0"), ctx)).toBeNull();
  });

  it("control: an INDEXED object's unresolvable Ghost read by its loop is NOT refused", () => {
    const { root, ctx } = load(
      `codeunit 50371 "R" { procedure P() begin while Ghost < 3 do Ghost := 0; end; }`,
      [],
    );
    expect(ctx.symbols.unindexedObjects.length).toBe(0);
    expect(classifyHangCapable(assignment(root, "Ghost := 0"), ctx)).toBeNull();
  });

  it("control: an indexed caller in the SAME file as a wrapped object is NOT refused", () => {
    const src = `${wrapped(`codeunit 50372 "W" { procedure Q() begin end; }`)}codeunit 50373 "R" { procedure P() begin while Ghost < 3 do Ghost := 0; end; }`;
    const { root, ctx } = load(src, []);
    expect(ctx.symbols.unindexedObjects.length).toBe(1);
    expect(classifyHangCapable(assignment(root, "Ghost := 0"), ctx)).toBeNull();
  });

  it("CLAIMS a wrapped MEMBER pair, not another receiver, not another member", () => {
    const { root, ctx } = load(
      unit(
        "repeat R.Done := true; R2.Done := true; R.Flag := true; until R.Done;",
        "R: Record Customer; R2: Record Customer;",
      ),
      [],
    );
    expect(classifyHangCapable(assignment(root, "R.Done := true"), ctx)).toBe(
      "loop-condition-target",
    );
    expect(classifyHangCapable(assignment(root, "R2.Done := true"), ctx)).toBeNull();
    expect(classifyHangCapable(assignment(root, "R.Flag := true"), ctx)).toBeNull();
  });

  it("DECLINES a plain Amount against the condition's R.Amount", () => {
    const { root, ctx } = load(
      unit("while R.Amount < 10 do Amount := 5;", "R: Record Customer; Amount: Decimal;"),
      [],
    );
    expect(classifyHangCapable(assignment(root, "Amount := 5"), ctx)).toBeNull();
  });

  it("CLAIMS a QUOTED name, matched case-insensitively", () => {
    const { root, ctx } = load(
      unit('while not "Line Done" do "LINE DONE" := true;', '"Line Done": Boolean;'),
      [],
    );
    expect(classifyHangCapable(assignment(root, '"LINE DONE" := true'), ctx)).toBe(
      "loop-condition-target",
    );
  });

  it("DECLINES a name read only in a condition tail the build compiles out", () => {
    const body = `while (I < 10)
#if LETHALX
      and (J < 5)
#endif
    do begin I := 0; J := 0; end;`;
    const off = load(unit(body), []);
    expect(classifyHangCapable(assignment(off.root, "J := 0"), off.ctx)).toBeNull();
    expect(classifyHangCapable(assignment(off.root, "I := 0"), off.ctx)).toBe(
      "loop-condition-target",
    );
    const on = load(unit(body), ["LETHALX"]);
    expect(classifyHangCapable(assignment(on.root, "J := 0"), on.ctx)).toBe(
      "loop-condition-target",
    );
  });

  it("CLAIMS inside a wrapper NESTED in another wrapper's #else (real parse)", () => {
    const src = `#if CLEANX
codeunit 50374 "Gone" { }
#else
#if not CLEANY
codeunit 50375 "W" { procedure P() var I: Integer; N: Integer; begin while I < N do I := 0; end; }
#endif
#endif
`;
    const { root, ctx } = load(src, []);
    expect(ctx.symbols.unindexedObjects.some((o) => o.text.includes('"W"'))).toBe(true);
    expect(classifyHangCapable(assignment(root, "I := 0"), ctx)).toBe("loop-condition-target");
  });

  it("a TRIGGER-local in a wrapped object resolves by DECLARATION, not the fallback", () => {
    const { root, ctx } = load(
      wrapped(`table 50376 "W" { fields { field(1; "No."; Code[20]) { } }
        trigger OnInsert() var N: Integer; begin while N < 3 do N := 0; end; }`),
      [],
    );
    const a = assignment(root, "N := 0");
    const target = assignmentTargetOf(a);
    if (target === null) throw new Error("no target");
    const sym = resolveVarRef(target, ctx);
    expect(sym).not.toBeNull();
    // Discriminating probe: the loop condition's own `N` resolves to the SAME declaration, so the
    // refusal is reachable by declaration alone. (A name-first path would also say yes here, which
    // is why the control below matters: a trigger-local the loop does NOT read.)
    const condN = nodeAt(root, ALNodeKind.identifier, "N", "N < 3");
    expect(resolveVarRef(condN, ctx)).toEqual(sym);
    expect(classifyHangCapable(a, ctx)).toBe("loop-condition-target");
  });

  it("a wrapped trigger-local the loop does NOT read is declined, though a same-named table field is read", () => {
    // `N` the loop reads is the table FIELD (Rec.N, unresolved by name); the trigger-local is `K`.
    // A name-first path keyed on the target's text `K` has nothing to match, and must stay null.
    const { root, ctx } = load(
      wrapped(`table 50377 "W" { fields { field(1; N; Integer) { } }
        trigger OnInsert() var K: Integer; begin while N < 3 do K := 0; end; }`),
      [],
    );
    const a = assignment(root, "K := 0");
    const target = assignmentTargetOf(a);
    if (target === null) throw new Error("no target");
    expect(resolveVarRef(target, ctx)).not.toBeNull();
    expect(classifyHangCapable(a, ctx)).toBeNull();
  });
});

describe("R-364: all four operators in an unindexed object", () => {
  beforeAll(async () => {
    await initParser();
  });

  type Case = {
    op: MutationOperator;
    body: string;
    kind: string;
    refused: string;
    refusedWithin?: string;
    claimed: string;
    claimedWithin?: string;
  };
  const CASES: Case[] = [
    {
      op: removeAssignment,
      body: "while I < N do begin I := 0; J := 0; end;",
      kind: "assignment_statement",
      refused: "I := 0",
      claimed: "J := 0",
    },
    {
      op: removeAssignment,
      body: "repeat Done := Check(); Flag := Check(); until Done;",
      kind: "assignment_statement",
      refused: "Done := Check()",
      claimed: "Flag := Check()",
    },
    {
      op: shiftInteger,
      body: "while I < N do begin I := 5; J := 5; end;",
      kind: "integer",
      refused: "5",
      refusedWithin: "I := 5",
      claimed: "5",
      claimedWithin: "J := 5",
    },
    {
      op: flipBooleanLiteral,
      body: "repeat Done := true; Flag := true; until Done;",
      kind: "boolean",
      refused: "true",
      refusedWithin: "Done := true",
      claimed: "true",
      claimedWithin: "Flag := true",
    },
    {
      op: removeAssignment,
      body: "repeat R.Done := true; R.Flag := true; until R.Done;",
      kind: "assignment_statement",
      refused: "R.Done := true",
      claimed: "R.Flag := true",
    },
  ];
  const src = (body: string) =>
    wrapped(`codeunit 50380 "W" {
      procedure Check(): Boolean begin end;
      procedure P() var I: Integer; J: Integer; N: Integer; Done: Boolean; Flag: Boolean; R: Record Customer;
      begin ${body} end; }`);

  for (const c of CASES) {
    it(`${c.op.name}: ${c.body} is a candidate, refused and counted; its sibling is emitted`, () => {
      const { root, ctx } = load(src(c.body), []);
      const refused = nodeAt(root, c.kind, c.refused, c.refusedWithin);
      const claimed = nodeAt(root, c.kind, c.claimed, c.claimedWithin);
      // Candidacy: every check but the hang check admits the site (R447's counter), so without the
      // fallback this mutant EXISTS; the sibling shows the same shape is emitted when not read.
      expect(c.op.refusesHangCapable?.(refused, ctx)).toBe(true);
      expect(c.op.targets(refused, ctx)).toBe(false);
      expect(c.op.generate(refused, ctx)).toEqual([]);
      expect(c.op.targets(claimed, ctx)).toBe(true);
      expect(c.op.generate(claimed, ctx).length).toBeGreaterThan(0);
    });
  }

  it("swap-additive: `I + 1` has unresolved operands, so the type guard declines it first", () => {
    const { root, ctx } = load(src("while I < N do I := I + 1;"), []);
    const node = nodeAt(root, "additive_expression", "I + 1");
    expect(swapAdditive.targets(node, ctx)).toBe(false);
    expect(swapAdditive.refusesHangCapable?.(node, ctx)).toBe(false);
  });

  it("swap-additive: wrapped `while I < N do I := 1 + 1` (literals type fine) is refused and counted", () => {
    // Without the fallback the site is a candidate: the same shape in an INDEXED object, whose
    // loop reads an unresolvable Ghost, is not refused and emits a mutant.
    const open = load(
      `codeunit 50381 "R" { procedure P() begin while Ghost < 3 do Ghost := 1 + 1; end; }`,
      [],
    );
    const openNode = nodeAt(open.root, "additive_expression", "1 + 1");
    expect(open.ctx.symbols.unindexedObjects.length).toBe(0);
    expect(swapAdditive.targets(openNode, open.ctx)).toBe(true);
    expect(swapAdditive.generate(openNode, open.ctx).length).toBe(1);
    // Wrapped, the name fallback refuses it, and it counts as hang-refused.
    const { root, ctx } = load(src("while I < N do I := 1 + 1;"), []);
    const node = nodeAt(root, "additive_expression", "1 + 1");
    expect(swapAdditive.refusesHangCapable?.(node, ctx)).toBe(true);
    expect(swapAdditive.targets(node, ctx)).toBe(false);
    expect(swapAdditive.generate(node, ctx)).toEqual([]);
  });
});
