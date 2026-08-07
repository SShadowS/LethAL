import { describe, expect, test } from "bun:test";
import type { MutantManifestEntry } from "@lethal/schemata";
import { createEmitter } from "../src/events";
import type { RunEmitter, RunEvent } from "../src/events";
import { record } from "../src/orchestrator";
import type { SessionOutcome } from "../src/report";
import { ResultsStore } from "../src/store";
import type { MutantVerdict } from "../src/store";

/**
 * Events must agree with the outcomes array while both exist. Task 4 makes the fold authoritative;
 * until then this is what proves the events are a faithful second view rather than a plausible one.
 *
 * Drives `record()` (orchestrator.ts) — exported ONLY for this file — directly against a real
 * in-memory `ResultsStore(":memory:")`. That IS the "fake store" this suite's tests already reuse:
 * `resume.test.ts` and `runner-provenance.test.ts` (grepped for `recordMutant` across
 * `packages/runner/tests/`) both construct `new ResultsStore(":memory:")` and call its methods
 * directly rather than stubbing a separate fake — there is no other fake-store helper to reuse, so
 * this file follows the same pattern instead of inventing one.
 */

function mutantEntry(
  mutantId: string,
  over: Partial<MutantManifestEntry> = {},
): MutantManifestEntry {
  return {
    mutantId,
    file: "Al/Codeunit/Codeunit 50100 Sales Helper.al",
    startIndex: 100,
    endIndex: 140,
    startLine: 10,
    operatorName: "lethal.void-method-call",
    operatorVersion: "1.0.0",
    astHash: `hash-${mutantId}`,
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

/** Every `MutantVerdict` (store.ts) `record()` can be asked to write directly (i.e. everything
 *  except the resume-carried path, which `driveOneCarriedRecord` below covers separately). */
const DIRECT_VERDICT_KINDS: readonly MutantVerdict[] = [
  "killed",
  "survived",
  "no-coverage",
  "timeout-killed",
  "known-survivor",
  "error",
];

/**
 * Drives `record()` once per verdict kind, plus one `carried: true` recording, against a fresh
 * in-memory store. Returns the `MutantManifestEntry[]` in the same order they were recorded, so
 * the test can assert a 1:1 correspondence between what was recorded and what was emitted.
 */
function driveRecordOverFakeStore(emit: RunEmitter): readonly MutantManifestEntry[] {
  const store = new ResultsStore(":memory:");
  try {
    const runId = store.createRun({ projectPath: "/p", backend: "bcdev", appVersion: "1.0.0.0" });
    const outcomes: SessionOutcome[] = [];
    const recorded: MutantManifestEntry[] = [];
    DIRECT_VERDICT_KINDS.forEach((verdict, i) => {
      const m = mutantEntry(`M${String(i + 1).padStart(4, "0")}`);
      record(store, runId, m, verdict, outcomes, 0, emit, undefined, undefined, undefined, 5, [
        "Sales Helper Tests.ComputeTotalMultipliesQtyByPrice",
      ]);
      recorded.push(m);
    });
    // Plus one carried — record()'s own contract requires `fromRunId` whenever `carried` is true
    // (it throws otherwise; see record()'s doc comment on why this is NOT the current `runId`).
    const carriedMutant = mutantEntry("M0099");
    record(
      store,
      runId,
      carriedMutant,
      "survived",
      outcomes,
      0,
      emit,
      undefined,
      undefined,
      undefined,
      42,
      ["Sales Helper Tests.CarriedCoverage"],
      undefined,
      undefined,
      true, // carried
      undefined, // strandedSkip
      undefined, // runner
      undefined, // runnerDisagreement
      undefined, // runnerDisagreementTest
      7, // fromRunId — a prior run this session resumed from
    );
    recorded.push(carriedMutant);
    return recorded;
  } finally {
    store.close();
  }
}

/** A single `carried: true` recording, isolated so the second test can assert in complete
 *  isolation that it NEVER also produces a `mutant-scored` event. */
function driveOneCarriedRecord(emit: RunEmitter): void {
  const store = new ResultsStore(":memory:");
  try {
    const runId = store.createRun({ projectPath: "/p", backend: "bcdev", appVersion: "1.0.0.0" });
    const outcomes: SessionOutcome[] = [];
    const m = mutantEntry("M0001");
    record(
      store,
      runId,
      m,
      "survived",
      outcomes,
      0,
      emit,
      undefined,
      undefined,
      undefined,
      10,
      ["Sales Helper Tests.CarriedCoverage"],
      undefined,
      undefined,
      true, // carried
      undefined,
      undefined,
      undefined,
      undefined,
      3, // fromRunId
    );
  } finally {
    store.close();
  }
}

describe("emitted mutant events agree with recorded outcomes", () => {
  test("every scored outcome has exactly one mutant-scored or mutant-carried event", () => {
    const events: RunEvent[] = [];
    const emit = createEmitter([(e) => events.push(e)]);

    const recorded = driveRecordOverFakeStore(emit);

    const mutantEvents = events.filter(
      (e) => e.type === "mutant-scored" || e.type === "mutant-carried",
    );
    expect(mutantEvents).toHaveLength(recorded.length);
    for (const m of recorded) {
      // The amended union (docs/superpowers/plans/2026-08-05-event-stream.md, "AMENDED AFTER
      // TASK-2 REVIEW") carries the full `MutantManifestEntry` under `mutant`, not a bare
      // `mutantCode: string` — matched on `mutant.mutantId`, not the brief's original
      // `mutantCode` field, which no longer exists on either event.
      const matches = mutantEvents.filter((e) => "mutant" in e && e.mutant.mutantId === m.mutantId);
      expect(matches).toHaveLength(1);
    }
  });

  test("a carried outcome emits mutant-carried, never mutant-scored", () => {
    const events: RunEvent[] = [];
    const emit = createEmitter([(e) => events.push(e)]);
    driveOneCarriedRecord(emit);
    expect(events.some((e) => e.type === "mutant-carried")).toBe(true);
    expect(events.some((e) => e.type === "mutant-scored")).toBe(false);
  });

  test("a carried mutant-carried event carries no durationMs field — R54 unrepresentable", () => {
    const events: RunEvent[] = [];
    const emit = createEmitter([(e) => events.push(e)]);
    driveOneCarriedRecord(emit);
    const carried = events.find((e) => e.type === "mutant-carried");
    if (carried === undefined) throw new Error("no mutant-carried event recorded");
    expect("durationMs" in carried).toBe(false);
    expect(carried).toMatchObject({ priorDurationMs: 10, fromRunId: 3 });
  });

  /**
   * R86 across the resume path, through the seam a carried kill is most likely to be lost in:
   * `record()`'s positional argument list, now twenty-one entries and mostly optional strings, so a
   * value passed one slot out lands on a neighbour and still typechecks. A `killingTestFailure` that
   * reaches the store row but not the `mutant-carried` event would leave every resumed report saying
   * "killed" with no account of why — the exact state R86 measured, reintroduced by the one path
   * that re-executes nothing. (`foldEvents`'s side of the same field is pinned in
   * `report-fold.test.ts`, which has the full-stream harness this file does not.)
   *
   * The assertion is on the exact TEXT, not on the field's presence: the neighbouring slot
   * (`permissionRefusedTest`) is also an optional string, so a swap would still produce a defined
   * value somewhere and only the value pins which one.
   */
  test("R86: a carried kill's failure text survives record()'s argument list", () => {
    const events: RunEvent[] = [];
    const emit = createEmitter([(e) => events.push(e)]);
    const store = new ResultsStore(":memory:");
    const outcomes: SessionOutcome[] = [];
    const KILL_TEXT =
      "The length of the string is 18, but it must be less than or equal to 10 characters";
    try {
      const runId = store.createRun({ projectPath: "/p", backend: "bcdev", appVersion: "1.0.0.0" });
      record(
        store,
        runId,
        mutantEntry("M0001"),
        "killed",
        outcomes,
        0,
        emit,
        "Sales Helper Tests.CarriedKill",
        undefined,
        undefined,
        10,
        ["Sales Helper Tests.CarriedKill"],
        undefined,
        undefined,
        true, // carried
        undefined,
        undefined,
        undefined,
        undefined,
        3, // fromRunId
        undefined, // permissionRefusedTest
        KILL_TEXT,
      );
    } finally {
      store.close();
    }
    const carried = events.find((e) => e.type === "mutant-carried");
    if (carried === undefined) throw new Error("no mutant-carried event recorded");
    expect(carried).toMatchObject({ killingTestFailure: KILL_TEXT });
    // `outcomes[]` is the second view `record()` writes alongside the event — they must agree.
    expect(outcomes[0]?.killingTestFailure).toBe(KILL_TEXT);
  });
});
