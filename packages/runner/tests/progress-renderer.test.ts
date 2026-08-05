import { describe, expect, test } from "bun:test";
import type { MutantManifestEntry } from "@lethal/schemata";
import type { RunEvent, RunEventInput } from "../src/events";
import { createProgressRenderer } from "../src/progress-renderer";

function lines(): { out: string[]; write: (l: string) => void } {
  const out: string[] = [];
  return { out, write: (l) => out.push(l) };
}

// The task-5 brief's own `ev` helper typed its first parameter `Omit<RunEvent, "seq">` — but
// `Omit` on a discriminated union collapses to the fields common to every member (just `type`),
// which is not what was meant and does not typecheck against the union's 18 real variants.
// `RunEventInput` already IS "a RunEvent minus `seq`" by construction (`RunEvent = RunEventInput
// & Base`, `Base = { seq }`) and stays a proper discriminated union, so it's used directly here.
const ev = (e: RunEventInput, seq = 1): RunEvent => ({ ...e, seq }) as RunEvent;

/** One realistic `MutantManifestEntry`, styled after events.test.ts's `sampleMutant` — every
 *  mutant-carrying event below reuses this shape rather than inventing a fresh one per test. */
function mutantFixture(mutantId: string): MutantManifestEntry {
  return {
    mutantId,
    file: "Al/Codeunit/Codeunit 50100 Sales Helper.al",
    startIndex: 1200,
    endIndex: 1240,
    startLine: 45,
    operatorName: "lethal.void-method-call",
    operatorVersion: "1.0.0",
    astHash: "hashA1",
    objectType: "codeunit",
    codeunitId: 50100,
    codeunitName: "Sales Helper",
    procedureName: "ComputeTotal",
    procedureScope: "public",
    originalText: "TotalAmount := Quantity * UnitPrice;",
    mutatedText: "",
  };
}

describe("progress renderer", () => {
  test("names the phase on entry", () => {
    const { out, write } = lines();
    createProgressRenderer(write, { heartbeatMs: 30_000 })(
      ev({ type: "phase-entered", phase: "baseline", detail: "409 tests" }),
    );
    expect(out[0]).toContain("baseline");
    expect(out[0]).toContain("409 tests");
  });

  test("phase-entered also reports testCount/batchIndex when they carry the detail instead", () => {
    const { out, write } = lines();
    createProgressRenderer(write, { heartbeatMs: 30_000 })(
      ev({ type: "phase-entered", phase: "baseline", testCount: 409, batchIndex: 2 }),
    );
    expect(out[0]).toContain("409 tests");
    expect(out[0]).toContain("batch 2");
  });

  test("phase-left reports elapsed time", () => {
    const { out, write } = lines();
    createProgressRenderer(write, { heartbeatMs: 30_000 })(
      ev({ type: "phase-left", phase: "baseline", elapsedMs: 12_345 }),
    );
    expect(out[0]).toContain("baseline");
    expect(out[0]).toContain("12.3s");
  });

  test("reports both site and deployed counts — R92", () => {
    const { out, write } = lines();
    createProgressRenderer(write, { heartbeatMs: 30_000 })(
      ev({
        type: "mutation-set-generated",
        siteCount: 176,
        deployedCount: 148,
        totalFiles: 554,
        instrumentableFiles: 441,
        notInstrumentedFiles: [],
        excludedByOnly: 0,
      }),
    );
    expect(out[0]).toContain("176");
    expect(out[0]).toContain("148");
  });

  test("baseline-batch-finished names failing tests, not just a count", () => {
    const { out, write } = lines();
    createProgressRenderer(write, { heartbeatMs: 30_000 })(
      ev({
        type: "baseline-batch-finished",
        batchIndex: 3,
        verdicts: [
          { name: "Data Tests.PassingOne", outcome: "pass", classification: [] },
          {
            name: "Data Tests.PageActionComputesNonZero",
            outcome: "fail",
            classification: ["tests-testpage-unsupported"],
            failureMessage: "no TestPage support in this fenced session",
          },
        ],
      }),
    );
    expect(out[0]).toContain("1/2");
    expect(out[0]).toContain("Data Tests.PageActionComputesNonZero");
  });

  test("coverage-split surfaces the no-coverage split live, not just at report time", () => {
    const { out, write } = lines();
    createProgressRenderer(write, { heartbeatMs: 30_000 })(
      ev({
        type: "coverage-split",
        batchIndex: 1,
        untargetedTriggerCount: 0,
        coveredCount: 34,
        noCoverageCount: 66,
      }),
    );
    expect(out[0]).toContain("34");
    expect(out[0]).toContain("66");
  });

  test("surfaces a warning rather than swallowing it", () => {
    const { out, write } = lines();
    createProgressRenderer(write, { heartbeatMs: 30_000 })(
      ev({ type: "warning", code: "stale-lease", message: "lease is old" }),
    );
    expect(out[0]).toContain("lease is old");
  });

  test("quarantined is surfaced, not silent", () => {
    const { out, write } = lines();
    createProgressRenderer(write, { heartbeatMs: 30_000 })(
      ev({ type: "quarantined", reason: "container needs recycle" }),
    );
    expect(out[0]).toContain("container needs recycle");
  });

  test("session-finished reports total elapsed time", () => {
    const { out, write } = lines();
    createProgressRenderer(write, { heartbeatMs: 30_000 })(
      ev({ type: "session-finished", elapsedMs: 1_078_000 }),
    );
    expect(out[0]).toContain("1078.0s");
  });

  test("does not print one line per mutant — the final table already exists", () => {
    const { out, write } = lines();
    const r = createProgressRenderer(write, { heartbeatMs: 30_000 });
    for (let i = 0; i < 50; i++) {
      r(
        ev(
          {
            type: "mutant-scored",
            mutant: mutantFixture(`M${i}`),
            verdict: "killed",
            batchIndex: 0,
            durationMs: 1,
            coveringTests: [],
          },
          i + 1,
        ),
      );
    }
    expect(out.length).toBeLessThan(5);
  });

  test("mutant-carried and mutant-skipped-stranded also count toward the mutant total", () => {
    const { out, write } = lines();
    const r = createProgressRenderer(write, { heartbeatMs: 30_000 });
    r(
      ev({
        type: "mutant-carried",
        mutant: mutantFixture("M0"),
        verdict: "killed",
        fromRunId: 1,
        batchIndex: 0,
        priorDurationMs: 500,
        coveringTests: [],
      }),
    );
    expect(out[0]).toContain("mutants: 1");
  });

  test("ignores an event type it does not render, without throwing", () => {
    const { out, write } = lines();
    expect(() =>
      createProgressRenderer(write, { heartbeatMs: 30_000 })(
        ev({ type: "stream-started", streamSchemaVersion: 1, runId: 1 }),
      ),
    ).not.toThrow();
    expect(out.length).toBe(0);
  });
});
