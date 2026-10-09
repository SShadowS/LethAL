import { beforeAll, describe, expect, it } from "bun:test";
/**
 * R-463: Tier 2's receiver resolution inside a `reportextension` (engine `semantic/receiver.ts`).
 * Each test names the revert that turns it red; the reverts are recorded in the R-463 build record.
 * Every AL shape here is one alc compiles: a data item is added with `addfirst`, never `add(X)`.
 */
import { ALNodeKind } from "../../src/ast/node-kinds";
import { initParser, parseAL } from "../../src/ast/parser";
import { type ALSyntaxNode, visit, wrapRoot } from "../../src/ast/syntax-node";
import { buildSemanticContext } from "../../src/semantic/context";
import {
  claimsRecordMethod,
  claimsSystemCall,
  receiverUnresolved,
} from "../../src/semantic/receiver";

const BAND = `table 50400 Band
{
    fields
    {
        field(1; "No."; Integer) { }
    }
}`;

/** The base report, in the project. `protected var G` is reachable from an extension. */
const BASE = `report 50401 "Base Rep"
{
    dataset
    {
        dataitem(Band; Band)
        {
        }
    }
    protected var
        G: Record Band;
}`;

type Site = { claimed: boolean; unresolved: boolean };

/** `claimsRecordMethod(.., method)` and `receiverUnresolved` at every call whose text is `call`. */
function sites(files: Record<string, string>, call: string, method: string): Site[] {
  const parsed = Object.entries(files).map(([path, src]) => ({
    path,
    root: wrapRoot(parseAL(src)),
  }));
  const ctx = buildSemanticContext(parsed);
  const out: Site[] = [];
  for (const { root } of parsed)
    visit(root, (n: ALSyntaxNode) => {
      if (n.kind === ALNodeKind.procedure_call && n.text === call)
        out.push({
          claimed: claimsRecordMethod(n, ctx, method),
          unresolved: receiverUnresolved(n, ctx, method),
        });
    });
  if (out.length === 0) throw new Error(`no call ${call}`);
  return out;
}

const CLAIMED: Site = { claimed: true, unresolved: false };
const REFUSED: Site = { claimed: false, unresolved: true };

beforeAll(async () => {
  await initParser();
});

describe("R-463 reportextension receivers", () => {
  // T1. Red: drop `reportextension` from OBJECT_KINDS.
  it("T1: a typed record declared in the extension is claimed", () => {
    const ext = `reportextension 50402 "Band Ext" extends "Base Rep"
{
    procedure CountIt(): Integer
    var
        Rel: Record Band;
    begin
        Rel.SetRange("No.", 1);
        exit(Rel.Count());
    end;
}`;
    expect(sites({ "t.al": BAND, "b.al": BASE, "e.al": ext }, 'Rel.SetRange("No.", 1)', "SetRange")).toEqual([CLAIMED]);
  });

  // T2. Red: drop `reportextension` from OBJECT_KINDS.
  it("T2: a bare call inside a data item the extension ADDS is claimed on that item's table", () => {
    const ext = `reportextension 50403 "Band Ext2" extends "Base Rep"
{
    dataset
    {
        addfirst(Band)
        {
            dataitem(Extra; Band)
            {
                trigger OnPreDataItem()
                begin
                    SetRange("No.", 2);
                end;
            }
        }
    }
}`;
    expect(sites({ "t.al": BAND, "b.al": BASE, "e.al": ext }, 'SetRange("No.", 2)', "SetRange")).toEqual([CLAIMED]);
  });

  // T3, the named refusal. Red: give `modify(X)` the base item's table (here X names its table).
  it("T3: a bare call in `modify(X)` is refused and keeps the tag, base report in the project", () => {
    const ext = `reportextension 50404 "Band Ext3" extends "Base Rep"
{
    dataset
    {
        modify(Band)
        {
            trigger OnBeforePreDataItem()
            begin
                SetRange("No.", 3);
            end;
        }
    }
}`;
    expect(sites({ "t.al": BAND, "b.al": BASE, "e.al": ext }, 'SetRange("No.", 3)', "SetRange")).toEqual([REFUSED]);
  });

  const ownSetRange = (call: string) => `reportextension 50405 "Band Ext4" extends "Base Rep"
{
    dataset
    {
        addfirst(Band)
        {
            dataitem(Extra; Band)
            {
                trigger OnPreDataItem()
                var
                    Rel: Record Band;
                begin
                    ${call};
                end;
            }
        }
    }
    procedure SetRange(A: Integer; B: Integer)
    begin
    end;
}`;

  // T4, bare half. Red: drop the `declaresProcedure` guard in `claimsRecordMethod`'s bare branch.
  it("T4: a bare call named like a procedure the extension declares is not claimed", () => {
    const call = "SetRange(4, 4)";
    expect(sites({ "t.al": BAND, "b.al": BASE, "e.al": ownSetRange(call) }, call, "SetRange")).toEqual([
      { claimed: false, unresolved: false },
    ]);
  });

  // T4, qualified half: `Rel.SetRange` binds the record method whatever the extension declares.
  // Red: drop `reportextension` from OBJECT_KINDS.
  it("T4: the QUALIFIED call on a typed record is claimed beside the extension's namesake", () => {
    const call = 'Rel.SetRange("No.", 4)';
    expect(sites({ "t.al": BAND, "b.al": BASE, "e.al": ownSetRange(call) }, call, "SetRange")).toEqual([CLAIMED]);
  });

  // T5, a built collision: a codeunit with the extension's NAME declares the global `Rel`. Red:
  // drop the kind from BOTH `extensionScopeKey` and `objectScopeKey` (symbol-table.ts).
  it("T5: a variable of a same-named codeunit is not visible inside the extension", () => {
    const ext = `reportextension 50406 "Twin" extends "Base Rep"
{
    dataset
    {
        addfirst(Band)
        {
            dataitem(Extra; Band)
            {
                trigger OnPreDataItem()
                begin
                    Rel.SetRange("No.", 5);
                end;
            }
        }
    }
}`;
    const cu = `codeunit 50407 "Twin"
{
    var
        Rel: Record Band;
}`;
    expect(sites({ "t.al": BAND, "b.al": BASE, "e.al": ext, "c.al": cu }, 'Rel.SetRange("No.", 5)', "SetRange")).toEqual([REFUSED]);
  });

  // T5b: the base report's `protected var G` is accessible to the extension (alc 18.0.43), but this
  // source does not resolve it there: refused, tag kept. Red: key the extension's scope as the base
  // report's (`objectScopeKey("report", <extends target>)` in `scopeOwnerOf`).
  it("T5b: a base report's protected var is not claimed and keeps the tag", () => {
    const ext = `reportextension 50408 "Band Ext5" extends "Base Rep"
{
    trigger OnPreReport()
    begin
        G.SetRange("No.", 6);
    end;
}`;
    expect(sites({ "t.al": BAND, "b.al": BASE, "e.al": ext }, 'G.SetRange("No.", 6)', "SetRange")).toEqual([REFUSED]);
  });
});

describe("R-463 claimsSystemCall inside a reportextension", () => {
  // T8. Red: drop the reportextension guard in `claimsSystemCall`. The other direction (a bare
  // `Commit()` in a codeunit or table IS claimed) is pinned by remove-commit's own tests.
  it("T8: a bare Commit() in a reportextension trigger is not claimed", () => {
    const ext = `reportextension 50409 "Band Ext6" extends "Base Rep"
{
    trigger OnPreReport()
    begin
        Commit();
    end;
}`;
    const parsed = [
      { path: "t.al", root: wrapRoot(parseAL(BAND)) },
      { path: "b.al", root: wrapRoot(parseAL(BASE)) },
      { path: "e.al", root: wrapRoot(parseAL(ext)) },
    ];
    const ctx = buildSemanticContext(parsed);
    const calls: boolean[] = [];
    visit(parsed[2]?.root as ALSyntaxNode, (n: ALSyntaxNode) => {
      if (n.kind === ALNodeKind.procedure_call) calls.push(claimsSystemCall(n, ctx, "Commit"));
    });
    expect(calls).toEqual([false]);
  });
});
