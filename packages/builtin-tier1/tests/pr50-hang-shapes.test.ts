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
 * PR-50 (R1052, R1063): the remaining hang shapes. Invented AL. Each test says which candidate it
 * pins (H, I, L, E, W, S); a refuse test goes red with its rule off, a keep test goes red when the
 * rule is widened.
 */

beforeAll(async () => {
  await initParser();
});

const EMPTY = "lethal.empty-block";
const RA = "lethal.remove-assignment";

function refused(src: string, kind: ALNodeKind, start: string, op: string): boolean {
  const root = wrapRoot(parseAL(src));
  const ctx = buildSemanticContext([{ path: "t.al", root }]);
  const site = findAll(root, kind).find((n: ALSyntaxNode) => n.text.startsWith(start));
  if (site === undefined) throw new Error(`no ${kind} starting ${start}`);
  return openItemHangRefuses(site, ctx, op);
}

const block = (src: string, start: string) => refused(src, ALNodeKind.block, start, EMPTY);
const assign = (src: string, start: string) =>
  refused(src, ALNodeKind.assignment_statement, start, RA);

describe("H: a progress call inside an assignment", () => {
  const src = (call: string) => `codeunit 50300 "H"
{
    procedure Run(N: Integer)
    var
        Pos: Integer;
        Other: Integer;
        X: Integer;
        Go: Boolean;
    begin
        while Pos < N do begin
            if Go then begin
                X := ${call};
            end;
        end;
    end;

    local procedure AdvE(var P: Integer): Integer
    begin
        P += 1;
        exit(P);
    end;
}`;
  it("refuses remove-assignment of X := AdvE(Pos)", () => {
    expect(assign(src("AdvE(Pos)"), "X :=")).toBe(true);
  });
  it("refuses empty-block of the block holding it", () => {
    expect(block(src("AdvE(Pos)"), "begin\n                X :=")).toBe(true);
  });
  it("keeps both when the call moves a name the exit does not read", () => {
    expect(assign(src("AdvE(Other)"), "X :=")).toBe(false);
    expect(block(src("AdvE(Other)"), "begin\n                X :=")).toBe(false);
  });
});

describe("H: a built-in call in an assignment is no progress", () => {
  it("keeps X := StrLen(Text) under a loop that reads Text", () => {
    const src = `codeunit 50309 "H2"
{
    procedure Run()
    var
        Text: Text;
        Len: Integer;
    begin
        Text := 'abc';
        while Text <> '' do begin
            Len := StrLen(Text);
            Text := CopyStr(Text, 2);
        end;
    end;
}`;
    expect(assign(src, "Len :=")).toBe(false);
  });
});

describe("I: a block holding the loop's only exit", () => {
  const src = (until: string, more = "") => `codeunit 50301 "I"
{
    var
        GDone: Boolean;

    procedure Run()
    var
        I: Integer;
    begin
        repeat
            I += 1;
            ${more}
            if I > 10 then begin
                GDone := true;
                exit;
            end;
        until ${until};
    end;
}`;
  const start = "begin\n                GDone";
  it("refuses empty-block under until false", () => {
    expect(block(src("false"), start)).toBe(true);
  });
  it("keeps it when the condition can end the loop", () => {
    expect(block(src("I > 20"), start)).toBe(false);
  });
  it("keeps it when another exit stays outside the block", () => {
    expect(block(src("false", "if I = 5 then exit;"), start)).toBe(false);
  });
  it("refuses a break and an Error the same way, and a while true", () => {
    const w = (exit: string) => `codeunit 50302 "I2"
{
    var
        GDone: Boolean;

    procedure Run()
    var
        I: Integer;
    begin
        while true do begin
            I += 1;
            if I > 10 then begin
                GDone := true;
                ${exit}
            end;
        end;
    end;
}`;
    const at = "begin\n                GDone";
    expect(block(w("break;"), at)).toBe(true);
    expect(block(w("Error('x');"), at)).toBe(true);
    expect(block(w("GDone := false;"), at)).toBe(false);
  });
});

describe("L: a local copy that feeds the exit name inside a progress procedure", () => {
  const src = (copyIn: string) => `codeunit 50303 "L"
{
    procedure Caller(T: Text)
    var
        Pos: Integer;
    begin
        while More(T, Pos) do;
    end;

    local procedure More(T: Text; var Pos: Integer): Boolean
    var
        Next: Integer;
        Side: Integer;
    begin
        ${copyIn}
        Skip(T, Next);
        Pos := Next;
        exit(Pos <= StrLen(T));
    end;

    local procedure Skip(T: Text; var I: Integer)
    begin
        I += 1;
    end;
}`;
  it("refuses emptying Skip when Next is copied from Pos", () => {
    expect(block(src("Next := Pos;"), "begin\n        I += 1")).toBe(true);
  });
  it("keeps it when Skip moves a local that never meets Pos", () => {
    const s = src("Side := Spare;")
      .replace("Skip(T, Next);", "Skip(T, Side);")
      .replace("Side: Integer;", "Side: Integer;\n        Spare: Integer;");
    expect(block(s, "begin\n        I += 1")).toBe(false);
  });
});

describe("E: rule B reads more", () => {
  const eq = (body: string, locals = "") => `codeunit 50304 "E1"
{
    procedure Run()
    var
        N: Integer;
        Size: Integer;
        ${locals}
    begin
        Size := 1000;
        repeat
            ${body}
        until N = Size;
    end;
}`;
  it("refuses until N = Size with N stepped first", () => {
    expect(assign(eq("N += 1;"), "Size :=")).toBe(true);
  });
  it("keeps it when N is reset after the step", () => {
    expect(assign(eq("N += 1; N := 0;"), "Size :=")).toBe(false);
  });
  it("keeps it when the step is conditional", () => {
    expect(assign(eq("if Random(2) = 1 then N += 1;"), "Size :=")).toBe(false);
  });
  it("keeps it when a continue can skip the step", () => {
    expect(assign(eq("if Random(2) = 1 then continue; N += 1;"), "Size :=")).toBe(false);
  });

  const alias = (between: string) => `codeunit 50305 "E2"
{
    procedure Run()
    var
        N: Integer;
        Size: Integer;
        Limit: Integer;
    begin
        Size := 1000;
        Limit := Size;
        ${between}
        repeat
            N := 0;
            N += 1;
        until N < Limit;
    end;
}`;
  it("refuses a bound read through a second local", () => {
    expect(assign(alias(""), "Size :=")).toBe(true);
  });
  it("keeps it when the second local is rewritten before the loop", () => {
    expect(assign(alias("Limit := 7;"), "Size :=")).toBe(false);
  });

  const each = (before: string, after: string) => `codeunit 50306 "E3"
{
    procedure Run(Ids: List of [Integer])
    var
        Id: Integer;
        N: Integer;
        Size: Integer;
    begin
        Size := 1000;
        foreach Id in Ids do begin
            ${before}
            repeat
                N := 0;
                N += 1;
            until N < Size;
            ${after}
        end;
    end;
}`;
  it("refuses when a write to Size comes after the loop in the same foreach", () => {
    expect(assign(each("", "Size := 5;"), "Size := 1000")).toBe(true);
  });
  it("keeps it when the write comes before the loop", () => {
    expect(assign(each("Size := 5;", ""), "Size := 1000")).toBe(false);
  });
});

describe("W: an earlier non-default write is given back", () => {
  const src = (first: string) => `codeunit 50307 "W"
{
    procedure Run()
    var
        N: Integer;
        Size: Integer;
    begin
        ${first}
        Size := 1000;
        repeat
            N := 0;
            N += 1;
        until N < Size;
    end;

    local procedure Calc(): Integer
    begin
        exit(5);
    end;
}`;
  it("gives back Size := 1000 after Size := 5", () => {
    expect(assign(src("Size := 5;"), "Size := 1000")).toBe(false);
  });
  it("keeps refusing with no earlier write", () => {
    expect(assign(src(""), "Size := 1000")).toBe(true);
  });
  it("keeps refusing after an earlier write of an unknown value", () => {
    expect(assign(src("Size := Calc();"), "Size := 1000")).toBe(true);
  });
  it("keeps refusing after an earlier write of the default", () => {
    expect(assign(src("Size := 0;"), "Size := 1000")).toBe(true);
  });
});

describe("S: the counter must start at 0 or more", () => {
  const src = (counter: "local" | "param" | "global") => `codeunit 50308 "S"
{
    var
        ${counter === "global" ? "N: Integer;" : ""}

    procedure Run(${counter === "param" ? "N: Integer" : ""})
    var
        Size: Integer;
        ${counter === "local" ? "N: Integer;" : ""}
    begin
        Size := 1000;
        repeat
            N += 1;
        until N < Size;
    end;
}`;
  it("refuses with a local counter", () => {
    expect(assign(src("local"), "Size :=")).toBe(true);
  });
  it("gives back a parameter counter", () => {
    expect(assign(src("param"), "Size :=")).toBe(false);
  });
  it("gives back a global counter", () => {
    expect(assign(src("global"), "Size :=")).toBe(false);
  });
});
