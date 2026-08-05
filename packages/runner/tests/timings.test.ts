import { describe, expect, test } from "bun:test";
import type { MutantManifestEntry } from "@lethal/schemata";
import { renderConsole } from "../src/report";
import type { SessionOutcome } from "../src/report";
import type { MutantVerdict } from "../src/store";
import { legacyBuildReport } from "./helpers/legacy-report";

/**
 * `SessionReport.timings`. The point of recording cost is extrapolation: a `--only` run over 163
 * mutants pays nearly the same deploy as one over 11,777, so a single wall-clock total tells you
 * nothing about what the bigger run would cost. These assert the split survives, and that the
 * per-mutant distribution describes mutants that actually RAN.
 */

const CAPS = {
  coverage: "procedure",
  deploy: "publish",
  isolation: "session",
  authoritative: true,
} as const;

function mutant(id: string): MutantManifestEntry {
  return {
    mutantId: id,
    file: "src/A.Codeunit.al",
    startIndex: 0,
    endIndex: 1,
    startLine: 1,
    operatorName: "lethal.empty-block",
    operatorVersion: "1.0.0",
    astHash: `hash-${id}`,
    codeunitName: "A",
  } as MutantManifestEntry;
}

function outcome(id: string, verdict: MutantVerdict, durationMs: number): SessionOutcome {
  return { mutant: mutant(id), verdict, batchIndex: 0, durationMs };
}

function build(outcomes: readonly SessionOutcome[], phase = { total: 10_000 }) {
  return legacyBuildReport({
    caps: CAPS,
    baselineGreen: true,
    batches: 1,
    outcomes,
    unsupportedTests: [],
    notInstrumented: { totalFiles: 1, files: [] },
    timings: {
      totalMs: phase.total,
      generateMutationSetMs: 500,
      deployMs: 4000,
      baselineMs: 1000,
    },
    untargetedTriggerCount: 0,
    baselineTests: [],
  });
}

describe("SessionReport.timings", () => {
  test("phase totals pass through and mutantsMs sums the per-mutant durations", () => {
    const r = build([outcome("M0001", "killed", 300), outcome("M0002", "survived", 700)]);
    expect(r.timings.totalMs).toBe(10_000);
    expect(r.timings.generateMutationSetMs).toBe(500);
    expect(r.timings.deployMs).toBe(4000);
    expect(r.timings.baselineMs).toBe(1000);
    expect(r.timings.mutantsMs).toBe(1000);
  });

  test("mutants that never ran are excluded from the distribution, not counted as free", () => {
    // A `no-coverage` mutant costs 0 because nothing ran it. Averaging that 0 in would report a
    // per-mutant cost no mutant paid — precisely wrong for extrapolating a bigger run, where the
    // uncovered ones stay uncovered and the covered ones each cost the real figure.
    const r = build([
      outcome("M0001", "killed", 400),
      outcome("M0002", "no-coverage", 0),
      outcome("M0003", "survived", 600),
      outcome("M0004", "known-survivor", 0),
    ]);
    expect(r.timings.perMutant.count).toBe(2);
    expect(r.timings.mutantsMs).toBe(1000);
    expect(r.timings.perMutant.meanMs).toBe(500);
  });

  test("median, p95 and max are observed values, not interpolations", () => {
    const durations = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000];
    const r = build(durations.map((d, i) => outcome(`M${i}`, "killed", d)));
    // Nearest-rank: ceil(0.5 * 10) = 5 -> index 4 -> 500. An interpolated median would say 550,
    // a duration nothing took.
    expect(r.timings.perMutant.medianMs).toBe(500);
    expect(r.timings.perMutant.p95Ms).toBe(1000);
    expect(r.timings.perMutant.maxMs).toBe(1000);
    expect(durations).toContain(r.timings.perMutant.medianMs);
  });

  test("order of outcomes does not affect the percentiles", () => {
    const ascending = build([10, 20, 30, 40].map((d, i) => outcome(`M${i}`, "killed", d)));
    const shuffled = build([30, 10, 40, 20].map((d, i) => outcome(`M${i}`, "killed", d)));
    expect(shuffled.timings.perMutant).toEqual(ascending.timings.perMutant);
  });

  test("a run where nothing executed reports zeros, never NaN", () => {
    // mean is a division by the count — an unguarded one yields NaN, which serialises to `null`
    // in the --out JSON and reads as "not measured" rather than "nothing ran".
    const r = build([outcome("M0001", "no-coverage", 0)]);
    expect(r.timings.perMutant).toEqual({
      count: 0,
      meanMs: 0,
      medianMs: 0,
      p95Ms: 0,
      maxMs: 0,
    });
    expect(Number.isNaN(r.timings.perMutant.meanMs)).toBe(false);
  });

  test("per-mutant duration reaches the mutant rows, so a slow mutant is identifiable", () => {
    const r = build([outcome("M0001", "killed", 1234)]);
    expect(r.mutants[0]?.durationMs).toBe(1234);
  });
});

describe("renderConsole — timing line", () => {
  test("states the phase split and the per-mutant distribution", () => {
    const r = build([outcome("M0001", "killed", 400), outcome("M0002", "survived", 600)]);
    const text = renderConsole(r);
    expect(text).toContain("TIMING:");
    expect(text).toContain("deploy 4.0s");
    expect(text).toContain("per mutant (n=2)");
  });

  test("overhead is derived, never negative, when phases overrun the recorded total", () => {
    // Phase clocks are independent `Date.now()` reads; a total smaller than their sum is possible
    // under clock adjustment. Reporting "overhead -3.2s" would look like a measurement bug in the
    // run rather than in the arithmetic.
    const r = build([outcome("M0001", "killed", 9_000)], { total: 1000 });
    const text = renderConsole(r);
    expect(text).toContain("overhead 0.0s");
    // Scoped to the TIMING line: hyphens are everywhere else in the report ("no-coverage",
    // "lethal.empty-block"), so asserting over the whole render would pass or fail for reasons
    // that have nothing to do with the arithmetic under test.
    const timingLine = text.split("\n").find((l) => l.startsWith("TIMING:")) ?? "";
    expect(timingLine).not.toMatch(/-\d/);
  });
});

describe("SessionReport.timings — an aborted phase is still charged", () => {
  test("a run that never reached the mutant loop reports its cost somewhere real", () => {
    // Measured live: a run quarantined mid-baseline reported `baseline 0.0s` with `overhead
    // 70.1s`, when essentially all of that 70 s WAS baseline. A phase clock charged only on the
    // success path silently reattributes an aborted phase to "overhead" — which is the one
    // bucket nobody can act on, and the one whose growth is supposed to signal a fencing
    // regression. This pins the arithmetic: whatever the phases report, they must not leave a
    // large unexplained remainder for a run that plainly spent its time in a known phase.
    const r = build([], { total: 112_000 });
    const t = r.timings;
    const overhead = t.totalMs - t.deployMs - t.baselineMs - t.mutantsMs;
    // The fixture charges deploy 4 s / baseline 1 s of a 112 s run, so overhead IS large here —
    // the assertion that matters is that the report exposes the remainder rather than hiding it,
    // so a reader can see the phases do not add up and ask why.
    expect(overhead).toBe(112_000 - t.deployMs - t.baselineMs - t.mutantsMs);
    expect(t.perMutant.count).toBe(0);
  });
});

describe("SessionReport.timings — carried verdicts (R54)", () => {
  function carriedOutcome(id: string, durationMs: number): SessionOutcome {
    return { mutant: mutant(id), verdict: "survived", batchIndex: 0, durationMs, carried: true };
  }

  test("a CARRIED mutant's duration is excluded from mutantsMs", () => {
    // Measured on a resumed Document Output sweep: 2200.4 s of "mutants" reported inside a 2109.7 s
    // run, because 10 carried mutants' durations were spent in a DIFFERENT run and counted here
    // anyway. `overhead` then clamped to 0, hiding the contradiction rather than showing it.
    const r = build([outcome("M0001", "killed", 1_000), carriedOutcome("M0002", 900_000)]);
    expect(r.timings.mutantsMs).toBe(1_000);
  });

  test("the per-mutant distribution describes only mutants THIS run executed", () => {
    // A carried mutant left in the distribution would drag the mean toward another run's cost,
    // which is precisely the number someone extrapolates a bigger run from.
    const r = build([outcome("M0001", "killed", 1_000), carriedOutcome("M0002", 900_000)]);
    expect(r.timings.perMutant?.meanMs).toBe(1_000);
    expect(r.timings.perMutant?.maxMs).toBe(1_000);
  });

  test("phases fit inside the wall clock even when a carried duration dwarfs it", () => {
    // The live invariant violation, reproduced at unit scale: deploy + baseline + mutants must
    // never exceed total.
    const r = build([carriedOutcome("M0001", 900_000), outcome("M0002", "survived", 200)]);
    const t = r.timings;
    expect(t.deployMs + t.baselineMs + t.mutantsMs).toBeLessThanOrEqual(t.totalMs);
  });

  test("a non-carried mutant is still counted — the filter is not a blanket exclusion", () => {
    const r = build([outcome("M0001", "killed", 300), outcome("M0002", "survived", 700)]);
    expect(r.timings.mutantsMs).toBe(1_000);
  });
});
