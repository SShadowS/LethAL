import assert from "node:assert/strict";
import type { SessionReport } from "../src/report";

/** What the gate pins about the `notInstrumented` population. */
export interface NotInstrumentedExpectation {
  readonly fileCount: number;
  readonly siteCount: number;
  readonly files: readonly string[];
}

/**
 * Task 4 (excluded-sites-spine). Extracted from `tables.itest.ts` so the red-check can call it
 * offline against a doctored report: a second live gate run would prove the same thing and cost a
 * billed environment. Lives in its own module rather than being exported from the itest, because
 * that file exits the process at import time when its env gate is unset.
 */
export function assertNotInstrumentedEvidence(
  report: SessionReport,
  expected: NotInstrumentedExpectation,
): void {
  // Task 4 (excluded-sites-spine): the `notInstrumented` twin of tables.itest.ts's
  // declarative-refusal block. Asserted BY FILE, not just by count: a count-only check would pass
  // identically against a permanently-empty derived view (`notInstrumentedView` returning
  // `{ ...view, files: [] }`), which is the exact gap this fixture and this assertion exist to
  // close.
  assert.equal(
    report.notInstrumented.fileCount,
    expected.fileCount,
    "notInstrumented fileCount mismatch",
  );
  assert.equal(
    report.notInstrumented.siteCount,
    expected.siteCount,
    "notInstrumented siteCount mismatch",
  );
  assert.deepEqual(
    report.notInstrumented.files.map((f) => f.file.replaceAll("\\", "/")).sort(),
    [...expected.files].sort(),
    "notInstrumented files mismatch: a permanently-empty derived view passes a count check but not this one",
  );
  assert.ok(
    report.validity.caveats.includes("uninstrumentable-files"),
    "a run that skipped an uninstrumentable file must CARRY the caveat — the count without the " +
      "caveat leaves a reader to discover the refusal by reading a number they were never pointed at",
  );
}
