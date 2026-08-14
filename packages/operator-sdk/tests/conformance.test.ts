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
});
