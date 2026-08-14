import { beforeAll, describe, expect, it } from "bun:test";
import { initParser } from "@lethal/engine";
import type { MutationOperator } from "@lethal/engine";
import { runConformance } from "../src/conformance";

function stubOperator(overrides: Partial<MutationOperator>): MutationOperator {
  return {
    name: "stub",
    version: "1.0.0",
    tier: "custom",
    targetNodeKinds: ["comparison_expression"],
    producesNodeKinds: ["comparison_expression"],
    requiresSemantic: [],
    targets: () => false,
    generate: () => [],
    conformanceTests: [],
    ...overrides,
  };
}

describe("runConformance", () => {
  beforeAll(async () => {
    await initParser();
  });

  it("passes when operator produces expected mutations", async () => {
    const op = stubOperator({
      conformanceTests: [
        {
          name: "flip > to >=",
          sourceAL: `codeunit 60001 "X" { procedure P(): Boolean begin exit(1 > 0); end; }`,
          expectedSpecs: [
            {
              parentContext: "statement-position",
              beforeText: "1 > 0",
              afterText: "1 >= 0",
            },
          ],
        },
      ],
      targets: (n) => n.kind === "comparison_expression" && n.text.includes(">"),
      generate: (n) => [
        {
          operatorName: "stub",
          operatorVersion: "1.0.0",
          astNodeId: `${n.startIndex}`,
          before: n,
          after: { ...n, text: n.text.replace(">", ">=") } as never,
          parentContext: "statement-position",
        },
      ],
    });
    const result = await runConformance(op);
    expect(result.allPassed).toBe(true);
  });

  it("fails a refusal case when the operator produces a spec it must not", async () => {
    // R137: a case with an EMPTY `expectedSpecs` is a documented refusal — the operator must emit
    // nothing at that site. Before this contract existed the harness only checked that every
    // EXPECTED spec appeared, so an empty expectation was satisfied by any output at all and four
    // of `swap-rec-xrec`'s refusals asserted nothing.
    const op = stubOperator({
      conformanceTests: [
        {
          name: "must refuse this site",
          sourceAL: `codeunit 60003 "X" { procedure P(): Boolean begin exit(1 > 0); end; }`,
          expectedSpecs: [],
        },
      ],
      targets: (n) => n.kind === "comparison_expression" && n.text.includes(">"),
      generate: (n) => [
        {
          operatorName: "stub",
          operatorVersion: "1.0.0",
          astNodeId: `${n.startIndex}`,
          before: n,
          after: { ...n, text: n.text.replace(">", ">=") } as never,
          parentContext: "statement-position",
        },
      ],
    });
    const result = await runConformance(op);
    expect(result.allPassed).toBe(false);
    expect(result.failures[0]?.caseName).toBe("must refuse this site");
    expect(result.failures[0]?.reason).toContain("refusal case produced 1 spec");
    expect(result.failures[0]?.produced[0]?.beforeText).toBe("1 > 0");
  });

  it("passes a refusal case when the operator produces nothing", async () => {
    const op = stubOperator({
      conformanceTests: [
        {
          name: "correctly refuses this site",
          sourceAL: `codeunit 60004 "X" { procedure P(): Boolean begin exit(1 > 0); end; }`,
          expectedSpecs: [],
        },
      ],
      targets: () => false,
    });
    const result = await runConformance(op);
    expect(result.allPassed).toBe(true);
  });

  it("reports a failing case when expected spec does not appear", async () => {
    const op = stubOperator({
      conformanceTests: [
        {
          name: "expects something that never fires",
          sourceAL: `codeunit 60002 "X" { procedure P(): Boolean begin exit(true); end; }`,
          expectedSpecs: [
            {
              parentContext: "statement-position",
              beforeText: "true",
              afterText: "false",
            },
          ],
        },
      ],
    });
    const result = await runConformance(op);
    expect(result.allPassed).toBe(false);
    expect(result.failures[0]?.caseName).toBe("expects something that never fires");
  });

  // R142: the other half of R137's contract. R137 made an EMPTY expectation mean "emit nothing
  // here". A NON-EMPTY one only ever checked that the expected spec APPEARED, so an operator
  // emitting the expected spec plus an unwanted one at the same snippet passed, and every
  // non-empty case in builtin-tier1 and builtin-tier2 inherited that.
  //
  // Measured before turning this on (scripts/r142-probe): 36 cases across all 15 registered
  // operators, 5 of them refusals, and ZERO of the 31 non-empty cases produce a spec its golden
  // does not name. So no golden needed completing and no operator bug was hiding behind the gap —
  // but nothing had checked, which is what the row was about.
  it("fails a NON-EMPTY case when the operator produces a spec the expectation does not name", async () => {
    const op = stubOperator({
      conformanceTests: [
        {
          name: "expects one, emits two",
          sourceAL: `codeunit 60005 "X" { procedure P(): Boolean begin exit(1 > 0); end; }`,
          expectedSpecs: [
            {
              parentContext: "statement-position",
              beforeText: "1 > 0",
              afterText: "1 >= 0",
            },
          ],
        },
      ],
      targets: (n) => n.kind === "comparison_expression" && n.text.includes(">"),
      generate: (n) => [
        {
          operatorName: "stub",
          operatorVersion: "1.0.0",
          astNodeId: `${n.startIndex}`,
          before: n,
          after: { ...n, text: n.text.replace(">", ">=") } as never,
          parentContext: "statement-position",
        },
        // The unwanted one. Same site, a mutation the golden says nothing about.
        {
          operatorName: "stub",
          operatorVersion: "1.0.0",
          astNodeId: `${n.startIndex}-extra`,
          before: n,
          after: { ...n, text: n.text.replace(">", "<") } as never,
          parentContext: "statement-position",
        },
      ],
    });
    const result = await runConformance(op);
    expect(result.allPassed).toBe(false);
    expect(result.failures[0]?.caseName).toBe("expects one, emits two");
    expect(result.failures[0]?.reason).toContain("1 spec(s) its expectation does not name");
    // The offending spec itself must be named, not just counted — the reader has to be able to
    // tell an under-specified golden from an operator emitting something it should not.
    expect(result.failures[0]?.reason).toContain("1 < 0");
  });

  // A case that BOTH misses an expected spec and emits an unexpected one is two different
  // problems, and folding them into one message would let the second hide behind the first.
  it("reports the missing and the unexpected separately when a case does both", async () => {
    const op = stubOperator({
      conformanceTests: [
        {
          name: "wrong mutation entirely",
          sourceAL: `codeunit 60006 "X" { procedure P(): Boolean begin exit(1 > 0); end; }`,
          expectedSpecs: [
            {
              parentContext: "statement-position",
              beforeText: "1 > 0",
              afterText: "1 >= 0",
            },
          ],
        },
      ],
      targets: (n) => n.kind === "comparison_expression" && n.text.includes(">"),
      generate: (n) => [
        {
          operatorName: "stub",
          operatorVersion: "1.0.0",
          astNodeId: `${n.startIndex}`,
          before: n,
          after: { ...n, text: n.text.replace(">", "<") } as never,
          parentContext: "statement-position",
        },
      ],
    });
    const result = await runConformance(op);
    expect(result.allPassed).toBe(false);
    expect(result.failures.length).toBe(2);
    expect(result.failures.map((f) => f.caseName)).toEqual([
      "wrong mutation entirely",
      "wrong mutation entirely",
    ]);
    expect(result.failures[0]?.reason).toContain("expected mutation not produced");
    expect(result.failures[1]?.reason).toContain("does not name");
  });

  // The check counts, so a duplicate is caught too: an operator emitting the expected spec TWICE
  // drains the single expectation once and leaves one over.
  it("fails when the expected spec is emitted more times than the expectation names", async () => {
    const op = stubOperator({
      conformanceTests: [
        {
          name: "emits the same mutation twice",
          sourceAL: `codeunit 60007 "X" { procedure P(): Boolean begin exit(1 > 0); end; }`,
          expectedSpecs: [
            {
              parentContext: "statement-position",
              beforeText: "1 > 0",
              afterText: "1 >= 0",
            },
          ],
        },
      ],
      targets: (n) => n.kind === "comparison_expression" && n.text.includes(">"),
      generate: (n) => [
        {
          operatorName: "stub",
          operatorVersion: "1.0.0",
          astNodeId: `${n.startIndex}`,
          before: n,
          after: { ...n, text: n.text.replace(">", ">=") } as never,
          parentContext: "statement-position",
        },
        {
          operatorName: "stub",
          operatorVersion: "1.0.0",
          astNodeId: `${n.startIndex}-dup`,
          before: n,
          after: { ...n, text: n.text.replace(">", ">=") } as never,
          parentContext: "statement-position",
        },
      ],
    });
    const result = await runConformance(op);
    expect(result.allPassed).toBe(false);
    expect(result.failures[0]?.reason).toContain("does not name");
  });

  // The control. Every existing non-empty case in the repo passes under the new check (measured),
  // so an exactly-matching case must still be green — otherwise the contract would be one that
  // no correct operator can satisfy.
  it("still passes a non-empty case whose expectation names exactly what was produced", async () => {
    const op = stubOperator({
      conformanceTests: [
        {
          name: "two expected, two produced",
          sourceAL: `codeunit 60008 "X" { procedure P(): Boolean begin exit((1 > 0) and (2 > 1)); end; }`,
          expectedSpecs: [
            { parentContext: "statement-position", beforeText: "1 > 0", afterText: "1 >= 0" },
            { parentContext: "statement-position", beforeText: "2 > 1", afterText: "2 >= 1" },
          ],
        },
      ],
      targets: (n) => n.kind === "comparison_expression" && n.text.includes(">"),
      generate: (n) => [
        {
          operatorName: "stub",
          operatorVersion: "1.0.0",
          astNodeId: `${n.startIndex}`,
          before: n,
          after: { ...n, text: n.text.replace(">", ">=") } as never,
          parentContext: "statement-position",
        },
      ],
    });
    const result = await runConformance(op);
    expect(result.allPassed).toBe(true);
  });
});
