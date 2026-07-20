import { describe, expect, test } from "bun:test";
import { type OperationOutcome, isRetrySafe, requiresUnsafeLatch } from "./operation-outcome";

describe("OperationOutcome predicates", () => {
  test("only pre-dispatch-rejected is retry-safe", () => {
    const all: OperationOutcome[] = [
      "pre-dispatch-rejected",
      "completed-accepted",
      "completed-effect-unknown",
      "in-flight-unknown",
      "cancelled-confirmed",
    ];
    expect(all.filter(isRetrySafe)).toEqual(["pre-dispatch-rejected"]);
  });

  test("only in-flight-unknown forces the unsafe latch", () => {
    const all: OperationOutcome[] = [
      "pre-dispatch-rejected",
      "completed-accepted",
      "completed-effect-unknown",
      "in-flight-unknown",
      "cancelled-confirmed",
    ];
    expect(all.filter(requiresUnsafeLatch)).toEqual(["in-flight-unknown"]);
  });
});
