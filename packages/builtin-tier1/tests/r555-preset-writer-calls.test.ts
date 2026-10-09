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
import { objectsOfType, presetExitNames } from "../src/loop-hazard";

/**
 * R555 (coord task R-555): a CALL to a procedure that writes a preset exit name is refused like the
 * write itself (R500 shape 1): the call, the guard deciding whether it runs, its enclosing blocks,
 * and an early exit before it. Also through a typed `Report X` receiver in any object. Every test
 * names the revert that turns it red; the red checks are recorded in the R-555 build log.
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
  const find = (path: string, kind: string, text: string): ALSyntaxNode => {
    const f = parsed.find((p) => p.path === path);
    if (f === undefined) throw new Error(`no file ${path}`);
    let hit: ALSyntaxNode | null = null;
    visit(f.root, (n: ALSyntaxNode) => {
      if (hit === null && n.rawKind === kind && n.text === text) hit = n;
    });
    if (hit === null) throw new Error(`${kind} ${text} not found in ${path}`);
    return hit;
  };
  return {
    ctx,
    find,
    at: (path: string, kind: string, text: string): boolean =>
      openItemHangRefuses(find(path, kind, text), ctx),
  };
}

/** `Continue` is read by the open `Loop` item's exit guard and never written in open-item code. */
const REP = `report 50550 "Writer Rep"
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
        if Counter = 0 then
            InitContinue();
        Prepare();
        CurrReport.Setup();
        if Ready then
            Counter := 2;
        Other();
        Clear(Counter);
        Commit();
    end;

    procedure InitContinue()
    begin
        Continue := true;
    end;

    procedure Prepare()
    begin
        InitContinue();
    end;

    procedure Setup()
    begin
        if Ready then
            Counter := 1;
    end;

    procedure Ready(): Boolean
    begin
        Continue := true;
        exit(true);
    end;

    procedure Other()
    begin
        Counter := 0;
    end;

    var
        Continue: Boolean;
        Counter: Integer;
}`;

describe("R555: a call to a preset writer inside the report", () => {
  const p = () => project({ "r.al": REP });

  // Red: `writes` back to `directWrite` alone.
  it("refuse: the writer call, its guard condition and the enclosing if are refused", () => {
    expect(p().at("r.al", "call_expression", "InitContinue()")).toBe(true);
    expect(p().at("r.al", "comparison_expression", "Counter = 0")).toBe(true);
    expect(p().at("r.al", "if_statement", "if Counter = 0 then\n            InitContinue()")).toBe(
      true,
    );
  });
  // Red: no fixpoint in `presetWriters` (direct writers only).
  it("transitive: `Prepare()`, which only calls the writer, is refused", () => {
    expect(p().at("r.al", "call_expression", "Prepare()")).toBe(true);
  });
  // Red: drop `hiddenCallee` from the fixpoint and from `callsPresetWriter`.
  it("hiddenCallee: `CurrReport.Setup()` and a paren-less `if Ready then` are refused", () => {
    expect(p().at("r.al", "call_expression", "CurrReport.Setup()")).toBe(true);
    expect(p().at("r.al", "if_statement", "if Ready then\n            Counter := 2")).toBe(true);
  });
  // Red: count every call as a writer.
  it("control: a call to a procedure that writes no preset name, and its body, stay deployed", () => {
    expect(p().at("r.al", "call_expression", "Other()")).toBe(false);
    expect(p().at("r.al", "assignment_statement", "Counter := 0")).toBe(false);
  });
  // Red: treat an unknown bare name in a report as a writer.
  it("builtin control: `Clear(Counter)` and `Commit()` are not writers", () => {
    expect(p().at("r.al", "call_expression", "Clear(Counter)")).toBe(false);
    expect(p().at("r.al", "call_expression", "Commit()")).toBe(false);
  });
});

/** The base's `Go` is NOT protected: an extension cannot spell it, and the extension declares no
 *  preset name of its own. */
const PRIV_BASE = `report 50551 "Priv Base"
{
    dataset
    {
        dataitem(Loop; Integer)
        {
            trigger OnAfterGetRecord()
            begin
                if not Go then
                    CurrReport.Break();
            end;
        }
    }

    procedure StartIt()
    begin
        Go := true;
    end;

    var
        Go: Boolean;
}`;

const PRIV_EXT = `reportextension 50552 "Priv Ext" extends "Priv Base"
{
    trigger OnPreReport()
    begin
        StartIt();
        Mine();
    end;

    local procedure Mine()
    begin
    end;
}`;

describe("R555: a reportextension calls a base writer of a base-private name", () => {
  const p = () => project({ "b.al": PRIV_BASE, "e.al": PRIV_EXT });

  // Red: drop the base candidates from `presetWriters`.
  it("refuse: `StartIt()` is refused", () => {
    expect(p().at("e.al", "call_expression", "StartIt()")).toBe(true);
  });
  // Red: keep the `names.size === 0` early return.
  it("names.size === 0 bypass: the extension has no preset name of its own, the call is still refused", () => {
    expect(p().at("e.al", "call_expression", "StartIt()")).toBe(true);
  });
  it("control: `Mine()` stays deployed", () => {
    expect(p().at("e.al", "call_expression", "Mine()")).toBe(false);
  });
});

/** An unparsed base: its text names the report and declares `procedure LostInit`, and mentions
 *  `Error` without declaring it. */
const LOST_BASE = `@@ report "Lost Base" @@ ))) procedure LostInit ( Error ( @@\n`;
const LOST_EXT = `reportextension 50553 "Lost Ext" extends "Lost Base"
{
    trigger OnPreReport()
    begin
        LostInit();
        Error('boom');
    end;
}`;

describe("R555: a reportextension whose base candidate is unparsed", () => {
  const p = () => project({ "b.al": LOST_BASE, "e.al": LOST_EXT });

  it("the base is an unparsed candidate", () => {
    expect(p().ctx.symbols.unparsedObjects.length).toBeGreaterThan(0);
  });
  // No argument, so `argWritten` cannot refuse it. Red: treat an unread declaration as not a writer.
  it("unknown: `LostInit()` (declared only in the unread text) is refused", () => {
    expect(p().at("e.al", "call_expression", "LostInit()")).toBe(true);
  });
  // A literal argument, so `argWritten` is not asked. Red: match the bare token instead of
  // `procedure <name>`.
  it("F5: `Error('boom')` is not a writer although the unread text mentions `Error`", () => {
    expect(p().at("e.al", "call_expression", "Error('boom')")).toBe(false);
  });
});

/** The var section and the open guard sit OUTSIDE the ERROR region; `InitIt` is swallowed. */
const DAMAGED = `report 50554 "Damaged"
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

    var
        Continue: Boolean;

    trigger OnPreReport()
    begin
        InitIt();
        Other();
    end;

    procedure Other()
    begin
    end;

    procedure InitIt(: : begin Continue := true; end;
}`;

describe("R555 F2: a parse-damaged report", () => {
  const p = () => project({ "r.al": DAMAGED });

  it("the report is damaged and still has a preset exit name", () => {
    const x = p();
    const rep = x.find("r.al", "report_declaration", DAMAGED);
    expect(rep.hasError).toBe(true);
    expect(presetExitNames(rep, x.ctx).size).toBeGreaterThan(0);
  });
  // Red: drop the ERROR-descendant rule from `callsPresetWriter`.
  it("refuse: the call to the swallowed writer is refused", () => {
    expect(p().at("r.al", "call_expression", "InitIt()")).toBe(true);
  });
  it("control: a call to a parsed non-writer stays deployed", () => {
    expect(p().at("r.al", "call_expression", "Other()")).toBe(false);
  });
});

/** `Continue` is protected so the extension can write it too. */
const CROSS_REP = `report 50555 "Cross Rep"
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

    procedure SetContinue(V: Boolean)
    begin
        Continue := V;
    end;

    procedure Other()
    begin
    end;

    protected var
        Continue: Boolean;
}`;

const CROSS_EXT = `reportextension 50556 "Cross Ext" extends "Cross Rep"
{
    procedure SetFromExt()
    begin
        Continue := true;
    end;
}`;

const CROSS_MGT = `codeunit 50557 "Cross Mgt"
{
    procedure Go(Flag: Boolean)
    var
        Rep: Report "Cross Rep";
    begin
        if Flag = true then
            Rep.SetContinue(true);
        Rep.Other();
        Rep.SetFromExt();
        Rep.RunModal();
    end;
}`;

describe("R555: a writer called from another object through `Report X`", () => {
  const p = () => project({ "r.al": CROSS_REP, "e.al": CROSS_EXT, "c.al": CROSS_MGT });

  // Red: drop the cross-object branch from `writesPresetExitName`.
  it("refuse: `Rep.SetContinue(true)`, its guard and the enclosing if are refused", () => {
    expect(p().at("c.al", "call_expression", "Rep.SetContinue(true)")).toBe(true);
    expect(p().at("c.al", "comparison_expression", "Flag = true")).toBe(true);
    expect(
      p().at("c.al", "if_statement", "if Flag = true then\n            Rep.SetContinue(true)"),
    ).toBe(true);
  });
  // Red: count every member call on a `Report X` receiver as a writer call.
  it("control: `Rep.Other()` stays deployed", () => {
    expect(p().at("c.al", "call_expression", "Rep.Other()")).toBe(false);
  });
  // alc 18.0.43 binds an extension procedure through `Report X` (R555 probe). Red: base writers only.
  it("extension writer: `Rep.SetFromExt()` is refused", () => {
    expect(p().at("c.al", "call_expression", "Rep.SetFromExt()")).toBe(true);
  });
  // Red: give `objectsOfType` a `report` branch.
  it("pin: `objectsOfType` stays [] for kind report (R500 shape 2's callee follow)", () => {
    const x = p();
    expect(objectsOfType({ kind: "report", name: "cross rep", temporary: false }, x.ctx)).toEqual(
      [],
    );
  });
});
