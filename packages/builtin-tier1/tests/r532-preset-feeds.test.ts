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

    procedure CaseParamFeed()
    var
        Tmp: Boolean;
    begin
        Tmp := Limit > 55;
        SetContinue(Tmp);
    end;

    procedure CaseEvaluateArg()
    var
        S: Text;
    begin
        S := 'go';
        Evaluate(Continue, S);
    end;

    procedure CaseWriteTail()
    var
        T: Boolean;
        U: Boolean;
    begin
        T := Limit > 91;
        U := Limit > 92;
        Continue := T
#if not CLEAN25
            or U
#endif
        ;
    end;

    procedure CaseFeedTail()
    var
        V: Boolean;
        W: Boolean;
        X: Boolean;
    begin
        X := Limit > 93;
        V := W
#if not CLEAN25
            or X
#endif
        ;
        Continue := V;
    end;

    procedure CaseClear()
    var
        Tmp: Boolean;
    begin
        Tmp := true;
        if Limit > 80 then
            Clear(Tmp);
        Continue := Tmp;
    end;

    procedure CaseUnknownCallee()
    var
        Tmp: Boolean;
        Ext: Codeunit "Not In Project";
    begin
        if Limit > 85 then
            Ext.Decide(Tmp);
        Continue := Tmp;
    end;

    procedure CaseCommentArg()
    var
        X: Integer;
        Tmp: Boolean;
    begin
        X := Limit + 59;
        Tmp := Limit > 58;
        SetSecond(/* note */ X, Tmp);
    end;

    local procedure SetSecond(N: Integer; B: Boolean)
    begin
        Continue := B;
    end;

    procedure CaseCrossObjectArg()
    var
        H: Integer;
        Ext: Codeunit "Not In Project";
    begin
        H := Limit + 95;
        Ext.Fill(Continue, H);
    end;

    procedure CaseRhsBoundary()
    var
        CustAddr: Integer;
        ShipAddr: Integer;
        Hdr: Integer;
        FormatAddr: Codeunit "Not In Project";
    begin
        FormatAddr.ShipTo(ShipAddr, Hdr);
        Continue := FormatAddr.BillTo(CustAddr, ShipAddr, Hdr);
    end;

    procedure CaseSetterBoundary()
    var
        Hdr: Integer;
        Y: Integer;
        Archive: Codeunit "Not In Project";
    begin
        FillFields(Hdr);
        if Limit > 97 then
            Archive.Store(Hdr, Y);
    end;

    procedure CaseBareRhs()
    var
        Tmp: Boolean;
    begin
        Tmp := Limit > 57;
        Continue := Decide(Tmp);
    end;

    procedure CaseReceiver()
    var
        Probe: Text;
    begin
        Probe := Txt + 'x';
        Continue := Probe.Contains('y');
    end;

    local procedure FillFields(Header: Integer)
    var
        FormatAddr: Codeunit "Not In Project";
    begin
        FormatAddr.Fill(Continue, Header);
    end;

    procedure CaseRecursiveWriter()
    var
        Start: Integer;
    begin
        Start := Limit + 99;
        Bump(Start);
    end;

    local procedure Bump(N: Integer)
    begin
        if N > 0 then
            Bump(N - 1);
        Continue := N > 98;
    end;

    local procedure Decide(B: Boolean): Boolean
    begin
        exit(B);
    end;

    local procedure SetContinue(B: Boolean)
    begin
        Continue := B;
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
function emitted(on: boolean, src = REP): Set<string> {
  r532FeedSeam.on = on;
  const root = wrapRoot(parseAL(src));
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

/** Two writers that call each other (build review r2, finding 1), declared in the given order. */
const cycleRep = (first: "x" | "y"): string => {
  const x = `    procedure SetX(P: Boolean)
    var
        Tmp: Boolean;
    begin
        Tmp := Limit > 56;
        SetY(Tmp);
    end;
`;
  const y = `    procedure SetY(Q: Boolean)
    begin
        Continue := Q;
        if Limit > 0 then
            SetX(Q);
    end;
`;
  return `report 50533 "Cycle Rep"
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

${first === "x" ? x + y : y + x}
    var
        Continue: Boolean;
        Limit: Integer;
}
`;
};

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

  // red: drop the call-argument seeding from `presetFeeds` (review r1 finding 2)
  it("a same-object parameter feed (`Tmp := ...; SetContinue(Tmp)`) is refused", () => {
    refusedByFeeds("lethal.remove-assignment @ Tmp := Limit > 55");
    refusedByFeeds("lethal.conditional-boundary @ Limit > 55");
  });

  // red: same revert as the parameter feed
  it("an argument feed of a preset write (`S := ...; Evaluate(Continue, S)`) is refused", () => {
    refusedByFeeds("lethal.remove-assignment @ S := 'go'");
  });

  // red: drop `exprTails(n)` from `presetFeeds`' preset-write seeds
  it("a feed read only in an `#if` tail of the preset write is refused", () => {
    refusedByFeeds("lethal.remove-assignment @ U := Limit > 92");
    refusedByFeeds("lethal.conditional-boundary @ Limit > 92");
  });

  // red: drop the `exprTails(a)` collection under `fed` in `r531Feeds`
  it("a feed read only in an `#if` tail of another feed is refused", () => {
    refusedByFeeds("lethal.remove-assignment @ X := Limit > 93");
    refusedByFeeds("lethal.conditional-boundary @ Limit > 93");
  });

  // red: drop the `directWrite(n, feeds.names, ctx)` half of `isFeed`
  it("a `Clear(Tmp)` feed and its guard are refused", () => {
    refusedByFeeds("lethal.conditional-boundary @ Limit > 80");
  });

  // red: same revert as `Clear` (an unresolved callee counts as writing its arguments)
  it("an unknown-callee feed (`Ext.Decide(Tmp)`) and its guard are refused", () => {
    refusedByFeeds("lethal.conditional-boundary @ Limit > 85");
  });

  // red: seed every argument of a preset-writing call, `Obj.Proc(...)` included (drop the
  // `bareCallee` condition in `presetFeeds`). This is the ruling's boundary: a value that reaches
  // the name through another object's function is the cross-object part R532 closed.
  it("BOUNDARY: the other arguments of a cross-object preset-writing call are not feeds", () => {
    expect(emitted(true).has("lethal.void-method-call @ Ext.Fill(Continue, H)")).toBe(false);
    for (const on of [false, true]) {
      const e = emitted(on);
      expect(e.has("lethal.remove-assignment @ H := Limit + 95")).toBe(true);
      expect(e.has("lethal.swap-additive @ Limit + 95")).toBe(true);
    }
  });

  // red: drop the non-bare-call branch from `r531Feeds`' `collect` (leak 1: `ShipAddr` and `Hdr`,
  // read only as arguments of `FormatAddr.BillTo`, become fed and the `ShipTo` call is refused)
  it("BOUNDARY-RHS: an argument of `Obj.Proc(...)` in a preset write's right side is not a feed", () => {
    for (const on of [false, true]) {
      const e = emitted(on);
      expect(e.has("lethal.void-method-call @ FormatAddr.ShipTo(ShipAddr, Hdr)")).toBe(true);
    }
  });

  // red: seed every argument of a same-object preset-writer call (`writerFedArgs` answers true;
  // leak 2: `Hdr` becomes fed and `Archive.Store(Hdr, Y)` is a var-arg feed of an unknown callee)
  it("BOUNDARY-SETTER: a parameter a writer only hands to `Obj.Proc(...)` is not a feed", () => {
    for (const on of [false, true]) {
      const e = emitted(on);
      expect(e.has("lethal.void-method-call @ Archive.Store(Hdr, Y)")).toBe(true);
      expect(e.has("lethal.conditional-boundary @ Limit > 97")).toBe(true);
      // the setter's own preset write stays refused (a write, not a feed)
      expect(e.has("lethal.void-method-call @ FormatAddr.Fill(Continue, Header)")).toBe(false);
    }
  });

  // red: skip the arguments of EVERY call in `r531Feeds`' `collect`, bare ones included
  it("a bare same-object call in the right side still feeds (`Continue := Decide(Tmp)`)", () => {
    refusedByFeeds("lethal.remove-assignment @ Tmp := Limit > 57");
    refusedByFeeds("lethal.conditional-boundary @ Limit > 57");
  });

  // red: drop the receiver (`collect(f)`) from the non-bare-call branch of `r531Feeds`' `collect`
  it("the receiver of a non-bare call in the right side still feeds (`Probe.Contains`)", () => {
    refusedByFeeds("lethal.remove-assignment @ Probe := Txt + 'x'");
  });

  // red: drop the `r532Reading` check in `presetFeeds` (the writer reads itself without end)
  it("a self-recursive writer's parameter feed (`Bump(Start)`) is refused without looping", () => {
    refusedByFeeds("lethal.remove-assignment @ Start := Limit + 99");
  });

  // red: treat every same-scope assignment as a feed
  // red: cache every `presetFeeds` result, nested ones included (drop the `outermost` condition).
  // With SetY declared first, SetX is then cached while SetY is in progress, without `Tmp`.
  it("two writers that call each other refuse the same feed in either declaration order", () => {
    for (const first of ["x", "y"] as const) {
      expect(
        emitted(false, cycleRep(first)).has("lethal.remove-assignment @ Tmp := Limit > 56"),
      ).toBe(true);
      const on = emitted(true, cycleRep(first));
      expect(on.has("lethal.remove-assignment @ Tmp := Limit > 56")).toBe(false);
      expect(on.has("lethal.conditional-boundary @ Limit > 56")).toBe(false);
    }
  });

  // red: read the writer call's arguments as raw named children (a comment then shifts positions)
  it("a comment in a setter call's arguments does not shift which argument is fed (R567)", () => {
    refusedByFeeds("lethal.remove-assignment @ Tmp := Limit > 58");
    for (const on of [false, true])
      expect(emitted(on).has("lethal.remove-assignment @ X := Limit + 59")).toBe(true);
  });

  it("CONTROL: a variable that never flows into a preset write is not refused", () => {
    for (const on of [false, true]) {
      const e = emitted(on);
      expect(e.has("lethal.remove-assignment @ Other := Limit + 70")).toBe(true);
      expect(e.has("lethal.swap-additive @ Limit + 70")).toBe(true);
      expect(e.has("lethal.void-method-call @ Message('%1', Other)")).toBe(true);
    }
  });
});
