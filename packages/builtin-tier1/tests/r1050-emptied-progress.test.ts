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

  it("refuses a by-value callee whose result is assigned to the exit's name (R829's trade)", () => {
    // revert: drop the return-value seed (the `targets.some(live)` branch in r1050Progress)
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
    expect(refused(src, ALNodeKind.block, "begin\n        exit(Left", EMPTY)).toBe(true);
  });

  it("keeps a by-value procedure with no return value (it cannot move the exit's name)", () => {
    // revert: count every argument, not only those bound to a var parameter (the PR-37 build review fix)
    const src = `codeunit 50103 "ByValueLog"
{
    procedure Run(N: Integer)
    var
        Pos: Integer;
    begin
        while Pos < N do begin
            Log(Pos);
            Pos += 1;
        end;
    end;

    local procedure Log(P: Integer)
    begin
        Message('%1', P);
    end;
}`;
    expect(refused(src, ALNodeKind.block, "begin\n        Message", EMPTY)).toBe(false);
    // the same procedure taking `var P` is refused: it could move Pos
    const byVar = src.replace("Log(P: Integer)", "Log(var P: Integer)");
    expect(refused(byVar, ALNodeKind.block, "begin\n        Message", EMPTY)).toBe(true);
  });

  it("B: refuses a callee reached only through another progress callee", () => {
    // revert: remove the fixpoint loop in r1050Progress
    const src = `codeunit 50104 "Transitive"
{
    procedure Caller(N: Integer)
    var
        Pos: Integer;
    begin
        while Pos < N do
            StepB(Pos);
    end;

    local procedure StepB(var P: Integer)
    begin
        AdvB(P);
    end;

    local procedure AdvB(var P: Integer)
    begin
        P := P + 1;
    end;
}`;
    expect(refused(src, ALNodeKind.block, "begin\n        P := P + 1", EMPTY)).toBe(true);
  });

  it("C: refuses a function whose result is assigned to the exit's name", () => {
    // revert: remove the return-value seed
    const src = `codeunit 50105 "Assigned"
{
    procedure Caller(N: Integer)
    var
        Pos: Integer;
    begin
        while Pos < N do
            Pos := NextC(Pos);
    end;

    local procedure NextC(P: Integer): Integer
    begin
        exit(P + 1);
    end;
}`;
    expect(refused(src, ALNodeKind.block, "begin\n        exit(P + 1)", EMPTY)).toBe(true);
  });

  it("D: refuses a function called in the loop's own exit", () => {
    // revert: remove the return-value seed
    const src = `codeunit 50106 "InExit"
{
    procedure Caller()
    var
        Counter: Integer;
    begin
        repeat
            Counter += 1;
        until IsDoneD(Counter);
    end;

    local procedure IsDoneD(C: Integer): Boolean
    begin
        exit(C >= 10);
    end;
}`;
    expect(refused(src, ALNodeKind.block, "begin\n        exit(C >= 10)", EMPTY)).toBe(true);
  });

  it("refuses the progress callee of a repeat loop", () => {
    const src = `codeunit 50107 "Repeat"
{
    procedure Caller(N: Integer)
    var
        Pos: Integer;
    begin
        repeat
            Adv(Pos);
        until Pos >= N;
    end;

    local procedure Adv(var P: Integer)
    begin
        P += 1;
    end;
}`;
    expect(refused(src, ALNodeKind.block, "begin\n        P += 1", EMPTY)).toBe(true);
  });

  it("F: refuses a callee that writes a global the loop's exit reads", () => {
    const src = `codeunit 50108 "Global"
{
    var
        GPos: Integer;

    trigger OnRun()
    begin
        while GPos < 10 do
            BumpF();
    end;

    local procedure BumpF()
    begin
        GPos += 1;
    end;
}`;
    expect(refused(src, ALNodeKind.block, "begin\n        GPos += 1", EMPTY)).toBe(true);
  });

  it("M: refuses a block holding a bare progress call in a loop", () => {
    // revert: drop the `procedure_call` branch of emptiedRefusedBlockHangs
    const src = `codeunit 50109 "BareCall"
{
    procedure Caller(N: Integer)
    var
        Pos: Integer;
        Log: Integer;
        Go: Boolean;
    begin
        Go := N > 0;
        while Pos < N do
            if Go then begin
                AdvA(Pos);
                Log += 1;
            end;
    end;

    local procedure AdvA(var P: Integer)
    begin
        P := P + 1;
    end;
}`;
    expect(refused(src, ALNodeKind.block, "begin\n                AdvA", EMPTY)).toBe(true);
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

  // exitsOnDefault: a value-returning callee in the loop's exit, emptied, returns its default.
  const exitCase = (loopStmt: string, ret: string, id: number): boolean => {
    const src = `codeunit ${id} "Dflt"
{
    procedure Caller()
    var
        Counter: Integer;
    begin
        ${loopStmt}
    end;

    local procedure F(): ${ret}
    begin
        exit(Probe);
    end;
}`;
    return refused(src, ALNodeKind.block, "begin\n        exit(Probe)", EMPTY);
  };

  it("NOT refused: repeat until F() = 0 (the default 0 exits at once)", () => {
    // revert: make exitsOnDefault return false
    expect(exitCase("repeat Counter += 1; until F() = 0;", "Integer", 50110)).toBe(false);
  });

  it("refused: repeat until IsDone() (the default false never exits)", () => {
    expect(exitCase("repeat Counter += 1; until F();", "Boolean", 50111)).toBe(true);
  });

  it("NOT refused: while Step() do (the default false never enters)", () => {
    // revert: make exitsOnDefault return false
    expect(exitCase("while F() do Counter += 1;", "Boolean", 50112)).toBe(false);
  });

  it("refused: while not AtEnd() do (the default false never leaves)", () => {
    expect(exitCase("while not F() do Counter += 1;", "Boolean", 50113)).toBe(true);
  });

  it("refused: until F() > 5 (0 > 5 is false, never exits)", () => {
    expect(exitCase("repeat Counter += 1; until F() > 5;", "Integer", 50114)).toBe(true);
  });
});
