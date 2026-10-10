import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import {
  type ALSyntaxNode,
  buildSemanticContext,
  initParser,
  parseAL,
  wrapRoot,
} from "@lethal/engine";
import { openItemHangRefuses, tier1Operators } from "../src/index";
import { r532FeedSeam } from "../src/loop-hazard";

/**
 * R532 (coord task R-532): a FEED of a preset exit name, a same-scope variable whose value flows by
 * name into an assignment to the name, is refused like the write itself (R500 shape 1): the feed,
 * its guard, its enclosing blocks, an early exit before it. Each test is per mutant: the mutant IS
 * emitted with the feeds switched off (`r532FeedSeam.on = false`, which is master's behaviour), and
 * absent with them on. "Emitted" is the orchestrator's dispatch rule: an operator targets the node,
 * generates a mutant, and neither `openItemHangRefuses` nor the operator's own hang check refuses it.
 * The red checks are recorded in /coord/handoff/R-532/build.md.
 */

beforeAll(async () => {
  await initParser();
});

afterEach(() => {
  r532FeedSeam.on = true;
});

/** `Continue` is read by the open `Loop` item's exit guard and never written in open-item code. */
const REP = `report 50532 "Feed Rep"
{
    dataset
    {
        dataitem(Loop; Integer)
        {
            trigger OnAfterGetRecord()
            begin
                if not Continue then
                    CurrReport.Break();
            end;
        }
    }

    procedure CaseAssign()
    var
        Tmp: Boolean;
    begin
        Tmp := Limit > 10;
        Continue := Tmp;
    end;

    procedure CaseTransitive()
    var
        Tmp: Boolean;
        T2: Boolean;
        T3: Boolean;
    begin
        T3 := Limit > 20;
        T2 := T3;
        Tmp := T2;
        Continue := Tmp;
    end;

    procedure CaseGuard()
    var
        Tmp: Boolean;
    begin
        if Limit > 30 then
            Tmp := true;
        Continue := Tmp;
    end;

    procedure CaseVarArg()
    var
        Tmp: Boolean;
    begin
        Compute(Tmp);
        Continue := Tmp;
    end;

    procedure CaseEvaluate()
    var
        Tmp: Boolean;
    begin
        if Txt <> 'yes' then
            Evaluate(Tmp, Txt);
        Continue := Tmp;
    end;

    procedure CaseArray()
    var
        Arr: array[2] of Boolean;
        Y: Boolean;
    begin
        Y := Limit > 60;
        Arr[1] := Y;
        Continue := Arr[1];
    end;

    procedure CaseControl()
    var
        Other: Integer;
    begin
        Other := Limit + 70;
        Message('%1', Other);
        Continue := Limit > 75;
    end;

    local procedure Compute(var B: Boolean)
    begin
        B := Limit > 40;
    end;

    var
        Continue: Boolean;
        Limit: Integer;
        Txt: Text;
}
`;

/** Every `<operator> @ <node text>` the dispatch would emit for REP, with the feeds on or off. */
function emitted(on: boolean): Set<string> {
  r532FeedSeam.on = on;
  const root = wrapRoot(parseAL(REP));
  const ctx = buildSemanticContext([{ path: "FeedRep.Report.al", root }]);
  const out = new Set<string>();
  const walk = (n: ALSyntaxNode): void => {
    for (const op of tier1Operators) {
      if (
        op.targets(n, ctx) &&
        op.generate(n, ctx).length > 0 &&
        !openItemHangRefuses(n, ctx, op.name) &&
        op.refusesHangCapable?.(n, ctx) !== true
      )
        out.add(`${op.name} @ ${n.text}`);
    }
    for (const c of n.namedChildren) walk(c);
  };
  walk(root);
  return out;
}

/** The mutant is emitted with the feeds off and refused with them on. */
function refusedByFeeds(key: string): void {
  expect(emitted(false).has(key)).toBe(true);
  expect(emitted(true).has(key)).toBe(false);
}

describe("R532: same-scope feeds of a preset exit name", () => {
  // red: drop `isFeed` from shape 1's `writes`
  it("an assignment feed (`Tmp := ...; Continue := Tmp`) is refused", () => {
    refusedByFeeds("lethal.remove-assignment @ Tmp := Limit > 10");
    refusedByFeeds("lethal.conditional-boundary @ Limit > 10");
  });

  // red: `r531Feeds` takes one pass only (no fixpoint). Two steps deep, because the names one pass
  // collects already make the NEXT assignment a `directWrite` of a fed name.
  it("a transitive feed (`T3 -> T2 -> Tmp -> Continue`) is refused", () => {
    refusedByFeeds("lethal.remove-assignment @ T3 := Limit > 20");
    refusedByFeeds("lethal.conditional-boundary @ Limit > 20");
    refusedByFeeds("lethal.remove-assignment @ T2 := T3");
    refusedByFeeds("lethal.remove-assignment @ Tmp := T2");
  });

  // red: drop shape 1's guard clause (the condition of a block that holds a write)
  it("the guard of a feed (`if Limit > 30 then Tmp := true`) is refused", () => {
    refusedByFeeds("lethal.conditional-boundary @ Limit > 30");
    refusedByFeeds("lethal.remove-assignment @ Tmp := true");
  });

  // red: drop the `directWrite(n, feeds.names, ctx)` half of `isFeed` (plan r2 F1). Only the call
  // statement is this rule's: the callee's own mutants come from a parameter (class P, closed by
  // ruling in R532) and stay emitted.
  it("a var-argument feed (`Compute(Tmp)`) is refused, the callee is not", () => {
    refusedByFeeds("lethal.void-method-call @ Compute(Tmp)");
    const on = emitted(true);
    expect(on.has("lethal.remove-assignment @ B := Limit > 40")).toBe(true);
    expect(on.has("lethal.conditional-boundary @ Limit > 40")).toBe(true);
  });

  // red: same revert as the var-argument case (`Evaluate` is a writing built-in in `argWritten`)
  it("an `Evaluate(Tmp, S)` feed and its guard are refused", () => {
    refusedByFeeds("lethal.void-method-call @ Evaluate(Tmp, Txt)");
    refusedByFeeds("lethal.negate-conditional @ Txt <> 'yes'");
    refusedByFeeds("lethal.toggle-blank-string @ 'yes'");
  });

  // red: `r531Feeds` matches the target as written, not by `rootName`. `Arr[1] := Y` itself is
  // also a `directWrite` of the fed name `Arr`, so the load-bearing mutants are `Y`'s, one step back.
  it("an array element feed (`Y -> Arr[1] -> Continue`) is refused", () => {
    refusedByFeeds("lethal.remove-assignment @ Arr[1] := Y");
    refusedByFeeds("lethal.remove-assignment @ Y := Limit > 60");
    refusedByFeeds("lethal.conditional-boundary @ Limit > 60");
  });

  // red: treat every same-scope assignment as a feed
  it("CONTROL: a variable that never flows into a preset write is not refused", () => {
    for (const on of [false, true]) {
      const e = emitted(on);
      expect(e.has("lethal.remove-assignment @ Other := Limit + 70")).toBe(true);
      expect(e.has("lethal.swap-additive @ Limit + 70")).toBe(true);
      expect(e.has("lethal.void-method-call @ Message('%1', Other)")).toBe(true);
    }
  });
});
