import { beforeAll, describe, expect, it } from "bun:test";
import { buildSemanticContext, initParser, parseAL, visit, wrapRoot } from "@lethal/engine";
import { shiftInteger } from "../src/shift-integer";

/** R984: a `shift-integer` on a comparison OPERAND carries R983's site risk `compared-value`; an
 *  assigned literal carries none (its operator's `value-rewrite` applies). */
function risks(body: string): string[] {
  const src = `codeunit 50984 R984 { procedure P() var N: Integer; begin ${body} end; }`;
  const root = wrapRoot(parseAL(src));
  const ctx = buildSemanticContext([{ path: "fixture.al", root }]);
  const out: string[] = [];
  visit(root, (n) => {
    if (!shiftInteger.targets(n, ctx)) return;
    for (const s of shiftInteger.generate(n, ctx)) {
      out.push(`${s.before.text} -> ${s.after.text}: ${s.equivalenceRisk ?? "none"}`);
    }
  });
  return out;
}

describe("R984: shift-integer comparison operands get compared-value", () => {
  beforeAll(async () => {
    await initParser();
  });

  it("an `=` and an `<>` operand are compared-value", () => {
    expect(risks("if N = 5 then exit; if N <> 7 then exit;")).toEqual([
      "5 -> 6: compared-value",
      "7 -> 8: compared-value",
    ]);
  });

  it("an assigned literal carries no site risk", () => {
    expect(risks("N := 5;")).toEqual(["5 -> 6: none"]);
  });
});
