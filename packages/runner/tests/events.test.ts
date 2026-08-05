import { describe, expect, test } from "bun:test";
import { STREAM_SCHEMA_VERSION, createEmitter } from "../src/events";
import type { RunEvent } from "../src/events";

function collect(): { events: RunEvent[]; sub: (e: RunEvent) => void } {
  const events: RunEvent[] = [];
  return { events, sub: (e) => events.push(e) };
}

describe("createEmitter", () => {
  test("stamps a monotonic seq starting at 1", () => {
    const { events, sub } = collect();
    const emit = createEmitter([sub]);
    emit({ type: "phase-entered", phase: "deploy" });
    emit({ type: "phase-entered", phase: "baseline" });
    expect(events.map((e) => e.seq)).toEqual([1, 2]);
  });

  test("fans out to every subscriber in registration order", () => {
    const a = collect();
    const b = collect();
    const emit = createEmitter([a.sub, b.sub]);
    emit({ type: "phase-entered", phase: "deploy" });
    expect(a.events).toHaveLength(1);
    expect(b.events).toHaveLength(1);
  });

  test("a throwing subscriber does not stop the others, and does not lose the event", () => {
    const good = collect();
    const emit = createEmitter([
      () => {
        throw new Error("subscriber exploded");
      },
      good.sub,
    ]);
    expect(() => emit({ type: "phase-entered", phase: "deploy" })).not.toThrow();
    expect(good.events).toHaveLength(1);
  });

  test("mutant-carried has no durationMs field — R54 made unrepresentable", () => {
    const { events, sub } = collect();
    const emit = createEmitter([sub]);
    emit({
      type: "mutant-carried",
      mutantCode: "M0001",
      verdict: "survived",
      fromRunId: 7,
      priorDurationMs: 4200,
      coveringTests: ["Suite.TestOne"],
    });
    const e = events[0];
    if (e === undefined) throw new Error("no event recorded");
    expect("durationMs" in e).toBe(false);
    expect(e).toMatchObject({ priorDurationMs: 4200 });
  });

  test("the header event carries the stream schema version", () => {
    const { events, sub } = collect();
    const emit = createEmitter([sub]);
    emit({ type: "stream-started", streamSchemaVersion: STREAM_SCHEMA_VERSION, runId: 3 });
    expect(events[0]).toMatchObject({ streamSchemaVersion: STREAM_SCHEMA_VERSION });
  });

  // Not from the brief's Step 1 — added per the team lead's explicit request to confirm that
  // `RunEvent = RunEventInput & Base` still narrows on the `type` discriminant under this repo's
  // tsconfig. This is a compile-time check as much as a runtime one: `bun test` alone would not
  // catch a narrowing regression, only `bun run typecheck` would.
  test("RunEvent narrows to mutant-carried on the type discriminant", () => {
    const { events, sub } = collect();
    const emit = createEmitter([sub]);
    emit({
      type: "mutant-carried",
      mutantCode: "M0002",
      verdict: "killed",
      fromRunId: 9,
      priorDurationMs: 1000,
      coveringTests: [],
    });
    const e = events[0];
    if (e === undefined) throw new Error("no event recorded");
    if (e.type !== "mutant-carried") throw new Error("expected mutant-carried");
    // Narrowed: `e` is now exactly the mutant-carried member intersected with `Base`, so
    // `priorDurationMs` is a plain, non-optional read with no cast.
    const prior: number = e.priorDurationMs;
    expect(prior).toBe(1000);
    // @ts-expect-error — mutant-carried has no durationMs; this line must fail to type-check.
    const bad = e.durationMs;
    expect(bad).toBeUndefined();
  });
});
