import { beforeAll, describe, expect, it } from "bun:test";
import {
  ALNodeKind,
  type ALSyntaxNode,
  buildSemanticContext,
  findAll,
  initParser,
  parseAL,
  wrapRoot,
} from "@lethal/engine";
import { classifyHangCapable, hangCapableForMutatedNode } from "../src/loop-hazard";

function load(src: string) {
  const root = wrapRoot(parseAL(src));
  return { root, ctx: buildSemanticContext([{ path: "t.al", root }]) };
}

/** The assignment statement whose source text contains `needle`. */
function assignment(root: ALSyntaxNode, needle: string): ALSyntaxNode {
  const out: ALSyntaxNode[] = [];
  const walk = (n: ALSyntaxNode): void => {
    if (n.kind === ALNodeKind.assignment_statement && n.text.includes(needle)) out.push(n);
    for (const c of n.namedChildren) walk(c);
  };
  walk(root);
  const first = out[0];
  if (first === undefined) throw new Error(`no assignment containing ${needle}`);
  return first;
}

describe("classifyHangCapable", () => {
  beforeAll(async () => {
    await initParser();
  });

  it("CLAIMS a counter advanced in a while body whose condition reads it", () => {
    const { root, ctx } = load(`codeunit 50300 "R" {
      procedure P(Limit: Integer) var I: Integer; begin
        while I < Limit do I += 1;
      end; }`);
    expect(classifyHangCapable(assignment(root, "I += 1"), ctx)).toBe("loop-condition-target");
  });

  it("CLAIMS a flag assigned in a repeat body whose until reads it", () => {
    const { root, ctx } = load(`codeunit 50301 "R" {
      procedure P() var Done: Boolean; begin
        repeat Done := true; until Done;
      end; }`);
    expect(classifyHangCapable(assignment(root, "Done := true"), ctx)).toBe(
      "loop-condition-target",
    );
  });

  it("CLAIMS through an OUTER loop, not only the nearest one", () => {
    const { root, ctx } = load(`codeunit 50302 "R" {
      procedure P() var Outer: Integer; Inner: Integer; begin
        while Outer < 10 do begin
          while Inner < 3 do Inner += 1;
          Outer += 1;
        end;
      end; }`);
    // `Outer += 1` sits inside the inner loop's sibling, but the OUTER condition reads it.
    expect(classifyHangCapable(assignment(root, "Outer += 1"), ctx)).toBe("loop-condition-target");
  });

  it("CLAIMS inside a TRIGGER body", () => {
    const { root, ctx } = load(`table 50303 "R" { fields { field(1; "No."; Code[20]) { } }
      trigger OnInsert() var N: Integer; begin
        while N < 3 do N += 1;
      end; }`);
    expect(classifyHangCapable(assignment(root, "N += 1"), ctx)).toBe("loop-condition-target");
  });

  it("DECLINES an assignment the condition does not read: the step variable (spec 3.2.1)", () => {
    const { root, ctx } = load(`codeunit 50304 "R" {
      procedure P(Limit: Integer) var I: Integer; Step: Integer; begin
        Step := 1;
        while I < Limit do I += Step;
      end; }`);
    expect(classifyHangCapable(assignment(root, "Step := 1"), ctx)).toBeNull();
  });

  it("DECLINES a preheader assignment (spec 3.2.2)", () => {
    const { root, ctx } = load(`codeunit 50305 "R" {
      procedure P(Target: Integer) var Position: Integer; begin
        Position := Target + 1;
        repeat if Position > Target then Position -= 1; until Position = Target;
      end; }`);
    expect(classifyHangCapable(assignment(root, "Position := Target + 1"), ctx)).toBeNull();
  });

  it("DECLINES an assignment outside any loop", () => {
    const { root, ctx } = load(`codeunit 50306 "R" {
      procedure P() var I: Integer; begin I := 1; end; }`);
    expect(classifyHangCapable(assignment(root, "I := 1"), ctx)).toBeNull();
  });

  it("DECLINES when the target cannot be resolved, rather than matching on name", () => {
    const { root, ctx } = load(`codeunit 50307 "R" {
      procedure P() begin while Ghost < 3 do Ghost += 1; end; }`);
    expect(classifyHangCapable(assignment(root, "Ghost += 1"), ctx)).toBeNull();
  });

  it("DECLINES a same-named variable in a DIFFERENT procedure's loop", () => {
    const { root, ctx } = load(`codeunit 50308 "R" {
      procedure A() var I: Integer; begin while I < 3 do ; end;
      procedure B() var I: Integer; begin I += 1; end; }`);
    expect(classifyHangCapable(assignment(root, "I += 1"), ctx)).toBeNull();
  });

  it("CLAIMS a QUOTED-identifier target read by an enclosing loop's condition", () => {
    const { root, ctx } = load(`codeunit 50309 "R" {
      procedure P() var "Line Done": Boolean; begin
        while not "Line Done" do "Line Done" := true;
      end; }`);
    expect(classifyHangCapable(assignment(root, '"Line Done" := true'), ctx)).toBe(
      "loop-condition-target",
    );
  });
});

describe("hangCapableForMutatedNode", () => {
  const ctxFor = (src: string) => {
    const root = wrapRoot(parseAL(src));
    return { root, ctx: buildSemanticContext([{ path: "fixture.al", root }]) };
  };

  // The assignment itself, which is remove-assignment's shape.
  it("claims the assignment statement it is given", () => {
    const { root, ctx } = ctxFor(`codeunit 50000 P
{
    procedure Go()
    var
        Remaining: Integer;
    begin
        Remaining := 1;
        while Remaining > 0 do
            Remaining := 0;
    end;
}`);
    const assignments = findAll(root, ALNodeKind.assignment_statement);
    const inLoop = assignments[assignments.length - 1];
    expect(inLoop).toBeDefined();
    if (inLoop === undefined) throw new Error("fixture has no assignment");
    expect(hangCapableForMutatedNode(inLoop, ctx)).toBe("loop-condition-target");
  });

  // A literal inside the assignment's right-hand side, which is shift-integer's shape.
  it("claims a literal on the value side of an in-loop assignment", () => {
    const { root, ctx } = ctxFor(`codeunit 50000 P
{
    procedure Go()
    var
        Remaining: Integer;
    begin
        Remaining := 1;
        while Remaining > 0 do
            Remaining := 0;
    end;
}`);
    // Both the loop's condition (`Remaining > 0`) and its body (`Remaining := 0`) contain a `0`
    // literal, so a flat `findAll(root, ...)` over the whole tree is ambiguous: a search scoped to
    // the file could pick up either one, and a positional index into that flat list is only as
    // stable as the fixture text happens to keep it (this is the bug a prior version of this test
    // had). Scope the search to the in-loop assignment's OWN subtree instead, so there is exactly
    // one `0` to find, structurally, regardless of how many others exist elsewhere in the file.
    const assignments = findAll(root, ALNodeKind.assignment_statement);
    const inLoop = assignments[assignments.length - 1];
    if (inLoop === undefined) throw new Error("fixture has no assignment");
    const literals = findAll(inLoop, ALNodeKind.integer_literal).filter((n) => n.text === "0");
    const lit = literals[0];
    if (lit === undefined) throw new Error("assignment has no `0` literal");
    expect(hangCapableForMutatedNode(lit, ctx)).toBe("loop-condition-target");
  });

  // The target side is not a value written to the target.
  //
  // The fixture is chosen so this can actually fail. An obvious alternative, a subscripted target
  // like `Slots[2] := 0`, would pass with the guard deleted: `assignmentTargetOf` already declines
  // any target that is not a bare identifier, so the enclosing assignment classifies as null
  // whatever the guard does. The target identifier itself is the one node inside `left` whose
  // enclosing assignment IS claimable, so it is the only fixture that separates the two.
  it("DECLINES the target identifier on the assignment's left", () => {
    const { root, ctx } = ctxFor(`codeunit 50000 P
{
    procedure Go()
    var
        Remaining: Integer;
    begin
        Remaining := 1;
        while Remaining > 0 do
            Remaining := 0;
    end;
}`);
    // The LAST `Remaining` on the left of an assignment: the one inside the loop body.
    const assignments = findAll(root, ALNodeKind.assignment_statement);
    const inLoop = assignments[assignments.length - 1];
    if (inLoop === undefined) throw new Error("fixture has no assignment");
    const target = inLoop.childForFieldName("left");
    if (target === null) throw new Error("assignment has no left field");
    expect(hangCapableForMutatedNode(target, ctx)).toBeNull();
  });

  // A node in a statement that is not an assignment must not borrow a neighbour's answer.
  it("DECLINES a literal in a non-assignment statement beside an in-loop assignment", () => {
    const { root, ctx } = ctxFor(`codeunit 50000 P
{
    procedure Go()
    var
        Remaining: Integer;
    begin
        Remaining := 1;
        while Remaining > 0 do begin
            Remaining := 0;
            Message('%1', 7);
        end;
    end;
}`);
    const sevens = findAll(root, ALNodeKind.integer_literal).filter((n) => n.text === "7");
    const seven = sevens[0];
    if (seven === undefined) throw new Error("fixture has no `7` literal");
    expect(hangCapableForMutatedNode(seven, ctx)).toBeNull();
  });

  // No enclosing loop at all.
  it("DECLINES a literal in an assignment outside any loop", () => {
    const { root, ctx } = ctxFor(`codeunit 50000 P
{
    procedure Go()
    var
        Remaining: Integer;
    begin
        Remaining := 3;
    end;
}`);
    const threes = findAll(root, ALNodeKind.integer_literal).filter((n) => n.text === "3");
    const three = threes[0];
    if (three === undefined) throw new Error("fixture has no `3` literal");
    expect(hangCapableForMutatedNode(three, ctx)).toBeNull();
  });

  // The mutated node's OWN procedure has no loop at all, so `classifyHangCapable` finds nothing to
  // claim against, even though a SIBLING procedure has one. This does NOT exercise the walk's
  // `SCOPE_KINDS` boundary check: from the `9` literal, the enclosing assignment is found on the
  // very first parent hop, already inside `Other()`, so `hangCapableForMutatedNode` never climbs
  // far enough to reach a scope boundary at all. The null answer comes entirely from
  // `classifyHangCapable` finding no enclosing loop in `Other()`. (A `.parent`-only walk can never
  // descend into a sibling procedure's subtree regardless, per `sameDeclaration`'s docstring in
  // `../src/loop-hazard.ts`, so no fixture in this file can exercise that boundary check either.)
  it("DECLINES a literal in an assignment whose own procedure has no loop", () => {
    const { root, ctx } = ctxFor(`codeunit 50000 P
{
    procedure Spin()
    var
        Remaining: Integer;
    begin
        Remaining := 1;
        while Remaining > 0 do
            Remaining := Remaining - 1;
    end;

    procedure Other()
    var
        Remaining: Integer;
    begin
        Remaining := 9;
    end;
}`);
    const nines = findAll(root, ALNodeKind.integer_literal).filter((n) => n.text === "9");
    const nine = nines[0];
    if (nine === undefined) throw new Error("fixture has no `9` literal");
    expect(hangCapableForMutatedNode(nine, ctx)).toBeNull();
  });
});
