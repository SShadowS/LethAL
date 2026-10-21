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
 * R562 (coord task R-562): FILTER HOP. A call that ends before an R-531 loop and sets, one hop
 * away, a filter the loop's ending depends on is refused with the callee's filter, and a call that
 * cannot be followed is refused itself. Every test was red-checked one direction at a time; the red
 * checks are recorded in the R-562 build log.
 */

beforeAll(async () => {
  await initParser();
});

const VMC = "lethal.void-method-call";
const RSR = "lethal.remove-setrange";
const NEG = "lethal.negate-conditional";

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
  /** Is the outermost node with exactly this text refused for `op`? */
  return (path: string, text: string, op: string = VMC): boolean =>
    openItemHangRefuses(find(path, text), ctx, op);
}

const LINE = `table 50110 "R562 Line"
{
    fields
    {
        field(1; "No."; Code[20]) { }
        field(2; Tpl; Code[20]) { }
        field(3; Name; Code[20]) { }
        field(4; Status; Integer) { }
    }

    procedure SetTplFilter(Src: Record "R562 Line")
    begin
        SetRange(Tpl, Src.Tpl);
    end;

    procedure SetOv(Src: Record "R562 Line")
    begin
        SetRange(Tpl, Src.Name);
    end;

    procedure SetOv(Other: Record "R562 Other")
    begin
        SetRange(Tpl, Other.Code);
    end;

    procedure SetStatusFilter()
    begin
        SetRange(Status, 0);
    end;

    procedure SetNameFilter()
    begin
        SetRange(Name, 'NAMEONLY');
    end;

    procedure SetAfter()
    begin
        SetRange(Name, 'AFTER');
    end;

    procedure SetMarked()
    begin
        MarkedOnly(true);
    end;

    procedure SetCode(T: Code[20])
    begin
        SetRange(Tpl, T);
    end;

    procedure SetGuarded(Src: Record "R562 Line")
    begin
        if Src."No." <> 'INNER' then
            SetRange(Tpl, Src."No.");
    end;

    procedure SetExit(Src: Record "R562 Line")
    begin
        if Src.Name = 'QUIT' then
            exit;
        SetRange(Name, Src.Tpl);
    end;

    procedure RenameAll()
    begin
        SetHelper();
        while FindFirst() do
            Rename('G');
    end;

    local procedure SetHelper()
    begin
        SetRange(Name, 'GLOBAL');
    end;

    procedure ViaRec()
    begin
        Rec.SetB();
        while FindFirst() do
            Rename('Q');
    end;

    procedure SetB()
    begin
        SetRange(Tpl, 'B1');
    end;

    procedure SetForExt(Src: Record "R562 Line")
    begin
        SetRange(Tpl, 'EXT');
    end;

    procedure SetForPage()
    begin
        SetRange(Tpl, 'PAGE');
    end;
}`;

const LINE_EXT = `tableextension 50114 "R562 Line Ext" extends "R562 Line"
{
    procedure ExtCall()
    begin
        SetForExt(xRec);
        while FindFirst() do
            Rename('E');
    end;
}`;

const LINE_PAGE = `page 50115 "R562 Line Page"
{
    SourceTable = "R562 Line";

    procedure PageCall()
    begin
        SetForPage();
        while FindFirst() do
            Rename('P');
    end;
}`;

const TN = `codeunit 50116 "R562 TN"
{
    TableNo = "R562 Line";

    trigger OnRun()
    begin
        Rec.SetRange(Name, 'TN');
    end;
}`;

const OTHER = `table 50111 "R562 Other"
{
    fields
    {
        field(1; Code; Code[20]) { }
    }
}`;

const FILTER_MGT = `codeunit 50112 "R562 Filter Mgt"
{
    procedure SetFilters(var L: Record "R562 Line")
    begin
        L.SetRange(Name, 'CU');
    end;
}`;

const CALLER = `codeunit 50113 "R562 Caller"
{
    procedure RecvProc(Src: Record "R562 Line")
    var
        R: Record "R562 Line";
    begin
        R.SetTplFilter(Src);
        while R.FindFirst() do
            R.Rename('R');
    end;

    procedure VarPass()
    var
        V: Record "R562 Line";
    begin
        SetVar(V);
        while V.FindFirst() do
            V.Rename('V');
    end;

    local procedure SetVar(var P: Record "R562 Line")
    begin
        P.SetRange(Name, 'VAR');
    end;

    procedure ByValue()
    var
        B: Record "R562 Line";
    begin
        SetVal(B);
        while B.FindFirst() do
            B.Rename('B');
    end;

    local procedure SetVal(P: Record "R562 Line")
    begin
        P.SetRange(Name, 'VAL');
    end;

    procedure Dependency()
    var
        D: Record "R562 Line";
    begin
        D.SetRange(Status, 1);
        D.SetNameFilter();
        while D.FindFirst() do begin
            D.Status := 2;
            D.Modify();
        end;
    end;

    procedure PostLoop()
    var
        A: Record "R562 Line";
    begin
        while A.FindFirst() do
            A.Rename('A');
        A.SetAfter();
    end;

    procedure Overloads(Src: Record "R562 Line")
    var
        O: Record "R562 Line";
    begin
        O.SetOv(Src);
        while O.FindFirst() do
            O.Rename('O');
    end;

    procedure Marks()
    var
        M: Record "R562 Line";
    begin
        M.SetMarked();
        while M.FindFirst() do
            M.Mark(false);
    end;

    procedure Guarded(Src: Record "R562 Line")
    var
        G: Record "R562 Line";
    begin
        if Src.Name <> 'SKIP' then
            G.SetGuarded(Src);
        while G.FindFirst() do
            G.Rename('G');
    end;

    procedure Feeds(Src: Record "R562 Line")
    var
        F: Record "R562 Line";
        T: Code[20];
    begin
        T := Src.Tpl;
        F.SetCode(T);
        while F.FindFirst() do
            F.Rename('F');
    end;

    procedure Unseen()
    var
        S: Record "R562 Line";
    begin
        S.SetStatusFilter();
        while S.FindFirst() do begin
            S.Status := 9;
            S.Modify();
        end;
    end;

    procedure Exits(Src: Record "R562 Line")
    var
        X: Record "R562 Line";
    begin
        X.SetExit(Src);
        while X.FindFirst() do
            X.Rename('X');
    end;

    procedure Unresolved(Src: Record "R562 Line")
    var
        U: Record Customer;
    begin
        U.SetSomething(Src);
        while U.FindFirst() do
            U.Rename('U');
    end;

    procedure Excluded()
    var
        K: Record "R562 Line";
        RR: RecordRef;
    begin
        RR.GetTable(K);
        Codeunit.Run(50112, K);
        while K.FindFirst() do
            K.Rename('K');
    end;

    procedure ProjectCodeunit()
    var
        C: Record "R562 Line";
        FM: Codeunit "R562 Filter Mgt";
    begin
        FM.SetFilters(C);
        while C.FindFirst() do
            C.Rename('C');
    end;

    procedure RunTableNo()
    var
        N: Record "R562 Line";
    begin
        Codeunit.Run(Codeunit::"R562 TN", N);
        while N.FindFirst() do
            N.Rename('N');
    end;

    procedure SetTableRef()
    var
        Q: Record "R562 Line";
        RR2: RecordRef;
    begin
        RR2.SetTable(Q);
        while Q.FindFirst() do
            Q.Rename('Q');
    end;

    procedure Ascending()
    var
        Z: Record "R562 Line";
    begin
        Z.SetAscending("No.", true);
        while Z.FindFirst() do
            Z.Rename('Z');
    end;
}`;

const FILES = {
  "Line.Table.al": LINE,
  "LineExt.TableExt.al": LINE_EXT,
  "LinePage.Page.al": LINE_PAGE,
  "TN.Codeunit.al": TN,
  "Other.Table.al": OTHER,
  "FilterMgt.Codeunit.al": FILTER_MGT,
  "Caller.Codeunit.al": CALLER,
};
const T = "Line.Table.al";
const C = "Caller.Codeunit.al";
const M = "FilterMgt.Codeunit.al";

describe("R562 FILTER HOP: a pre-loop call that sets the loop's filter", () => {
  it("recv-proc: refuses the call and the table procedure's filter", () => {
    const refused = project(FILES);
    expect(refused(C, "R.SetTplFilter(Src)")).toBe(true);
    expect(refused(T, "SetRange(Tpl, Src.Tpl)", RSR)).toBe(true);
  });
  it("pass-rec through a VAR parameter: refuses the call and the callee's filter", () => {
    const refused = project(FILES);
    expect(refused(C, "SetVar(V)")).toBe(true);
    expect(refused(C, "P.SetRange(Name, 'VAR')", RSR)).toBe(true);
  });
  it("control: pass-rec BY VALUE is not refused (the copy's filters are its own)", () => {
    const refused = project(FILES);
    expect(refused(C, "SetVal(B)")).toBe(false);
    expect(refused(C, "P.SetRange(Name, 'VAL')", RSR)).toBe(false);
  });
  it("control: a callee filtering a field the Modify loop does not write is not refused", () => {
    const refused = project(FILES);
    expect(refused(T, "SetRange(Name, 'NAMEONLY')", RSR)).toBe(false);
    expect(refused(C, "D.SetNameFilter()")).toBe(false);
  });
  it("control: the same kind of call AFTER the loop is not refused", () => {
    const refused = project(FILES);
    expect(refused(C, "A.SetAfter()")).toBe(false);
    expect(refused(T, "SetRange(Name, 'AFTER')", RSR)).toBe(false);
  });
  // R564 closed this test's former over-refusal: `Src` is a "R562 Line", so the call can only reach
  // the "R562 Line" overload, and the "R562 Other" one is no longer followed.
  it("overloads by argument type: only the overload `Src`'s table picks is refused (R564)", () => {
    const refused = project(FILES);
    expect(refused(T, "SetRange(Tpl, Src.Name)", RSR)).toBe(true);
    expect(refused(T, "SetRange(Tpl, Other.Code)", RSR)).toBe(false);
  });
  it("Mark: a callee's `MarkedOnly(true)` before a `Mark(false)` loop is refused", () => {
    expect(project(FILES)(T, "MarkedOnly(true)")).toBe(true);
  });
  it("global-call via the implicit Rec: refuses the helper's filter and the call", () => {
    const refused = project(FILES);
    expect(refused(T, "SetRange(Name, 'GLOBAL')", RSR)).toBe(true);
    expect(refused(T, "SetHelper()")).toBe(true);
  });
  it("preGuards: the `if` around the call is refused", () => {
    expect(project(FILES)(C, "Src.Name <> 'SKIP'", NEG)).toBe(true);
  });
  it("FEEDS: the assignment feeding the call's argument is refused", () => {
    expect(project(FILES)(C, "T := Src.Tpl", "lethal.remove-assignment")).toBe(true);
  });
  it("the guard around the filter inside the callee is refused", () => {
    expect(project(FILES)(T, `Src."No." <> 'INNER'`, NEG)).toBe(true);
  });
  it("F1: a Modify loop filtered only through a helper refuses the helper's filter and the call", () => {
    const refused = project(FILES);
    expect(refused(T, "SetRange(Status, 0)", RSR)).toBe(true);
    expect(refused(C, "S.SetStatusFilter()")).toBe(true);
  });
  it("F2: the guard of the callee's early exit before the filter is refused", () => {
    expect(project(FILES)(T, "Src.Name = 'QUIT'", NEG)).toBe(true);
  });
  it("F3: a call on R whose table procedure is not in the project is refused", () => {
    expect(project(FILES)(C, "U.SetSomething(Src)")).toBe(true);
  });
  it("control: `RecRef.GetTable(R)` and `Codeunit.Run(.., R)` are not refused", () => {
    const refused = project(FILES);
    expect(refused(C, "RR.GetTable(K)")).toBe(false);
    expect(refused(C, "Codeunit.Run(50112, K)")).toBe(false);
  });
  it("F4: a project codeunit's VAR parameter filter is refused, and the call", () => {
    const refused = project(FILES);
    expect(refused(M, "L.SetRange(Name, 'CU')", RSR)).toBe(true);
    expect(refused(C, "FM.SetFilters(C)")).toBe(true);
  });
});

describe("R562 FILTER HOP: the implicit Rec's table, Codeunit.Run, SetTable, SetAscending (build review)", () => {
  it("`Rec.SetB()` in a table: the callee's filter is refused", () => {
    expect(project(FILES)(T, "SetRange(Tpl, 'B1')", RSR)).toBe(true);
  });
  it("a tableextension calling the base table's `SetForExt(xRec)`: the call and the filter are refused", () => {
    const refused = project(FILES);
    expect(refused(T, "SetRange(Tpl, 'EXT')", RSR)).toBe(true);
    expect(refused("LineExt.TableExt.al", "SetForExt(xRec)")).toBe(true);
  });
  it("a page with SourceTable calling `SetForPage()`: the callee's filter is refused", () => {
    expect(project(FILES)(T, "SetRange(Tpl, 'PAGE')", RSR)).toBe(true);
  });
  it("`Codeunit.Run` of a project TableNo codeunit: its OnRun filter and the call are refused", () => {
    const refused = project(FILES);
    expect(refused("TN.Codeunit.al", "Rec.SetRange(Name, 'TN')", RSR)).toBe(true);
    expect(refused(C, `Codeunit.Run(Codeunit::"R562 TN", N)`)).toBe(true);
  });
  it("F3: `RecRef.SetTable(R)` (it writes R) is refused", () => {
    expect(project(FILES)(C, "RR2.SetTable(Q)")).toBe(true);
  });
  it("control: `R.SetAscending(..)` is a built-in and is not refused", () => {
    expect(project(FILES)(C, `Z.SetAscending("No.", true)`)).toBe(false);
  });
});
