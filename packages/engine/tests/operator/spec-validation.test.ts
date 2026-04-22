import { describe, it, expect } from "bun:test";
import { validateSpec } from "../../src/operator/spec-validation";

describe("validateSpec", () => {
  const base = {
    operatorName: "test.op",
    operatorVersion: "1.0.0",
    astNodeId: "node-1",
    before: { kind: "comparison_expression" },
    after: { kind: "comparison_expression" },
    parentContext: "statement-position",
  };

  it("accepts a well-formed spec", () => {
    const result = validateSpec(base);
    expect(result.ok).toBe(true);
  });

  it("rejects a spec missing parentContext", () => {
    const { parentContext, ...bad } = base;
    const result = validateSpec(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("parentContext");
  });

  it("rejects a spec with an invalid parentContext value", () => {
    const result = validateSpec({ ...base, parentContext: "nowhere" });
    expect(result.ok).toBe(false);
  });

  it("rejects a spec with non-semver operator version", () => {
    const result = validateSpec({ ...base, operatorVersion: "v1" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("operatorVersion");
  });

  it("accepts optional equivalenceHint when present", () => {
    const result = validateSpec({ ...base, equivalenceHint: "likely-equivalent" });
    expect(result.ok).toBe(true);
  });
});
