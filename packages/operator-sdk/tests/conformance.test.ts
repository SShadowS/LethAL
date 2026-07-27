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
