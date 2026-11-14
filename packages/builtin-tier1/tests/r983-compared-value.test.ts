import { beforeAll, describe, expect, it } from "bun:test";
import { buildSemanticContext, initParser, parseAL, visit, wrapRoot } from "@lethal/engine";
import type { MutationOperator } from "@lethal/operator-sdk";
import { toggleBlankString } from "../src/toggle-blank-string";
import { toggleBlankTemporal } from "../src/toggle-blank-temporal";

/** R983 (GitHub #51): a blank toggle on a comparison OPERAND carries the site risk
 *  `compared-value`; the same operator's ASSIGNED literal carries none (its operator's applies). */
function risks(op: MutationOperator, body: string): string[] {
  const src = `codeunit 50983 R983 { procedure P() var S: Text[10]; D: Date; T: Time; begin ${body} end; }`;
  const root = wrapRoot(parseAL(src));
  const ctx = buildSemanticContext([{ path: "fixture.al", root }]);
  const out: string[] = [];
  visit(root, (n) => {
    if (!op.targets(n, ctx)) return;
    for (const s of op.generate(n, ctx)) {
      out.push(`${s.before.text} -> ${s.after.text}: ${s.equivalenceRisk ?? "none"}`);
    }
  });
  return out;
}

describe("R983: blank toggles inside a comparison get their own equivalence risk", () => {
  beforeAll(async () => {
    await initParser();
  });

  it("string: a comparison operand, both directions, is compared-value", () => {
    expect(risks(toggleBlankString, "if S = '' then exit; if S <> 'FOO' then exit;")).toEqual([
      "'' -> 'x': compared-value",
      "'FOO' -> '': compared-value",
    ]);
  });

  it("an ordered comparison operand is compared-value too (the explanation covers its range)", () => {
    expect(risks(toggleBlankString, "if S > '' then exit;")).toEqual(["'' -> 'x': compared-value"]);
    expect(risks(toggleBlankTemporal, "if T >= 120000T then exit;")).toEqual([
      "120000T -> 0T: compared-value",
    ]);
  });

  it("string: an assigned literal carries no site risk", () => {
    expect(risks(toggleBlankString, "S := ''; S := 'FOO';")).toEqual([
      "'' -> 'x': none",
      "'FOO' -> '': none",
    ]);
  });

  it("temporal: a comparison operand, both directions, is compared-value", () => {
    expect(risks(toggleBlankTemporal, "if D <> 0D then exit; if T = 120000T then exit;")).toEqual([
      "0D -> 17530101D: compared-value",
      "120000T -> 0T: compared-value",
    ]);
  });

  it("temporal: an assigned literal carries no site risk", () => {
    expect(risks(toggleBlankTemporal, "D := 0D; T := 120000T;")).toEqual([
      "0D -> 17530101D: none",
      "120000T -> 0T: none",
    ]);
  });
});
