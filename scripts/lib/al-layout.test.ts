import { beforeAll, describe, expect, it } from "bun:test";
import { tier1Operators } from "../../packages/builtin-tier1/src/index";
import { tier2Operators } from "../../packages/builtin-tier2/src/index";
import { initParser } from "../../packages/engine/src/ast/parser";
import { alTokenStream, layoutAL } from "./al-layout";

describe("layoutAL", () => {
  beforeAll(async () => {
    await initParser();
  });

  /**
   * The load-bearing test. A layout pass that reordered, dropped or invented a token would change
   * what the code MEANS while still looking tidy, and a slide built from it would be a lie about
   * the operator it illustrates. Comparing token streams is what makes that impossible to miss.
   *
   * It runs over every committed conformance source rather than a hand-picked sample, so a fixture
   * added later is covered without anyone remembering to add it here.
   */
  it("preserves the token stream of every committed conformance source", () => {
    const cases = [...tier1Operators, ...tier2Operators].flatMap((op) =>
      op.conformanceTests.map((c) => ({ op: op.name, name: c.name, sourceAL: c.sourceAL })),
    );

    // An empty corpus would make every assertion below vacuous, which is this project's signature
    // bug. The count is a floor, not a pin: adding operators must not fail this test.
    expect(cases.length).toBeGreaterThanOrEqual(100);

    const differing = cases.filter(
      (c) => alTokenStream(layoutAL(c.sourceAL)) !== alTokenStream(c.sourceAL),
    );
    expect(differing.map((c) => `${c.op} / ${c.name}`)).toEqual([]);
  });

  it("breaks a one-liner into lines", () => {
    const out = layoutAL(
      `codeunit 51302 "C" { procedure P(A: Integer) begin if A > 0 then exit(1); end; }`,
    );
    expect(out.split("\n").length).toBeGreaterThan(4);
    expect(out).toContain("\n    procedure P(A: Integer)");
    expect(out).toContain("\n    begin");
  });

  it("puts a var SECTION on its own line and indents its declarations", () => {
    const out = layoutAL(
      `codeunit 1 "C" { procedure P() var Cust: Record Customer; begin Cust.Get(); end; }`,
    );
    expect(out).toContain("\n    var\n        Cust: Record Customer;");
  });

  /**
   * The one case a naive `var` rule gets wrong. Inside parentheses `var` marks a by-reference
   * PARAMETER, so breaking there would split a signature across lines and indent the rest of the
   * object under it.
   */
  it("does NOT break on a by-reference parameter's var", () => {
    const out = layoutAL(
      `codeunit 1 "C" { procedure P(var Rec: Record Customer) begin Rec.Get(); end; }`,
    );
    expect(out).toContain("procedure P(var Rec: Record Customer)");
  });

  it("does not put a space before a call's parenthesis or after a member dot", () => {
    const out = layoutAL(
      `codeunit 1 "C" { procedure P() var C: Record Customer; begin C.SetRange("No.", 'x'); end; }`,
    );
    expect(out).toContain(`C.SetRange("No.", 'x');`);
  });
});
