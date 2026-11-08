import { beforeAll, describe, expect, it } from "bun:test";
import {
  ALNodeKind,
  buildSemanticContext,
  findAll,
  initParser,
  parseAL,
  wrapRoot,
} from "@lethal/engine";
import type { MutationOperator } from "@lethal/operator-sdk";
import { deleteAdditiveRight } from "../src/delete-additive-operand";
import { swapAdditive } from "../src/swap-additive";

// R865 (coord R-871): an additive mutant on a direct recursion's depth argument is refused.
const OPS: readonly MutationOperator[] = [swapAdditive, deleteAdditiveRight];

/** The `before` text of every spec `op` claims, and how many sites it counts as hang-refused. */
function claimed(op: MutationOperator, body: string): { texts: string[]; refused: number } {
  const root = wrapRoot(parseAL(`codeunit 50000 R\n{\n${body}\n}`));
  const ctx = buildSemanticContext([{ path: "r.al", root }]);
  const nodes = findAll(root, ALNodeKind.additive_expression);
  const texts = nodes
    .filter((n) => op.targets(n, ctx))
    .flatMap((n) => op.generate(n, ctx))
    .map((s) => s.before.text);
  const refused = nodes.filter((n) => op.refusesHangCapable?.(n, ctx) === true).length;
  return { texts, refused };
}

describe("R865: recursionDepthHangs", () => {
  beforeAll(async () => {
    await initParser();
  });

  it("refuses the depth argument behind an exit guard, and keeps an argument no guard reads", () => {
    const body = `
    procedure Walk(Level: Integer; Count: Integer)
    begin
        if Level >= 10 then
            exit;
        Walk(Level + 1, Count + 1);
    end;`;
    for (const op of OPS) {
      const { texts, refused } = claimed(op, body);
      expect(texts).toEqual(["Count + 1"]);
      expect(refused).toBe(1);
    }
  });

  it("refuses through a guard on a call arm and `this.`, and through another argument", () => {
    const body = `
    procedure Walk(Level: Integer; Done: Boolean): Integer
    begin
        if not Done then
            exit(this.Walk(Level + 1, Level > 5));
        exit(Level);
    end;`;
    for (const op of OPS) expect(claimed(op, body).texts).toEqual([]);
  });

  it("an overload with another argument count is not recursion", () => {
    const body = `
    procedure Walk(Level: Integer)
    begin
        if Level >= 10 then
            exit;
        Walk(Level + 1, 0);
    end;

    procedure Walk(Level: Integer; Extra: Integer)
    begin
    end;`;
    for (const op of OPS) expect(claimed(op, body).texts).toEqual(["Level + 1"]);
  });

  it("an overload of the same count goes by argument types, both ways", () => {
    const body = (arg: string) => `
    procedure Walk(Level: Integer)
    var
        Amount: Decimal;
    begin
        if Level >= 10 then
            exit;
        Walk(${arg});
    end;

    procedure Walk(Amount: Decimal)
    begin
    end;`;
    // `Amount + 1.5` is a Decimal: the call is the other overload, so the mutant stays.
    for (const op of OPS) expect(claimed(op, body("Amount + 1.5")).texts).toEqual(["Amount + 1.5"]);
    // `Level + 1` is an Integer: the call is this procedure, so the mutant is refused.
    for (const op of OPS) expect(claimed(op, body("Level + 1")).texts).toEqual([]);
  });

  it("a call to another procedure is untouched", () => {
    const body = `
    procedure Walk(Level: Integer)
    begin
        if Level >= 10 then
            exit;
        Step(Level + 1);
    end;

    procedure Step(Level: Integer)
    begin
    end;`;
    for (const op of OPS) expect(claimed(op, body).texts).toEqual(["Level + 1"]);
  });
});
