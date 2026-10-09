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

  it("a header-name write in NO loop is not refused (the fallback is not a blanket refusal)", () => {
    const { root, ctx } = load(NO_LOOP);
    const assignment = nodeOf(root, ALNodeKind.assignment_statement, "Steps := Steps - 1");
    expect(classifyHangCapable(assignment, ctx)).toBeNull();
    const sum = nodeOf(root, "additive_expression", "Steps - 1");
    expect(swapAdditive.generate(sum, ctx).length).toBe(1);
  });
});
