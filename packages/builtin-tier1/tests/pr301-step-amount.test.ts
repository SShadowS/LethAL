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
 * PR-301 (GitHub #52): `remove-assignment` of `X := v` before a loop, where X is not read by the
 * loop's exit but is the AMOUNT of a step that moves a name the exit reads. With X at its default
 * the step leaves that name unchanged (`T := CopyStr(T, X + 1)`, `I += X`), so the loop cannot
 * progress. R1061's rule B reads X in the exit only and misses it. Invented AL.
 */

beforeAll(async () => {
  await initParser();
});

const OP = "lethal.remove-assignment";

function refused(src: string, start: string, op = OP): boolean {
  const root = wrapRoot(parseAL(src));
  const ctx = buildSemanticContext([{ path: "t.al", root }]);
  const site = findAll(root, ALNodeKind.assignment_statement).find((n: ALSyntaxNode) =>
    n.text.startsWith(start),
  );
  if (site === undefined) throw new Error(`no assignment starting ${start}`);
  return openItemHangRefuses(site, ctx, op);
}

const unit = (body: string, locals = "") => `codeunit 50131 "Step Amount"
{
    procedure Run(Source: Text)
    var
        Remaining: Text;
        Piece: Text;
        Chunk: Integer;
        I: Integer;
        N: Integer;
        Step: Integer;
        Total: Integer;
        ${locals}
    begin
${body}
    end;

    local procedure Emit(T: Text)
    begin
    end;
}`;

/** The issue's shape (#52), with the insert replaced by a local call. */
const ISSUE = (assign = "Chunk := 80;", elseBranch = "Remaining := '';") =>
  unit(
    [
      "        Remaining := Source;",
      `        ${assign}`,
      "        while Remaining <> '' do begin",
      "            Piece := CopyStr(Remaining, 1, 80);",
      "            Emit(Piece);",
      "            if StrLen(Remaining) > Chunk then",
      "                Remaining := CopyStr(Remaining, Chunk + 1)",
      "            else",
      `                ${elseBranch}`,
      "            Total += 1;",
      "        end;",
    ].join("\n"),
  );

describe("PR-301: a removed step amount set before the loop", () => {
  it("refuses the #52 shape: `Chunk :=` feeds the step `Remaining := CopyStr(Remaining, Chunk + 1)` (revert: the step-amount check)", () => {
    expect(refused(ISSUE(), "Chunk := 80")).toBe(true);
  });

  it("control: the same loop's other writes stay mutants", () => {
    expect(refused(ISSUE(), "Total += 1")).toBe(false);
    expect(refused(ISSUE(), "Piece := CopyStr")).toBe(false);
  });

  it("control: `Chunk := 0` is the default already, so removing it changes nothing (revert: the default test)", () => {
    expect(refused(ISSUE("Chunk := 0;"), "Chunk := 0")).toBe(false);
  });

  it("control: a loop that writes Chunk itself decides its own amount (revert: the no-write-in-loop test)", () => {
    const src = ISSUE("Chunk := 80;", "Chunk := 1;");
    expect(refused(src, "Chunk := 80")).toBe(false);
  });

  it("control: another operator on the same site is not refused by this rule (revert: the operator test)", () => {
    expect(refused(ISSUE(), "Chunk := 80", "lethal.shift-integer")).toBe(false);
  });

  it("refuses a counter stepped by an amount set before the loop: `I += Step` under `while I < N` (revert: the += form)", () => {
    const src = unit(
      [
        "        N := 10;",
        "        Step := 2;",
        "        while I < N do begin",
        "            I += Step;",
        "            Total += 1;",
        "        end;",
      ].join("\n"),
    );
    expect(refused(src, "Step := 2")).toBe(true);
    expect(refused(src, "Total += 1")).toBe(false);
  });

  it("refuses `I := I + Step` too, and a `repeat .. until I >= N` loop (revert: the := form)", () => {
    const src = unit(
      [
        "        N := 10;",
        "        Step := 2;",
        "        repeat",
        "            I := I + Step;",
        "        until I >= N;",
      ].join("\n"),
    );
    expect(refused(src, "Step := 2")).toBe(true);
  });

  it("refuses `Remaining := DelStr(Remaining, 1, Chunk)` (revert: the DelStr form)", () => {
    const src = unit(
      [
        "        Remaining := Source;",
        "        Chunk := 80;",
        "        while Remaining <> '' do begin",
        "            Emit(CopyStr(Remaining, 1, Chunk));",
        "            Remaining := DelStr(Remaining, 1, Chunk);",
        "        end;",
      ].join("\n"),
    );
    expect(refused(src, "Chunk := 80")).toBe(true);
  });

  it("control: an amount whose step moves a name the exit does NOT read is not refused (revert: the exit-reads-target test)", () => {
    const src = unit(
      [
        "        N := 10;",
        "        Step := 2;",
        "        while I < N do begin",
        "            Total += Step;",
        "            I += 1;",
        "        end;",
      ].join("\n"),
    );
    expect(refused(src, "Step := 2")).toBe(false);
  });

  it("control: a step that still moves at X's default is not refused: `CopyStr(Remaining, Chunk + 2)` (revert: the identity test)", () => {
    const src = unit(
      [
        "        Remaining := Source;",
        "        Chunk := 80;",
        "        while Remaining <> '' do",
        "            Remaining := CopyStr(Remaining, Chunk + 2);",
      ].join("\n"),
    );
    expect(refused(src, "Chunk := 80")).toBe(false);
  });
});

/** The spec-adversary's cases: unknown keeps the mutant (R1061), and two more hang forms. */
describe("PR-301 review: narrowing and two more forms", () => {
  const L = "Done: Boolean; Len: Integer; Cust: Record Customer;";

  it("control: another exit name that still moves ends the loop: `while (I < N) and (Remaining <> '')` (revert: condition 4)", () => {
    const src = unit(
      [
        "        N := 10;",
        "        Remaining := Source;",
        "        Chunk := 80;",
        "        while (I < N) and (Remaining <> '') do begin",
        "            Remaining := CopyStr(Remaining, Chunk + 1);",
        "            I += 1;",
        "        end;",
      ].join("\n"),
      L,
    );
    expect(refused(src, "Chunk := 80")).toBe(false);
  });

  it("control: a cursor in the condition ends the loop: `until (Cust.Next() = 0) or (I > N)` (revert: the cursor check)", () => {
    const src = unit(
      [
        "        N := 10;",
        "        Step := 2;",
        "        repeat",
        "            I += Step;",
        "        until (Cust.Next() = 0) or (I > N);",
      ].join("\n"),
      L,
    );
    expect(refused(src, "Step := 2")).toBe(false);
  });

  it("control: an else that moves at X = 0 under a guard that reads X only (revert: the guard must read T too)", () => {
    const src = unit(
      [
        "        Remaining := Source;",
        "        Chunk := 80;",
        "        while Remaining <> '' do",
        "            if Chunk > 0 then",
        "                Remaining := CopyStr(Remaining, Chunk + 1)",
        "            else",
        "                Remaining := CopyStr(Remaining, 2);",
      ].join("\n"),
      L,
    );
    expect(refused(src, "Chunk := 80")).toBe(false);
  });

  it("control: a same-object callee that writes T keeps the site (revert: callWrites for T)", () => {
    const src = `codeunit 50132 "Step Callee"
{
    var
        Remaining: Text;

    procedure Run(Source: Text)
    var
        Chunk: Integer;
    begin
        Remaining := Source;
        Chunk := 80;
        while Remaining <> '' do begin
            Remaining := CopyStr(Remaining, Chunk + 1);
            Advance();
        end;
    end;

    local procedure Advance()
    begin
        Remaining := '';
    end;
}`;
    expect(refused(src, "Chunk := 80")).toBe(false);
  });

  it("refuses the three-argument form `CopyStr(Remaining, Chunk + 1, 80)` (revert: the length form)", () => {
    const src = unit(
      [
        "        Remaining := Source;",
        "        Chunk := 80;",
        "        while Remaining <> '' do",
        "            Remaining := CopyStr(Remaining, Chunk + 1, 80);",
      ].join("\n"),
      L,
    );
    expect(refused(src, "Chunk := 80")).toBe(true);
  });

  it("refuses through a local copy: `Len := Chunk` then a step by Len (revert: xs instead of x)", () => {
    const src = unit(
      [
        "        Remaining := Source;",
        "        Chunk := 80;",
        "        Len := Chunk;",
        "        while Remaining <> '' do",
        "            Remaining := CopyStr(Remaining, Len + 1);",
      ].join("\n"),
      L,
    );
    expect(refused(src, "Chunk := 80")).toBe(true);
  });

  it("refuses a flag fed by T: `Done := Remaining = ''` (condition 4 lets a write that reads T through)", () => {
    const src = unit(
      [
        "        Remaining := Source;",
        "        Chunk := 80;",
        "        while not Done do begin",
        "            Remaining := CopyStr(Remaining, Chunk + 1);",
        "            Done := Remaining = '';",
        "        end;",
      ].join("\n"),
      L,
    );
    expect(refused(src, "Chunk := 80")).toBe(true);
  });

  it("given back only for a positive earlier amount: -1 stays refused, 3 is given back (revert: lit > 0)", () => {
    const loop = (earlier: string) =>
      unit(
        [
          "        N := 10;",
          `        Step := ${earlier};`,
          "        Step := 2;",
          "        while I < N do",
          "            I += Step;",
        ].join("\n"),
        L,
      );
    expect(refused(loop("-1"), "Step := 2")).toBe(true);
    expect(refused(loop("3"), "Step := 2")).toBe(false);
  });
});

/** The Opus build review's cases. */
describe("PR-301 build review", () => {
  const L = "Lines: List of [Text]; Cust: Record Customer; Len: Integer; GoOn: Boolean;";
  const issueWith = (call: string) =>
    unit(
      [
        "        Remaining := Source;",
        "        Chunk := 80;",
        "        while Remaining <> '' do begin",
        "            Piece := CopyStr(Remaining, 1, 80);",
        `            ${call}`,
        "            if StrLen(Remaining) > Chunk then",
        "                Remaining := CopyStr(Remaining, Chunk + 1)",
        "            else",
        "                Remaining := '';",
        "        end;",
      ].join("\n"),
      L,
    );

  it("refuses #52's shape with an ordinary call in the body: a List Add and a record Insert(true) (revert: callee names out of exitNames)", () => {
    expect(refused(issueWith("Lines.Add(Piece);"), "Chunk := 80")).toBe(true);
    expect(refused(issueWith("Cust.Insert(true);"), "Chunk := 80")).toBe(true);
  });

  it("control: a defensive zero guard ends the loop at X = 0: `if (Chunk = 0) or (StrLen(Remaining) <= Chunk) then Remaining := ''` (revert: the exact #52 guard)", () => {
    const src = unit(
      [
        "        Remaining := Source;",
        "        Chunk := 80;",
        "        while Remaining <> '' do",
        "            if (Chunk = 0) or (StrLen(Remaining) <= Chunk) then",
        "                Remaining := ''",
        "            else",
        "                Remaining := CopyStr(Remaining, Chunk + 1);",
      ].join("\n"),
      L,
    );
    expect(refused(src, "Chunk := 80")).toBe(false);
  });

  it("control: a call in the condition may end the loop itself: `while (I < N) and Budget() do` (revert: the pure-call check)", () => {
    const src = `codeunit 50133 "Step Budget"
{
    procedure Run()
    var
        I: Integer;
        N: Integer;
        Step: Integer;
    begin
        N := 10;
        Step := 2;
        while (I < N) and Budget() do
            I += Step;
    end;

    local procedure Budget(): Boolean
    begin
        exit(false);
    end;
}`;
    expect(refused(src, "Step := 2")).toBe(false);
  });

  it("control: a three-argument CopyStr whose cut meets an exit that measures T: `while StrLen(Remaining) > 80` (revert: the StrLen exclusion)", () => {
    const src = unit(
      [
        "        Remaining := Source;",
        "        Chunk := 80;",
        "        while StrLen(Remaining) > 80 do",
        "            Remaining := CopyStr(Remaining, Chunk + 1, 80);",
      ].join("\n"),
      L,
    );
    expect(refused(src, "Chunk := 80")).toBe(false);
  });
});
