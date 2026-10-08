import { beforeAll, describe, expect, it } from "bun:test";
import {
  type ALSyntaxNode,
  buildSemanticContext,
  initParser,
  normalizeAlName,
  parseAL,
  visit,
  wrapRoot,
} from "@lethal/engine";
import { openItemHangRefuses } from "../src/index";

/**
 * R500: the report-loop shapes R487/R501 did not cover, asked through `openItemHangRefuses` (the
 * dispatch check) directly. Every refused case has a twin that must still emit, in its own `it`, so
 * a rule removed turns one test red and a rule widened turns another red (R-427). Orchestrator-level
 * tests (the carrier gate, the XMLport publisher, the scheme twin) are in the runner's
 * `r500-dispatch.test.ts`.
 */

beforeAll(async () => {
  await initParser();
});

type Project = {
  /** Does the dispatch check refuse the first statement of procedure `proc` in file `path`? */
  proc: (path: string, proc: string) => boolean;
  /** Does it refuse the first node of raw kind `kind` whose text is exactly `text` in `path`? */
  at: (path: string, kind: string, text: string, nth?: number) => boolean;
};

function project(files: Record<string, string>): Project {
  const parsed = Object.entries(files).map(([path, src]) => ({
    path,
    root: wrapRoot(parseAL(src)),
  }));
  const ctx = buildSemanticContext(parsed);
  const rootOf = (path: string): ALSyntaxNode => {
    const f = parsed.find((p) => p.path === path);
    if (f === undefined) throw new Error(`no file ${path}`);
    return f.root;
  };
  const find = (
    path: string,
    ok: (n: ALSyntaxNode) => boolean,
    nth: number,
    what: string,
  ): ALSyntaxNode => {
    const hits: ALSyntaxNode[] = [];
    visit(rootOf(path), (n: ALSyntaxNode) => {
      if (ok(n)) hits.push(n);
    });
    const hit = hits[nth - 1];
    if (hit === undefined) throw new Error(`${what} #${nth} not found in ${path}`);
    return hit;
  };
  return {
    proc: (path, proc) => {
      const p = find(
        path,
        (n) =>
          n.rawKind === "procedure" &&
          normalizeAlName(n.childForFieldName("name")?.text ?? "") === normalizeAlName(proc),
        1,
        `procedure ${proc}`,
      );
      const first = p.childForFieldName("body")?.childForFieldName("body")?.namedChildren[0];
      if (first === undefined) throw new Error(`procedure ${proc} has no statement`);
      return openItemHangRefuses(first, ctx);
    },
    at: (path, kind, text, nth = 1) =>
      openItemHangRefuses(
        find(path, (n) => n.rawKind === kind && n.text === text, nth, `${kind} ${text}`),
        ctx,
      ),
  };
}

// ---------------------------------------------------------------------------------------------
// Shape 2: one-hop callees in other objects (codeunit, record, interface, subscriber), dotted names
// ---------------------------------------------------------------------------------------------

const WALK = `report 50200 "Walk 1.0"
{
    dataset
    {
        dataitem(Loop; Integer)
        {
            dataitem(Line; "Line Buffer")
            {
                trigger OnAfterGetRecord()
                begin
                    Line.ByItemName();
                    ByImplicit();
                end;
            }
            trigger OnAfterGetRecord()
            begin
                if not Post.Step() then
                    CurrReport.Break();
                Ledger.Touch();
                Ledger.TouchT();
                Iter.Next2();
                Mfg.Calc();
                OnWalkStep(Done);
                if Done then
                    CurrReport.Break();
            end;
        }
        dataitem(Capped; Integer)
        {
            MaxIteration = 1;
            trigger OnAfterGetRecord()
            begin
                Other.Calc();
                Look.Touch();
                OnQuietStep(Done);
            end;
        }
    }

    trigger OnPreReport()
    begin
        Iter.Init();
        Spare.Init();
    end;

    [IntegrationEvent(false, false)]
    local procedure OnWalkStep(var IsDone: Boolean)
    begin
    end;

    [IntegrationEvent(false, false)]
    local procedure OnQuietStep(var IsDone: Boolean)
    begin
    end;

    var
        Post: Codeunit "Gen. Jnl.-Post Line";
        Ledger: Record "Cust. Ledger Entry";
        Look: Record "Ledger Entry";
        Iter: Interface "My.Iterator";
        Spare: Interface "Iterator";
        Mfg: Codeunit "Mfg. Calculate BOM Tree";
        Other: Codeunit "Calculate BOM Tree";
        Done: Boolean;
}
`;

const WALK2 = `report 50209 "Walk 2.0"
{
    [IntegrationEvent(false, false)]
    local procedure OnWalkStep(var IsDone: Boolean)
    begin
    end;
}
`;

const TABLES = `table 50201 "Cust. Ledger Entry"
{
    fields
    {
        field(1; "Entry No."; Integer) { }
    }
    procedure TouchT()
    begin
        TCount := TCount + 1;
    end;

    procedure Untouched()
    begin
        UCount := UCount + 1;
    end;

    var
        TCount: Integer;
        UCount: Integer;
}

tableextension 50202 "Cust. Ledger Ext" extends "Cust. Ledger Entry"
{
    procedure Touch()
    begin
        ECount := ECount + 1;
    end;

    var
        ECount: Integer;
}

table 50203 "Ledger Entry"
{
    fields
    {
        field(1; "Entry No."; Integer) { }
    }
    procedure TouchT()
    begin
        LCount := LCount + 1;
    end;

    var
        LCount: Integer;
}

tableextension 50205 "Ledger Ext" extends "Ledger Entry"
{
    procedure Touch()
    begin
        LECount := LECount + 1;
    end;

    var
        LECount: Integer;
}

table 50204 "Line Buffer"
{
    fields
    {
        field(1; "Entry No."; Integer) { }
    }
    procedure ByItemName()
    begin
        B1 := B1 + 1;
    end;

    procedure ByImplicit()
    begin
        B2 := B2 + 1;
    end;

    procedure NotCalled()
    begin
        B3 := B3 + 1;
    end;

    var
        B1: Integer;
        B2: Integer;
        B3: Integer;
}
`;

const CODEUNITS = `codeunit 50220 "Gen. Jnl.-Post Line"
{
    procedure Step(): Boolean
    begin
        Helper();
        this.Helper2();
        if IsOk then
            Pos += 1;
        exit(Pos > 3);
    end;

    local procedure Helper()
    begin
        H1 := H1 + 1;
        OnStepDone(H1);
    end;

    [IntegrationEvent(false, false)]
    local procedure OnStepDone(var Count: Integer)
    begin
    end;

    [IntegrationEvent(false, false)]
    local procedure OnUnreachedDone(var Count: Integer)
    begin
    end;

    local procedure Helper2()
    begin
        H2 := H2 + 1;
    end;

    local procedure IsOk(): Boolean
    begin
        H3 := H3 + 1;
        exit(H3 > 0);
    end;

    procedure Unreached()
    begin
        U := U + 1;
        OnUnreachedDone(U);
    end;

    var
        Pos: Integer;
        H1: Integer;
        H2: Integer;
        H3: Integer;
        U: Integer;
}

codeunit 50221 "Mfg. Calculate BOM Tree"
{
    procedure Calc()
    begin
        M := M + 1;
    end;

    var
        M: Integer;
}

codeunit 50222 "Calculate BOM Tree"
{
    procedure Calc()
    begin
        C := C + 1;
    end;

    var
        C: Integer;
}

interface "My.Iterator"
{
    procedure Init();
    procedure Next2();
}

interface "Iterator"
{
    procedure Init();
    procedure Next2();
}

codeunit 50223 "Iter.Impl" implements "My.Iterator"
{
    procedure Init()
    begin
        P := 0;
    end;

    procedure Next2()
    begin
        P += 1;
    end;

    var
        P: Integer;
}

codeunit 50224 "Plain Impl" implements "Iterator"
{
    procedure Init()
    begin
        Q := 0;
    end;

    procedure Next2()
    begin
        Q += 1;
    end;

    var
        Q: Integer;
}
`;

const SUBS = `codeunit 50230 "Walk Subs"
{
    [EventSubscriber(ObjectType::Report, Report::"Walk 1.0", OnWalkStep, '', false, false)]
    local procedure BareName(var IsDone: Boolean)
    begin
        IsDone := true;
    end;

    [EventSubscriber(ObjectType::Report, Report::"Walk 1.0", 'OnWalkStep', '', false, false)]
    local procedure QuotedName(var IsDone: Boolean)
    begin
        IsDone := true;
    end;

    [EventSubscriber(ObjectType::Report, Report::"Walk 1.0", OnQuietStep, '', false, false)]
    local procedure OtherEvent(var IsDone: Boolean)
    begin
        IsDone := true;
    end;

    [EventSubscriber(ObjectType::Report, 50200, 'OnWalkStep', '', false, false)]
    local procedure ById(var IsDone: Boolean)
    begin
        IsDone := true;
    end;

    [EventSubscriber(ObjectType::Report, 50209, 'OnWalkStep', '', false, false)]
    local procedure ByOtherId(var IsDone: Boolean)
    begin
        IsDone := true;
    end;

    [EventSubscriber(ObjectType::Report, Report::Contoso.Reports."Walk 1.0", OnWalkStep, '', false, false)]
    local procedure ByNamespace(var IsDone: Boolean)
    begin
        IsDone := true;
    end;

    [EventSubscriber(ObjectType::Report, Report::Contoso.Reports."Walk 2.0", OnWalkStep, '', false, false)]
    local procedure ByNamespaceOther(var IsDone: Boolean)
    begin
        IsDone := true;
    end;

    [EventSubscriber(ObjectType::Codeunit, Codeunit::"Gen. Jnl.-Post Line", OnStepDone, '', false, false)]
    local procedure CalleeEvent(var Count: Integer)
    begin
        Count := 0;
    end;

    [EventSubscriber(ObjectType::Codeunit, Codeunit::"Gen. Jnl.-Post Line", OnUnreachedDone, '', false, false)]
    local procedure UnreachedEvent(var Count: Integer)
    begin
        Count := 0;
    end;
}
`;

describe("R500 shape 2: one-hop callees of open-item code", () => {
  const p = () =>
    project({
      "Walk.al": WALK,
      "Walk2.al": WALK2,
      "Tables.al": TABLES,
      "Codeunits.al": CODEUNITS,
      "Subs.al": SUBS,
    });

  it("dotted codeunit callees (`Gen. Jnl.-Post Line`, `Mfg. Calculate BOM Tree`) are refused", () => {
    const x = p();
    expect(x.proc("Codeunits.al", "Step")).toBe(true);
    expect(x.at("Codeunits.al", "assignment_statement", "M := M + 1")).toBe(true);
  });
  it("an undotted look-alike codeunit (`Calculate BOM Tree` against `Mfg. Calculate BOM Tree`) emits", () => {
    expect(p().at("Codeunits.al", "assignment_statement", "C := C + 1")).toBe(false);
  });
  it("the callee's same-object closure (`P()`, `this.P()`, a bare `IsOk` in an expression) is refused", () => {
    const x = p();
    expect(x.proc("Codeunits.al", "Helper")).toBe(true);
    expect(x.proc("Codeunits.al", "Helper2")).toBe(true);
    expect(x.proc("Codeunits.al", "IsOk")).toBe(true);
  });
  it("a procedure of the callee object that nothing reached emits", () => {
    expect(p().proc("Codeunits.al", "Unreached")).toBe(false);
  });

  it("record callees: a dotted table's procedure and its tableextension's are refused", () => {
    const x = p();
    expect(x.at("Tables.al", "assignment_statement", "TCount := TCount + 1")).toBe(true);
    expect(x.at("Tables.al", "assignment_statement", "ECount := ECount + 1")).toBe(true);
  });
  it("record twins: the dotted table's uncalled procedure, and the undotted look-alike table and its extension, emit", () => {
    const x = p();
    expect(x.at("Tables.al", "assignment_statement", "UCount := UCount + 1")).toBe(false);
    expect(x.at("Tables.al", "assignment_statement", "LCount := LCount + 1")).toBe(false);
    expect(x.at("Tables.al", "assignment_statement", "LECount := LECount + 1")).toBe(false);
  });
  it("a data-item record receiver and an implicit-record call are typed through resolveReceiverTable", () => {
    const x = p();
    expect(x.proc("Tables.al", "ByItemName")).toBe(true);
    expect(x.proc("Tables.al", "ByImplicit")).toBe(true);
  });
  it("the data item's table: an uncalled procedure emits", () => {
    expect(p().proc("Tables.al", "NotCalled")).toBe(false);
  });

  it("interface implementers of a dotted interface are refused, Init through a receiver seeded in OnPreReport", () => {
    const x = p();
    expect(x.at("Codeunits.al", "assignment_statement", "P += 1")).toBe(true);
    expect(x.at("Codeunits.al", "assignment_statement", "P := 0")).toBe(true);
  });
  it("an undotted look-alike interface's implementer emits, though OnPreReport calls its Init", () => {
    const x = p();
    expect(x.at("Codeunits.al", "assignment_statement", "Q += 1")).toBe(false);
    expect(x.at("Codeunits.al", "assignment_statement", "Q := 0")).toBe(false);
  });

  it("subscribers of an event open-item code raises: bare and quoted event names", () => {
    const x = p();
    expect(x.proc("Subs.al", "BareName")).toBe(true);
    expect(x.proc("Subs.al", "QuotedName")).toBe(true);
  });
  it("a subscriber of an event raised only from a bounded item emits", () => {
    expect(p().proc("Subs.al", "OtherEvent")).toBe(false);
  });
  it("a subscriber naming the publisher by integer id is refused (resolved through object_id)", () => {
    expect(p().proc("Subs.al", "ById")).toBe(true);
  });
  it("a subscriber naming another report's id, with the same event name, emits", () => {
    expect(p().proc("Subs.al", "ByOtherId")).toBe(false);
  });
  it("a namespace-qualified subscriber object is read by its last member", () => {
    expect(p().proc("Subs.al", "ByNamespace")).toBe(true);
  });
  it("a namespace-qualified subscriber of another report emits", () => {
    expect(p().proc("Subs.al", "ByNamespaceOther")).toBe(false);
  });
  it("a subscriber of an event a refused callee raises (PEPPOL Management's OnFindNext*) is refused", () => {
    expect(p().proc("Subs.al", "CalleeEvent")).toBe(true);
  });
  it("a subscriber of an event raised only from an unreached procedure of the callee object emits", () => {
    expect(p().proc("Subs.al", "UnreachedEvent")).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// Shape 1 (LIMIT): writes before the item of a global an open item's exit reads
// ---------------------------------------------------------------------------------------------

const MEMO = `report 50300 "Memo Test"
{
    dataset
    {
        dataitem(Setup; Integer)
        {
            MaxIteration = 1;
            trigger OnAfterGetRecord()
            begin
                if ShowDim then
                    Continue := true;
                Mark(Continue);
                SetIt(Continue);
            end;
        }
        dataitem(DimensionLoop; Integer)
        {
            trigger OnAfterGetRecord()
            begin
                if not Continue then
                    CurrReport.Break();
                ReadLimit();
            end;
        }
        dataitem(Days; Date)
        {
            trigger OnAfterGetRecord()
            begin
                if DayNo > MaxDays then
                    CurrReport.Break();
            end;
        }
        dataitem(CappedDays; Date)
        {
            MaxIteration = 7;
            trigger OnAfterGetRecord()
            begin
                if DayNo > CapDays then
                    CurrReport.Break();
            end;
        }
    }

    trigger OnPreReport()
    begin
        if Hide then
            CurrReport.Quit();
        Limit := 5;
        Limit2 := 5;
        "No. of Lines" := 3;
        "No. of Copies" := 2;
        Buf."No. of Lines" := 4;
        MaxDays := 10;
        CapDays := 10;
        if Late then
            CurrReport.Quit();
    end;

    local procedure ReadLimit()
    begin
        if Counter >= Limit then
            CurrReport.Break();
        if Counter > "No. of Lines" then
            CurrReport.Break();
    end;

    local procedure NotReached()
    begin
        if Counter >= Limit2 then
            CurrReport.Break();
    end;

    local procedure Mark(Value: Boolean)
    begin
        Marked := Value;
    end;

    local procedure SetIt(var Value: Boolean)
    begin
        Value := true;
    end;

    var
        ShowDim: Boolean;
        Continue: Boolean;
        Hide: Boolean;
        Late: Boolean;
        Marked: Boolean;
        Limit: Integer;
        Limit2: Integer;
        Counter: Integer;
        "No. of Lines": Integer;
        "No. of Copies": Integer;
        MaxDays: Integer;
        CapDays: Integer;
        DayNo: Integer;
        Buf: Record "Line Totals";
}
`;

describe("R500 shape 1 (LIMIT): a preset exit name written before the item", () => {
  const p = () => project({ "Memo.al": MEMO });
  const F = "Memo.al";

  it("a guard around a preset write (DimensionLoop's `Continue`) is refused, and the write itself", () => {
    const x = p();
    expect(x.at(F, "identifier", "ShowDim")).toBe(true);
    expect(x.at(F, "assignment_statement", "Continue := true")).toBe(true);
  });
  it("a `var` argument is a write: refused", () => {
    expect(p().at(F, "call_expression", "SetIt(Continue)")).toBe(true);
  });
  it("a by-value argument is not a write: emits", () => {
    expect(p().at(F, "call_expression", "Mark(Continue)")).toBe(false);
  });
  it("an exit guard in a same-object procedure open-item code reaches: its preset name's write is refused", () => {
    expect(p().at(F, "assignment_statement", "Limit := 5")).toBe(true);
  });
  it("the same guard in a procedure nothing open reaches: the write emits", () => {
    expect(p().at(F, "assignment_statement", "Limit2 := 5")).toBe(false);
  });
  it("an open Date item's exit guard makes its name preset: refused", () => {
    expect(p().at(F, "assignment_statement", "MaxDays := 10")).toBe(true);
  });
  it("a MaxIteration Date item's guard does not: emits", () => {
    expect(p().at(F, "assignment_statement", "CapDays := 10")).toBe(false);
  });
  it('a quoted dotted global (`"No. of Lines"`) is read from its identifier node: refused', () => {
    expect(p().at(F, "assignment_statement", '"No. of Lines" := 3')).toBe(true);
  });
  it('a dotted global no exit reads (`"No. of Copies"`) emits', () => {
    expect(p().at(F, "assignment_statement", '"No. of Copies" := 2')).toBe(false);
  });
  it('a record field of the same name (`Buf."No. of Lines"`) writes Buf, its leftmost identifier: emits', () => {
    expect(p().at(F, "assignment_statement", 'Buf."No. of Lines" := 4')).toBe(false);
  });
  it("an early exit BEFORE a preset write in its scope is refused (its condition and its exit)", () => {
    const x = p();
    expect(x.at(F, "identifier", "Hide")).toBe(true);
    expect(x.at(F, "call_expression", "CurrReport.Quit()", 1)).toBe(true);
  });
  it("an early exit AFTER every preset write emits", () => {
    const x = p();
    expect(x.at(F, "identifier", "Late")).toBe(false);
    expect(x.at(F, "call_expression", "CurrReport.Quit()", 2)).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// Shape 3 (LIMIT): the OnPreDataItem filter of an item that inserts into its own table
// ---------------------------------------------------------------------------------------------

const COMPRESS = `report 50400 "Date Compress Ledger"
{
    dataset
    {
        dataitem(Entry; "Cust. Ledger Entry")
        {
            trigger OnPreDataItem()
            begin
                SetRange("Entry No.", 0, LastEntryNo);
            end;

            trigger OnAfterGetRecord()
            begin
                NewEntry.Insert();
            end;
        }
        dataitem(TempOnly; "Cust. Ledger Entry")
        {
            trigger OnPreDataItem()
            begin
                SetRange("Entry No.", 0, LastTemp);
            end;

            trigger OnAfterGetRecord()
            begin
                TempEntry.Insert();
            end;
        }
        dataitem(Look; "Ledger Entry")
        {
            trigger OnPreDataItem()
            begin
                Look.SetRange("Entry No.", 0, LastLook);
            end;

            trigger OnAfterGetRecord()
            begin
                NewEntry.Insert();
            end;
        }
        dataitem(Own; "Cust. Ledger Entry")
        {
            trigger OnPreDataItem()
            begin
                Own.SetRange("Entry No.", 0, LastOwn);
            end;

            trigger OnAfterGetRecord()
            begin
                Own.Insert();
            end;
        }
        dataitem(Parent; "Ledger Entry")
        {
            dataitem(Cross; "Cust. Ledger Entry")
            {
                trigger OnPreDataItem()
                begin
                    Cross.SetRange("Entry No.", 0, LastCross);
                end;

                trigger OnAfterGetRecord()
                begin
                    Parent.Insert();
                end;
            }
        }
    }

    var
        NewEntry: Record "Cust. Ledger Entry";
        TempEntry: Record "Cust. Ledger Entry" temporary;
        LastEntryNo: Integer;
        LastTemp: Integer;
        LastLook: Integer;
        LastOwn: Integer;
        LastCross: Integer;
}

table 50401 "Cust. Ledger Entry"
{
    fields
    {
        field(1; "Entry No."; Integer) { }
    }
}

table 50402 "Ledger Entry"
{
    fields
    {
        field(1; "Entry No."; Integer) { }
    }
}
`;

describe("R500 shape 3 (LIMIT): a self-inserting item's own filter", () => {
  const p = () => project({ "Compress.al": COMPRESS });
  it("a Date Compress item over a dotted table: its OnPreDataItem SetRange is refused", () => {
    expect(p().at("Compress.al", "call_expression", 'SetRange("Entry No.", 0, LastEntryNo)')).toBe(
      true,
    );
  });
  it("an item inserting only into a temporary record, or into another table, emits", () => {
    const x = p();
    expect(x.at("Compress.al", "call_expression", 'SetRange("Entry No.", 0, LastTemp)')).toBe(
      false,
    );
    expect(x.at("Compress.al", "call_expression", 'Look.SetRange("Entry No.", 0, LastLook)')).toBe(
      false,
    );
  });
  it("`Own.Insert()` on the data item's own record counts as a self-insert (resolveReceiverTable): refused", () => {
    expect(p().at("Compress.al", "call_expression", 'Own.SetRange("Entry No.", 0, LastOwn)')).toBe(
      true,
    );
  });
  it("an Insert on the PARENT data item's record, over another table, does not: emits", () => {
    expect(
      p().at("Compress.al", "call_expression", 'Cross.SetRange("Entry No.", 0, LastCross)'),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// Shapes 4, 5b, 9: Date items and their children, outside filter calls, hidden call shapes
// ---------------------------------------------------------------------------------------------

const DATES = `report 50700 "Dates"
{
    dataset
    {
        dataitem(Days; Date)
        {
            dataitem(DayLine; Integer)
            {
                MaxIteration = 1;
                trigger OnAfterGetRecord()
                begin
                    DL := DL + 1;
                end;
            }
            trigger OnAfterGetRecord()
            begin
                DD := DD + 1;
            end;
        }
        dataitem(Week; Date)
        {
            MaxIteration = 7;
            dataitem(WeekLine; Integer)
            {
                MaxIteration = 1;
                trigger OnAfterGetRecord()
                begin
                    WL := WL + 1;
                end;
            }
            trigger OnAfterGetRecord()
            begin
                WW := WW + 1;
            end;
        }
    }

    var
        DL: Integer;
        DD: Integer;
        WL: Integer;
        WW: Integer;
}
`;

describe("R500 shape 4: a Date item is open unless MaxIteration bounds it", () => {
  const p = () => project({ "Dates.al": DATES });
  it("an open Date item's code and its bounded child item's code are refused", () => {
    const x = p();
    expect(x.at("Dates.al", "assignment_statement", "DD := DD + 1")).toBe(true);
    expect(x.at("Dates.al", "assignment_statement", "DL := DL + 1")).toBe(true);
  });
  it("a MaxIteration Date item's code and its child's emit", () => {
    const x = p();
    expect(x.at("Dates.al", "assignment_statement", "WW := WW + 1")).toBe(false);
    expect(x.at("Dates.al", "assignment_statement", "WL := WL + 1")).toBe(false);
  });
});

const HIDDEN = `report 50500 "Hidden"
{
    dataset
    {
        dataitem(Loop; Integer)
        {
            trigger OnAfterGetRecord()
            begin
                CurrReport.ViaCurr();
                if IsOk then
                    Total := GetVal;
            end;
        }
        dataitem(Fixed; Integer)
        {
            MaxIteration = 3;
            trigger OnAfterGetRecord()
            begin
                Total := 0;
            end;
        }
    }

    trigger OnPreReport()
    begin
        Loop.SetRange(Number, 1, N);
        Fixed.SetRange(Number, 1, N);
    end;

    local procedure ViaCurr()
    begin
        A := A + 1;
    end;

    local procedure IsOk(): Boolean
    begin
        B := B + 1;
        exit(B > 0);
    end;

    local procedure GetVal(): Integer
    begin
        C := C + 1;
        exit(C);
    end;

    local procedure Spare()
    begin
        D := D + 1;
    end;

    var
        Total: Integer;
        N: Integer;
        A: Integer;
        B: Integer;
        C: Integer;
        D: Integer;
}
`;

describe("R500 shape 9: hidden same-object call shapes", () => {
  const p = () => project({ "Hidden.al": HIDDEN });
  it("`CurrReport.P()`, a bare `IsOk` condition and `X := GetVal` reach their procedures: refused", () => {
    const x = p();
    expect(x.proc("Hidden.al", "ViaCurr")).toBe(true);
    expect(x.proc("Hidden.al", "IsOk")).toBe(true);
    expect(x.proc("Hidden.al", "GetVal")).toBe(true);
  });
  it("a procedure no open-item code names emits", () => {
    expect(p().proc("Hidden.al", "Spare")).toBe(false);
  });
});

describe("R500 shape 5b: a filter call on an open item's record from outside its code", () => {
  const p = () => project({ "Hidden.al": HIDDEN });
  it("OnPreReport's `Loop.SetRange` on the open item is refused", () => {
    expect(p().at("Hidden.al", "call_expression", "Loop.SetRange(Number, 1, N)")).toBe(true);
  });
  it("the same call on a MaxIteration item emits", () => {
    expect(p().at("Hidden.al", "call_expression", "Fixed.SetRange(Number, 1, N)")).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// Shape 7: a reportextension the grammar could not read extends every report
// ---------------------------------------------------------------------------------------------

const VIEWED = `report 50800 "Viewed Report"
{
    dataset
    {
        dataitem(Loop; Integer)
        {
            DataItemTableView = where(Number = const(1));
            trigger OnAfterGetRecord()
            begin
                V := V + 1;
            end;
        }
    }

    var
        V: Integer;
}
`;

const SPLIT_EXT = `#if CLEAN26
reportextension 50801 "Split Ext" extends "Other Report"
#else
reportextension 50801 "Split Ext" extends "Third Report"
#endif
{
    dataset
    {
    }
}
`;

const PLAIN_EXT = `reportextension 50802 "Plain Ext" extends "Other Report"
{
    dataset
    {
    }
}
`;

describe("R500 shape 7: an unparsed or split reportextension", () => {
  it("a `#if`-split reportextension header counts as extending every report: the view bound no longer holds", () => {
    const x = project({ "Viewed.al": VIEWED, "Split.al": SPLIT_EXT });
    expect(x.at("Viewed.al", "assignment_statement", "V := V + 1")).toBe(true);
  });
  it("a readable reportextension of another report leaves the view bound", () => {
    const x = project({ "Viewed.al": VIEWED, "Plain.al": PLAIN_EXT });
    expect(x.at("Viewed.al", "assignment_statement", "V := V + 1")).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// Shape 5: XMLport `tableelement` over Integer, and the `source` field skip
// ---------------------------------------------------------------------------------------------

const XMLPORT = `xmlport 50600 "XP Open"
{
    schema
    {
        textelement(Root)
        {
            tableelement(Cnt; Integer)
            {
                trigger OnAfterGetRecord()
                begin
                    Opened := Opened + 1;
                end;
            }
            tableelement(Viewed; Integer)
            {
                SourceTableView = sorting(Number) where(Number = const(1));
                trigger OnAfterGetRecord()
                begin
                    Viewed2 := Viewed2 + 1;
                end;
            }
            tableelement(Integer; Integer)
            {
                SourceTableView = where(Number = filter(1 .. 3));
                trigger OnAfterGetRecord()
                begin
                    Named := Named + 1;
                end;
            }
            tableelement(Ranged; Integer)
            {
                trigger OnPreXmlItem()
                begin
                    Ranged.SetRange(Number, 1, 3);
                end;

                trigger OnAfterGetRecord()
                begin
                    Rng := Rng + 1;
                end;
            }
        }
    }

    var
        Opened: Integer;
        Viewed2: Integer;
        Named: Integer;
        Rng: Integer;
}

report 50601 "Column Source"
{
    dataset
    {
        dataitem(Loop; Integer)
        {
            DataItemTableView = where(Number = const(1));
            column(LoopCol; Loop) { }
            trigger OnAfterGetRecord()
            begin
                W := W + 1;
            end;
        }
    }

    var
        W: Integer;
}
`;

describe("R500 shape 5: an XMLport tableelement over Integer is a loop item", () => {
  const p = () => project({ "Xp.al": XMLPORT });
  it("an unbounded tableelement's code is refused (asked directly: the orchestrator skips xmlport files)", () => {
    expect(p().at("Xp.al", "assignment_statement", "Opened := Opened + 1")).toBe(true);
  });
  it("a SourceTableView bound holds", () => {
    expect(p().at("Xp.al", "assignment_statement", "Viewed2 := Viewed2 + 1")).toBe(false);
  });
  it("an OnPreXmlItem SetRange certificate holds", () => {
    expect(p().at("Xp.al", "assignment_statement", "Rng := Rng + 1")).toBe(false);
  });
  it("that SetRange is the element's only bound: refused", () => {
    expect(p().at("Xp.al", "call_expression", "Ranged.SetRange(Number, 1, 3)")).toBe(true);
  });
  it("an element named like its source table (`tableelement(Integer; Integer)`): the source is not a mention", () => {
    expect(p().at("Xp.al", "assignment_statement", "Named := Named + 1")).toBe(false);
  });
  it("the `source` skip applies under xmlport_element only: a report column's source naming the item is a mention", () => {
    expect(p().at("Xp.al", "assignment_statement", "W := W + 1")).toBe(true);
  });
});
