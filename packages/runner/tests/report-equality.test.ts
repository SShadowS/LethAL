import { describe, expect, test } from "bun:test";
import { buildReport } from "../src/report";
import type { BuildReportInput } from "../src/report";
import goldenInput from "./fixtures/golden-report-input.json";

/**
 * The safety net for the event-stream refactor (spec 2026-08-05 §A).
 *
 * `buildReport` is being rewritten from a bag-of-fields builder into a fold over emitted events.
 * That rewrite touches how EVERY verdict reaches the report. This test pins the output over a
 * fixture exercising every optional field and every verdict kind, so the rewrite is provably
 * behaviour-preserving rather than plausibly so.
 *
 * It must be green BEFORE the rewrite starts and after it lands. A snapshot recorded after the
 * rewrite would prove nothing.
 */
describe("buildReport output is stable across the event-stream refactor", () => {
  test("the golden input produces a report identical to the committed snapshot", () => {
    const report = buildReport(goldenInput as unknown as BuildReportInput);
    expect(report).toMatchSnapshot();
  });

  test("the golden input exercises every verdict kind and the carried path", () => {
    const input = goldenInput as unknown as BuildReportInput;
    const verdicts = new Set(input.outcomes.map((o) => o.verdict));
    for (const v of ["killed", "survived", "no-coverage", "timeout-killed", "error"]) {
      expect(verdicts.has(v as never)).toBe(true);
    }
    expect(input.outcomes.some((o) => o.carried === true && (o.durationMs ?? 0) > 0)).toBe(true);
  });

  test("mutantsMs excludes carried durations — the R54 regression", () => {
    const input = goldenInput as unknown as BuildReportInput;
    const report = buildReport(input);
    const carriedMs = input.outcomes
      .filter((o) => o.carried === true)
      .reduce((n, o) => n + (o.durationMs ?? 0), 0);
    const allMs = input.outcomes.reduce((n, o) => n + (o.durationMs ?? 0), 0);
    expect(carriedMs).toBeGreaterThan(0);
    expect(report.timings.mutantsMs).toBe(allMs - carriedMs);
  });
});
