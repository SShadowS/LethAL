// PR-21 addendum 2: which baseline rows count as this session's line evidence (R926 reach, R975 trigger
// placement). Without the re-checked rows, a resumed serve session decided 2 of Service Declaration's 222
// mutants differently from an uninterrupted one (`/coord/handoff/PR-21/precommit/`).
import { describe, expect, test } from "bun:test";
import type { TestMethodRef } from "../src/backend";
import { lineEvidenceOf } from "../src/orchestrator";

const ref = (method: string): TestMethodRef =>
  ({ codeunitId: 50100, codeunitName: "T", method }) as TestMethodRef;

describe("PR-21: lineEvidenceOf", () => {
  const a = ref("A");
  const b = ref("B");
  const baseline = [{ ref: a }, { ref: b }];

  test("a reused snapshot that passed L5's re-check: every baseline row counts", () => {
    const got = lineEvidenceOf(new Set(), baseline, true);
    expect(got.has(a)).toBe(true); // red without addendum 2: a reused row never counted
    expect(got.has(b)).toBe(true);
  });

  test("R192's unchecked reuse, and a fresh baseline: only the rows that ran here", () => {
    const ranHere = new Set([a]);
    const got = lineEvidenceOf(ranHere, baseline, false);
    expect(got.has(a)).toBe(true);
    expect(got.has(b)).toBe(false); // red if every reused row counted without a re-check
    expect(lineEvidenceOf(new Set(), baseline, false).size).toBe(0);
  });
});
