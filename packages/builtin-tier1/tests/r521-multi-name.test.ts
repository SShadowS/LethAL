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
 * R521 (coord task R-521): a multi-name declaration (`A, B: Interface X`) declares EVERY name, not
 * only the first. Four sites in `loop-hazard.ts` read it; one test per site, each naming the revert
 * (that site alone back to `childForFieldName("name")`) that turns it red. The red checks are in
 * the R-521 handoff (`redcheck.md`).
 */

beforeAll(async () => {
  await initParser();
});

function project(files: Record<string, string>) {
  const parsed = Object.entries(files).map(([path, src]) => ({
    path,
    root: wrapRoot(parseAL(src)),
  }));
  const ctx = buildSemanticContext(parsed);
  /** Is the `nth` node of raw kind `kind` with exactly this text refused? */
  return (path: string, kind: string, text: string, nth = 1): boolean => {
    const f = parsed.find((p) => p.path === path);
    if (f === undefined) throw new Error(`no file ${path}`);
    const hits: ALSyntaxNode[] = [];
    visit(f.root, (n: ALSyntaxNode) => {
      if (n.rawKind === kind && n.text === text) hits.push(n);
    });
    const hit = hits[nth - 1];
    if (hit === undefined) throw new Error(`${kind} ${text} #${nth} not found in ${path}`);
    return openItemHangRefuses(hit, ctx, undefined);
  };
}

// (3) declaredType's fallback: an XMLport is not in the symbol table, so its receiver is typed by
// the nearest `var` declaration, which PEPPOL writes as `PostedHeaderIterator, PostedLineIterator`.
const XP = `xmlport 50521 "R521 Lines"
{
    schema
    {
        textelement(Root)
        {
            tableelement(LineLoop; Integer)
            {
                trigger OnAfterGetRecord()
                begin
                    if not LineIter.GetNextLine() then
                        currXMLport.Break();
                end;
            }
        }
    }

    var
        HeadIter, LineIter: Interface "R521 Iterator";
}

interface "R521 Iterator"
{
    procedure GetNextLine(): Boolean;
    procedure Unused();
}

codeunit 50522 "R521 Iter Impl" implements "R521 Iterator"
{
    procedure GetNextLine(): Boolean
    begin
        Pos += 1;
        exit(Pos < 10);
    end;

    procedure Unused()
    begin
        Spare += 1;
    end;

    var
        Pos: Integer;
        Spare: Integer;
}
`;

describe("R521 (3): declaredType reads the second name of an XMLport's multi-name declaration", () => {
  const at = () => project({ "Xp.al": XP });
  // Red: `declaredType`'s fallback compares only `childForFieldName("name")`.
  it("the implementer of the SECOND name's interface, called from the open item, is refused", () => {
    expect(at()("Xp.al", "assignment_statement", "Pos += 1")).toBe(true);
  });
  it("control: the implementer's procedure nothing calls emits", () => {
    expect(at()("Xp.al", "assignment_statement", "Spare += 1")).toBe(false);
  });
});

// (2) presetExitNames' globals: `Continue`, the second name, is read by the open item's guard.
const PRESET = `report 50523 "R521 Preset"
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

    trigger OnPreReport()
    begin
        Continue := true;
        Other := false;
    end;

    var
        Other, Continue: Boolean;
}
`;

describe("R521 (2): a preset exit name declared second in a multi-name global", () => {
  const at = () => project({ "r.al": PRESET });
  // Red: the open-item globals set in `presetExitNames` takes only the first name.
  it("the write of `Continue` before the item is refused", () => {
    expect(at()("r.al", "assignment_statement", "Continue := true")).toBe(true);
  });
  it("control: the first name `Other`, which no exit guard reads, emits", () => {
    expect(at()("r.al", "assignment_statement", "Other := false")).toBe(false);
  });
});

// (4) protectedVarNames: the base's `protected var Halt, Continue` reaches its extension.
const BASE = `report 50524 "R521 Base"
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

    protected var
        Halt, Continue: Boolean;
}
`;

const EXT = `reportextension 50525 "R521 Ext" extends "R521 Base"
{
    trigger OnPreReport()
    begin
        Continue := true;
        Halt := false;
    end;
}
`;

describe("R521 (4): a protected preset exit name declared second in a multi-name base global", () => {
  const at = () => project({ "b.al": BASE, "e.al": EXT });
  // Red: `protectedVarNames` takes only the first name.
  it("the extension's write of the base's protected `Continue` is refused", () => {
    expect(at()("e.al", "assignment_statement", "Continue := true")).toBe(true);
  });
  it("control: the first protected name `Halt`, which no exit guard reads, emits", () => {
    expect(at()("e.al", "assignment_statement", "Halt := false")).toBe(false);
  });
});

// (1) r531Declares: a callee's multi-name LOCAL `Other, GA` shadows the global R `GA`.
const SHADOW = `table 50526 "R521 Line"
{
    fields
    {
        field(1; "No."; Code[20]) { }
    }
}

codeunit 50527 "R521 Shadow"
{
    var
        GA: Record "R521 Line";

    procedure Loop()
    begin
        while GA.FindFirst() do begin
            GA.Delete();
            HelperShadow();
        end;
    end;

    local procedure HelperShadow()
    var
        Other, GA: Record "R521 Line";
    begin
        GA.Delete();
    end;
}
`;

describe("R521 (1): r531Declares reads the second name of a multi-name local", () => {
  const at = () => project({ "s.al": SHADOW });
  it("the loop's own consumer on the global is refused", () => {
    expect(at()("s.al", "call_expression", "GA.Delete()", 1)).toBe(true);
  });
  // Red: `r531Declares` takes only `childForFieldName("name")`.
  it("a callee's local declared second (`Other, GA`) shadows the global: its Delete emits", () => {
    expect(at()("s.al", "call_expression", "GA.Delete()", 2)).toBe(false);
  });
});

// (1), the other direction: the LOOP's own scope declares `Other, GA` / `Other2, GB`, so R is a local
// there. A local R with a filter on another field is not `modify-all`, and a bare call cannot see a
// local R (`global-call`).
const LOCALR = `table 50528 "R521 Row"
{
    fields
    {
        field(1; "No."; Code[20]) { }
        field(2; Qty; Integer) { }
    }
}

codeunit 50529 "R521 Local R"
{
    var
        GA: Record "R521 Row";
        GB: Record "R521 Row";

    procedure LocalModify()
    var
        Other, GA: Record "R521 Row";
    begin
        GA.SetRange("No.", 'A');
        while GA.FindFirst() do begin
            GA.Qty := 2;
            GA.Modify();
        end;
    end;

    procedure LocalCall()
    var
        Other2, GB: Record "R521 Row";
    begin
        while GB.FindFirst() do
            DropGB();
    end;

    local procedure DropGB()
    begin
        GB.Delete();
    end;
}
`;

describe("R521 (1): a loop's own multi-name local R is a local, not a global", () => {
  const kinds = (head: string): string[] => {
    const root = wrapRoot(parseAL(LOCALR));
    const ctx = buildSemanticContext([{ path: "l.al", root }]);
    let loop: ALSyntaxNode | null = null;
    visit(root, (n: ALSyntaxNode) => {
      if (loop === null && n.rawKind === "while_statement" && n.text.startsWith(head)) loop = n;
    });
    if (loop === null) throw new Error(`loop ${head} not found`);
    return r531Analyze(loop, ctx)?.kinds ?? [];
  };
  // Red: `r531Declares` takes only the first name, so `GA` reads as the global (`modify-all`).
  it("modify-all: a local R filtered on another field is not a modify-all consumer", () => {
    expect(kinds("while GA.FindFirst()")).toEqual([]);
  });
  // Red: same revert, so the bare `DropGB()` reads as seeing R (`global-call`).
  it("global-call: a bare call cannot see the loop's local R", () => {
    expect(kinds("while GB.FindFirst()")).toEqual([]);
  });
});
