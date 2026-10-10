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
 * R567: every loop-hazard reader of a call's or an attribute's arguments goes through the engine's
 * `argumentList` (comments removed) and asks `argumentsReadable` before it reads by position. When
 * a `#pragma` sits among the arguments (unreadable), each reader takes the direction that refuses
 * MORE. One test per consumer and per unreadable path; each was red-checked by reverting that one
 * consumer (`/coord/handoff/R-567/redcheck.md`). The R564 pins this flips are in
 * `r564-overload-by-type.test.ts`.
 */

beforeAll(async () => {
  await initParser();
});

const VMC = "lethal.void-method-call";
const RSR = "lethal.remove-setrange";
const PRAGMA = "#pragma warning disable AA0001";

function project(files: Record<string, string>) {
  const parsed = Object.entries(files).map(([path, src]) => ({
    path,
    root: wrapRoot(parseAL(src)),
  }));
  const ctx = buildSemanticContext(parsed);
  const find = (path: string, ok: (n: ALSyntaxNode) => boolean, what: string): ALSyntaxNode => {
    const f = parsed.find((p) => p.path === path);
    if (f === undefined) throw new Error(`no file ${path}`);
    let hit: ALSyntaxNode | undefined;
    visit(f.root, (n: ALSyntaxNode) => {
      if (hit === undefined && ok(n)) hit = n;
    });
    if (hit === undefined) throw new Error(`${what} not found in ${path}`);
    return hit;
  };
  return {
    /** Is the outermost node with exactly this text refused for `op`? */
    at: (path: string, text: string, op: string = VMC): boolean =>
      openItemHangRefuses(
        find(path, (n) => n.text === text, text),
        ctx,
        op,
      ),
    /** Is the first statement of procedure `proc` refused? */
    proc: (path: string, proc: string): boolean => {
      const p = find(
        path,
        (n) =>
          n.rawKind === "procedure" &&
          normalizeAlName(n.childForFieldName("name")?.text ?? "") === normalizeAlName(proc),
        `procedure ${proc}`,
      );
      const first = p.childForFieldName("body")?.childForFieldName("body")?.namedChildren[0];
      if (first === undefined) throw new Error(`procedure ${proc} has no statement`);
      return openItemHangRefuses(first, ctx, undefined);
    },
  };
}

// ---------------------------------------------------------------------------------------------
// R531 HOP and R562 FILTER HOP
// ---------------------------------------------------------------------------------------------

const T = `table 50140 "R567 T"
{
    fields
    {
        field(1; "No."; Code[20]) { }
        field(2; Tpl; Code[20]) { }
    }

    procedure TProc(A: Integer)
    begin
        DeleteAll(false);
    end;

    procedure TFilt(A: Integer)
    begin
        SetRange(Tpl, 'TF');
    end;

    procedure TFilt2(A: Integer)
    begin
        SetRange(Tpl, 'TF2');
    end;
}`;

/** Bare calls on the implicit Rec to a procedure of the BASE table (the bare-consumer gate and
 *  `bareRec`), each with a pragma among its arguments. */
const T_EXT = `tableextension 50143 "R567 T Ext" extends "R567 T"
{
    procedure ExtLoop()
    begin
        while FindFirst() do
            TProc(1,
${PRAGMA}
                2);
    end;

    procedure ExtFilter()
    begin
        TFilt(1,
${PRAGMA}
            2);
        while FindFirst() do
            Rename('EF');
    end;
}`;

const MGT = `codeunit 50142 "R567 Mgt"
{
    procedure SetCu(var C: Record "R567 T"; Q: Integer)
    begin
        C.SetRange(Tpl, 'OtherUn');
    end;
}`;

const RUNNERS = `codeunit 50144 "R567 Runner"
{
    TableNo = "R567 T";

    trigger OnRun()
    begin
        SetRange(Tpl, 'RUN1');
    end;
}

codeunit 50145 "R567 Runner2"
{
    TableNo = "R567 T";

    trigger OnRun()
    begin
        SetRange(Tpl, 'RUN2');
    end;
}`;

const CALLER = `codeunit 50141 "R567 C"
{
    procedure RunPragma()
    var
        RN: Record "R567 T";
        RN2: Record "R567 T";
    begin
        Codeunit.Run(Codeunit::"R567 Runner",
${PRAGMA}
            RN);
        while RN.FindFirst() do
            RN.Rename('RN');
        Codeunit.Run(
${PRAGMA}
            Codeunit::"R567 Runner2", RN2);
        while RN2.FindFirst() do
            RN2.Rename('RN2');
    end;

    procedure HopVar()
    var
        R: Record "R567 T";
        O: Record "R567 T";
    begin
        while R.FindFirst() do
            ConsVar(/*c*/ R, O);
    end;

    local procedure ConsVar(var W: Record "R567 T"; V: Record "R567 T")
    begin
        W.SetRange(Tpl, 'HV-W');
        V.SetRange(Tpl, 'HV-V');
    end;

    procedure ArgsZero()
    var
        A0: Record "R567 T";
    begin
        A0.SetRange(/*c*/ Tpl, 'A0');
        while A0.FindFirst() do begin
            A0.Tpl := 'A0-NEW';
            A0.Modify();
        end;
    end;

    procedure ArgsZeroPragma()
    var
        P0: Record "R567 T";
    begin
        P0.SetRange(
${PRAGMA}
            Tpl, 'P0');
        while P0.FindFirst() do begin
            P0.Tpl := 'P0-NEW';
            P0.Modify();
        end;
    end;

    procedure Sibling()
    var
        S: Record "R567 T";
    begin
        SetSib(S /*c*/);
        while S.FindFirst() do
            S.Rename('SIB');
    end;

    local procedure SetSib(var P: Record "R567 T")
    begin
        P.SetRange(Tpl, 'Sib1');
    end;

    local procedure SetSib(var P: Record "R567 T"; Q: Integer)
    begin
        P.SetRange(Tpl, 'Sib2');
    end;

    procedure Unread()
    var
        U: Record "R567 T";
    begin
        SetUn(U,
${PRAGMA}
            1);
        while U.FindFirst() do
            U.Rename('UN');
    end;

    local procedure SetUn(Q: Integer; var P: Record "R567 T")
    begin
        P.SetRange(Tpl, 'Un1');
    end;

    local procedure SetUn(var P: Record "R567 T"; Q: Integer)
    begin
        P.SetRange(Tpl, 'Un2');
    end;

    procedure UnreadOther()
    var
        X: Record "R567 T";
        FM: Codeunit "R567 Mgt";
    begin
        FM.SetCu(X,
${PRAGMA}
            1);
        while X.FindFirst() do
            X.Rename('UO');
    end;

    procedure UnreadHop()
    var
        H: Record "R567 T";
    begin
        while H.FindFirst() do
            ConsUn(1,
${PRAGMA}
                H);
    end;

    local procedure ConsUn(Q: Integer; var W: Record "R567 T")
    begin
        W.SetRange(Tpl, 'CU');
    end;

    procedure UnreadNoHop()
    var
        N: Record "R567 T";
    begin
        SetNo(N,
${PRAGMA}
            1);
        while N.FindFirst() do
            N.Rename('NO');
    end;

    local procedure SetNo(var P: Record "R567 T"; Q: Integer)
    begin
        P.Tpl := 'NO';
    end;

    procedure RecvProcPragma()
    var
        RP: Record "R567 T";
    begin
        RP.TFilt2(1,
${PRAGMA}
            2);
        while RP.FindFirst() do
            RP.Rename('RP');
    end;

    procedure DepPragma()
    var
        D: Record "R567 T";
    begin
        SetDep(D);
        while D.FindFirst() do begin
            D.Tpl := 'DP-NEW';
            D.Modify();
        end;
    end;

    local procedure SetDep(var P: Record "R567 T")
    begin
        P.SetRange(
${PRAGMA}
            "No.", 'DP');
    end;

    procedure ValidatePragma()
    var
        V: Record "R567 T";
    begin
        V.SetRange(Tpl, 'VV');
        while V.FindFirst() do begin
            V.Validate(
${PRAGMA}
                "No.", 'VV-NEW');
            V.Modify();
        end;
    end;

    procedure ModifyAllPragma()
    var
        MA: Record "R567 T";
    begin
        MA.SetRange(Tpl, 'MA');
        while MA.FindFirst() do
            MA.ModifyAll(
${PRAGMA}
                "No.", 'MA-NEW');
    end;

    procedure CopyPragma()
    var
        R2: Record "R567 T";
        CP: Record "R567 T";
    begin
        while R2.FindFirst() do begin
            CP.Copy(
${PRAGMA}
                R2, true);
            CP.Delete();
        end;
    end;
}`;

const FILES = {
  "T.Table.al": T,
  "TExt.TableExt.al": T_EXT,
  "C.Codeunit.al": CALLER,
  "M.Codeunit.al": MGT,
  "Runners.Codeunit.al": RUNNERS,
};
const C = "C.Codeunit.al";

describe("R567: a comment among a call's arguments is not an argument", () => {
  it("HOP: a comment before the receiver maps it to the `var` parameter, which is followed", () => {
    const x = project(FILES);
    expect(x.at(C, "W.SetRange(Tpl, 'HV-W')", RSR)).toBe(true);
    expect(x.at(C, "V.SetRange(Tpl, 'HV-V')", RSR)).toBe(false);
  });
  it("`.args[0]`: `SetRange(/*c*/ Tpl, ...)` is read with field Tpl", () => {
    const x = project(FILES);
    expect(x.at(C, "A0.Modify()")).toBe(true);
    expect(x.at(C, "A0.SetRange(/*c*/ Tpl, 'A0')", RSR)).toBe(true);
  });
  it("an inflated count with a sibling overload: the one-parameter overload is followed", () => {
    const x = project(FILES);
    expect([
      x.at(C, "P.SetRange(Tpl, 'Sib1')", RSR),
      x.at(C, "P.SetRange(Tpl, 'Sib2')", RSR),
    ]).toEqual([true, false]);
  });
});

describe("R567: a #pragma among a call's arguments (unreadable) refuses more", () => {
  it("FILTER HOP same-object: every same-name procedure, whatever its arity, is refused", () => {
    const x = project(FILES);
    expect([
      x.at(C, "P.SetRange(Tpl, 'Un1')", RSR),
      x.at(C, "P.SetRange(Tpl, 'Un2')", RSR),
    ]).toEqual([true, true]);
  });
  it("FILTER HOP other-object: the callee is followed and its filter refused", () => {
    expect(project(FILES).at("M.Codeunit.al", "C.SetRange(Tpl, 'OtherUn')", RSR)).toBe(true);
  });
  it("HOP pass-rec: R is paired with every parameter, so the `var` one is followed", () => {
    expect(project(FILES).at(C, "W.SetRange(Tpl, 'CU')", RSR)).toBe(true);
  });
  it("`.args[0]` is a pragma: the field reads as any field", () => {
    expect(project(FILES).at(C, "P0.Modify()")).toBe(true);
  });
  it("FILTER HOP `depends`: a callee's filter on a pragma-hidden field counts", () => {
    const call = `P.SetRange(\n${PRAGMA}\n            "No.", 'DP')`;
    expect(project(FILES).at(C, call, RSR)).toBe(true);
  });
  it("`Validate` with a pragma-hidden field writes any field: the loop's filter is refused", () => {
    expect(project(FILES).at(C, "V.SetRange(Tpl, 'VV')", RSR)).toBe(true);
  });
  it("`ModifyAll` with a pragma-hidden field writes any field: the loop's filter is refused", () => {
    expect(project(FILES).at(C, "MA.SetRange(Tpl, 'MA')", RSR)).toBe(true);
  });
  it("`Copy` with a pragma among its arguments aliases every argument", () => {
    expect(project(FILES).at(C, "CP.Delete()")).toBe(true);
  });
  it("the uncertain call itself is refused, even where no callee filters", () => {
    expect(project(FILES).at(C, `SetNo(N,\n${PRAGMA}\n            1)`)).toBe(true);
  });
  it("the bare-consumer gate takes any arity: the base table procedure's DeleteAll is refused", () => {
    expect(project(FILES).at("T.Table.al", "DeleteAll(false)")).toBe(true);
  });
  it("FILTER HOP recv-proc (`RP.TFilt2(...)`) takes any arity: the table procedure's filter is refused", () => {
    expect(project(FILES).at("T.Table.al", "SetRange(Tpl, 'TF2')", RSR)).toBe(true);
  });
  it("`Codeunit.Run(X, <pragma> R)`: R at any position reaches the TableNo codeunit's OnRun", () => {
    expect(project(FILES).at("Runners.Codeunit.al", "SetRange(Tpl, 'RUN1')", RSR)).toBe(true);
  });
  it("`Codeunit.Run(<pragma> X, R)`: the codeunit id is unknown, so any TableNo codeunit", () => {
    expect(project(FILES).at("Runners.Codeunit.al", "SetRange(Tpl, 'RUN2')", RSR)).toBe(true);
  });
  it("`bareRec` takes any arity: the base table procedure's filter is refused", () => {
    expect(project(FILES).at("T.Table.al", "SetRange(Tpl, 'TF')", RSR)).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// R500 shape 1: preset exit names (`directWrite`, the open-item write scan)
// ---------------------------------------------------------------------------------------------

const MEMO = `report 50160 "R567 Memo"
{
    dataset
    {
        dataitem(Lp; Integer)
        {
            trigger OnAfterGetRecord()
            begin
                if not Continue then
                    CurrReport.Break();
                if Stop2 then
                    CurrReport.Break();
                if Lim > 3 then
                    CurrReport.Break();
                if Lim2 > 3 then
                    CurrReport.Break();
                Two(/*c*/ Lim, Other);
                Two(
${PRAGMA}
                    Lim2, Other2);
            end;
        }
    }

    trigger OnPreReport()
    begin
        SetIt(/*c*/ Continue);
        SetIt(
${PRAGMA}
            Stop2);
        Lim := 5;
        Lim2 := 6;
    end;

    local procedure SetIt(var Value: Boolean)
    begin
        Value := true;
    end;

    local procedure Two(A: Integer; var B: Integer)
    begin
        B := A;
    end;

    var
        Continue: Boolean;
        Stop2: Boolean;
        Lim: Integer;
        Lim2: Integer;
        Other: Integer;
        Other2: Integer;
}`;

describe("R567: preset exit names read arguments past a comment", () => {
  const M = "Memo.al";
  it("`directWrite`: `SetIt(/*c*/ Continue)` to a `var` parameter writes the preset name: refused", () => {
    expect(project({ [M]: MEMO }).at(M, "SetIt(/*c*/ Continue)")).toBe(true);
  });
  it("the open-item write scan: `Two(/*c*/ Lim, ...)` passes Lim by value, so Lim stays preset", () => {
    expect(project({ [M]: MEMO }).at(M, "Lim := 5")).toBe(true);
  });
  it("`directWrite` unreadable: an identifier argument counts as writing", () => {
    expect(project({ [M]: MEMO }).at(M, `SetIt(\n${PRAGMA}\n            Stop2)`)).toBe(true);
  });
  it("the open-item write scan unreadable: no argument counts as written, so Lim2 stays preset", () => {
    expect(project({ [M]: MEMO }).at(M, "Lim2 := 6")).toBe(true);
  });
});

const BOUND = `report 50170 "R567 Bound"
{
    dataset
    {
        dataitem(Cm; Integer)
        {
            trigger OnPreDataItem()
            begin
                SetRange(Number, 1, /*c*/ 4);
            end;

            trigger OnAfterGetRecord()
            begin
                Seen := Seen + 1;
            end;
        }
        dataitem(Rd; Integer)
        {
            trigger OnPreDataItem()
            begin
                Buf.SetRange(/*c*/ Cap, 1);
            end;

            trigger OnAfterGetRecord()
            begin
                if Total > 5 then
                    CurrReport.Break();
            end;
        }
    }

    trigger OnPreReport()
    begin
        Cap := 3;
    end;

    var
        Total: Integer;
        Seen: Integer;
        Cap: Integer;
        Buf: Record Customer temporary;
}`;

describe("R567: SetRange bounds and reads past a comment", () => {
  const B = "Bound.al";
  it("literal bounds: `SetRange(Number, 1, /*c*/ 4)` bounds the item, so its body emits", () => {
    expect(project({ [B]: BOUND }).at(B, "Seen := Seen + 1")).toBe(false);
  });
  it("the read scan: a comment before the field does not make the field a read name", () => {
    expect(project({ [B]: BOUND }).at(B, "Cap := 3")).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// R500 shape 2: event subscribers (`subscriberKey`, `attributesOf`)
// ---------------------------------------------------------------------------------------------

const WALK = `report 50150 "R567 Walk"
{
    dataset
    {
        dataitem(Loop; Integer)
        {
            trigger OnAfterGetRecord()
            begin
                OnStep(Done);
                OnStep2(Done);
                if Done then
                    CurrReport.Break();
            end;
        }
    }

    [IntegrationEvent(false, false)]
    local procedure OnStep(var IsDone: Boolean)
    begin
    end;

    [IntegrationEvent(false, false)]
    // a comment between the attribute and the procedure
    local procedure OnStep2(var IsDone: Boolean)
    begin
    end;

    [IntegrationEvent(false, false)]
    local procedure OnQuiet(var IsDone: Boolean)
    begin
    end;

    var
        Done: Boolean;
}`;

const SUBS = `codeunit 50151 "R567 Subs"
{
    [EventSubscriber(ObjectType::Report, /*c*/ Report::"R567 Walk", OnStep, '', false, false)]
    local procedure CommentSub(var IsDone: Boolean)
    begin
        IsDone := true;
    end;

    [EventSubscriber(ObjectType::Report,
${PRAGMA}
        Report::"R567 Walk", OnStep, '', false, false)]
    local procedure PragmaSub(var IsDone: Boolean)
    begin
        IsDone := true;
    end;

    [EventSubscriber(ObjectType::Report, Report::"R567 Walk", OnStep, '', false, false)]
    // a comment between the attribute and the procedure
${PRAGMA}
    local procedure SiblingSub(var IsDone: Boolean)
    begin
        IsDone := true;
    end;

    [EventSubscriber(ObjectType::Report, Report::"R567 Walk", OnStep2, '', false, false)]
    local procedure PublisherCommentSub(var IsDone: Boolean)
    begin
        IsDone := true;
    end;

    [EventSubscriber(ObjectType::Report, Report::"R567 Walk", OnQuiet, '', false, false)]
    local procedure QuietSub(var IsDone: Boolean)
    begin
        IsDone := true;
    end;
}`;

describe("R567: event subscribers read their attribute past a comment", () => {
  const p = () => project({ "Walk.al": WALK, "Subs.al": SUBS });
  it("control: a subscriber of an event nothing open raises emits", () => {
    expect(p().proc("Subs.al", "QuietSub")).toBe(false);
  });
  it("`subscriberKey`: a comment before the object reference still finds the edge", () => {
    expect(p().proc("Subs.al", "CommentSub")).toBe(true);
  });
  it("`subscriberKey` unreadable: the subscriber is reached by any raised event", () => {
    expect(p().proc("Subs.al", "PragmaSub")).toBe(true);
  });
  it("`attributesOf`: a comment and a pragma between `[EventSubscriber]` and the procedure", () => {
    expect(p().proc("Subs.al", "SiblingSub")).toBe(true);
  });
  it("`attributesOf`: a comment between `[IntegrationEvent]` and the publisher", () => {
    expect(p().proc("Subs.al", "PublisherCommentSub")).toBe(true);
  });
});
