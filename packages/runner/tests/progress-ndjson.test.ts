import { describe, expect, test } from "bun:test";
import type { RunEvent, RunEventInput } from "../src/events";
import { STREAM_SCHEMA_VERSION } from "../src/events";
import { createNdjsonSink } from "../src/progress-ndjson";

// Same reasoning as progress-renderer.test.ts's own `ev` helper: `Omit<RunEvent, "seq">` collapses
// a discriminated union down to its common fields (just `type`), which is not what's meant and does
// not typecheck against the union's real variants. `RunEventInput` already IS "a RunEvent minus
// `seq`" by construction (`RunEvent = RunEventInput & Base`), so it's used directly here.
const ev = (e: RunEventInput, seq: number): RunEvent => ({ ...e, seq }) as RunEvent;

describe("ndjson sink", () => {
  test("writes a header line first, then one JSON object per line, seq preserved", () => {
    const chunks: string[] = [];
    const sink = createNdjsonSink((c) => chunks.push(c));
    sink(ev({ type: "stream-started", streamSchemaVersion: STREAM_SCHEMA_VERSION, runId: 1 }, 1));
    sink(ev({ type: "phase-entered", phase: "deploy" }, 2));
    const parsed = chunks
      .join("")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(parsed).toHaveLength(3);
    expect(parsed[0]).toMatchObject({
      ndjsonHeader: true,
      streamSchemaVersion: STREAM_SCHEMA_VERSION,
    });
    expect(parsed[1]).toMatchObject({ type: "stream-started", seq: 1 });
    expect(parsed[2]).toMatchObject({ type: "phase-entered", seq: 2 });
  });

  test("the header line is written on construction, before any event is forwarded", () => {
    const chunks: string[] = [];
    // No event pushed at all — the header must already be there.
    createNdjsonSink((c) => chunks.push(c));
    expect(chunks).toHaveLength(1);
    const header = JSON.parse(chunks[0] ?? "");
    expect(header).toEqual({ ndjsonHeader: true, streamSchemaVersion: STREAM_SCHEMA_VERSION });
  });

  test("the header is distinguishable from a real stream-started event", () => {
    const chunks: string[] = [];
    const sink = createNdjsonSink((c) => chunks.push(c));
    sink(ev({ type: "stream-started", streamSchemaVersion: STREAM_SCHEMA_VERSION, runId: 7 }, 1));
    const [headerLine, streamStartedLine] = chunks;
    const header = JSON.parse(headerLine ?? "");
    const streamStarted = JSON.parse(streamStartedLine ?? "");
    expect(header.ndjsonHeader).toBe(true);
    expect("ndjsonHeader" in streamStarted).toBe(false);
    expect("seq" in header).toBe(false);
    expect(streamStarted.seq).toBe(1);
  });

  test("a mutant-carried line has no durationMs key", () => {
    const chunks: string[] = [];
    const sink = createNdjsonSink((c) => chunks.push(c));
    sink(
      ev(
        {
          type: "mutant-carried",
          mutant: {
            mutantId: "M1",
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
          },
          verdict: "survived",
          fromRunId: 2,
          batchIndex: 0,
          priorDurationMs: 10,
          coveringTests: [],
        },
        1,
      ),
    );
    // chunks[0] is the header; the mutant-carried line is chunks[1].
    const parsed = JSON.parse(chunks[1] ?? "");
    expect("durationMs" in parsed).toBe(false);
    expect(parsed.priorDurationMs).toBe(10);
  });

  test("seq gaps in the input stream (a crash-truncated run) are passed through unmodified", () => {
    const chunks: string[] = [];
    const sink = createNdjsonSink((c) => chunks.push(c));
    sink(ev({ type: "phase-entered", phase: "deploy" }, 1));
    sink(ev({ type: "phase-entered", phase: "mutants" }, 2));
    // Line 3 never arrives — this sink does not know or care; it just forwards what it's given.
    const parsed = chunks
      .join("")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(parsed.map((p) => p.seq)).toEqual([undefined, 1, 2]);
  });
});
