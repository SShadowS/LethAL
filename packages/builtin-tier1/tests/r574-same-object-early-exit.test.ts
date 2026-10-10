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
import { r574Seam } from "../src/loop-hazard";

/**
 * R574 (prototype): R531's same-object HOP refuses the callee's early exits (an `exit` or `Error`
 * before the last consumer, or inside a callee loop holding one), their guards and the values that
 * feed those guards. Each site is read with `r574Seam` off (master) and on.
 */

beforeAll(async () => {
  await initParser();
});

const VMC = "lethal.void-method-call";
const REMOVE_NOT = "lethal.remove-not";
const NEG = "lethal.negate-conditional";

function refused(src: string, text: string, op: string): boolean {
  const root = wrapRoot(parseAL(src));
  const ctx = buildSemanticContext([{ path: "a.al", root }]);
  let hit: ALSyntaxNode | null = null;
  visit(root, (n: ALSyntaxNode) => {
    if (hit === null && n.text === text) hit = n;
  });
  if (hit === null) throw new Error(`${text} not found`);
  return openItemHangRefuses(hit, ctx, op);
}

/** [seam off, seam on] */
function bothWays(src: string, text: string, op: string): [boolean, boolean] {
  r574Seam.on = false;
  try {
    const off = refused(src, text, op);
    r574Seam.on = true;
    return [off, refused(src, text, op)];
  } finally {
    r574Seam.on = true;
  }
}

const SAME = `codeunit 50100 Q
{
    var
        Buf: Record Buf temporary;
        Quiet: Boolean;

    procedure Drain()
    begin
        while not Buf.IsEmpty() do
            Pop();
    end;

    local procedure Pop()
    var
        Found: Boolean;
    begin
        Found := Buf.FindLast();
        if not Found then
            exit;
        Buf.Delete();
        if not Quiet then
            exit;
    end;
}`;

const TABLE = `table 50101 Buf
{
    fields { field(1; Value; Code[20]) { } }

    procedure Take()
    begin
        if not FindFirst() then
            Error('empty');
        Delete();
    end;
}

codeunit 50102 R
{
    procedure Drain(var Buf: Record Buf)
    begin
        while Buf.FindFirst() do
            Buf.Take();
    end;
}`;

describe("R574: early exits in R531's same-object hop", () => {
  it("refuses a guarded exit before the callee's Delete, and the value feeding its guard", () => {
    expect(bothWays(SAME, "not Found", REMOVE_NOT)).toEqual([false, true]);
    expect(bothWays(SAME, "Found := Buf.FindLast()", VMC)).toEqual([false, true]);
  });

  it("refuses an Error guard before a table procedure's Delete on R", () => {
    expect(bothWays(TABLE, "not FindFirst()", NEG)).toEqual([false, true]);
  });

  it("does not refuse an exit after the callee's last consumer (control)", () => {
    expect(bothWays(SAME, "not Quiet", REMOVE_NOT)).toEqual([false, false]);
  });
});
