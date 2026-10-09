import { beforeAll, describe, expect, it } from "bun:test";
/**
 * R340 (plan r2, opus review C1): once a trigger's header names are TYPED, swap-additive reaches
 * sites on them, so the hang check must see a loop over a trigger PARAMETER or NAMED RETURN. Those
 * names do not resolve as declarations on the hang path (`triggerScopeVar` reads only the plain
 * `var` section), so the check falls back to a NAME match for a header name of the enclosing
 * trigger, as R-364 does for an unindexed object. That also closes master's door: remove-assignment
 * at such a write was emitted hang-capable before R340. Each shape is measured in the review
 * (h1 a parameter in a while, h3 a named return in a repeat, h6 a usercontrol event parameter).
 */
import {
  ALNodeKind,
  type ALSyntaxNode,
  buildSemanticContext,
  initParser,
  parseAL,
  wrapRoot,
} from "@lethal/engine";
import { assignmentTargetOf, classifyHangCapable } from "../src/loop-hazard";
import { removeAssignment } from "../src/remove-assignment";
import { swapAdditive } from "../src/swap-additive";
import { swapCallArguments } from "../src/swap-call-arguments";

function load(src: string) {
  const root = wrapRoot(parseAL(src));
  return { root, ctx: buildSemanticContext([{ path: "t.al", root }]) };
}

function nodeOf(root: ALSyntaxNode, kind: string, text: string): ALSyntaxNode {
  let found: ALSyntaxNode | null = null;
  const walk = (n: ALSyntaxNode): void => {
    if (found !== null) return;
    if (n.rawKind === kind && n.text === text) found = n;
    for (const c of n.children) walk(c);
  };
  walk(root);
  if (found === null) throw new Error(`no ${kind} "${text}"`);
  return found;
}

const H1 = `page 50340 "H1"
{
    trigger OnNextRecord(Steps: Integer): Integer
    var
        Total: Integer;
    begin
        while Steps > 0 do begin
            Steps := Steps - 1;
            Total := Total + Steps;
        end;
        exit(Total);
    end;
}`;

const H3 = `page 50341 "H3"
{
    trigger OnNextRecord(Steps: Integer) Moved: Integer
    var
        Total: Integer;
    begin
        repeat
            Moved := Moved + 1;
            Total := Total + Moved;
        until Moved >= Steps;
    end;
}`;

const H6 = `page 50342 "H6"
{
    layout
    {
        area(Content)
        {
            usercontrol(Ctl; "Some AddIn")
            {
                trigger Ready(Count: Integer)
                var
                    Total: Integer;
                begin
                    while Count > 0 do begin
                        Count := Count - 1;
                        Total := Total + Count;
                    end;
                end;
            }
        }
    }
}`;

const FOR_PARAM = `page 50343 "F"
{
    trigger OnNextRecord(Steps: Integer): Integer
    begin
        for Steps := 1 to 3 do
            Steps := Steps + 1;
        exit(Steps);
    end;
}`;

const NO_LOOP = `page 50344 "N"
{
    trigger OnNextRecord(Steps: Integer): Integer
    begin
        Steps := Steps - 1;
        exit(Steps);
    end;
}`;

describe("R340: the hang check sees a loop over a trigger header name", () => {
  beforeAll(async () => {
    await initParser();
  });

  for (const [label, src, write, additive, safe] of [
    ["h1: a parameter in a while", H1, "Steps := Steps - 1", "Steps - 1", "Total + Steps"],
    ["h3: a named return in a repeat", H3, "Moved := Moved + 1", "Moved + 1", "Total + Moved"],
    ["h6: a usercontrol event parameter", H6, "Count := Count - 1", "Count - 1", "Total + Count"],
  ] as const) {
    it(`${label}: the loop write is hang-capable, swap-additive and remove-assignment refuse it; the safe additive is emitted`, () => {
      const { root, ctx } = load(src);
      const assignment = nodeOf(root, ALNodeKind.assignment_statement, write);
      expect(assignmentTargetOf(assignment)?.text).toBe(write.split(" ")[0]);
      expect(classifyHangCapable(assignment, ctx)).toBe("loop-condition-target");
      expect(removeAssignment.refusesHangCapable?.(assignment, ctx)).toBe(true);
      const loopSum = nodeOf(root, "additive_expression", additive);
      expect(swapAdditive.refusesHangCapable?.(loopSum, ctx)).toBe(true);
      expect(swapAdditive.generate(loopSum, ctx)).toEqual([]);
      // Not vacuous: the same trigger's SAFE additive (its target never feeds a loop condition)
      // is typed now (R340) and emitted, so this file does carry swap-additive sites.
      const safeSum = nodeOf(root, "additive_expression", safe);
      expect(swapAdditive.targets(safeSum, ctx)).toBe(true);
      expect(swapAdditive.generate(safeSum, ctx).length).toBe(1);
    });
  }

  it("a for loop whose control variable is a trigger parameter: the write is hang-capable", () => {
    const { root, ctx } = load(FOR_PARAM);
    const assignment = nodeOf(root, ALNodeKind.assignment_statement, "Steps := Steps + 1");
    expect(classifyHangCapable(assignment, ctx)).toBe("loop-condition-target");
  });

  // Plan r2 review, Important-1: swap-call-arguments can redirect a `var` write away from the loop's
  // variable (`Dec(Steps, One)` -> `Dec(One, Steps)` compiles and never ends). R340 types these
  // arguments in triggers; the same door was open in procedures.
  const SWAP = `page 50345 "S"
{
    trigger OnNextRecord(Steps: Integer): Integer
    var
        One: Integer;
        A: Integer;
        B: Integer;
        I: Integer;
    begin
        One := 1;
        while Steps > 0 do
            Dec(Steps, One);
        for I := 1 to 3 do
            Inc(I, One);
        Take(A, B);
        exit(Steps);
    end;

    procedure Loop(N: Integer)
    var
        Step: Integer;
    begin
        Step := 1;
        while N > 0 do
            Dec(N, Step);
    end;

    procedure Take(X: Integer; Y: Integer)
    begin
    end;
}`;

  it("swap-call-arguments refuses a swap whose argument a loop reads (trigger parameter, for variable, procedure); a call in no loop still swaps", () => {
    const { root, ctx } = load(SWAP);
    for (const call of ["Dec(Steps, One)", "Inc(I, One)", "Dec(N, Step)"]) {
      const node = nodeOf(root, ALNodeKind.procedure_call, call);
      expect(swapCallArguments.refusesHangCapable?.(node, ctx)).toBe(true);
      expect(swapCallArguments.targets(node, ctx)).toBe(false);
      expect(swapCallArguments.generate(node, ctx)).toEqual([]);
    }
    const free = nodeOf(root, ALNodeKind.procedure_call, "Take(A, B)");
    expect(swapCallArguments.refusesHangCapable?.(free, ctx)).toBe(false);
    expect(swapCallArguments.generate(free, ctx).map((s) => s.after.text)).toEqual(["Take(B, A)"]);
  });

  // Plan r2 review, Minor-1: a field of a record-typed trigger PARAMETER, written in a loop over it.
  // No standard trigger is known to take a Record parameter; the shape is pinned so the member path
  // cannot regress silently.
  it("a member write on a trigger header record parameter in a loop over it is hang-capable", () => {
    const { root, ctx } = load(`page 50346 "M"
{
    trigger OnNextRecord(var P: Record "Some Tab"): Integer
    begin
        while P.Amount < 10 do
            P.Amount := P.Amount + 1;
    end;
}`);
    const assignment = nodeOf(root, ALNodeKind.assignment_statement, "P.Amount := P.Amount + 1");
    expect(classifyHangCapable(assignment, ctx)).toBe("loop-condition-target");
  });

  it("a header-name write in NO loop is not refused (the fallback is not a blanket refusal)", () => {
    const { root, ctx } = load(NO_LOOP);
    const assignment = nodeOf(root, ALNodeKind.assignment_statement, "Steps := Steps - 1");
    expect(classifyHangCapable(assignment, ctx)).toBeNull();
    const sum = nodeOf(root, "additive_expression", "Steps - 1");
    expect(swapAdditive.generate(sum, ctx).length).toBe(1);
  });
});
