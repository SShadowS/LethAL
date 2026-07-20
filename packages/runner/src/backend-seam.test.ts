import { describe, expect, test } from "bun:test";
import type { TestVerdict } from "./backend";

describe("TestVerdict.operation", () => {
  test("a verdict may carry an OperationOutcome", () => {
    const v: TestVerdict = {
      ref: { codeunitId: 1, codeunitName: "C", method: "m" },
      outcome: "error",
      durationMs: 1,
      operation: "pre-dispatch-rejected",
    };
    expect(v.operation).toBe("pre-dispatch-rejected");
  });
});
