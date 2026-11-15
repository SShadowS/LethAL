// PR-21 addendum 2, PR-25 (R1034): which baseline rows count as this session's line evidence (R926 reach, R975
// trigger placement). Without a reused snapshot's rows, a resumed session decided 2 of Service Declaration's 222
// mutants differently from an uninterrupted one, on serve (`/coord/handoff/PR-21/precommit/`) and one-shot
// (`/coord/handoff/PR-21/oneshot/`). The call site passes `reused !== undefined`; orchestrator.test.ts's "PR-25 (R1034)" test is its check.
import { describe, expect, test } from "bun:test";
import type { TestMethodRef } from "../src/backend";
import { lineEvidenceOf } from "../src/orchestrator";

const ref = (method: string): TestMethodRef =>
  ({ codeunitId: 50100, codeunitName: "T", method }) as TestMethodRef;

describe("PR-21/PR-25: lineEvidenceOf", () => {
  const a = ref("A");
  const b = ref("B");
  const baseline = [{ ref: a }, { ref: b }];

  test("a reused snapshot (R192 on any transport, L5's on serve): every baseline row counts", () => {
    const got = lineEvidenceOf(new Set(), baseline, true);
    expect(got.has(a)).toBe(true); // red without the fix: a reused row never counted
    expect(got.has(b)).toBe(true);
  });

  test("no reuse: only the rows that ran here", () => {
    const ranHere = new Set([a]);
    const got = lineEvidenceOf(ranHere, baseline, false);
    expect(got.has(a)).toBe(true);
    expect(got.has(b)).toBe(false); // red if every row counted without a reuse
    expect(lineEvidenceOf(new Set(), baseline, false).size).toBe(0);
  });
});
