import { describe, expect, test } from "bun:test";
import type { MutantOutcome, SessionReport } from "../packages/runner/src/report";
import { bucket, bucketReports, classify } from "./r546-bucket";

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
  test.each([
    ["file", { file: "g.al" }],
    ["startIndex", { startIndex: 1 }],
    ["endIndex", { endIndex: 4 }],
    ["originalText", { originalText: "abd" }],
    ["mutatedText", { mutatedText: "xyw" }],
  ] as const)("a different %s for one key is refused as a LethAL defect", (field, over) => {
    expect(() => bucket([m({})], [m(over)])).toThrow(new RegExp(`differs in ${field}`));
  });
  test("the same mutant on both sides buckets", () => {
    const rows = bucket([m({})], [m({ verdict: "survived" })]);
    expect(rows.map((r) => r.cls)).toEqual(["kill-vs-survive"]);
  });
  test("a key on one side only is its own row", () => {
    const rows = bucket([m({}), m({ astHash: "h2" })], [m({})]);
    // Rows are sorted by key, and "h2|..." sorts before "h|...".
    expect(rows.map((r) => [r.cls, r.bc, r.ar])).toEqual([
      ["one-side-only", "killed", null],
      ["agree", "killed", "killed"],
    ]);
  });
  test("an empty side is refused, never an empty-vs-empty agreement", () => {
    expect(() => bucket([], [])).toThrow(/no mutants/);
    expect(() => bucket([m({})], [])).toThrow(/no mutants/);
  });
});

describe("R546 report pairing", () => {
  const rep = (backend: string) => ({ backend, mutants: [m({})] }) as unknown as SessionReport;
  test("one bcdev report then one al-runner report is accepted", () => {
    expect(bucketReports(rep("bcdev"), rep("al-runner")).length).toBe(1);
  });
  test("the same backend twice, or the wrong order, is refused", () => {
    expect(() => bucketReports(rep("al-runner"), rep("al-runner"))).toThrow(/expected a bcdev/);
    expect(() => bucketReports(rep("al-runner"), rep("bcdev"))).toThrow(/expected a bcdev/);
  });
});
