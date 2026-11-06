import { beforeAll, describe, expect, it } from "bun:test";
import {
  type ALSyntaxNode,
  type MutationOperator,
  buildSemanticContext,
  initParser,
  parseAL,
  visit,
  wrapRoot,
} from "@lethal/engine";
import { deleteAdditiveLeft, deleteAdditiveRight } from "../src/delete-additive-operand";
import { deleteLogicalLeft, deleteLogicalRight } from "../src/delete-logical-operand";

/**
 * R855 (GitHub #35, #41). No live gate may hold a hang-capable site (R164), so each refusal is proved
 * here, with a CONTROL beside it that must still be claimed: a rule that refused everything goes red.
 * `refusesHangCapable` is checked too, so a hang refusal is counted and not silently dropped.
 */
function sites(op: MutationOperator, src: string): { claimed: string[]; hang: string[] } {
  const root = wrapRoot(parseAL(src));
  expect(root.hasError).toBe(false);
  const ctx = buildSemanticContext([{ path: "fixture.al", root }]);
  const claimed: string[] = [];
  const hang: string[] = [];
  visit(root, (n: ALSyntaxNode) => {
    const on = op.targets(n, ctx);
    expect(on, `targets() and generate() disagree at ${n.text}`).toBe(
      op.generate(n, ctx).length > 0,
    );
    if (on) claimed.push(n.text);
    if (op.refusesHangCapable?.(n, ctx) === true) hang.push(n.text);
  });
  return { claimed, hang };
}

const unit = (vars: string, body: string): string => `codeunit 51630 "C"
{
    var
        Counter: Integer;
        Limit: Integer;
        Pos: Integer;
${vars}

    procedure P(A: Boolean; B: Boolean; I: Integer; J: Integer): Integer
    var
        Total: Integer;
    begin
${body}
    end;

    local procedure Advance()
    begin
        Counter += 1;
    end;

    local procedure Step(): Integer
    begin
        Pos += 1;
        exit(1);
    end;

    local procedure StepB(): Boolean
    begin
        Pos += 1;
        exit(true);
    end;

    local procedure Quiet(): Boolean
    begin
        exit(true);
    end;

    local procedure Noop()
    begin
    end;
}
`;

beforeAll(async () => {
  await initParser();
});

describe("R855: a deleted operand that holds the loop's progress", () => {
  const LOOP = unit(
    "",
    `        while Pos < Limit do
            Total := Total + Step();
        while Pos < Limit do begin
            Pos += 1;
            Total := Total + Step();
        end;
        while Pos < Limit do begin
            Pos := Pos + 1;
            if A or StepB() then Total := 1;
            if A or Quiet() then Total := 2;
        end;`,
  );

  it("additive right deletes the call: refused and counted", () => {
    const r = sites(deleteAdditiveRight, LOOP);
    expect(r.claimed).not.toContain("Total + Step()");
    expect(r.hang).toContain("Total + Step()");
  });

  it("additive left keeps the call: claimed, the control", () => {
    expect(sites(deleteAdditiveLeft, LOOP).claimed).toContain("Total + Step()");
  });

  it("logical right deletes the call: refused and counted; the same site with a quiet call is claimed", () => {
    const r = sites(deleteLogicalRight, LOOP);
    expect(r.hang).toContain("A or StepB()");
    expect(r.claimed).toEqual(["A or Quiet()"]);
  });

  it("logical left deletes the flag and keeps the call: claimed", () => {
    expect(sites(deleteLogicalLeft, LOOP).claimed).toContain("A or StepB()");
  });
});

describe("R855: a site that guards the loop's progress", () => {
  const GUARD = unit(
    "",
    `        repeat
            if A or B then Advance();
            if A and B then Noop();
        until Counter >= Limit;`,
  );

  for (const op of [deleteLogicalRight, deleteLogicalLeft]) {
    it(`${op.name}: refused and counted beside a guard of nothing`, () => {
      const r = sites(op, GUARD);
      expect(r.hang).toEqual(["A or B"]);
      expect(r.claimed).toEqual(["A and B"]);
    });
  }

  it("the branch is read, not the procedure: an additive site in such a condition", () => {
    const src = unit(
      "",
      "        repeat\n            if I + J > 0 then Advance();\n            if I + J > 1 then Noop();\n        until Counter >= Limit;",
    );
    const r = sites(deleteAdditiveRight, src);
    expect(r.hang).toEqual(["I + J"]);
    expect(r.claimed).toEqual(["I + J"]);
  });
});

describe("R855: a site in a loop's exit parts", () => {
  it("a loop's own condition, for every operator", () => {
    const src = unit("", "        while (I + J < Limit) and (A or B) do\n            I += 1;");
    for (const op of [
      deleteLogicalRight,
      deleteLogicalLeft,
      deleteAdditiveRight,
      deleteAdditiveLeft,
    ]) {
      expect(sites(op, src).claimed).toEqual([]);
    }
  });

  it("a guard of an exit: `repeat ... until false` ends only through it", () => {
    const src = unit(
      "",
      "        repeat\n            if A or B then exit(1);\n            if A or Quiet() then Total := 1;\n        until false;",
    );
    expect(sites(deleteLogicalRight, src).claimed).toEqual(["A or Quiet()"]);
  });

  it("a write to what the condition reads (R196)", () => {
    const src = unit(
      "",
      "        while I < Limit do\n            I := I + 1;\n        Total := I + 1;",
    );
    const r = sites(deleteAdditiveRight, src);
    expect(r.hang).toEqual(["I + 1"]);
    expect(r.claimed).toEqual(["I + 1"]);
  });
});

describe("R855: operands that may not be deleted", () => {
  it("a bare literal left over, signed or in parentheses, is refused; an operand stays", () => {
    const src = unit(
      "",
      "        Total := I + 300;\n        Total := 300 + I;\n        Total := I + (-1);",
    );
    expect(sites(deleteAdditiveLeft, src).claimed).toEqual(["300 + I"]);
    expect(sites(deleteAdditiveRight, src).claimed).toEqual(["I + 300", "I + (-1)"]);
  });

  it("a divisor is refused at any depth; a dividend and a multiplier are not", () => {
    const src = unit(
      "",
      "        Total := Total / (I + J);\n        Total := Total div ((I + J) * 2);\n        Total := Total mod (I + J);\n        Total := (I + J) / Total;\n        Total := Total * (I + J);",
    );
    expect(sites(deleteAdditiveRight, src).claimed).toEqual(["I + J", "I + J"]);
  });

  it("an array index stays in, by ruling", () => {
    const src = unit("        Arr: array[3] of Integer;", "        Total := Arr[I - J];");
    expect(sites(deleteAdditiveRight, src).claimed).toEqual(["I - J"]);
  });

  it("the left of `and` is claimed: AL does not short-circuit", () => {
    const src = unit("", "        if (I > 0) and (A or B) then Total := 1;");
    expect(sites(deleteLogicalLeft, src).claimed).toContain("(I > 0) and (A or B)");
  });
});
