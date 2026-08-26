import { describe, expect, test } from "bun:test";
import type { MutantManifestEntry } from "@lethal/schemata";
import type { RunEvent, RunEventInput } from "../src/events";
import { foldEvents } from "../src/report-fold";
import type { FoldStatics } from "../src/report-fold";

/**
 * `foldEvents` (report-fold.ts) — the presence-asserting fold, event-stream refactor (spec
 * 2026-08-05 §A, "AMENDED AFTER TASK-2 REVIEW"). The brief's original skeleton is superseded here:
 * `FoldStatics` is the closed set `{ caps, only, testsOnly, stopHungSessions }`, and
 * `baseline-finished` (the brief's original event) does not exist — it was deleted in favour of
 * `baseline-batch-finished`, which carries per-test verdicts + classification rather than a bare
 * aggregate (events.ts's own doc comment: "events carry facts, consumers compute aggregates").
 */

const STATICS: FoldStatics = {
  caps: { authoritative: true, coverage: "procedure", deploy: "publish", isolation: "session" },
};

function seq(events: readonly RunEventInput[]): RunEvent[] {
  return events.map((e, i) => ({ ...e, seq: i + 1 }) as RunEvent);
}

function mutant(id: string, over: Partial<MutantManifestEntry> = {}): MutantManifestEntry {
  return {
    mutantId: id,
    file: "Al/Codeunit/Codeunit 50100 Sales Helper.al",
    startIndex: 100,
    endIndex: 140,
    startLine: 10,
    operatorName: "lethal.void-method-call",
    operatorVersion: "1.0.0",
    astHash: `hash-${id}`,
    objectType: "codeunit",
    codeunitId: 50100,
    codeunitName: "Sales Helper",
    procedureName: "ComputeTotal",
    procedureScope: "public",
    originalText: "TotalAmount := Quantity * UnitPrice;",
    mutatedText: "",
    ...over,
  };
}

/** A minimal, complete, non-throwing prefix every positive test can extend. */
function baseEvents(): RunEventInput[] {
  return [
    {
      type: "mutation-set-generated",
      siteCount: 1,
      deployedCount: 1,
      totalFiles: 1,
      instrumentableFiles: 1,
      notInstrumentedFiles: [],
      declarativeSiteFiles: [],
      excludedByOnly: 0,
      excludedByOperator: 0,
    },
    {
      type: "baseline-batch-finished",
      batchIndex: 0,
      verdicts: [{ name: "Sales Helper Tests.T1", outcome: "pass", classification: [] }],
    },
    // R106: a batch that finishes baseline with a GREEN test under a coverage-claiming mode always
    // reaches the coverage filter and always emits this. A fixture without it describes a stream
    // `runSession` cannot produce — and this file's own lesson is that a fixture describing an
    // unreachable state proves nothing about the code that reads it.
    {
      type: "coverage-split",
      batchIndex: 0,
      untargetedTriggerCount: 0,
      coveredCount: 1,
      noCoverageCount: 0,
      unplaceableCount: 0,
      unplaceableMutants: [],
    },
  ];
}

describe("foldEvents — mandatory events, throwing rather than defaulting", () => {
  test("THROWS when mutation-set-generated never arrived", () => {
    const events = seq([
      { type: "baseline-batch-finished", batchIndex: 0, verdicts: [] },
      { type: "session-finished", elapsedMs: 10 },
    ]);
    expect(() => foldEvents(STATICS, events)).toThrow(/mutation-set-generated/);
  });

  test("THROWS when neither baseline-batch-finished nor quarantined arrived, and a batch published", () => {
    const events = seq([
      {
        type: "mutation-set-generated",
        siteCount: 9,
        deployedCount: 8,
        totalFiles: 3,
        instrumentableFiles: 2,
        notInstrumentedFiles: [],
        declarativeSiteFiles: [],
        excludedByOnly: 0,
        excludedByOperator: 0,
      },
      { type: "batch-published", batchIndex: 0, guardCount: 8, elapsedMs: 100 },
      { type: "session-finished", elapsedMs: 10 },
    ]);
    expect(() => foldEvents(STATICS, events)).toThrow(/baseline-batch-finished.*quarantined/s);
  });

  test("THROWS when session-finished never arrived — a truncated stream is not a report", () => {
    const events = seq(baseEvents());
    expect(() => foldEvents(STATICS, events)).toThrow(/session-finished/);
  });

  test("accepts the quarantined path instead of baseline-batch-finished", () => {
    const events = seq([
      {
        type: "mutation-set-generated",
        siteCount: 9,
        deployedCount: 8,
        totalFiles: 3,
        instrumentableFiles: 2,
        notInstrumentedFiles: [],
        declarativeSiteFiles: [],
        excludedByOnly: 0,
        excludedByOperator: 0,
      },
      { type: "batch-published", batchIndex: 0, guardCount: 8, elapsedMs: 100 },
      { type: "quarantined", reason: "test in-flight-unknown" },
      { type: "session-finished", elapsedMs: 10 },
    ]);
    expect(() => foldEvents(STATICS, events)).not.toThrow();
  });

  test("accepts zero instrumentable files without baseline-batch-finished or quarantined", () => {
    // A project with no mutable sites: `planArtifacts` returns zero batches, so the baseline
    // literally never runs — orchestrator.test.ts pins `report.batches === 0` for this shape.
    const events = seq([
      {
        type: "mutation-set-generated",
        siteCount: 0,
        deployedCount: 0,
        totalFiles: 3,
        instrumentableFiles: 0,
        notInstrumentedFiles: [],
        declarativeSiteFiles: [],
        excludedByOnly: 0,
        excludedByOperator: 0,
      },
      { type: "session-finished", elapsedMs: 10 },
    ]);
    const folded = foldEvents(STATICS, events);
    expect(folded.batches).toBe(0);
    expect(folded.baselineGreen).toBe(true);
  });

  test("accepts a batch that never published (every deploy failed) without baseline-batch-finished", () => {
    // An environmental deploy failure (or a bisection that keeps reproducing): the batch is
    // recorded `error` and aborted via `continue` before baseline ever gets a chance to run.
    const events = seq([
      {
        type: "mutation-set-generated",
        siteCount: 4,
        deployedCount: 4,
        totalFiles: 1,
        instrumentableFiles: 1,
        notInstrumentedFiles: [],
        declarativeSiteFiles: [],
        excludedByOnly: 0,
        excludedByOperator: 0,
      },
      { type: "phase-entered", phase: "deploy" },
      {
        type: "mutant-scored",
        mutant: mutant("M0001"),
        verdict: "error",
        batchIndex: 0,
        durationMs: 0,
        coveringTests: [],
        failureNote: "not attributable to any mutant: alc: internal compiler error",
      },
      { type: "session-finished", elapsedMs: 500 },
    ]);
    const folded = foldEvents(STATICS, events);
    expect(folded.batches).toBe(1);
    expect(folded.outcomes).toHaveLength(1);
  });

  test("an unknown event type is ignored, not fatal", () => {
    const events = seq([
      ...baseEvents(),
      { type: "future-event-from-a-newer-writer" } as never,
      { type: "session-finished", elapsedMs: 10 },
    ]);
    expect(() => foldEvents(STATICS, events)).not.toThrow();
  });
});

describe("foldEvents — R54, a carried verdict never reaches the mutant clock", () => {
  test("mutant-carried contributes NO durationMs; the display duration comes from priorDurationMs", () => {
    const events = seq([
      {
        type: "mutation-set-generated",
        siteCount: 2,
        deployedCount: 2,
        totalFiles: 1,
        instrumentableFiles: 1,
        notInstrumentedFiles: [],
        declarativeSiteFiles: [],
        excludedByOnly: 0,
        excludedByOperator: 0,
      },
      { type: "baseline-batch-finished", batchIndex: 0, verdicts: [] },
      {
        type: "mutant-scored",
        mutant: mutant("M0001"),
        verdict: "killed",
        batchIndex: 0,
        durationMs: 1000,
        coveringTests: [],
        killingTest: "Sales Helper Tests.T1",
      },
      {
        type: "mutant-carried",
        mutant: mutant("M0002"),
        verdict: "survived",
        fromRunId: 1,
        batchIndex: 0,
        priorDurationMs: 9999,
        coveringTests: [],
      },
      { type: "session-finished", elapsedMs: 5000 },
    ]);
    const folded = foldEvents(STATICS, events);
    const carried = folded.outcomes.find((o) => o.mutant.mutantId === "M0002");
    expect(carried?.carried).toBe(true);
    expect(carried?.durationMs).toBeUndefined();
    expect(carried?.priorDurationMs).toBe(9999);
    // The mutant clock only ever sums `durationMs` — carried has none, so the sum is exactly the
    // scored mutant's cost, with no filter required to get there.
    const total = folded.outcomes.reduce((n, o) => n + (o.durationMs ?? 0), 0);
    expect(total).toBe(1000);
  });
});

/**
 * R86: `buildReport` reads THIS fold, not `orchestrator.ts`'s `outcomes[]`. A `killingTestFailure`
 * that rides the event but is dropped here reaches nothing a reader ever sees, on either the scored
 * or the carried path — machinery that runs and measures nothing.
 *
 * Both verdicts below are kills with DIFFERENT text, so the assertion cannot be satisfied by a fold
 * that copies one outcome's field onto the other, and neither can be satisfied by an absent field.
 */
/**
 * R106. `untargetedTriggerCount` is summed from `coverage-split` events and was trusted
 * unconditionally, so a stream where none arrived produced a plausible ZERO rather than an error —
 * the "absent tally read as a measured zero" shape the fold's other mandatory-event checks exist to
 * close, left open for this one field.
 *
 * The second test is the one that matters most. The row proposing this fix assumed the condition
 * was "a batch published", and that is WRONG in a way that would throw on real sessions:
 * `runSession` emits `coverage-split` at step 5, after the step-4 early `continue` that fires when a
 * batch has no green baseline test. An all-red baseline is a legitimate completed run — it records
 * every mutant "no green baseline tests" — and owes no split.
 */
describe("foldEvents — R106, an absent coverage-split is not a measured zero", () => {
  const generated = {
    type: "mutation-set-generated" as const,
    siteCount: 1,
    deployedCount: 1,
    totalFiles: 1,
    instrumentableFiles: 1,
    notInstrumentedFiles: [],
    declarativeSiteFiles: [],
    excludedByOnly: 0,
    excludedByOperator: 0,
  };

  test("THROWS when a green baseline batch produced no coverage-split", () => {
    const events = seq([
      generated,
      {
        type: "baseline-batch-finished",
        batchIndex: 0,
        verdicts: [{ name: "T.T1", outcome: "pass", classification: [] }],
      },
      { type: "session-finished", elapsedMs: 1 },
    ]);
    expect(() => foldEvents(STATICS, events)).toThrow(/no coverage-split event arrived/);
    // Names the consequence, not just the absence — the point is the zero, not the event.
    expect(() => foldEvents(STATICS, events)).toThrow(/measured 0/);
  });

  test("does NOT throw when the batch's baseline was entirely RED — it owes no split", () => {
    // The false positive that would have broken real sessions. A batch with no green test never
    // reaches the coverage filter, so demanding a split from it is demanding something the
    // orchestrator structurally cannot emit.
    const events = seq([
      generated,
      {
        type: "baseline-batch-finished",
        batchIndex: 0,
        verdicts: [{ name: "T.T1", outcome: "fail", classification: [] }],
      },
      { type: "session-finished", elapsedMs: 1 },
    ]);
    expect(() => foldEvents(STATICS, events)).not.toThrow();
  });

  test("does NOT throw under coverage mode `none` — that branch never filters", () => {
    const events = seq([
      generated,
      {
        type: "baseline-batch-finished",
        batchIndex: 0,
        verdicts: [{ name: "T.T1", outcome: "pass", classification: [] }],
      },
      { type: "session-finished", elapsedMs: 1 },
    ]);
    const noCoverage = {
      ...STATICS,
      caps: { ...STATICS.caps, coverage: "none" as const },
    };
    expect(() => foldEvents(noCoverage, events)).not.toThrow();
  });
});

describe("foldEvents — R86, a kill's own account of why it died", () => {
  test("carries killingTestFailure on both the scored and the carried path", () => {
    const SCORED_TEXT =
      "The length of the string is 18, but it must be less than or equal to 10 characters";
    const CARRIED_TEXT = "Assert.AreEqual failed. Expected: <3>. Actual: <4>";
    const events = seq([
      {
        type: "mutation-set-generated",
        siteCount: 2,
        deployedCount: 2,
        totalFiles: 1,
        instrumentableFiles: 1,
        notInstrumentedFiles: [],
        declarativeSiteFiles: [],
        excludedByOnly: 0,
        excludedByOperator: 0,
      },
      { type: "baseline-batch-finished", batchIndex: 0, verdicts: [] },
      {
        type: "mutant-scored",
        mutant: mutant("M0001"),
        verdict: "killed",
        batchIndex: 0,
        durationMs: 1000,
        coveringTests: [],
        killingTest: "Sales Helper Tests.T1",
        killingTestFailure: SCORED_TEXT,
      },
      {
        type: "mutant-carried",
        mutant: mutant("M0002"),
        verdict: "killed",
        fromRunId: 1,
        batchIndex: 0,
        priorDurationMs: 500,
        coveringTests: [],
        killingTest: "Sales Helper Tests.T2",
        killingTestFailure: CARRIED_TEXT,
      },
      { type: "session-finished", elapsedMs: 5000 },
    ]);
    const folded = foldEvents(STATICS, events);
    expect(folded.outcomes.find((o) => o.mutant.mutantId === "M0001")?.killingTestFailure).toBe(
      SCORED_TEXT,
    );
    expect(folded.outcomes.find((o) => o.mutant.mutantId === "M0002")?.killingTestFailure).toBe(
      CARRIED_TEXT,
    );
  });
});

describe("foldEvents — batch-invalidated rewrites history", () => {
  test("rewrites the named batch's verdicts to error, with the reason in failureNote", () => {
    const events = seq([
      {
        type: "mutation-set-generated",
        siteCount: 1,
        deployedCount: 1,
        totalFiles: 1,
        instrumentableFiles: 1,
        notInstrumentedFiles: [],
        declarativeSiteFiles: [],
        excludedByOnly: 0,
        excludedByOperator: 0,
      },
      { type: "baseline-batch-finished", batchIndex: 0, verdicts: [] },
      {
        type: "mutant-scored",
        mutant: mutant("M0001"),
        verdict: "survived",
        batchIndex: 2,
        durationMs: 5,
        coveringTests: [],
      },
      { type: "batch-invalidated", batchIndex: 2, reason: "lease lost" },
      { type: "session-finished", elapsedMs: 10 },
    ]);
    const folded = foldEvents(STATICS, events);
    const o = folded.outcomes.find((x) => x.mutant.mutantId === "M0001");
    expect(o?.verdict).toBe("error");
    expect(o?.failureNote).toMatch(/lease lost/);
  });

  // The only remaining coverage of "an EARLIER batch's verdicts stand" — the pure
  // `invalidateBatchVerdicts` helper this used to be unit-tested against directly (orchestrator.ts)
  // is deleted (Fix round 1, Important 5): `buildReport` no longer reads the array it corrected, so
  // it had become a second, unread implementation of this SAME rule.
  test("leaves an earlier batch's verdicts untouched — only the named batch is rewritten", () => {
    const events = seq([
      {
        type: "mutation-set-generated",
        siteCount: 3,
        deployedCount: 3,
        totalFiles: 1,
        instrumentableFiles: 1,
        notInstrumentedFiles: [],
        declarativeSiteFiles: [],
        excludedByOnly: 0,
        excludedByOperator: 0,
      },
      { type: "baseline-batch-finished", batchIndex: 0, verdicts: [] },
      {
        type: "mutant-scored",
        mutant: mutant("M0001"),
        verdict: "survived",
        batchIndex: 0,
        durationMs: 5,
        coveringTests: [],
      },
      {
        type: "mutant-scored",
        mutant: mutant("M0002"),
        verdict: "killed",
        batchIndex: 0,
        durationMs: 5,
        coveringTests: [],
      },
      {
        type: "mutant-scored",
        mutant: mutant("M0003"),
        verdict: "survived",
        batchIndex: 1,
        durationMs: 5,
        coveringTests: [],
      },
      { type: "batch-invalidated", batchIndex: 1, reason: "lease-lost" },
      { type: "session-finished", elapsedMs: 10 },
    ]);
    const folded = foldEvents(STATICS, events);
    const m1 = folded.outcomes.find((x) => x.mutant.mutantId === "M0001");
    const m2 = folded.outcomes.find((x) => x.mutant.mutantId === "M0002");
    const m3 = folded.outcomes.find((x) => x.mutant.mutantId === "M0003");
    expect(m1?.verdict).toBe("survived"); // earlier batch was individually fence-validated
    expect(m2?.verdict).toBe("killed");
    expect(m3?.verdict).toBe("error");
  });

  test("leaves an already-classified error (a `cause`) untouched", () => {
    const events = seq([
      {
        type: "mutation-set-generated",
        siteCount: 1,
        deployedCount: 1,
        totalFiles: 1,
        instrumentableFiles: 1,
        notInstrumentedFiles: [],
        declarativeSiteFiles: [],
        excludedByOnly: 0,
        excludedByOperator: 0,
      },
      { type: "baseline-batch-finished", batchIndex: 0, verdicts: [] },
      {
        type: "mutant-scored",
        mutant: mutant("M0001"),
        verdict: "error",
        batchIndex: 0,
        durationMs: 0,
        coveringTests: [],
        cause: "deadline-exceeded",
        failureNote: "deadline exceeded confirming T1",
      },
      { type: "batch-invalidated", batchIndex: 0, reason: "lease lost" },
      { type: "session-finished", elapsedMs: 10 },
    ]);
    const folded = foldEvents(STATICS, events);
    const o = folded.outcomes.find((x) => x.mutant.mutantId === "M0001");
    expect(o?.cause).toBe("deadline-exceeded");
    expect(o?.failureNote).toBe("deadline exceeded confirming T1");
  });

  test("leaves a known-survivor untouched — it was never re-tested against this batch's binary", () => {
    const events = seq([
      {
        type: "mutation-set-generated",
        siteCount: 1,
        deployedCount: 1,
        totalFiles: 1,
        instrumentableFiles: 1,
        notInstrumentedFiles: [],
        declarativeSiteFiles: [],
        excludedByOnly: 0,
        excludedByOperator: 0,
      },
      { type: "baseline-batch-finished", batchIndex: 0, verdicts: [] },
      {
        type: "mutant-scored",
        mutant: mutant("M0001"),
        verdict: "known-survivor",
        batchIndex: 0,
        durationMs: 0,
        coveringTests: [],
      },
      { type: "batch-invalidated", batchIndex: 0, reason: "lease lost" },
      { type: "session-finished", elapsedMs: 10 },
    ]);
    const folded = foldEvents(STATICS, events);
    const o = folded.outcomes.find((x) => x.mutant.mutantId === "M0001");
    expect(o?.verdict).toBe("known-survivor");
  });
});

describe("foldEvents — the R35 kill-confirmation path (not just baseline classification)", () => {
  test("mutant-scored.permissionRefusedTest feeds permissionsRefusedTests independently of baseline", () => {
    const events = seq([
      {
        type: "mutation-set-generated",
        siteCount: 1,
        deployedCount: 1,
        totalFiles: 1,
        instrumentableFiles: 1,
        notInstrumentedFiles: [],
        declarativeSiteFiles: [],
        excludedByOnly: 0,
        excludedByOperator: 0,
      },
      { type: "baseline-batch-finished", batchIndex: 0, verdicts: [] },
      {
        type: "mutant-scored",
        mutant: mutant("M0001"),
        verdict: "error",
        batchIndex: 0,
        durationMs: 0,
        coveringTests: [],
        cause: "unstable",
        failureNote: "unstable test T1: fails at baseline confirmation — permission refusal",
        permissionRefusedTest: "Sales Permission Tests.WritesToAppTable",
      },
      { type: "session-finished", elapsedMs: 10 },
    ]);
    const folded = foldEvents(STATICS, events);
    expect(folded.permissionsRefusedTests).toEqual(["Sales Permission Tests.WritesToAppTable"]);
  });
});

describe("foldEvents — statics reunited with learned facts", () => {
  test("only.patterns (static) + excludedByOnly (learned) combine into one field", () => {
    const statics: FoldStatics = { ...STATICS, only: { patterns: ["Al/Codeunit/**"] } };
    const events = seq([
      {
        type: "mutation-set-generated",
        siteCount: 1,
        deployedCount: 1,
        totalFiles: 5,
        instrumentableFiles: 1,
        notInstrumentedFiles: [],
        declarativeSiteFiles: [],
        excludedByOnly: 4,
        excludedByOperator: 0,
      },
      { type: "baseline-batch-finished", batchIndex: 0, verdicts: [] },
      { type: "session-finished", elapsedMs: 10 },
    ]);
    const folded = foldEvents(statics, events);
    expect(folded.only).toEqual({ patterns: ["Al/Codeunit/**"], excludedFileCount: 4 });
  });

  test("R127: operators.names (static) + excludedByOperator (learned) combine into one field", () => {
    const statics: FoldStatics = {
      ...STATICS,
      operators: { names: ["lethal.swap-call-arguments"] },
    };
    const events = seq([
      {
        type: "mutation-set-generated",
        siteCount: 3,
        deployedCount: 3,
        totalFiles: 5,
        instrumentableFiles: 5,
        notInstrumentedFiles: [],
        declarativeSiteFiles: [],
        excludedByOnly: 0,
        excludedByOperator: 891,
      },
      { type: "baseline-batch-finished", batchIndex: 0, verdicts: [] },
      { type: "session-finished", elapsedMs: 10 },
    ]);
    const folded = foldEvents(statics, events);
    expect(folded.operators).toEqual({
      names: ["lethal.swap-call-arguments"],
      excludedSiteCount: 891,
    });
  });

  test("R127: no operator static means the field is ABSENT even when the count rode the event", () => {
    // Guards the reunion in the direction that matters: a learned count with no configured names
    // must not manufacture a narrowing block on a run that was never operator-scoped.
    const events = seq([
      {
        type: "mutation-set-generated",
        siteCount: 3,
        deployedCount: 3,
        totalFiles: 5,
        instrumentableFiles: 5,
        notInstrumentedFiles: [],
        declarativeSiteFiles: [],
        excludedByOnly: 0,
        excludedByOperator: 891,
      },
      { type: "baseline-batch-finished", batchIndex: 0, verdicts: [] },
      { type: "session-finished", elapsedMs: 10 },
    ]);
    expect(foldEvents(STATICS, events).operators).toBeUndefined();
  });

  test("batches is the count of deploy phase entries, one per batch loop iteration", () => {
    const events = seq([
      {
        type: "mutation-set-generated",
        siteCount: 2,
        deployedCount: 2,
        totalFiles: 2,
        instrumentableFiles: 2,
        notInstrumentedFiles: [],
        declarativeSiteFiles: [],
        excludedByOnly: 0,
        excludedByOperator: 0,
      },
      { type: "phase-entered", phase: "deploy" },
      { type: "phase-entered", phase: "deploy" },
      { type: "baseline-batch-finished", batchIndex: 0, verdicts: [] },
      { type: "session-finished", elapsedMs: 10 },
    ]);
    expect(foldEvents(STATICS, events).batches).toBe(2);
  });
});
