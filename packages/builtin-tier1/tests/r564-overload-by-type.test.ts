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
 * R564 (coord task R-564): a HOP (R531) or FILTER HOP (R562) follows only the overload a call's
 * argument TYPES choose, when that is certain: no candidate is `#if`-split, every argument is a
 * record of a resolved project table, every parameter of every candidate is a `Record` of a
 * resolved project table, exactly one candidate matches at every position and every other differs
 * at some position. Otherwise every overload that fits by parameter count is followed, as before.
 * Tables are compared by IDENTITY, never by spelling. Every test was red-checked one direction at a
 * time; the red checks are recorded in `/coord/handoff/R-564/redcheck.md`.
 */

beforeAll(async () => {
  await initParser();
});

const VMC = "lethal.void-method-call";
const RSR = "lethal.remove-setrange";

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

/** The caller side: each procedure passes `xRec` (or a local) to an `Att` procedure before a
 *  `Rename` loop on `Att`, so every pre-loop filter the callee sets is one the loop depends on. */
const LINE = `table 50120 "R564 Line"
{
    fields
    {
        field(1; "No."; Code[20]) { }
        field(2; Tpl; Code[20]) { }
    }

    trigger OnRename()
    var
        Att: Record "R564 Att";
    begin
        Att.SetTemplateFilter(xRec);
        while Att.FindFirst() do
            Att.Rename('T1');
    end;

    procedure UnknownArgs()
    var
        Att: Record "R564 Att";
        RR: RecordRef;
    begin
        Att.SetF2(xRec, RR);
        Att.SetF2b(xRec, xRec.Tpl);
        while Att.FindFirst() do
            Att.Rename('T2');
    end;

    procedure Shapes()
    var
        Att: Record "R564 Att";
    begin
        Att.SetF3(xRec);
        Att.SetF4(xRec);
        Att.SetF7(xRec, 5);
        Att.SetF9(xRec);
        Att.SetF9b(xRec);
        Att.SetF10(xRec);
        Att.SetF12(xRec);
        while Att.FindFirst() do
            Att.Rename('T3');
    end;

    procedure Spellings()
    var
        Att: Record "R564 Att";
        ById: Record 50120;
        Qual: Record Other.Ns."R564 Line";
    begin
        Att.SetF8a(ById);
        Att.SetF8p(ById);
        Att.SetF8b(xRec);
        Att.SetF8q(xRec);
        Att.SetF8c(Qual);
        while Att.FindFirst() do
            Att.Rename('T8');
    end;

    procedure Amb()
    var
        Att: Record "R564 Att";
#if A
        Rec: Record "R564 Other";
#endif
    begin
        Att.SetF13(Rec);
        while Att.FindFirst() do
            Att.Rename('T13');
    end;

    procedure ExtSite()
    var
        Att: Record "R564 Att";
    begin
        Att.SetExtF(xRec);
        while Att.FindFirst() do
            Att.Rename('T11E');
    end;

    procedure HopTable()
    var
        Att: Record "R564 Att";
    begin
        while Att.FindFirst() do
            Att.ConsumeF(xRec);
    end;

    procedure Comments()
    var
        Att: Record "R564 Att";
    begin
        Att.SetCm(xRec /*c*/);
        while Att.FindFirst() do
            Att.Rename('CM');
    end;

    procedure HopTableComment()
    var
        Att: Record "R564 Att";
    begin
        while Att.FindFirst() do
            Att.ConsumeCm(xRec /*c*/);
    end;
}`;

const OTHER = `table 50121 "R564 Other"
{
    fields
    {
        field(1; Code; Code[20]) { }
    }
}`;

const ATT = `table 50122 "R564 Att"
{
    fields
    {
        field(1; "No."; Code[20]) { }
        field(2; Tpl; Code[20]) { }
    }

    procedure SetTemplateFilter(L: Record "R564 Line")
    begin
        SetRange(Tpl, 'T1L');
    end;

    procedure SetTemplateFilter(O: Record "R564 Other")
    begin
        SetRange(Tpl, 'T1O');
    end;

    procedure SetF2(L: Record "R564 Line"; X: Record "R564 Line")
    begin
        SetRange(Tpl, 'T2L');
    end;

    procedure SetF2(O: Record "R564 Other"; X: Record "R564 Line")
    begin
        SetRange(Tpl, 'T2O');
    end;

    procedure SetF2b(L: Record "R564 Line"; X: Record "R564 Line")
    begin
        SetRange(Tpl, 'T2bL');
    end;

    procedure SetF2b(O: Record "R564 Other"; X: Record "R564 Line")
    begin
        SetRange(Tpl, 'T2bO');
    end;

    procedure SetF3(L: Record "R564 Line")
    begin
        SetRange(Tpl, 'T3L');
    end;

    procedure SetF3(V: Variant)
    begin
        SetRange(Tpl, 'T3V');
    end;

    procedure SetF4(O: Record "R564 Other")
    begin
        SetRange(Tpl, 'T4O');
    end;

    procedure SetF4(A: Record "R564 Att")
    begin
        SetRange(Tpl, 'T4A');
    end;

    procedure SetF7(L: Record "R564 Line"; N: Integer)
    begin
        SetRange(Tpl, 'T7L');
    end;

    procedure SetF7(O: Record "R564 Other"; N: Integer)
    begin
        SetRange(Tpl, 'T7O');
    end;

    procedure SetF8a(L: Record "R564 Line")
    begin
        SetRange(Tpl, 'T8aL');
    end;

    procedure SetF8a(V: Variant)
    begin
        SetRange(Tpl, 'T8aV');
    end;

    procedure SetF8p(L: Record "R564 Line")
    begin
        SetRange(Tpl, 'T8pL');
    end;

    procedure SetF8p(O: Record "R564 Other")
    begin
        SetRange(Tpl, 'T8pO');
    end;

    procedure SetF8b(L: Record 50120)
    begin
        SetRange(Tpl, 'T8bL');
    end;

    procedure SetF8b(V: Variant)
    begin
        SetRange(Tpl, 'T8bV');
    end;

    procedure SetF8q(L: Record 50120)
    begin
        SetRange(Tpl, 'T8qL');
    end;

    procedure SetF8q(O: Record "R564 Other")
    begin
        SetRange(Tpl, 'T8qO');
    end;

    procedure SetF8c(L: Record "R564 Line")
    begin
        SetRange(Tpl, 'T8cL');
    end;

    procedure SetF8c(V: Variant)
    begin
        SetRange(Tpl, 'T8cV');
    end;

    procedure SetF8d(L: Record "R564 Line")
    begin
        SetRange(Tpl, 'T8dL');
    end;

    procedure SetF8d(V: Variant)
    begin
        SetRange(Tpl, 'T8dV');
    end;

    procedure SetF8e(L: Record "R564 Line")
    begin
        SetRange(Tpl, 'T8eL');
    end;

    procedure SetF8e(O: Record "R564 Other")
    begin
        SetRange(Tpl, 'T8eO');
    end;

#if A
    procedure SetF9(O: Record "R564 Other")
#else
    procedure SetF9(L: Record "R564 Line")
#endif
    begin
        SetRange(Tpl, 'T9S');
    end;

#if A
    procedure SetF9(L: Record "R564 Line")
    begin
        SetRange(Tpl, 'T9P');
    end;
#endif

    procedure SetF9b(
#if A
        O: Record "R564 Other"
#else
        L: Record "R564 Line"
#endif
    )
    begin
        SetRange(Tpl, 'T9bS');
    end;

#if A
    procedure SetF9b(L: Record "R564 Line")
    begin
        SetRange(Tpl, 'T9bP');
    end;
#endif

    procedure SetF10(RR: RecordRef)
    begin
        SetRange(Tpl, 'T10R');
    end;

    procedure SetF10(V: Variant)
    begin
        SetRange(Tpl, 'T10V');
    end;

    procedure SetF10(L: Record "R564 Line")
    begin
        SetRange(Tpl, 'T10L');
    end;

    procedure SetF12(L: Record "R564 Line")
    begin
        SetRange(Tpl, 'T12A');
    end;

    procedure SetF12(L2: Record 50120)
    begin
        SetRange(Tpl, 'T12B');
    end;

    procedure SetF12(O: Record "R564 Other")
    begin
        SetRange(Tpl, 'T12O');
    end;

    procedure SetF13(L: Record "R564 Line")
    begin
        SetRange(Tpl, 'T13L');
    end;

    procedure SetF13(O: Record "R564 Other")
    begin
        SetRange(Tpl, 'T13O');
    end;

    procedure ConsumeF(L: Record "R564 Line")
    begin
        Delete(false);
    end;

    procedure ConsumeF(O: Record "R564 Other")
    begin
        Delete(true);
    end;

    procedure SetCm(L: Record "R564 Line")
    begin
        SetRange(Tpl, 'CmL');
    end;

    procedure SetCm(O: Record "R564 Other")
    begin
        SetRange(Tpl, 'CmO');
    end;

    procedure ConsumeCm(L: Record "R564 Line")
    begin
        DeleteAll(false);
    end;

    procedure ConsumeCm(O: Record "R564 Other")
    begin
        DeleteAll(true);
    end;
}`;

/** T8: `xRec` in a tableextension whose `extends` is qualified. */
const LINE_EXT = `tableextension 50123 "R564 Line Ext" extends Lethal.Test."R564 Line"
{
    procedure ExtCall()
    var
        Att: Record "R564 Att";
    begin
        Att.SetF8d(xRec);
        Att.SetF8e(xRec);
        while Att.FindFirst() do
            Att.Rename('T8d');
    end;
}`;

/** T11: the overloads live in a tableextension of the called record's table. */
const ATT_EXT = `tableextension 50124 "R564 Att Ext" extends "R564 Att"
{
    procedure SetExtF(L: Record "R564 Line")
    begin
        SetRange(Tpl, 'T11EL');
    end;

    procedure SetExtF(O: Record "R564 Other")
    begin
        SetRange(Tpl, 'T11EO');
    end;
}`;

const FILTER_MGT = `codeunit 50125 "R564 Filter Mgt"
{
    procedure SetCu(var C: Record "R564 Line"; L: Record "R564 Line")
    begin
        C.SetRange(Tpl, 'T11CL');
    end;

    procedure SetCu(var C: Record "R564 Line"; O: Record "R564 Other")
    begin
        C.SetRange(Tpl, 'T11CO');
    end;

    procedure SetCuCm(var C: Record "R564 Line"; L: Record "R564 Line")
    begin
        C.SetRange(Tpl, 'CmCL');
    end;

    procedure SetCuCm(var C: Record "R564 Line"; O: Record "R564 Other")
    begin
        C.SetRange(Tpl, 'CmCO');
    end;
}`;

const CALLER = `codeunit 50126 "R564 Caller"
{
    procedure SameObj(Src: Record "R564 Line")
    var
        S: Record "R564 Line";
    begin
        SetSame(S, Src);
        while S.FindFirst() do
            S.Rename('T6');
    end;

    local procedure SetSame(var P: Record "R564 Line"; L: Record "R564 Line")
    begin
        P.SetRange(Tpl, 'T6L');
    end;

    local procedure SetSame(var P: Record "R564 Line"; O: Record "R564 Other")
    begin
        P.SetRange(Tpl, 'T6O');
    end;

    procedure CuPath(Src: Record "R564 Line")
    var
        C: Record "R564 Line";
        FM: Codeunit "R564 Filter Mgt";
    begin
        FM.SetCu(C, Src);
        while C.FindFirst() do
            C.Rename('T11C');
    end;

    procedure HopSame(Src: Record "R564 Line")
    var
        H: Record "R564 Line";
    begin
        while H.FindFirst() do
            Consume(H, Src);
    end;

    local procedure Consume(var W: Record "R564 Line"; L: Record "R564 Line")
    begin
        W.Delete(false);
    end;

    local procedure Consume(var W: Record "R564 Line"; O: Record "R564 Other")
    begin
        W.Delete(true);
    end;

    procedure SameObjComment(Src: Record "R564 Line")
    var
        S2: Record "R564 Line";
    begin
        SetSameCm(S2, Src /*c*/);
        while S2.FindFirst() do
            S2.Rename('CmS');
    end;

    local procedure SetSameCm(var P: Record "R564 Line"; L: Record "R564 Line")
    begin
        P.SetRange(Tpl, 'CmSL');
    end;

    local procedure SetSameCm(var P: Record "R564 Line"; O: Record "R564 Other")
    begin
        P.SetRange(Tpl, 'CmSO');
    end;

    procedure CuPathComment(Src: Record "R564 Line")
    var
        C2: Record "R564 Line";
        FM: Codeunit "R564 Filter Mgt";
    begin
        FM.SetCuCm(C2, Src /*c*/);
        while C2.FindFirst() do
            C2.Rename('CmC');
    end;

    procedure HopSameComment(Src: Record "R564 Line")
    var
        H2: Record "R564 Line";
    begin
        while H2.FindFirst() do
            ConsumeCm(H2, Src /*c*/);
    end;

    local procedure ConsumeCm(var W: Record "R564 Line"; L: Record "R564 Line")
    begin
        W.DeleteAll(false);
    end;

    local procedure ConsumeCm(var W: Record "R564 Line"; O: Record "R564 Other")
    begin
        W.DeleteAll(true);
    end;
}`;

const FILES = {
  "Line.Table.al": LINE,
  "Other.Table.al": OTHER,
  "Att.Table.al": ATT,
  "LineExt.TableExt.al": LINE_EXT,
  "AttExt.TableExt.al": ATT_EXT,
  "FilterMgt.Codeunit.al": FILTER_MGT,
  "Caller.Codeunit.al": CALLER,
};
const A = "Att.Table.al";
const C = "Caller.Codeunit.al";
const M = "FilterMgt.Codeunit.al";

/** [refused?] of the two `SetRange(Tpl, '<tag>')` sites, in order. */
const both = (tags: string[], path = A): boolean[] => {
  const refused = project(FILES);
  return tags.map((t) => refused(path, `SetRange(Tpl, '${t}')`, RSR));
};

describe("R564: an overload the argument types rule out is not followed", () => {
  it("T1, type picks one (R562 recv-proc, DO's `SetTemplateFilter(xRec)` in OnRename)", () => {
    expect(both(["T1L", "T1O"])).toEqual([true, false]);
  });
  it("T5, the R531 consumer HOP's same-object path: only the chosen overload's Delete is refused", () => {
    const refused = project(FILES);
    expect(refused(C, "W.Delete(false)")).toBe(true);
    expect(refused(C, "W.Delete(true)")).toBe(false);
  });
  it("T6, the R562 same-object path", () => {
    const refused = project(FILES);
    expect(refused(C, "P.SetRange(Tpl, 'T6L')", RSR)).toBe(true);
    expect(refused(C, "P.SetRange(Tpl, 'T6O')", RSR)).toBe(false);
  });
  it("T11, the R562 table/codeunit path (a project codeunit's VAR parameter)", () => {
    const refused = project(FILES);
    expect(refused(M, "C.SetRange(Tpl, 'T11CL')", RSR)).toBe(true);
    expect(refused(M, "C.SetRange(Tpl, 'T11CO')", RSR)).toBe(false);
  });
  it("T11, `r531TableProcs` over a tableextension of the table (R562)", () => {
    expect(both(["T11EL", "T11EO"], "AttExt.TableExt.al")).toEqual([true, false]);
  });
  it("T11, `r531TableProcs` on the R531 consumer HOP (`Att.ConsumeF(xRec)` in the loop)", () => {
    const refused = project(FILES);
    expect(refused(A, "Delete(false)")).toBe(true);
    expect(refused(A, "Delete(true)")).toBe(false);
  });
  it("T8, identity not spelling: an argument by id against a parameter by name narrows", () => {
    expect(both(["T8pL", "T8pO"])).toEqual([true, false]);
  });
  it("T8, identity not spelling: an argument by name against a parameter by id narrows", () => {
    expect(both(["T8qL", "T8qO"])).toEqual([true, false]);
  });
});

describe("R564: every overload is kept unless the choice is certain", () => {
  it("T2, an unknown argument (a RecordRef variable, a field) keeps all", () => {
    expect(both(["T2L", "T2O", "T2bL", "T2bO"])).toEqual([true, true, true, true]);
  });
  it("T3, Record beside Variant: both are kept", () => {
    expect(both(["T3L", "T3V"])).toEqual([true, true]);
  });
  it("T4, no overload matches (a resolution gap): all are kept", () => {
    expect(both(["T4O", "T4A"])).toEqual([true, true]);
  });
  it("T7, two arguments, the second an Integer literal: all are kept", () => {
    expect(both(["T7L", "T7O"])).toEqual([true, true]);
  });
  it("T8, an argument by id against a parameter by name, Variant sibling: both kept", () => {
    expect(both(["T8aL", "T8aV"])).toEqual([true, true]);
  });
  it("T8, an argument by name against a parameter by id, Variant sibling: both kept", () => {
    expect(both(["T8bL", "T8bV"])).toEqual([true, true]);
  });
  it("T8, a qualified argument type against an unqualified parameter, Variant sibling: both kept", () => {
    expect(both(["T8cL", "T8cV"])).toEqual([true, true]);
  });
  it("T8, `xRec` in a tableextension with a qualified `extends`, Variant sibling: both kept", () => {
    expect(both(["T8dL", "T8dV"])).toEqual([true, true]);
  });
  it("T8, `xRec` under a qualified `extends` (an ERROR in the parse) is unknown: both Records kept", () => {
    expect(both(["T8eL", "T8eO"])).toEqual([true, true]);
  });
  it("T9, a `#if`-split candidate keeps all", () => {
    expect(both(["T9S", "T9P"])).toEqual([true, true]);
  });
  it("T9, a `#if` inside a candidate's parentheses (ERROR siblings in the parse) keeps all", () => {
    expect(both(["T9bS", "T9bP"])).toEqual([true, true]);
  });
  it("T10, RecordRef and Variant beside a matching Record: all kept", () => {
    expect(both(["T10R", "T10V", "T10L"])).toEqual([true, true, true]);
  });
  it("T12, two candidates match (the same table by name and by id): all kept, not the two", () => {
    expect(both(["T12A", "T12B", "T12O"])).toEqual([true, true, true]);
  });
  it("T13, an `#if`-ambiguous local `Rec` argument keeps all (not the implicit record)", () => {
    expect(both(["T13L", "T13O"])).toEqual([true, true]);
  });
});

describe("R564: a table name two project tables share resolves to neither", () => {
  it('`Record "R564 Dup"` against `Record 50130` and `Record 50131`: both kept', () => {
    const refused = project({
      "DupA.Table.al": `namespace R564.One;
table 50130 "R564 Dup"
{
    fields { field(1; K; Code[20]) { } }
}`,
      "DupB.Table.al": `namespace R564.Two;
table 50131 "R564 Dup"
{
    fields { field(1; K; Code[20]) { } }
}`,
      "Holder.Table.al": `table 50132 "R564 Holder"
{
    fields
    {
        field(1; "No."; Code[20]) { }
        field(2; Tpl; Code[20]) { }
    }

    procedure SetD(X: Record 50130)
    begin
        SetRange(Tpl, 'DA');
    end;

    procedure SetD(Y: Record 50131)
    begin
        SetRange(Tpl, 'DB');
    end;
}`,
      "DupCaller.Codeunit.al": `codeunit 50133 "R564 Dup Caller"
{
    procedure Run()
    var
        D: Record "R564 Dup";
        H: Record "R564 Holder";
    begin
        H.SetD(D);
        while H.FindFirst() do
            H.Rename('D');
    end;
}`,
    });
    expect(refused("Holder.Table.al", "SetRange(Tpl, 'DA')", RSR)).toBe(true);
    expect(refused("Holder.Table.al", "SetRange(Tpl, 'DB')", RSR)).toBe(true);
  });
});

// `r531Call` counts a comment inside the argument list as an argument, so `F(xRec /*c*/)` fits no
// one-parameter overload. These pin today's behaviour at each call site; the narrowing never sees
// such a call (it needs two candidates). Where a site then follows nothing, see R567.
describe("R564: a comment among the arguments keeps today's behaviour", () => {
  it("R562 recv-proc (`r531TableProcs`): the call is refused, the callee's filters are not", () => {
    const refused = project(FILES);
    expect(refused("Line.Table.al", "Att.SetCm(xRec /*c*/)")).toBe(true);
    expect(both(["CmL", "CmO"])).toEqual([false, false]);
  });
  it("R562 same-object: the call is refused, the callee's filters are not", () => {
    const refused = project(FILES);
    expect(refused(C, "SetSameCm(S2, Src /*c*/)")).toBe(true);
    expect(refused(C, "P.SetRange(Tpl, 'CmSL')", RSR)).toBe(false);
    expect(refused(C, "P.SetRange(Tpl, 'CmSO')", RSR)).toBe(false);
  });
  it("R562 table/codeunit: the call is refused, the callee's filters are not", () => {
    const refused = project(FILES);
    expect(refused(C, "FM.SetCuCm(C2, Src /*c*/)")).toBe(true);
    expect(refused(M, "C.SetRange(Tpl, 'CmCL')", RSR)).toBe(false);
    expect(refused(M, "C.SetRange(Tpl, 'CmCO')", RSR)).toBe(false);
  });
  it("R531 HOP, recv-proc and same-object: the call is refused, the callees' consumers are not", () => {
    const refused = project(FILES);
    expect(refused("Line.Table.al", "Att.ConsumeCm(xRec /*c*/)")).toBe(true);
    expect(refused(A, "DeleteAll(false)")).toBe(false);
    expect(refused(A, "DeleteAll(true)")).toBe(false);
    expect(refused(C, "ConsumeCm(H2, Src /*c*/)")).toBe(true);
    expect(refused(C, "W.DeleteAll(false)")).toBe(false);
    expect(refused(C, "W.DeleteAll(true)")).toBe(false);
  });
});
