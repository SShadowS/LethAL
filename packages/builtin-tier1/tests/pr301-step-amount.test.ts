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
