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
        field(3; Note; Text[50]) { }
        field(4; Grp; Code[10]) { }
    }

    keys
    {
        key(PK; "No.") { Clustered = true; }
        key(ByQty; Qty) { }
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

    procedure ReadOnly(): Boolean
    var
        Tag: Text;
    begin
        Tag := 'ROTAB';
        TestField(Qty);
        exit(Qty > 0);
    end;

    procedure StepNext(): Boolean
    var
        Tag: Text;
    begin
        Tag := 'NEXTTAB';
        exit(Next() <> 0);
    end;

    procedure DropIt(): Boolean
    var
        Tag: Text;
    begin
        Tag := 'DELTAB';
        Delete();
        exit(true);
    end;

    procedure WriteNote(): Boolean
    var
        Tag: Text;
    begin
        Tag := 'NONKEYW';
        Note := 'x';
        exit(true);
    end;

    procedure WriteKey(): Boolean
    var
        Tag: Text;
    begin
        Tag := 'KEYW';
        "No." := 'X';
        exit(true);
    end;

    procedure WriteGrpModify(): Boolean
    var
        Tag: Text;
    begin
        Tag := 'FILTMOD';
        Grp := 'B';
        Modify();
        exit(true);
    end;

    procedure WriteGrpNoModify(): Boolean
    var
        Tag: Text;
    begin
        Tag := 'FILTNOMOD';
        Grp := 'B';
        exit(true);
    end;

    procedure WriteNoteModify(): Boolean
    var
        Tag: Text;
    begin
        Tag := 'NOTEMOD';
        Note := 'z';
        Modify();
        exit(true);
    end;

    procedure WriteNoteModifyTrue(): Boolean
    var
        Tag: Text;
    begin
        Tag := 'MODTRUE';
        Note := 'q';
        Modify(true);
        exit(true);
    end;

    procedure SplitDone(): Boolean
    var
        Tag: Text;
    begin
        Tag := 'SPLIT1';
        MarkDone();
        Close();
        exit(true);
    end;

    local procedure MarkDone()
    var
        Tag: Text;
    begin
        Tag := 'MARKDONE';
        Grp := 'D';
    end;

    local procedure Close()
    begin
        Modify();
    end;

    procedure SplitSave(): Boolean
    var
        Tag: Text;
    begin
        Tag := 'SPLIT2';
        CloseGrp();
        Save();
        exit(true);
    end;

    local procedure CloseGrp()
    begin
        Grp := 'C';
    end;

    local procedure Save()
    begin
        Modify();
    end;

    procedure FieldWrite(): Boolean
    var
        Tag: Text;
    begin
        Tag := 'FIELDW';
        Qty := 0;
        exit(true);
    end;

    procedure GlobalFn(): Boolean
    var
        Tag: Text;
    begin
        Tag := 'GLOBALFN';
        Commit();
        exit(Qty > 0);
    end;

    procedure ViaHelper(): Boolean
    var
        Tag: Text;
    begin
        Tag := 'HELPTAB';
        exit(InnerStep());
    end;

    local procedure InnerStep(): Boolean
    begin
        exit(Rec.Next() <> 0);
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

    procedure NextHop(): Boolean
    begin
        Tag := 'NEXTHOP';
        exit(Buf.Next() <> 0);
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

    procedure ReadVar(var R: Record "R570 Item"): Boolean
    begin
        Tag := 'ROVAR';
        exit(R.Qty > 0);
    end;

    procedure NextVar(var R: Record "R570 Item"): Boolean
    begin
        Tag := 'NEXTVAR';
        exit(R.Next() <> 0);
    end;

    procedure NextVarHelp(var R: Record "R570 Item"): Boolean
    begin
        Tag := 'VARHELP';
        exit(StepIt(R));
    end;

    local procedure StepIt(var R2: Record "R570 Item"): Boolean
    begin
        exit(R2.Next() <> 0);
    end;

    procedure PassOn(var R: Record "R570 Item"): Boolean
    begin
        Tag := 'UNRES';
        exit(Ext.Unknown(R));
    end;

    procedure NextRecNamed(var Rec: Record "R570 Item"): Boolean
    begin
        Tag := 'RECNAMED';
        exit(Rec.Next() <> 0);
    end;

    procedure Passer(var R: Record "R570 Item"): Boolean
    begin
        Tag := 'PASSER';
        Adv.Advance(R);
        exit(true);
    end;

    procedure FieldWriteVar(var R: Record "R570 Item"): Boolean
    begin
        Tag := 'FIELDWV';
        R.Qty := 0;
        exit(true);
    end;

    procedure TfInto(var R: Record "R570 Item"): Boolean
    var
        Other: Record "R570 Item";
    begin
        Tag := 'TFINTO';
        R.TransferFields(Other);
        exit(true);
    end;

    procedure TfFrom(var R: Record "R570 Item"): Boolean
    var
        Other: Record "R570 Item";
    begin
        Tag := 'TFFROM';
        Other.TransferFields(R);
        exit(true);
    end;

    procedure CopyShare(var R: Record "R570 Item"): Boolean
    var
        Other: Record "R570 Item";
    begin
        Tag := 'COPYSHARE';
        Other.Copy(R, true);
        exit(true);
    end;

    procedure CopyInto(var R: Record "R570 Item"): Boolean
    var
        Other: Record "R570 Item";
    begin
        Tag := 'COPYINTO';
        Other.Copy(R);
        exit(true);
    end;

    procedure GetTab(var R: Record "R570 Item"): Boolean
    var
        RecRef: RecordRef;
    begin
        Tag := 'GETTABLE';
        RecRef.GetTable(R);
        exit(true);
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
        Ext: Codeunit "R570 Not In Project";
        Adv: Codeunit "R570 Adv";
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
            if not Ent.ReadOnly() then
                exit;
            if not Ent.StepNext() then
                exit;
            if not Ent.DropIt() then
                exit;
            if not Ent.ViaHelper() then
                exit;
            if not Fefo.ReadVar(Ent) then
                exit;
            if not Fefo.NextVar(Ent) then
                exit;
            if not Fefo.NextVarHelp(Ent) then
                exit;
            if not Fefo.PassOn(Ent) then
                exit;
            if not Fefo.NextRecNamed(Ent) then
                exit;
            if not Fefo.Passer(Ent) then
                exit;
            if not Fefo.FieldWriteVar(Ent) then
                exit;
            if not Fefo.TfInto(Ent) then
                exit;
            if not Fefo.TfFrom(Ent) then
                exit;
            if not Fefo.CopyShare(Ent) then
                exit;
            if not Fefo.CopyInto(Ent) then
                exit;
            if not Fefo.GetTab(Ent) then
                exit;
            if not Ent.FieldWrite() then
                exit;
            if not Ent.GlobalFn() then
                exit;
            if not Deep.RoSix(Ent) then
                exit;
            if not Deep.NextSix(Ent) then
                exit;
            if not Deep.DelSix(Ent) then
                exit;
            if not Deep.RoNine(Ent) then
                exit;
            if not Deep.CycRo(Ent) then
                exit;
            if not Deep.CycTouch(Ent) then
                exit;
        until Ent.Next() = 0;
    end;

    procedure RunExt()
    var
        Cust: Record Customer;
    begin
        repeat
            if not Cust.ExtBare() then
                exit;
            if not Cust.ExtRec() then
                exit;
            if not Cust.ExtWrite() then
                exit;
        until Cust.Next() = 0;
    end;

    procedure RunFiltered()
    var
        L: Record "R570 Item";
    begin
        L.SetRange(Grp, 'A');
        if L.FindSet() then
            repeat
                if not L.WriteNote() then
                    exit;
                if not L.WriteKey() then
                    exit;
                if not L.WriteGrpModify() then
                    exit;
                if not L.WriteGrpNoModify() then
                    exit;
                if not L.WriteNoteModify() then
                    exit;
                if not L.WriteNoteModifyTrue() then
                    exit;
            until L.Next() = 0;
    end;

    procedure RunSplit()
    var
        L2: Record "R570 Item";
    begin
        L2.SetRange(Grp, 'A');
        if L2.FindSet() then
            repeat
                if not L2.SplitDone() then
                    exit;
                if not L2.SplitSave() then
                    exit;
            until L2.Next() = 0;
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

    procedure RunLocalHop()
    begin
        repeat
            Q += 1;
        until not LocalNext();
        while not LocalPlain() do
            Q += 1;
    end;

    local procedure LocalNext(): Boolean
    var
        Tag: Text;
    begin
        Tag := 'LOCALHOP';
        exit(Fefo.NextHop());
    end;

    local procedure LocalPlain(): Boolean
    var
        Tag: Text;
    begin
        Tag := 'LOCALPLAIN';
        exit(Fefo.IsBig(Q));
    end;

    var
        Fefo: Codeunit "R570 Fefo";
        Deep: Codeunit "R570 Deep";
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

const ADV = `codeunit 50711 "R570 Adv"
{
    procedure Advance(var R: Record "R570 Item"): Boolean
    var
        Tag: Text;
    begin
        Tag := 'ADVANCE';
        exit(R.Find('-'));
    end;
}
`;

const CUSTEXT = `tableextension 50700 "R570 CustExt" extends Customer
{
    procedure ExtBare(): Boolean
    var
        Tag: Text;
    begin
        Tag := 'EXTBARE';
        exit(CheckCredit());
    end;

    procedure ExtRec(): Boolean
    var
        Tag: Text;
    begin
        Tag := 'EXTREC';
        exit(Rec.CheckCredit());
    end;

    procedure ExtWrite(): Boolean
    var
        Tag: Text;
    begin
        Tag := 'EXTWRITE';
        "Name 2" := 'x';
        exit(true);
    end;
}
`;

const R531_RECKEY = `codeunit 50720 "R570 R531 RecKey"
{
    procedure DrainA()
    var
        Ent: Record "R570 Item";
    begin
        while not Ent.IsEmpty() do
            EatRec(Ent);
    end;

    procedure DrainB()
    var
        Ent: Record "R570 Item";
    begin
        while not Ent.IsEmpty() do
            EatR(Ent);
    end;

    local procedure EatRec(var Rec: Record "R570 Item")
    begin
        Rec.Delete();
    end;

    local procedure EatR(var R: Record "R570 Item")
    begin
        R.Delete();
    end;
}
`;

/** A same-object chain `<p> -> <p>1 -> ... -> <p><n>` handing the record on by `var`; `<p><n>`
 *  runs `last` on it. The entry procedure carries the marker `tag`. */
const chain = (p: string, n: number, tag: string, last: string): string => {
  const procs = [
    `    procedure ${p}(var R: Record "R570 Item"): Boolean
    begin
        Tag := '${tag}';
        ${p}1(R);
        exit(true);
    end;
`,
  ];
  for (let i = 1; i < n; i++)
    procs.push(`    local procedure ${p}${i}(var R: Record "R570 Item")
    begin
        ${p}${i + 1}(R);
    end;
`);
  procs.push(`    local procedure ${p}${n}(var R: Record "R570 Item")
    begin
        ${last}
    end;
`);
  return procs.join("\n");
};

const DEEP = `codeunit 50712 "R570 Deep"
{
${chain("RoSix", 6, "RO6", "X := R.Qty;")}
${chain("NextSix", 6, "NEXT6", "R.Next();")}
${chain("DelSix", 6, "DEL6", "R.Delete();")}
${chain("RoNine", 9, "RO9", "X := R.Qty;")}
    procedure CycRo(var R: Record "R570 Item"): Boolean
    begin
        Tag := 'CYCRO';
        CycRoA(R);
        exit(true);
    end;

    local procedure CycRoA(var R: Record "R570 Item")
    begin
        X := R.Qty;
        CycRoB(R);
    end;

    local procedure CycRoB(var R: Record "R570 Item")
    begin
        CycRoA(R);
    end;

    procedure CycTouch(var R: Record "R570 Item"): Boolean
    begin
        Tag := 'CYCTOUCH';
        CycTA(R);
        exit(true);
    end;

    local procedure CycTA(var R: Record "R570 Item")
    begin
        CycTB(R);
    end;

    local procedure CycTB(var R: Record "R570 Item")
    var
        Tag2: Text;
    begin
        Tag2 := 'CYCTB';
        CycTA(R);
        R.Next();
    end;

    var
        Tag: Text;
        X: Integer;
}
`;

const FILES: Record<string, string> = {
  "Deep.Codeunit.al": DEEP,
  "Adv.Codeunit.al": ADV,
  "CustExt.TableExt.al": CUSTEXT,
  "R531RecKey.Codeunit.al": R531_RECKEY,
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

describe("R570 I3b: a same-object first hop that exits an other-object cursor call", () => {
  it("the same-object hop and the other-object cursor callee are both refused", () => {
    const at = project(FILES);
    expect(at("Loops.Codeunit.al", "LOCALHOP")).toBe(true);
    expect(at(F, "NEXTHOP")).toBe(true);
  });
  it("a same-object hop that exits a NON-cursor other-object call is not refused", () => {
    const at = project(FILES);
    expect(at("Loops.Codeunit.al", "LOCALPLAIN")).toBe(false);
    expect(at(F, "PLAIN")).toBe(false);
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
  it("the cursor record passed to a `var` parameter whose callee Finds on it: refused", () => {
    expect(project(FILES)(F, "BYVAR")).toBe(true);
  });
});

describe("R570 (orchestrator option b): a sharing guard callee is refused only if it TOUCHES the record", () => {
  const T = "Item.Table.al";
  it("a table procedure on the cursor record that uses only ANOTHER record: NOT refused", () => {
    expect(project(FILES)(T, "TABLEPROC")).toBe(false);
  });
  it("a table procedure on the cursor record that only reads fields: NOT refused", () => {
    expect(project(FILES)(T, "ROTAB")).toBe(false);
  });
  it("a table procedure that calls Next on its implicit Rec: refused", () => {
    expect(project(FILES)(T, "NEXTTAB")).toBe(true);
  });
  it("a table procedure that Deletes its implicit Rec: refused", () => {
    expect(project(FILES)(T, "DELTAB")).toBe(true);
  });
  it("a table procedure whose same-object helper steps Rec: refused", () => {
    expect(project(FILES)(T, "HELPTAB")).toBe(true);
  });
  it("the record passed to a `var` parameter that is only read: NOT refused", () => {
    expect(project(FILES)(F, "ROVAR")).toBe(false);
  });
  it("the record passed to a `var` parameter that is stepped with Next: refused", () => {
    expect(project(FILES)(F, "NEXTVAR")).toBe(true);
  });
  it("the `var` parameter handed to a same-object helper that steps it: refused", () => {
    expect(project(FILES)(F, "VARHELP")).toBe(true);
  });
  it("the `var` parameter handed to an unresolved call: refused (unknown counts as touching)", () => {
    expect(project(FILES)(F, "UNRES")).toBe(true);
  });
});

describe("R570 build review: touch fixes", () => {
  const T = "Item.Table.al";
  it("BLOCKING 1: a `var` parameter NAMED `Rec` that is stepped with Next: refused", () => {
    expect(project(FILES)(F, "RECNAMED")).toBe(true);
  });
  it("IMPORTANT 2: the record handed on into another object's procedure that touches it: both refused", () => {
    const at = project(FILES);
    expect(at(F, "PASSER")).toBe(true);
    expect(at("Adv.Codeunit.al", "ADVANCE")).toBe(true);
  });
  it("IMPORTANT 3: a bare unknown name in a tableextension of a table OUTSIDE the project: refused", () => {
    expect(project(FILES)("CustExt.TableExt.al", "EXTBARE")).toBe(true);
  });
  it("IMPORTANT 3 control: `Rec.X()` on an outside table's procedure: refused", () => {
    expect(project(FILES)("CustExt.TableExt.al", "EXTREC")).toBe(true);
  });
  it("a bare global function in a PROJECT table (`Commit`) does not touch: NOT refused", () => {
    expect(project(FILES)(T, "GLOBALFN")).toBe(false);
  });
  it("field-write rule: a non-key, non-filtered field write is NOT touching", () => {
    expect(project(FILES)(T, "NONKEYW")).toBe(false);
  });
  it("field-write rule: a primary-key field write IS touching", () => {
    expect(project(FILES)(T, "KEYW")).toBe(true);
  });
  it("field-write rule: a write of the loop's filtered field, then Modify, IS touching", () => {
    expect(project(FILES)(T, "FILTMOD")).toBe(true);
  });
  it("field-write rule (review fix 1): the filtered field written WITHOUT Modify IS touching", () => {
    expect(project(FILES)(T, "FILTNOMOD")).toBe(true);
  });
  it("review fix 1: a filtered write in one helper (MarkDone), the Modify in another (Close): touching", () => {
    const at = project(FILES);
    expect(at(T, "SPLIT1")).toBe(true);
    expect(at(T, "MARKDONE")).toBe(true);
  });
  it("review fix 1: the reverse split (write in Close, Modify in Save): touching", () => {
    expect(project(FILES)(T, "SPLIT2")).toBe(true);
  });
  it("review fix 3: `Modify(true)` runs OnModify, so it touches even after a non-key, non-filtered write", () => {
    expect(project(FILES)(T, "MODTRUE")).toBe(true);
  });
  it("field-write rule: a non-key, non-filtered field written then Modify is NOT touching", () => {
    expect(project(FILES)(T, "NOTEMOD")).toBe(false);
  });
  it("field-write rule: a field write on a table outside the project IS touching", () => {
    expect(project(FILES)("CustExt.TableExt.al", "EXTWRITE")).toBe(true);
  });
  it("IMPORTANT 4: a write of a secondary-key field on the implicit Rec: refused", () => {
    expect(project(FILES)(T, "FIELDW")).toBe(true);
  });
  it("IMPORTANT 4: a field write on the `var` parameter: refused", () => {
    expect(project(FILES)(F, "FIELDWV")).toBe(true);
  });
  it("IMPORTANT 4: TransferFields INTO the shared record: refused", () => {
    expect(project(FILES)(F, "TFINTO")).toBe(true);
  });
  it("IMPORTANT 4: `X.Copy(R, true)` (shares the table): refused", () => {
    expect(project(FILES)(F, "COPYSHARE")).toBe(true);
  });
  it("TransferFields FROM the shared record into another: NOT refused", () => {
    expect(project(FILES)(F, "TFFROM")).toBe(false);
  });
  it("`X.Copy(R)` into another record: NOT refused", () => {
    expect(project(FILES)(F, "COPYINTO")).toBe(false);
  });
  it("`RecRef.GetTable(R)`: NOT refused", () => {
    expect(project(FILES)(F, "GETTABLE")).toBe(false);
  });
});

describe("R570 option (d): the record is followed 8 hops, with a visited set", () => {
  const D = "Deep.Codeunit.al";
  it("a 6-hop read-only path does NOT touch", () => {
    expect(project(FILES)(D, "RO6")).toBe(false);
  });
  it("a 6-hop path ending in Next touches", () => {
    expect(project(FILES)(D, "NEXT6")).toBe(true);
  });
  it("a 6-hop path ending in Delete touches", () => {
    expect(project(FILES)(D, "DEL6")).toBe(true);
  });
  it("a 9-hop path touches (past the cap: unknown)", () => {
    expect(project(FILES)(D, "RO9")).toBe(true);
  });
  it("a cycle with no toucher ends and does NOT touch", () => {
    expect(project(FILES)(D, "CYCRO")).toBe(false);
  });
  it("a cycle where one member touches DOES touch, and that member is refused", () => {
    const at = project(FILES);
    expect(at(D, "CYCTOUCH")).toBe(true);
    expect(at(D, "CYCTB")).toBe(true);
  });
});

/** A loop whose guard hands the cursor record to `Ring.<entry>` by `var`, and nothing else. */
const ringLoop = (entry: string) => `codeunit 50730 "R570 Ring Loop"
{
    procedure Run()
    var
        Ent: Record "R570 Item";
        Ring: Codeunit "R570 Ring";
    begin
        repeat
            if not Ring.${entry}(Ent) then
                exit;
        until Ent.Next() = 0;
    end;
}
`;

const RING = `codeunit 50731 "R570 Ring"
{
    procedure Q(var R: Record "R570 Item"): Boolean
    begin
        Tag := 'QAB';
        if X > 0 then
            A(R)
        else
            B(R);
        exit(true);
    end;

    procedure A(var R: Record "R570 Item"): Boolean
    begin
        Tag := 'AAB';
        R.Next();
        if X > 1 then
            B(R);
        exit(true);
    end;

    procedure B(var R: Record "R570 Item"): Boolean
    begin
        Tag := 'BAB';
        A(R);
        exit(true);
    end;

    procedure RingA(var R: Record "R570 Item"): Boolean
    begin
        Tag := 'RINGA';
        RingB(R);
        exit(true);
    end;

    procedure RingB(var R: Record "R570 Item"): Boolean
    begin
        Tag := 'RINGB';
        R.Next();
        RingC(R);
        exit(true);
    end;

    procedure RingC(var R: Record "R570 Item"): Boolean
    begin
        Tag := 'RINGC';
        RingA(R);
        exit(true);
    end;

    var
        Tag: Text;
        X: Integer;
}
`;

describe("R570 review fix 2: the visited set never caches a half-finished answer", () => {
  const ring = (entry: string) =>
    project({
      "Item.Table.al": ITEM,
      "Ring.Codeunit.al": RING,
      "Loop.Codeunit.al": ringLoop(entry),
    });
  const R = "Ring.Codeunit.al";
  it("the review's Q/A/B shape: B (reached first while A is still being checked) is refused", () => {
    const at = ring("Q");
    expect(at(R, "QAB")).toBe(true);
    expect(at(R, "AAB")).toBe(true);
    expect(at(R, "BAB")).toBe(true);
  });
  for (const entry of ["RingA", "RingB", "RingC"])
    it(`a ring A -> B -> C -> A whose member B touches: entered at ${entry}, every member is refused`, () => {
      const at = ring(entry);
      expect(at(R, "RINGA")).toBe(true);
      expect(at(R, "RINGB")).toBe(true);
      expect(at(R, "RINGC")).toBe(true);
    });
});

describe("R531: a HOP into a `var` parameter NAMED `Rec`", () => {
  const C = "R531RecKey.Codeunit.al";
  const at = (text: string): boolean => {
    const parsed = Object.entries(FILES).map(([path, src]) => ({
      path,
      root: wrapRoot(parseAL(src)),
    }));
    const ctx = buildSemanticContext(parsed);
    const f = parsed.find((p) => p.path === C);
    let hit: ALSyntaxNode | undefined;
    if (f !== undefined)
      visit(f.root, (n: ALSyntaxNode) => {
        if (hit === undefined && n.text === text) hit = n;
      });
    if (hit === undefined) throw new Error(`${text} not found`);
    return openItemHangRefuses(hit, ctx, VMC);
  };
  it("the callee's `Rec.Delete()` is refused", () => {
    expect(at("Rec.Delete()")).toBe(true);
  });
  it("control: the same callee with the parameter named `R`", () => {
    expect(at("R.Delete()")).toBe(true);
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
