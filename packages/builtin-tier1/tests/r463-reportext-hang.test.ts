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
 * R-463: a table procedure called from an OPEN reportextension block through an UNTYPED receiver
 * (a data item the extension adds, `D.Proc()`, or a bare `Proc()` inside it) is followed by R-500
 * shape 2, so every statement in it is hang-refused. Before R-463 `resolveReceiverTable` answered
 * null inside a reportextension and both calls were not followed (62 such BaseApp mutants were
 * deployed on master 2e40f73f). T7 is the not-vacuous control: the same calls from a block whose
 * anchor is an ordinary table item stay emitted.
 */

beforeAll(async () => {
  await initParser();
});

const TAB = `table 50410 "Hop Tab"
{
    fields
    {
        field(1; "No."; Integer) { }
    }
    procedure ViaName()
    begin
        NCount := NCount + 1;
        NCount := NCount * 2;
    end;

    procedure ViaBare()
    begin
        BCount := BCount + 1;
        BCount := BCount * 2;
    end;

    var
        NCount: Integer;
        BCount: Integer;
}`;

/** The base report: `I` is an Integer item with no `MaxIteration` (open), `Hdr` an ordinary
 *  table item (bounded). */
const BASE = `report 50411 "Hop Base"
{
    dataset
    {
        dataitem(I; Integer)
        {
        }
        dataitem(Hdr; "Hop Tab")
        {
        }
    }
}`;

const ext = (anchor: string) => `reportextension 50412 "Hop Ext" extends "Hop Base"
{
    dataset
    {
        addfirst(${anchor})
        {
            dataitem(D; "Hop Tab")
            {
                trigger OnAfterGetRecord()
                begin
                    D.ViaName();
                    ViaBare();
                end;
            }
        }
    }
}`;

/** `openItemHangRefuses` at every statement of table procedure `proc`. */
function refusedIn(anchor: string, proc: string): boolean[] {
  const parsed = [
    { path: "t.al", root: wrapRoot(parseAL(TAB)) },
    { path: "b.al", root: wrapRoot(parseAL(BASE)) },
    { path: "e.al", root: wrapRoot(parseAL(ext(anchor))) },
  ];
  const ctx = buildSemanticContext(parsed);
  const out: boolean[] = [];
  visit(parsed[0]?.root as ALSyntaxNode, (n: ALSyntaxNode) => {
    if (
      n.rawKind === "procedure" &&
      normalizeAlName(n.childForFieldName("name")?.text ?? "") === normalizeAlName(proc)
    )
      for (const s of n.childForFieldName("body")?.childForFieldName("body")?.namedChildren ?? [])
        out.push(openItemHangRefuses(s, ctx, undefined));
  });
  if (out.length !== 2) throw new Error(`procedure ${proc}: ${out.length} statements, want 2`);
  return out;
}

describe("R-463: one-hop table callees from a reportextension's added data item", () => {
  // T6. Red: drop `reportextension` from OBJECT_KINDS in receiver.ts (both calls type to nothing).
  it("T6: anchored on an open Integer item, every statement of D.ViaName() is refused", () => {
    expect(refusedIn("I", "ViaName")).toEqual([true, true]);
  });
  it("T6: anchored on an open Integer item, every statement of a bare ViaBare() is refused", () => {
    expect(refusedIn("I", "ViaBare")).toEqual([true, true]);
  });

  // T7, the control. Red: make `modifiedItemOpen` (loop-hazard.ts) answer true.
  it("T7: anchored on an ordinary table item, D.ViaName() and ViaBare() stay emitted", () => {
    expect(refusedIn("Hdr", "ViaName")).toEqual([false, false]);
    expect(refusedIn("Hdr", "ViaBare")).toEqual([false, false]);
  });
});
