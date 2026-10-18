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
 * R574: R531's same-object HOP (a same-object callee, or a table procedure on R) is built by
 * R571's `r571Hop`, so it refuses the callee's early exits (an `exit` or `Error` before the last
 * consumer or inside a callee loop holding one, and a `break` leaving such a loop), their guards
 * and the values that feed the hop's guards. Each site is read with `r574Seam` off (master) and on.
 */

beforeAll(async () => {
  await initParser();
});

const REMOVE_NOT = "lethal.remove-not";
const REMOVE_ASSIGN = "lethal.remove-assignment";
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

/** A codeunit whose loop drains `Buf` through the same-object callee `Pop`, whose body is `pop`. */
const drain = (pop: string, locals = ""): string => `codeunit 50100 Q
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
    ${locals}
    begin
${pop}
    end;
}`;

const GUARDED_EXIT = drain(`        if not Buf.FindLast() then
            exit;
        Buf.Delete();
        if not Quiet then
            exit;`);

const EXIT_IN_LOOP = drain(`        if Buf.FindSet() then
            repeat
                Buf.Delete();
                if Buf.Blocked then
                    exit;
            until Buf.Next() = 0;`);

const FEED = drain(
  `        Found := Buf.FindLast();
        if not Found then
            exit;
        Buf.Delete();`,
  `var
        Found: Boolean;`,
);

const RAISED = drain(`        if Buf.Blocked then
            Error('blocked');
        Buf.Delete();`);

const BREAK = drain(`        if Buf.FindSet() then
            repeat
                if Buf.Blocked then
                    break;
                Buf.Delete();
            until Buf.Next() = 0;`);

const TABLE = `table 50101 Buf
{
    fields { field(1; Value; Code[20]) { } }

    procedure Take()
    begin
        if not FindFirst() then
            exit;
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
  // red: r574Seam.on = false (the same-object hop no longer goes through r571Hop)
  it("T1: refuses a guarded exit before the callee's Delete", () => {
    expect(bothWays(GUARDED_EXIT, "not Buf.FindLast()", REMOVE_NOT)).toEqual([false, true]);
  });

  // red: isExit by textual order only (drop the loops clause)
  it("T2: refuses an exit after the Delete inside the callee's consumer loop", () => {
    expect(bothWays(EXIT_IN_LOOP, "Buf.Blocked", NEG)).toEqual([false, true]);
  });

  // red: isExit takes every exit
  it("T3: does not refuse an exit after the callee's last consumer (control)", () => {
    expect(bothWays(GUARDED_EXIT, "not Quiet", REMOVE_NOT)).toEqual([false, false]);
  });

  // red: drop r571Hop's feeds line (R571's T16 goes red too)
  it("T4: refuses the assignment feeding the exit guard", () => {
    expect(bothWays(FEED, "Found := Buf.FindLast()", REMOVE_ASSIGN)).toEqual([false, true]);
  });

  // red: the seam on same-object callees only (table procedures on R keep r531CalleeHop)
  it("T5: refuses a guarded exit before a table procedure's Delete on R", () => {
    expect(bothWays(TABLE, "not FindFirst()", REMOVE_NOT)).toEqual([false, true]);
  });

  // red: exits only (drop isRaisedError from isExit); pins Date Compress as a stated over-refusal
  it("T6: refuses an Error guard before the callee's Delete", () => {
    expect(bothWays(RAISED, "Buf.Blocked", NEG)).toEqual([false, true]);
  });

  // red: drop the break_statement branch of isExit (R571's T17 goes red too)
  it("T7: refuses the guard of a break that leaves the callee's consumer loop", () => {
    expect(bothWays(BREAK, "Buf.Blocked", NEG)).toEqual([false, true]);
  });
});
