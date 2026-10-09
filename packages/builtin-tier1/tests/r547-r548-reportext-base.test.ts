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
 * R547 and R548 (coord task R-547): a reportextension reaches its BASE report. R547: a bare call
 * from an open extension block to a base-report procedure is followed onto every base candidate,
 * so that procedure's mutants are hang-refused. R548: an extension's write of a preset exit name,
 * the base's `protected var` ones and its own, is refused like a write inside the report. Every
 * test names the revert that turns it red; the red checks are recorded in the R-547 build log.
 */

beforeAll(async () => {
  await initParser();
});

/** `openItemHangRefuses` at every statement of procedure `proc` in file `path` (first match). */
function project(files: Record<string, string>, undecided = false) {
  const parsed = Object.entries(files).map(([path, src]) => ({
    path,
    root: wrapRoot(parseAL(src)),
  }));
  const built = buildSemanticContext(parsed);
  const ctx = undecided ? { ...built, armOf: () => "undecided" as const } : built;
  const rootOf = (path: string): ALSyntaxNode => {
    const f = parsed.find((p) => p.path === path);
    if (f === undefined) throw new Error(`no file ${path}`);
    return f.root;
  };
  return {
    proc: (path: string, proc: string): boolean[] => {
      const out: boolean[] = [];
      let seen = false;
      visit(rootOf(path), (n: ALSyntaxNode) => {
        if (
          seen ||
          n.rawKind !== "procedure" ||
          normalizeAlName(n.childForFieldName("name")?.text ?? "") !== normalizeAlName(proc)
        )
          return;
        seen = true;
        for (const s of n.childForFieldName("body")?.childForFieldName("body")?.namedChildren ?? [])
          out.push(openItemHangRefuses(s, ctx));
      });
      if (out.length === 0) throw new Error(`procedure ${proc}: no statement in ${path}`);
      return out;
    },
    at: (path: string, kind: string, text: string): boolean => {
      let hit: ALSyntaxNode | null = null;
      visit(rootOf(path), (n: ALSyntaxNode) => {
        if (hit === null && n.rawKind === kind && n.text === text) hit = n;
      });
      if (hit === null) throw new Error(`${kind} ${text} not found in ${path}`);
      return openItemHangRefuses(hit, ctx);
    },
  };
}

// ---------------------------------------------------------------------------------------------
// R547: a bare base-report procedure called from an open extension block
// ---------------------------------------------------------------------------------------------

const BASE_BODY = `{
    dataset
    {
        dataitem(Loop; Integer)
        {
            trigger OnAfterGetRecord()
            begin
                if Loop.Number > 3 then
                    CurrReport.Break();
            end;
        }
        dataitem(Hdr; "Hop Tab")
        {
        }
    }

    procedure BaseProc()
    begin
        Total := Total + 1;
        BaseInner();
    end;

    procedure BaseInner()
    begin
        Total := Total * 2;
    end;

    procedure ViaExtProc()
    begin
        Total := Total + 3;
    end;

    procedure Unreached()
    begin
        Total := Total + 4;
    end;

    var
        Total: Integer;
}`;

const BASE = `report 50500 "Hop Base"\n${BASE_BODY}`;

/** The extension: a block anchored on `anchor` calls `BaseProc()` from its trigger and
 *  `ViaExtProc()` through its own procedure. */
const ext = (anchor: string) => `reportextension 50501 "Hop Ext" extends "Hop Base"
{
    dataset
    {
        modify(${anchor})
        {
            trigger OnAfterAfterGetRecord()
            begin
                BaseProc();
                ExtHelper();
            end;
        }
    }

    local procedure ExtHelper()
    begin
        ViaExtProc();
    end;
}`;

describe("R547: a base-report procedure called bare from an open reportextension block", () => {
  // Red: drop the base-candidate follow in `callTargets`' bare branch.
  const open = () => project({ "b.al": BASE, "e.al": ext("Loop") });
  it("refuse: the callee of the open block's trigger is refused", () => {
    expect(open().proc("b.al", "BaseProc")).toEqual([true, true]);
    expect(open().proc("b.al", "Unreached")).toEqual([false]);
  });
  it("refuse: the callee of an extension procedure the open block reaches is refused", () => {
    expect(open().proc("b.al", "ViaExtProc")).toEqual([true]);
  });
  it("refuse: the callee's own same-object callee in the base report (closure) is refused", () => {
    expect(open().proc("b.al", "BaseInner")).toEqual([true]);
  });

  // F8 control: the anchor is an ordinary table item, not inside an Integer item, and the base
  // never reaches these procedures from its own open item. Red: make `modifiedItemOpen` answer true.
  it("control: the same calls from a closed block keep every mutant", () => {
    const p = project({ "b.al": BASE, "e.al": ext("Hdr") });
    expect(p.proc("b.al", "BaseProc")).toEqual([false, false]);
    expect(p.proc("b.al", "BaseInner")).toEqual([false]);
    expect(p.proc("b.al", "ViaExtProc")).toEqual([false]);
  });

  // F2: two same-named base reports, one in an undecided `#if` arm that alone declares BaseProc.
  // Red: return the candidates only when there is exactly one.
  it("ambiguity: every same-named candidate is followed", () => {
    const plain = `report 50500 "Hop Base"
{
    dataset
    {
        dataitem(Loop; Integer)
        {
        }
    }
}`;
    const wrapped = `#if V2\nreport 50502 "Hop Base"\n${BASE_BODY}\n#endif\n`;
    const p = project({ "a.al": plain, "b.al": wrapped, "e.al": ext("Loop") }, true);
    expect(p.proc("b.al", "BaseProc")).toEqual([true, true]);
  });

  // r3 F1: a base report whose HEADER is split by `#if` is a candidate, not a dependency.
  // Red: drop `splitObjects` from `baseCandidatesOf`.
  it("split header: the split base report's BaseProc is refused", () => {
    const split = `#if CLEAN\nreport 50500 "Hop Base"\n#else\nreport 50503 "Hop Base"\n#endif\n${BASE_BODY}`;
    const p = project({ "b.al": split, "e.al": ext("Loop") });
    expect(p.proc("b.al", "BaseProc")).toEqual([true, true]);
    expect(p.proc("b.al", "Unreached")).toEqual([false]);
  });
});

// ---------------------------------------------------------------------------------------------
// R548: an extension's write of a preset exit name
// ---------------------------------------------------------------------------------------------

/** `Continue` (protected) and `Seen` (not protected) are read by the open `Loop` item's guards. */
const MEMO = `report 50510 "Memo Base"
{
    dataset
    {
        dataitem(Loop; Integer)
        {
            trigger OnAfterGetRecord()
            begin
                if not Continue then
                    CurrReport.Break();
                if Seen then
                    CurrReport.Break();
                Counter := Counter + 1;
            end;
        }
    }

    procedure BaseInit(var C: Boolean)
    begin
        C := true;
    end;

    procedure BaseRead(C: Boolean)
    begin
        Marked := C;
    end;

    var
        Seen: Boolean;
        Counter: Integer;
        Marked: Boolean;

    protected var
        Continue: Boolean;
        Halt: Boolean;
}`;

const MEMO_EXT = `reportextension 50511 "Memo Ext" extends "Memo Base"
{
    dataset
    {
        modify(Loop)
        {
            trigger OnAfterAfterGetRecord()
            begin
                if Stop then
                    CurrReport.Break();
                if Halt then
                    CurrReport.Break();
            end;
        }
    }

    trigger OnPreReport()
    begin
        Continue := true;
        Seen := false;
        Stop := false;
        Halt := false;
        BaseInit(Continue);
        BaseRead(Continue);
        Mine := 1;
    end;

    var
        Seen: Boolean;
        Stop: Boolean;
        Mine: Integer;
}`;

describe("R548: a reportextension's write of a preset exit name", () => {
  const p = () => project({ "b.al": MEMO, "e.al": MEMO_EXT });

  it("the base Integer item is open: its own trigger's statement is refused", () => {
    expect(p().at("b.al", "assignment_statement", "Counter := Counter + 1")).toBe(true);
  });
  // Red: drop the reportextension branch of `writesPresetExitName`.
  it("refuse: the extension's write of the base's protected `Continue` is refused", () => {
    expect(p().at("e.al", "assignment_statement", "Continue := true")).toBe(true);
  });
  // F1 control: the base `Seen` is not protected, so the extension's `Seen` is its own.
  // Red: drop the protected filter in `extensionPresetExitNames`.
  it("control: a write of the extension's own `Seen` (the base one is not protected) emits", () => {
    expect(p().at("e.al", "assignment_statement", "Seen := false")).toBe(false);
  });
  // F3a: an extension `modify(Loop)` guard reads the extension's own `Stop`.
  // Red: drop `presetExitNames(ext)` from `extensionPresetExitNames`.
  it("F3a: a write of an extension global its own open block's guard reads is refused", () => {
    expect(p().at("e.al", "assignment_statement", "Stop := false")).toBe(true);
  });
  // F3a: the same guard reading a base `protected var` no base guard reads (`Halt`).
  // Red: do not seed the extension's globals with the base's protected names.
  it("F3a: a write of a base protected var only the extension's open guard reads is refused", () => {
    expect(p().at("e.al", "assignment_statement", "Halt := false")).toBe(true);
  });
  // F4: a `var` argument to a base procedure. Red: drop the base lookup in `argWritten`.
  it("F4: `BaseInit(Continue)` (a var parameter of a base procedure) is refused", () => {
    expect(p().at("e.al", "call_expression", "BaseInit(Continue)")).toBe(true);
  });
  // r3 F2: by value. Red: answer `unknown` for every base callee in `argWritten`.
  it("F4 control: `BaseRead(Continue)` (by value) emits", () => {
    expect(p().at("e.al", "call_expression", "BaseRead(Continue)")).toBe(false);
  });
  it("a write no exit guard reads emits", () => {
    expect(p().at("e.al", "assignment_statement", "Mine := 1")).toBe(false);
  });
});
