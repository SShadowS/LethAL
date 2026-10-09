import { describe, expect, test } from "bun:test";
import type { MutantOutcome } from "../packages/runner/src/report";
import { bucket, classify } from "./r546-bucket";

describe("R546 verdict-pair table", () => {
  test("each class from its pair", () => {
    expect(classify("killed", "killed")).toBe("agree");
    expect(classify("no-coverage", "no-coverage")).toBe("agree");
    expect(classify("killed", "survived")).toBe("kill-vs-survive");
    expect(classify("survived", "killed")).toBe("kill-vs-survive");
    expect(classify("killed", "no-coverage")).toBe("verdict-vs-no-coverage");
    expect(classify("no-coverage", "survived")).toBe("verdict-vs-no-coverage");
    expect(classify("killed", undefined)).toBe("one-side-only");
  });
  test("an error or timeout on EITHER side, even on both, is never agree", () => {
    expect(classify("error", "error")).toBe("error-timeout");
    expect(classify("timeout-killed", "timeout-killed")).toBe("error-timeout");
    expect(classify("timeout-killed", "killed")).toBe("error-timeout");
    expect(classify("survived", "error")).toBe("error-timeout");
  });
  test("known-survivor is refused", () => {
    expect(() => classify("known-survivor", "survived")).toThrow();
  });
});

const m = (over: Partial<MutantOutcome>): MutantOutcome =>
  ({
    astHash: "h",
    codeunitName: "C",
    procedureName: "P",
    operatorName: "op",
    operatorMajor: 1,
    file: "f.al",
    line: 1,
    startIndex: 0,
    endIndex: 3,
    originalText: "abc",
    mutatedText: "xyz",
    verdict: "killed",
    ...over,
  }) as MutantOutcome;

describe("R546 row checks", () => {
  test("a key twice on one side is refused", () => {
    expect(() => bucket([m({}), m({})], [m({})])).toThrow(/group size/);
  });
  test("a different mutated text for one key is refused as a LethAL defect", () => {
    expect(() => bucket([m({})], [m({ mutatedText: "xyw" })])).toThrow(/mutatedText/);
  });
  test("the same mutant on both sides buckets", () => {
    const rows = bucket([m({})], [m({ verdict: "survived" })]);
    expect(rows.map((r) => r.cls)).toEqual(["kill-vs-survive"]);
  });
});
