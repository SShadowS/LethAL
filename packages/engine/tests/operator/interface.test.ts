import { describe, expect, it } from "bun:test";
import type { ConformanceCase, MutationOperator, MutationSpec } from "../../src/operator/interface";

describe("MutationOperator typing", () => {
  it("accepts a minimal valid operator shape", () => {
    const op: MutationOperator = {
      name: "test.op",
      version: "1.0.0",
      tier: "custom",
      targetNodeKinds: ["comparison_expression"],
      producesNodeKinds: ["comparison_expression"],
      requiresSemantic: [],
      targets: () => false,
      generate: () => [],
      conformanceTests: [] as ConformanceCase[],
    };
    expect(op.name).toBe("test.op");
  });

  it("MutationSpec carries parentContext required field", () => {
    const spec: MutationSpec = {
      operatorName: "test.op",
      operatorVersion: "1.0.0",
      astNodeId: "node-1",
      before: {} as never,
      after: {} as never,
      parentContext: "statement-position",
    };
    expect(spec.parentContext).toBe("statement-position");
  });
});
