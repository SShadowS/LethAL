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
import { r531Analyze } from "../src/loop-hazard";

/**
 * R531 (coord task R-531): a loop whose cursor condition (`Find*`, `IsEmpty`, `Count`, never
 * `Next`) ends only because its body consumes the record set is hang-refused for every operator.
 * One test per consumer kind asserts the kind LABEL; the rest pin each refusal part and its
 * control. Every test was red-checked one direction at a time; the red checks are recorded in the
 * R-531 build log.
 */

beforeAll(async () => {
  await initParser();
});

const VMC = "lethal.void-method-call";

function project(files: Record<string, string>) {
  const parsed = Object.entries(files).map(([path, src]) => ({
    path,
    root: wrapRoot(parseAL(src)),
  }));
  const ctx = buildSemanticContext(parsed);
  const find = (
    path: string,
    pred: (n: ALSyntaxNode) => boolean,
    what: string,
    nth = 1,
  ): ALSyntaxNode => {
    const f = parsed.find((p) => p.path === path);
    if (f === undefined) throw new Error(`no file ${path}`);
    const hits: ALSyntaxNode[] = [];
    visit(f.root, (n: ALSyntaxNode) => {
      // the outermost node of each occurrence: skip a node inside the previous hit
      const last = hits[hits.length - 1];
      if (last !== undefined && n.startIndex < last.endIndex) return;
      if (pred(n)) hits.push(n);
    });
    const hit = hits[nth - 1];
    if (hit === undefined) throw new Error(`${what} #${nth} not found in ${path}`);
    return hit;
  };
  return {
    /** Is the `nth` outermost node with exactly this text refused for `op`? */
    refused: (path: string, text: string, op: string | undefined = VMC, nth = 1): boolean =>
      openItemHangRefuses(
        find(path, (n) => n.text === text, text, nth),
        ctx,
        op,
      ),
    /** The consumer kind labels of the loop whose text starts with `head` ([] when not the shape). */
    kinds: (path: string, head: string): string[] => {
      const loop = find(
        path,
        (n) =>
          (n.rawKind === "while_statement" || n.rawKind === "repeat_statement") &&
          n.text.startsWith(head),
        head,
      );
      return r531Analyze(loop, ctx)?.kinds ?? [];
    },
  };
}

const LINE = `table 50100 "R531 Line"
{
    fields
    {
        field(1; "No."; Code[20]) { }
        field(2; Name; Code[20]) { }
        field(3; Qty; Integer) { }
    }

    procedure Consume()
    begin
        Delete();
    end;
}`;

/** One procedure per consumer kind, plus the Next, exit/Error and after-the-loop controls. */
const KINDS = `codeunit 50101 "R531 Kinds"
{
    var
        Glob: Record "R531 Line";
        GlobCall: Record "R531 Line";

    procedure KDelete()
    var
        Del: Record "R531 Line";
        After: Record "R531 Line";
    begin
        while Del.FindFirst() do begin
            if Del.Qty < 0 then
                Error('negative');
            if Del.Qty > 100 then
                exit;
            if Del.Qty > 0 then
                Del.Delete();
        end;
        After.Name := 'Z';
    end;

    procedure KDeleteAll()
    var
        DA: Record "R531 Line";
    begin
        while DA.FindFirst() do
            DA.DeleteAll();
    end;

    procedure KRename(NewName: Code[20])
    var
        Rn: Record "R531 Line";
    begin
        while Rn.FindFirst() do
            Rn.Rename(NewName);
    end;

    procedure KRefilter()
    var
        St: Record "R531 Line";
        Last: Code[20];
    begin
        while St.FindFirst() do begin
            Last := St."No.";
            St.SetFilter("No.", '>%1', Last);
        end;
    end;

    procedure KMark()
    var
        Mk: Record "R531 Line";
    begin
        Mk.MarkedOnly(true);
        while Mk.FindFirst() do
            Mk.Mark(false);
    end;

    procedure KModifyFiltered()
    var
        MF: Record "R531 Line";
    begin
        MF.SetRange(Qty, 0);
        while MF.FindFirst() do begin
            MF.Qty := 1;
            MF.Modify();
        end;
    end;

    procedure KModifyUnseen(var MU: Record "R531 Line")
    begin
        while MU.FindFirst() do begin
            MU.Qty := 1;
            MU.Modify();
        end;
    end;

    procedure KModifyAll()
    begin
        Glob.SetRange(Name, 'A');
        while Glob.FindFirst() do begin
            Glob.Qty := 2;
            Glob.Modify();
        end;
    end;

    procedure KReinsert()
    var
        RI: Record "R531 Line";
    begin
        RI.SetRange("No.", 'OLD');
        while RI.FindFirst() do begin
            RI.Delete();
            RI."No." := 'NEW';
            RI.Insert();
        end;
    end;

    procedure KPassRec()
    var
        PR: Record "R531 Line";
        Handler: Codeunit "R531 Other";
    begin
        while PR.FindFirst() do
            Handler.Take(PR);
    end;

    procedure KRecvProc()
    var
        RP: Record "R531 Line";
    begin
        while RP.FindFirst() do
            RP.Consume();
    end;

    procedure KGlobalCall()
    begin
        while GlobCall.FindFirst() do
            DropGlobCall();
    end;

    local procedure DropGlobCall()
    begin
        GlobCall.Delete();
    end;

    procedure KAlias()
    var
        A1: Record "R531 Line";
        A2: Record "R531 Line";
    begin
        A2 := A1;
        while A1.FindFirst() do
            A2.Delete();
    end;

    procedure KNext()
    var
        Nx: Record "R531 Line";
    begin
        if Nx.FindSet() then
            repeat
                Nx.Delete();
            until Nx.Next() = 0;
    end;
}`;

const OTHER = `codeunit 50102 "R531 Other"
{
    procedure Take(var L: Record "R531 Line")
    begin
    end;
}`;

const KFILES = { "Line.Table.al": LINE, "Kinds.Codeunit.al": KINDS, "Other.Codeunit.al": OTHER };

describe("R531: one consumer kind per loop, by label", () => {
  const files = { "Line.Table.al": LINE, "Kinds.Codeunit.al": KINDS, "Other.Codeunit.al": OTHER };
  const K = "Kinds.Codeunit.al";
  it("Delete", () => {
    expect(project(files).kinds(K, "while Del.FindFirst()")).toEqual(["delete"]);
  });
  it("DeleteAll", () => {
    expect(project(files).kinds(K, "while DA.FindFirst()")).toEqual(["deleteall"]);
  });
  it("Rename", () => {
    expect(project(files).kinds(K, "while Rn.FindFirst()")).toEqual(["rename"]);
  });
  it("refilter", () => {
    expect(project(files).kinds(K, "while St.FindFirst()")).toEqual(["refilter"]);
  });
  it("mark", () => {
    expect(project(files).kinds(K, "while Mk.FindFirst()")).toEqual(["mark"]);
  });
  it("modify-filtered", () => {
    expect(project(files).kinds(K, "while MF.FindFirst()")).toEqual(["modify-filtered"]);
  });
  it("modify-unseen", () => {
    expect(project(files).kinds(K, "while MU.FindFirst()")).toEqual(["modify-unseen"]);
  });
  it("delete-reinsert", () => {
    expect(project(files).kinds(K, "while RI.FindFirst()")).toEqual(["delete", "delete-reinsert"]);
  });
  it("pass-rec", () => {
    expect(project(files).kinds(K, "while PR.FindFirst()")).toEqual(["pass-rec"]);
  });
  it("recv-proc", () => {
    expect(project(files).kinds(K, "while RP.FindFirst()")).toEqual(["recv-proc"]);
  });
  it("global-call", () => {
    expect(project(files).kinds(K, "while GlobCall.FindFirst()")).toEqual(["global-call"]);
  });
  it("alias (A2 := A1, then A2.Delete())", () => {
    expect(project(files).kinds(K, "while A1.FindFirst()")).toEqual(["alias", "delete"]);
  });
});

describe("R531 BASE: the consumer, its block and its guard are refused; controls are not", () => {
  const files = { "Line.Table.al": LINE, "Kinds.Codeunit.al": KINDS, "Other.Codeunit.al": OTHER };
  const K = "Kinds.Codeunit.al";
  it("refuses the Delete call and the guard deciding whether it runs", () => {
    const p = project(files);
    expect(p.refused(K, "Del.Delete()")).toBe(true);
    expect(p.refused(K, "Del.Qty > 0", "lethal.negate-conditional")).toBe(true);
  });
  it("does not refuse an exit or an Error in the body, nor their guards: each ENDS the loop", () => {
    const p = project(files);
    expect(p.refused(K, "Error('negative')")).toBe(false);
    expect(p.refused(K, "Del.Qty < 0", "lethal.negate-conditional")).toBe(false);
    expect(p.refused(K, "Del.Qty > 100", "lethal.negate-conditional")).toBe(false);
  });
  it("does not refuse a site after the loop", () => {
    // a field no consumer, guard or filter reads: FEEDS matches targets BY NAME over the whole scope
    expect(project(files).refused(K, "After.Name := 'Z'", "lethal.remove-assignment")).toBe(false);
  });
  it("does not refuse a Delete in `repeat ... until Nx.Next() = 0`: Next advances regardless", () => {
    const p = project(files);
    expect(p.kinds(K, "repeat")).toEqual([]);
    expect(p.refused(K, "Nx.Delete()")).toBe(false);
  });
  it("delete-reinsert: the KEY-FIELD write's remove-assignment is refused", () => {
    expect(project(files).refused(K, `RI."No." := 'NEW'`, "lethal.remove-assignment")).toBe(true);
  });
});

/** A counter in an `or` beside the cursor test: refused anyway (ruling (a), a known false positive). */
const OR = `codeunit 50103 "R531 Or"
{
    procedure OrShape()
    var
        OrRec: Record "R531 Line";
        Ctr: Integer;
    begin
        while (Ctr < 10) or OrRec.FindFirst() do begin
            Ctr += 1;
            OrRec.Delete();
        end;
    end;
}`;

describe("R531: the `or` shape keeps no exemption", () => {
  it("a BODY consumer under `(Ctr < 10) or OrRec.FindFirst()` is refused", () => {
    const p = project({ "Line.Table.al": LINE, "Or.Codeunit.al": OR });
    expect(p.refused("Or.Codeunit.al", "OrRec.Delete()")).toBe(true);
  });
});

/** FILTER: an OnRename loop over lines filtered on the OLD name, and a Delete loop's control. */
const BATCH = `table 50104 "R531 Batch"
{
    fields
    {
        field(1; Name; Code[20]) { }
    }

    trigger OnRename()
    var
        Ln: Record "R531 Line";
    begin
        Ln.SetRange(Name, xRec.Name);
        while Ln.FindFirst() do
            Ln.Rename(Rec.Name);
    end;

    procedure DropAll()
    var
        Dl: Record "R531 Line";
    begin
        Dl.SetRange(Qty, 5);
        while Dl.FindFirst() do
            Dl.Delete();
    end;
}`;

describe("R531 FILTER: a pre-loop filter the loop's ending depends on", () => {
  const files = { "Line.Table.al": LINE, "Batch.Table.al": BATCH };
  const B = "Batch.Table.al";
  it("refuses remove-setrange of the OnRename filter `SetRange(Name, xRec.Name)`", () => {
    expect(
      project(files).refused(B, "Ln.SetRange(Name, xRec.Name)", "lethal.remove-setrange"),
    ).toBe(true);
  });
  it("refuses swap-rec-xrec on its `xRec.Name` (Rec.Name would find the renamed lines for ever)", () => {
    expect(project(files).refused(B, "xRec.Name", "lethal.swap-rec-xrec")).toBe(true);
  });
  it("control: a filter on a field the consumer does not modify (a Delete loop) is not refused", () => {
    expect(project(files).refused(B, "Dl.SetRange(Qty, 5)", "lethal.remove-setrange")).toBe(false);
  });
  it("mark before the loop: `MarkedOnly(true)` before a `Mark(false)` loop is refused", () => {
    const p = project(KFILES);
    expect(p.refused("Kinds.Codeunit.al", "Mk.MarkedOnly(true)")).toBe(true);
  });
});

/** NEG: the loop's own cursor condition, each loop with a consumer. */
const NEG = `codeunit 50105 "R531 Neg"
{
    procedure NotEmpty()
    var
        NE: Record "R531 Line";
    begin
        while not NE.IsEmpty() do
            NE.Delete();
    end;

    procedure Counted()
    var
        NC: Record "R531 Line";
    begin
        while NC.Count() > 0 do
            NC.Delete();
    end;

    procedure Found()
    var
        NF: Record "R531 Line";
    begin
        while NF.FindFirst() do
            NF.Delete();
    end;
}`;

describe("R531 NEG: every operator in the cursor condition but swap-find-direction", () => {
  const files = { "Line.Table.al": LINE, "Neg.Codeunit.al": NEG };
  const N = "Neg.Codeunit.al";
  it("refuses remove-not on `not NE.IsEmpty()`", () => {
    expect(project(files).refused(N, "not NE.IsEmpty()", "lethal.remove-not")).toBe(true);
  });
  it("refuses conditional-boundary on `NC.Count() > 0`", () => {
    expect(project(files).refused(N, "NC.Count() > 0", "lethal.conditional-boundary")).toBe(true);
  });
  it("control: swap-find-direction on `NF.FindFirst()` is not refused", () => {
    expect(project(files).refused(N, "NF.FindFirst()", "lethal.swap-find-direction")).toBe(false);
  });
});

/** HOP: DC's shape (a dequeue call passing R as `var`), by-value parameters, and overloads. */
const HOP = `codeunit 50106 "R531 Hop"
{
    procedure Drain(var TempQ: Record "R531 Line" temporary)
    begin
        while not TempQ.IsEmpty() do
            Dequeue(TempQ);
    end;

    local procedure Dequeue(var TempQueue: Record "R531 Line" temporary)
    begin
        TempQueue.Reset();
        TempQueue.FindFirst();
        TempQueue.Delete();
    end;

    procedure Peeks()
    var
        Pk: Record "R531 Line";
    begin
        while Pk.FindFirst() do
            Peek(Pk);
    end;

    local procedure Peek(Copy: Record "R531 Line")
    begin
        Copy.Delete();
    end;

    procedure Narrows()
    var
        Nw: Record "R531 Line";
    begin
        while Nw.FindFirst() do begin
            Nw.Delete();
            Narrow(Nw);
        end;
    end;

    local procedure Narrow(Own: Record "R531 Line")
    begin
        Own.SetRange(Qty, 1);
        Own.Reset();
        Own.Mark(true);
    end;

    procedure Overloads()
    var
        OvRec: Record "R531 Line";
    begin
        while OvRec.FindFirst() do
            Ov(OvRec);
    end;

    local procedure Ov(V: Record "R531 Line"; I: Integer)
    begin
        V.Qty := I;
    end;

    local procedure Ov(var W: Record "R531 Line")
    begin
        W.Delete();
    end;
}`;

describe("R531 HOP: one hop into a same-object callee", () => {
  const files = { "Line.Table.al": LINE, "Hop.Codeunit.al": HOP };
  const H = "Hop.Codeunit.al";
  it("refuses the callee's Delete when R is passed to a `var` parameter", () => {
    expect(project(files).refused(H, "TempQueue.Delete()")).toBe(true);
  });
  // The plan's by-value control (plan r3 item 5) assumed a by-value Record copies the table. It
  // copies the VARIABLE: the callee's Delete hits the real row (R-531 build review finding 1).
  it("refuses the callee's Delete when R is passed BY VALUE (the copy deletes the real row)", () => {
    expect(project(files).refused(H, "Copy.Delete()")).toBe(true);
  });
  it("control: a by-value callee that only refilters or marks its copy is not refused", () => {
    const p = project(files);
    expect(p.refused(H, "Own.SetRange(Qty, 1)", "lethal.remove-setrange")).toBe(false);
    expect(p.refused(H, "Own.Reset()")).toBe(false);
    expect(p.refused(H, "Own.Mark(true)")).toBe(false);
  });
  it("follows every overload whose parameter count fits: `Ov(OvRec)` reaches `Ov(var W)`, declared second", () => {
    expect(project(files).refused(H, "W.Delete()")).toBe(true);
  });
});

/** MARK aliases: the alias scan is by name within one procedure; another scope's same name is not R. */
const ALIAS = `codeunit 50107 "R531 Alias"
{
    var
        GA: Record "R531 Line";
        AliasRec: Record "R531 Line";

    procedure Loop()
    var
        AliasRec: Record "R531 Line";
    begin
        AliasRec := GA;
        while GA.FindFirst() do begin
            GA.Delete();
            HelperNamesake();
            HelperShadow();
        end;
    end;

    local procedure HelperNamesake()
    begin
        // the GLOBAL AliasRec: Loop's alias is its LOCAL of the same name, which shadows it there
        AliasRec.Delete();
    end;

    local procedure HelperShadow()
    var
        GA: Record "R531 Line";
    begin
        GA.Delete();
    end;
}`;

describe("R531 MARK alias: a shadowed name in another scope is not R", () => {
  const files = { "Line.Table.al": LINE, "Alias.Codeunit.al": ALIAS };
  const A = "Alias.Codeunit.al";
  it("refuses the alias's consumer in the loop (KAlias: `A2 := A1`, then `A2.Delete()`)", () => {
    const p = project(KFILES);
    expect(p.refused("Kinds.Codeunit.al", "A2.Delete()")).toBe(true);
  });
  it("control: the global namesake of the caller's LOCAL alias, used in a callee, is not R", () => {
    const p = project(files);
    expect(p.refused(A, "AliasRec.Delete()")).toBe(false);
  });
  it("control: a callee's LOCAL that shadows the global R is not R", () => {
    const p = project(files);
    expect(p.refused(A, "GA.Delete()", VMC, 1)).toBe(true); // the loop's own, on the global
    expect(p.refused(A, "GA.Delete()", VMC, 2)).toBe(false); // HelperShadow's local GA
  });
});

describe("R531 MODALL: a global R with a filter on another field", () => {
  it("refuses the write and the Modify (`Glob.Qty := 2` with `Glob.SetRange(Name, 'A')`)", () => {
    const p = project(KFILES);
    expect(p.refused("Kinds.Codeunit.al", "Glob.Qty := 2", "lethal.remove-assignment")).toBe(true);
    expect(p.refused("Kinds.Codeunit.al", "Glob.Modify()")).toBe(true);
  });
});

describe("R531 FEEDS: the stepping loop (`Last := St.No.`, then `St.SetFilter(No., '>%1', Last)`)", () => {
  it("refuses the feed's remove-assignment", () => {
    const p = project(KFILES);
    const feed = `Last := St."No."`;
    expect(p.refused("Kinds.Codeunit.al", feed, "lethal.remove-assignment")).toBe(true);
  });
});

/** Alias through `Copy`: a bare `Copy(X, true)` on the implicit Rec, and a non-literal share flag. */
const SHARED = `table 50108 "R531 Shared"
{
    fields
    {
        field(1; K; Code[20]) { }
    }

    procedure BareCopy()
    var
        Other: Record "R531 Shared";
    begin
        Copy(Other, true);
        while FindFirst() do
            Other.Delete();
    end;
}`;

const SHARE_FLAG = `codeunit 50109 "R531 Share Flag"
{
    procedure Shared(ShareIt: Boolean)
    var
        S1: Record "R531 Line";
        S2: Record "R531 Line";
    begin
        S2.Copy(S1, ShareIt);
        while S1.FindFirst() do
            S2.Delete();
    end;
}`;

describe("R531 MARK alias through Copy (R-531 build review finding 4)", () => {
  it("a bare `Copy(Other, true)` and `S2.Copy(S1, ShareIt)` both make the copy R", () => {
    const p = project({
      "Line.Table.al": LINE,
      "Shared.Table.al": SHARED,
      "ShareFlag.Codeunit.al": SHARE_FLAG,
    });
    expect(p.refused("Shared.Table.al", "Other.Delete()")).toBe(true);
    expect(p.refused("ShareFlag.Codeunit.al", "S2.Delete()")).toBe(true);
  });
});

/** HOP on the implicit Rec outside the declaring table (R-562 build review, shared resolver). */
const LINE_EXT = `tableextension 50110 "R531 Line Ext" extends "R531 Line"
{
    procedure ExtLoop()
    begin
        while FindFirst() do
            Consume();
    end;
}`;

describe("R531 HOP through the implicit Rec's table (`r531TableProcs`)", () => {
  it("a tableextension's bare `Consume()` reaches the base table's `Delete()`", () => {
    const p = project({ "Line.Table.al": LINE, "LineExt.TableExt.al": LINE_EXT });
    expect(p.refused("Line.Table.al", "Delete()")).toBe(true);
  });
});
