import { beforeAll, describe, expect, it } from "bun:test";
import {
  type ALSyntaxNode,
  buildSemanticContext,
  initParser,
  parseAL,
  visit,
  wrapRoot,
} from "@lethal/engine";
import { openItemHangRefuses } from "../src/index";

/**
 * R570 (coord task R-570): a `while`/`repeat` loop of any object kind whose exit calls a
 * cursor-shaped procedure in ANOTHER project object refuses every site in that procedure, and in
 * every procedure its `exit(<call>)` delegation chain reaches (up to 4 hops). Each site is checked
 * through a unique text literal marker inside the procedure. Every test was red-checked one
 * direction at a time; the red checks are recorded in `/coord/handoff/R-570/redcheck.md`.
 */

beforeAll(async () => {
  await initParser();
});

const VMC = "lethal.void-method-call";
const PRAGMA = "#pragma warning disable AA0001";

function project(files: Record<string, string>) {
  const parsed = Object.entries(files).map(([path, src]) => ({
    path,
    root: wrapRoot(parseAL(src)),
  }));
  const ctx = buildSemanticContext(parsed);
  const find = (path: string, text: string): ALSyntaxNode => {
    const f = parsed.find((p) => p.path === path);
    if (f === undefined) throw new Error(`no file ${path}`);
    let hit: ALSyntaxNode | undefined;
    visit(f.root, (n: ALSyntaxNode) => {
      if (hit === undefined && n.text === text) hit = n;
    });
    if (hit === undefined) throw new Error(`${text} not found in ${path}`);
    return hit;
  };
  /** Is the marker literal `'<tag>'` in `path` refused? */
  return (path: string, tag: string): boolean =>
    openItemHangRefuses(find(path, `'${tag}'`), ctx, VMC);
}

const ITEM = `table 50700 "R570 Item"
{
    fields
    {
        field(1; "No."; Code[20]) { }
        field(2; Qty; Integer) { }
    }

    procedure CheckValid(): Boolean
    var
        Other: Record "R570 Item";
        Tag: Text;
    begin
        Tag := 'TABLEPROC';
        Other.SetRange(Qty, 0);
        exit(Other.IsEmpty());
    end;

    procedure NextBare(): Boolean
    var
        Other: Record "R570 Item";
        Tag: Text;
    begin
        Tag := 'BARE';
        exit(Other.FindFirst());
    end;

    procedure DrainStack()
    var
        Stack: Codeunit "R570 Stack";
        V: Integer;
    begin
        while Stack.PopT(V) do
            Qty += V;
    end;
}
`;

const OTHER = `table 50701 "R570 Other"
{
    fields
    {
        field(1; Code; Code[20]) { }
    }
}
`;

const FEFO = `codeunit 50700 "R570 Fefo"
{
    procedure FindNextEntry(var Ent: Record "R570 Item"): Boolean
    begin
        Tag := 'COND';
        if Ent.Next() = 0 then
            exit(false);
        exit(true);
    end;

    procedure FindNextMixed(var Ent: Record "R570 Item"): Boolean
    begin
        Tag := 'MIXED';
        if Ent.Next() = 0 then
            exit(false);
        exit(Ent.Qty > 1);
    end;

    procedure IsBig(Q: Integer): Boolean
    begin
        Tag := 'PLAIN';
        Buf.TestField(Qty);
        exit(Q > 10);
    end;

    procedure Spin(): Boolean
    var
        I: Integer;
    begin
        Tag := 'LOOPED';
        while I < 3 do
            I += 1;
        exit(I > Cnt);
    end;

    procedure NoParen(): Boolean
    begin
        Tag := 'NOPAREN';
        exit(Buf.FindSet());
    end;

    procedure NextBreak(): Boolean
    begin
        Tag := 'BREAK';
        exit(Buf.FindFirst());
    end;

    procedure NextExit(): Boolean
    begin
        Tag := 'EXIT';
        exit(Buf.FindLast());
    end;

    procedure NextError(): Boolean
    begin
        Tag := 'ERROR';
        exit(Buf.IsEmpty());
    end;

    procedure NextInner(): Boolean
    begin
        Tag := 'INNER';
        exit(Buf.Count() > 0);
    end;

    procedure IsValid(R: Record "R570 Item"): Boolean
    begin
        Tag := 'BYVALUE';
        exit(R.FindFirst());
    end;

    procedure IsValidVar(var R: Record "R570 Item"): Boolean
    begin
        Tag := 'BYVAR';
        exit(R.FindFirst());
    end;

    procedure Pick(var R: Record "R570 Item"): Boolean
    begin
        Tag := 'OV1';
        exit(R.Next() <> 0);
    end;

    procedure Pick(var R: Record "R570 Other"; X: Integer): Boolean
    begin
        Tag := 'OV2';
        exit(X > 0);
    end;

    procedure Pragma(var R: Record "R570 Item"; Q: Integer): Boolean
    begin
        Tag := 'PRAGMA';
        exit(R.Next() <> Q);
    end;

    procedure SelfLoop()
    var
        Q: Integer;
    begin
        while SelfNext() do
            Q += 1;
    end;

    local procedure SelfNext(): Boolean
    begin
        Tag := 'SELF';
        exit(Buf.Next() <> 0);
    end;

    var
        Buf: Record "R570 Item";
        Tag: Text;
        Cnt: Integer;
}
`;

const LOOPS = `codeunit 50701 "R570 Loops"
{
    procedure RunCond()
    begin
        repeat
            Q += 1;
        until not Fefo.FindNextEntry(Ent);
    end;

    procedure RunMixed()
    begin
        repeat
            Q -= 1;
        until (not Fefo.FindNextMixed(Ent)) or (Q = 0);
    end;

    procedure RunPlain()
    begin
        while not Fefo.IsBig(Q) do
            Q += 1;
    end;

    procedure RunSpin()
    begin
        while Fefo.Spin() do
            Q += 1;
    end;

    procedure RunNoParen()
    begin
        while Fefo.NoParen do
            Q += 1;
    end;

    procedure RunBreak()
    begin
        while true do begin
            if not Fefo.NextBreak() then
                break;
            Q += 1;
        end;
    end;

    procedure RunExit()
    begin
        while true do begin
            if not Fefo.NextExit() then
                exit;
            Q += 1;
        end;
    end;

    procedure RunError()
    begin
        while true do begin
            if not Fefo.NextError() then
                Error('stop');
            Q += 1;
        end;
    end;

    procedure RunInner()
    begin
        while Q < 10 do begin
            Q += 1;
            repeat
                if not Fefo.NextInner() then
                    break;
            until Ent.Next() = 0;
        end;
    end;

    procedure RunByValue()
    begin
        repeat
            if not Fefo.IsValid(Ent) then
                exit;
        until Ent.Next() = 0;
    end;

    procedure RunByVar()
    begin
        repeat
            if not Fefo.IsValidVar(Ent) then
                exit;
        until Ent.Next() = 0;
    end;

    procedure RunTableProc()
    begin
        repeat
            if not Ent.CheckValid() then
                exit;
        until Ent.Next() = 0;
    end;

    procedure RunOverload()
    begin
        while Fefo.Pick(Ent) do
            Q += 1;
    end;

    procedure RunPragma()
    begin
        repeat
            Q += 1;
        until not Fefo.Pragma(Ent,
${PRAGMA}
            Q);
    end;

    procedure RunChain()
    begin
        repeat
            Q += 1;
        until Wrap.GetNextAcc() = 0;
    end;

    procedure RunPriceWrap()
    begin
        while PW.NextW() do
            Q += 1;
    end;

    procedure RunHops()
    begin
        while Hops.P0() do
            Q += 1;
        while Hops.Q0() do
            Q += 1;
    end;

    procedure RunCycle()
    begin
        repeat
            Q += 1;
        until Cyc.C1() = 0;
        repeat
            Q += 1;
        until Cyc.C3() = 0;
    end;

    procedure RunIface()
    begin
        while It.MoveNext() do
            Q += 1;
    end;

    var
        Fefo: Codeunit "R570 Fefo";
        Wrap: Codeunit "R570 Wrap";
        PW: Codeunit "R570 PriceWrap";
        Hops: Codeunit "R570 Hops";
        Cyc: Codeunit "R570 Cycle";
        It: Interface "R570 Iter";
        Ent: Record "R570 Item";
        Q: Integer;
}
`;

const WRAP = `codeunit 50702 "R570 Wrap"
{
    procedure GetNextAcc(): Integer
    var
        Tag: Text;
    begin
        Tag := 'WRAP';
        exit(Mid.GetNextAcc());
    end;

    var
        Mid: Codeunit "R570 Mid";
}
`;

const MID = `codeunit 50703 "R570 Mid"
{
    procedure GetNextAcc(): Integer
    begin
        Tag := 'MID';
        exit(LocalNext());
    end;

    local procedure LocalNext(): Integer
    begin
        Tag := 'MIDLOCAL';
        exit(Leaf.GetNextAcc());
    end;

    var
        Leaf: Codeunit "R570 Leaf";
        Tag: Text;
}
`;

const LEAF = `codeunit 50704 "R570 Leaf"
{
    procedure GetNextAcc(): Integer
    var
        Tag: Text;
    begin
        Tag := 'LEAF';
        if GL.Next() = 0 then
            exit(0);
        exit(1);
    end;

    var
        GL: Record "R570 Item";
}
`;

const PRICE = `codeunit 50705 "R570 PriceList"
{
    procedure Next(): Boolean
    var
        Tag: Text;
    begin
        Tag := 'PLNEXT';
        Idx += 1;
        exit(Idx <= Lines.Count());
    end;

    var
        Lines: List of [Text];
        Idx: Integer;
}
`;

const PRICEWRAP = `codeunit 50706 "R570 PriceWrap"
{
    procedure NextW(): Boolean
    var
        Tag: Text;
    begin
        Tag := 'PWRAP';
        exit(PL.Next());
    end;

    var
        PL: Codeunit "R570 PriceList";
}
`;

const HOPS = `codeunit 50707 "R570 Hops"
{
    procedure P0(): Boolean
    begin
        Tag := 'HOP0';
        exit(P1());
    end;

    local procedure P1(): Boolean
    begin
        exit(P2());
    end;

    local procedure P2(): Boolean
    begin
        exit(P3());
    end;

    local procedure P3(): Boolean
    begin
        exit(P4());
    end;

    local procedure P4(): Boolean
    begin
        exit(P5());
    end;

    local procedure P5(): Boolean
    begin
        Tag := 'HOP5';
        exit(Buf.Next() <> 0);
    end;

    procedure Q0(): Boolean
    begin
        Tag := 'QOP0';
        exit(Q1());
    end;

    local procedure Q1(): Boolean
    begin
        exit(Q2());
    end;

    local procedure Q2(): Boolean
    begin
        exit(Q3());
    end;

    local procedure Q3(): Boolean
    begin
        exit(Q4());
    end;

    local procedure Q4(): Boolean
    begin
        Tag := 'QOP4';
        exit(Buf.Next() <> 0);
    end;

    var
        Buf: Record "R570 Item";
        Tag: Text;
}
`;

const CYCLE = `codeunit 50708 "R570 Cycle"
{
    procedure C1(): Integer
    begin
        Tag := 'CYC1';
        exit(C2());
    end;

    local procedure C2(): Integer
    begin
        Tag := 'CYC2';
        exit(C1());
    end;

    procedure C3(): Integer
    begin
        Tag := 'CYC3';
        exit(C4());
    end;

    local procedure C4(): Integer
    begin
        Tag := 'CYC4';
        if Buf.Next() = 0 then
            exit(0);
        exit(C3());
    end;

    var
        Buf: Record "R570 Item";
        Tag: Text;
}
`;

const ITER = `interface "R570 Iter"
{
    procedure MoveNext(): Boolean;
}
`;

const ITERIMPL = `codeunit 50709 "R570 IterImpl" implements "R570 Iter"
{
    procedure MoveNext(): Boolean
    var
        Tag: Text;
    begin
        Tag := 'IMPL';
        exit(Buf.Next() <> 0);
    end;

    var
        Buf: Record "R570 Item";
}
`;

const STACK = `codeunit 50710 "R570 Stack"
{
    procedure PopT(var V: Integer): Boolean
    begin
        Tag := 'POPT';
        exit(Pop(V));
    end;

    procedure PopP(var V: Integer): Boolean
    begin
        Tag := 'POPP';
        exit(Pop(V));
    end;

    procedure PopQ(var V: Integer): Boolean
    begin
        Tag := 'POPQ';
        exit(Pop(V));
    end;

    procedure PopR(var V: Integer): Boolean
    begin
        Tag := 'POPR';
        exit(Pop(V));
    end;

    local procedure Pop(var V: Integer): Boolean
    begin
        if not Buf.FindLast() then
            exit(false);
        V := Buf.Qty;
        Buf.Delete();
        exit(true);
    end;

    var
        Buf: Record "R570 Item";
        Tag: Text;
}
`;

const PAGE = `page 50700 "R570 Page"
{
    SourceTable = "R570 Item";

    trigger OnOpenPage()
    var
        Stack: Codeunit "R570 Stack";
        V: Integer;
    begin
        while Stack.PopP(V) do
            V += 1;
        while NextBare() do
            V += 1;
    end;
}
`;

const REPORT = `report 50700 "R570 Report"
{
    dataset
    {
        dataitem(One; Integer)
        {
            MaxIteration = 1;
            trigger OnAfterGetRecord()
            var
                Stack: Codeunit "R570 Stack";
                V: Integer;
            begin
                Stack.PopR(V);
                while Stack.PopQ(V) do
                    N += 1;
            end;
        }
    }

    var
        N: Integer;
}
`;

const FILES: Record<string, string> = {
  "Item.Table.al": ITEM,
  "Other.Table.al": OTHER,
  "Fefo.Codeunit.al": FEFO,
  "Loops.Codeunit.al": LOOPS,
  "Wrap.Codeunit.al": WRAP,
  "Mid.Codeunit.al": MID,
  "Leaf.Codeunit.al": LEAF,
  "Price.Codeunit.al": PRICE,
  "PriceWrap.Codeunit.al": PRICEWRAP,
  "Hops.Codeunit.al": HOPS,
  "Cycle.Codeunit.al": CYCLE,
  "Iter.Interface.al": ITER,
  "IterImpl.Codeunit.al": ITERIMPL,
  "Stack.Codeunit.al": STACK,
  "Page.Page.al": PAGE,
  "Report.Report.al": REPORT,
};

const F = "Fefo.Codeunit.al";

describe("R570: the loop's own condition calls a cursor procedure in another object", () => {
  it("`until not Other.FindNextEntry(...)`: the callee is refused", () => {
    expect(project(FILES)(F, "COND")).toBe(true);
  });
  it("a mixed condition (FEFO's `or Qty = 0`) still refuses the callee", () => {
    expect(project(FILES)(F, "MIXED")).toBe(true);
  });
  it("a callee with no Find/Next/IsEmpty/Count and no loop is NOT refused", () => {
    expect(project(FILES)(F, "PLAIN")).toBe(false);
  });
  it("a callee holding a loop (and no cursor method) is refused", () => {
    expect(project(FILES)(F, "LOOPED")).toBe(true);
  });
  it("a paren-less member call (`Fefo.NoParen`) finds its callee", () => {
    expect(project(FILES)(F, "NOPAREN")).toBe(true);
  });
  it("a bare call on a page's implicit Rec finds the table procedure", () => {
    expect(project(FILES)("Item.Table.al", "BARE")).toBe(true);
  });
  it("a same-object callee is NOT refused (another object only)", () => {
    expect(project(FILES)(F, "SELF")).toBe(false);
  });
});

describe("R570: a body exit guard, when the condition steps no cursor", () => {
  it("`then break` of this loop: refused", () => {
    expect(project(FILES)(F, "BREAK")).toBe(true);
  });
  it("`then exit`: refused", () => {
    expect(project(FILES)(F, "EXIT")).toBe(true);
  });
  it("`then Error(...)`: refused", () => {
    expect(project(FILES)(F, "ERROR")).toBe(true);
  });
  it("a `break` of an INNER loop does not count for the outer loop: NOT refused", () => {
    expect(project(FILES)(F, "INNER")).toBe(false);
  });
});

describe("R570: a guard while the condition steps its own cursor", () => {
  it("the cursor record passed BY VALUE: NOT refused (the callee can only end the loop earlier)", () => {
    expect(project(FILES)(F, "BYVALUE")).toBe(false);
  });
  it("the cursor record passed to a `var` parameter: refused", () => {
    expect(project(FILES)(F, "BYVAR")).toBe(true);
  });
  it("a table procedure ON the cursor record (`Ent.CheckValid()`): refused", () => {
    expect(project(FILES)("Item.Table.al", "TABLEPROC")).toBe(true);
  });
});

describe("R570: overloads and an uncertain call", () => {
  it("the overload the call picks is refused", () => {
    expect(project(FILES)(F, "OV1")).toBe(true);
  });
  it("matching is by name: every overload of that name is refused", () => {
    expect(project(FILES)(F, "OV2")).toBe(true);
  });
  it("a call with a #pragma among its arguments (uncertain arity) still finds its callee", () => {
    expect(project(FILES)(F, "PRAGMA")).toBe(true);
  });
  it("an interface call reaches the implementing codeunit", () => {
    expect(project(FILES)("IterImpl.Codeunit.al", "IMPL")).toBe(true);
  });
});

describe("R570: the `exit(<call>)` delegation chain", () => {
  it("the first link (GetNextGLAcc's shape) is refused", () => {
    expect(project(FILES)("Wrap.Codeunit.al", "WRAP")).toBe(true);
  });
  it("the middle link and its same-object hop are refused", () => {
    const at = project(FILES);
    expect(at("Mid.Codeunit.al", "MID")).toBe(true);
    expect(at("Mid.Codeunit.al", "MIDLOCAL")).toBe(true);
  });
  it("the cursor-shaped end is refused", () => {
    expect(project(FILES)("Leaf.Codeunit.al", "LEAF")).toBe(true);
  });
  it("a wrapper over a `Next`-named PROJECT procedure: the real `Next` is refused too", () => {
    const at = project(FILES);
    expect(at("PriceWrap.Codeunit.al", "PWRAP")).toBe(true);
    expect(at("Price.Codeunit.al", "PLNEXT")).toBe(true);
  });
  it("a chain whose cursor is 4 hops away is followed", () => {
    const at = project(FILES);
    expect(at("Hops.Codeunit.al", "QOP0")).toBe(true);
    expect(at("Hops.Codeunit.al", "QOP4")).toBe(true);
  });
  it("a chain whose cursor is 5 hops away is NOT followed", () => {
    const at = project(FILES);
    expect(at("Hops.Codeunit.al", "HOP0")).toBe(false);
    expect(at("Hops.Codeunit.al", "HOP5")).toBe(false);
  });
  it("a cycle with no cursor ends and refuses nothing", () => {
    const at = project(FILES);
    expect(at("Cycle.Codeunit.al", "CYC1")).toBe(false);
    expect(at("Cycle.Codeunit.al", "CYC2")).toBe(false);
  });
  it("a cycle through a cursor-shaped procedure refuses both", () => {
    const at = project(FILES);
    expect(at("Cycle.Codeunit.al", "CYC3")).toBe(true);
    expect(at("Cycle.Codeunit.al", "CYC4")).toBe(true);
  });
});

describe("R570: every object kind", () => {
  it("a table procedure's loop refuses its callee", () => {
    expect(project(FILES)("Stack.Codeunit.al", "POPT")).toBe(true);
  });
  it("a page trigger's loop refuses its callee", () => {
    expect(project(FILES)("Stack.Codeunit.al", "POPP")).toBe(true);
  });
  it("a loop inside a BOUNDED report item's trigger refuses its callee (R570 applies in report items)", () => {
    expect(project(FILES)("Stack.Codeunit.al", "POPQ")).toBe(true);
  });
  it("a bounded report item's plain (non-loop) callee stays deployed: R500's own rule is unchanged", () => {
    expect(project(FILES)("Stack.Codeunit.al", "POPR")).toBe(false);
  });
});
