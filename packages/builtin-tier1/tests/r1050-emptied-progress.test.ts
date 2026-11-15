import { beforeAll, describe, expect, it } from "bun:test";
import {
  ALNodeKind,
  type ALSyntaxNode,
  buildSemanticContext,
  findAll,
  initParser,
  parseAL,
  wrapRoot,
} from "@lethal/engine";
import { openItemHangRefuses } from "../src/index";

/**
 * R1050 (PR-37): `empty-block` on a same-object callee's body, or on a block holding an exit-feeding
 * write, hangs the caller's loop. Invented AL. Each test names the revert that turns it red.
 */

beforeAll(async () => {
  await initParser();
});

const SHAPE = `codeunit 50100 "Callee Shape"
{
    procedure Split(Text: Text): Text
    var
        Head: Text;
        Position: Integer;
        Length: Integer;
    begin
        Position := 1;
        Length := StrLen(Text);
        while Length <> 0 do begin
            ReadUntil('|', Text, Position);
            if Position > 1 then begin
                Head := Head + CopyStr(Text, 1, Position - 1);
                Text := CopyStr(Text, Position);
                Position := 1;
                Length := StrLen(Text);
            end;
        end;
        exit(Head);
    end;

    local procedure ReadUntil(Stop: Text; Text: Text; var Position: Integer)
    var
        Length: Integer;
    begin
        Length := StrLen(Text);
        while (Position <= Length) and (StrPos(Stop, CopyStr(Text, Position, 1)) = 0) do
            Position := Position + 1;
    end;
}`;

function load(src: string) {
  const root = wrapRoot(parseAL(src));
  return { root, ctx: buildSemanticContext([{ path: "t.al", root }]) };
}

/** Is the node of this kind whose text starts with `start` refused for `op`? */
function refused(src: string, kind: ALNodeKind, start: string, op: string): boolean {
  const { root, ctx } = load(src);
  const site = findAll(root, kind).find((n: ALSyntaxNode) => n.text.startsWith(start));
  if (site === undefined) throw new Error(`no ${kind} starting ${start}`);
  return openItemHangRefuses(site, ctx, op);
}

const EMPTY = "lethal.empty-block";
const CALLEE_BODY = "begin\n        Length := StrLen(Text);";
const IF_BLOCK = "begin\n                Head :=";

describe("R1050: empty-block that freezes a loop's progress", () => {
  it("refuses emptying the callee body the caller's loop progresses through", () => {
    // revert: return false at the top of emptiedProgressCalleeHangs, or use exitEffect.read only
    expect(refused(SHAPE, ALNodeKind.block, CALLEE_BODY, EMPTY)).toBe(true);
  });

  it("refuses emptying the caller's block that holds the exit-feeding write", () => {
    // revert: return false at the top of emptiedRefusedBlockHangs
    expect(refused(SHAPE, ALNodeKind.block, IF_BLOCK, EMPTY)).toBe(true);
  });

  it("still keeps the callee-internal sites (R837)", () => {
    const { root, ctx } = load(SHAPE);
    const callee = findAll(root, ALNodeKind.procedure).find((p) => p.text.includes("ReadUntil("));
    if (callee === undefined) throw new Error("no callee");
    const inside = (kind: ALNodeKind, op: string): boolean => {
      const site = findAll(callee, kind)[0];
      if (site === undefined) throw new Error(`no ${kind}`);
      return openItemHangRefuses(site, ctx, op);
    };
    expect(inside(ALNodeKind.assignment_statement, "lethal.remove-assignment")).toBe(false);
    expect(inside(ALNodeKind.while_statement, "lethal.loop-skip")).toBe(false);
    expect(inside(ALNodeKind.while_statement, "lethal.negate-conditional")).toBe(false);
  });

  it("keeps a callee the caller's exit does not depend on", () => {
    const src = SHAPE.replace(
      "ReadUntil('|', Text, Position);",
      "ReadUntil('|', Text, Position);\n            Count += 1;",
    )
      .replace("while Length <> 0 do", "while Count < 3 do")
      .replace("Position: Integer;", "Position: Integer;\n        Count: Integer;")
      .replace("Length := StrLen(Text);\n            end;", "Text := Text;\n            end;");
    expect(refused(src, ALNodeKind.block, CALLEE_BODY, EMPTY)).toBe(false);
  });

  it("keeps a callee whose argument is passed by value (only a var parameter can be moved)", () => {
    // revert: count every argument, not only those bound to a var parameter (the PR-37 build review fix)
    const src = `codeunit 50102 "ByValue"
{
    procedure Run(): Integer
    var
        Remaining: Integer;
    begin
        Remaining := 5;
        while Remaining > 0 do
            Remaining := Consume(Remaining);
        exit(Remaining);
    end;

    local procedure Consume(Left: Integer): Integer
    begin
        exit(Left - 1);
    end;
}`;
    expect(refused(src, ALNodeKind.block, "begin\n        exit(Left", EMPTY)).toBe(false);
    // the same shape with `var Left` is refused: the callee could move Remaining
    const byVar = src.replace("Consume(Left: Integer)", "Consume(var Left: Integer)");
    expect(refused(byVar, ALNodeKind.block, "begin\n        exit(Left", EMPTY)).toBe(true);
  });

  it("keeps a block in a loop that holds no exit-feeding write", () => {
    const src = `codeunit 50101 "Quiet"
{
    procedure P()
    var
        N: Integer;
        Log: Integer;
    begin
        while N < 3 do begin
            N += 1;
            if N > 1 then begin
                Log := Log + 1;
            end;
        end;
    end;
}`;
    expect(refused(src, ALNodeKind.block, "begin\n                Log", EMPTY)).toBe(false);
  });
});
