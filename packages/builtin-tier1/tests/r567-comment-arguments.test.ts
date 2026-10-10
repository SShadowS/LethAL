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
}`;

const MGT = `codeunit 50142 "R567 Mgt"
{
    procedure SetCu(var C: Record "R567 T"; Q: Integer)
    begin
        C.SetRange(Tpl, 'OtherUn');
    end;
}`;

const CALLER = `codeunit 50141 "R567 C"
{
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
            ConsUn(H,
${PRAGMA}
                1);
    end;

    local procedure ConsUn(var W: Record "R567 T"; Q: Integer)
    begin
        W.SetRange(Tpl, 'CU');
    end;
}`;

const FILES = { "T.Table.al": T, "C.Codeunit.al": CALLER, "M.Codeunit.al": MGT };
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
        Cap: Integer;
        Buf: Record Customer temporary;
}`;

describe("R567: SetRange bounds and reads past a comment", () => {
  const B = "Bound.al";
  it("literal bounds: `SetRange(Number, 1, /*c*/ 4)` is the item's literal bound (its 4 is refused)", () => {
    expect(project({ [B]: BOUND }).at(B, "4")).toBe(true);
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
