import { describe, expect, test } from "bun:test";
import { keepOriginalBody, readA2 } from "./size-arm";

describe("readA2", () => {
  const full = { pairsDone: 60, pairsPlanned: 60, sBreaks: 0, sRunnable: true };
  test("a complete arm with no S break clears the grouped path", () => {
    expect(readA2(full)).toBe("grouped fix not required");
  });
  test("ONE S break requires the grouped fix", () => {
    expect(readA2({ ...full, sBreaks: 1 })).toBe("grouped fix required");
  });
  test("an incomplete arm cannot clear it", () => {
    expect(readA2({ ...full, pairsDone: 59 })).toBe("grouped fix required");
  });
  test("an unrunnable S arm cannot clear it", () => {
    expect(readA2({ ...full, sRunnable: false })).toBe("grouped fix required");
  });
});

describe("keepOriginalBody", () => {
  test("keeps the RunMutantWithCoverage body and ignores the GetOpAnswer body of the same attempt", () => {
    const bodies = new Map<string, string>();
    keepOriginalBody(
      bodies,
      { action: "LethALControl_RunMutantWithCoverage", attemptId: "r236s-k-1" },
      "original",
    );
    keepOriginalBody(
      bodies,
      { action: "LethALControl_GetOpAnswer", attemptId: "r236s-k-1" },
      "readback",
    );
    expect(bodies.get("r236s-k-1")).toBe("original");
  });
});
