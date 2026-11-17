// PR-100: the TIMING section folded from a run's events. Spec
// docs/superpowers/specs/2026-11-17-pr100-timing-visibility.md §3.
import { describe, expect, test } from "bun:test";
import type { RunEvent } from "../src/events";
import { foldTiming, parseEventsNdjson } from "../src/timing-summary";

const ev = (e: Record<string, unknown>): RunEvent => e as unknown as RunEvent;
const phase = (p: string, elapsedMs: number) => ev({ type: "phase-left", phase: p, elapsedMs });
const timed = (e: Record<string, unknown>) => ev({ type: "serve-request-timed", ...e });
const closed = (e: Record<string, unknown>) => ev({ type: "serve-daemon-closed", ...e });
const scored = (verdict: string) => ev({ type: "mutant-scored", verdict });
const finished = ev({ type: "session-finished", elapsedMs: 1 });

const FIXED: RunEvent[] = [
  phase("generate", 9_900),
  phase("deploy", 26_400),
  phase("baseline", 300_600),
  phase("mutants", 1_830_000),
  phase("teardown", 0),
  timed({ kind: "warmup", lane: 0, wallMs: 2_500, entries: 1, tests: 1, cause: "first" }),
  timed({ kind: "warmup", lane: 0, wallMs: 2_600, entries: 1, tests: 1, cause: "first" }),
  timed({ kind: "warmup", lane: 0, wallMs: 10_200, entries: 1, tests: 1, cause: "after-refusal" }),
  timed({ kind: "warmup", lane: 0, wallMs: 6_800, entries: 1, tests: 1, cause: "recycle" }),
  timed({
    kind: "prefetch",
    lane: 0,
    wallMs: 1_000_000,
    entries: 9,
    tests: 9,
    selectedOnly: true,
    timings: { setupMs: 1_000, testsMs: 900_000, coverageMs: 0 },
  }),
  timed({ kind: "prefetch", lane: 0, wallMs: 231_500, entries: 9, tests: 9, cut: true }),
  timed({
    kind: "live",
    lane: 0,
    wallMs: 500_000,
    entries: 2,
    tests: 2,
    selectedOnly: true,
    timings: {
      setupMs: 200,
      compileMs: 12_000,
      engineMs: 3_100,
      baselineMs: 1_900,
      testsMs: 700_000,
      otherMs: 7_300,
    },
  }),
  timed({ kind: "live", lane: 0, wallMs: 74_000, entries: 2, tests: 2, failed: true }),
  closed({ reason: "refusal", family: "WithEvents subscriber …", phase: "prefetch" }),
  closed({ reason: "refusal", family: "WithEvents subscriber …", phase: "prefetch" }),
  closed({ reason: "timeout", phase: "live" }),
  closed({ reason: "recycle", phase: "idle" }),
  scored("killed"),
  scored("killed"),
  scored("killed"),
  scored("no-coverage"),
  scored("no-coverage"),
  scored("timeout-killed"),
  finished,
];

describe("PR-100: foldTiming", () => {
  test("each line, over a fixed event list", () => {
    const text = foldTiming(FIXED);
    expect(text).toBe(
      [
        "TIMING (wall clock)",
        "  phases: generate 9.9 s, deploy 26.4 s, baseline 300.6 s, mutants 1,830.0 s, teardown 0.0 s",
        "  serve requests: warm-up 4 (22.1 s), prefetch 2 (1,231.5 s), live 2 (574.0 s); selected-only 2",
        "    warm-ups by cause: first 2 (5.1 s), after-refusal 1 (10.2 s), recycle 1 (6.8 s)",
        "    al-runner inside them: setup 1.2 s, compile 12.0 s, engine 3.1 s, baseline 1.9 s, tests 1,600.0 s, coverage 0.0 s, other 7.3 s",
        "  daemon restarts: 4 — refusal/WithEvents subscriber … in prefetch 2, recycle 1, timeout in live 1",
        "  timeouts: 1 mutants timeout-killed, 1 answers cut at a timeout row",
        "  per covered mutant: 457.50 s (4 scored with coverage over the mutants phase)",
      ].join("\n"),
    );
  });

  test("a restart family is cut at 40 characters", () => {
    const text = foldTiming([
      closed({ reason: "refusal", family: "x".repeat(60), phase: "live" }),
      finished,
    ]);
    expect(text).toContain(`refusal/${"x".repeat(40)} in live 1`);
    expect(text).not.toContain("x".repeat(41));
  });

  test("per covered mutant excludes no-coverage", () => {
    const base = [phase("mutants", 10_000), finished];
    const one = foldTiming([
      ...base,
      scored("killed"),
      scored("no-coverage"),
      scored("no-coverage"),
    ]);
    expect(one).toContain("per covered mutant: 10.00 s (1 scored with coverage");
    const two = foldTiming([...base, scored("killed"), scored("survived")]);
    expect(two).toContain("per covered mutant: 5.00 s (2 scored");
  });

  test("per covered mutant is omitted at 0, never '0 s'", () => {
    const text = foldTiming([phase("mutants", 10_000), scored("no-coverage"), finished]);
    expect(text).not.toContain("per covered mutant");
    expect(text).toContain("mutants 10.0 s");
  });

  test("a stream with no session-finished is partial", () => {
    const text = foldTiming([phase("generate", 1_000)]);
    expect(text?.split("\n")[0]).toBe("TIMING (partial: the run did not finish)");
  });

  test("a stream from a non-serve backend shows phases and per-mutant only", () => {
    const text = foldTiming([
      phase("deploy", 2_000),
      phase("mutants", 6_000),
      scored("killed"),
      scored("survived"),
      scored("killed"),
      finished,
    ]);
    expect(text).toBe(
      [
        "TIMING (wall clock)",
        "  phases: deploy 2.0 s, mutants 6.0 s",
        "  per covered mutant: 2.00 s (3 scored with coverage over the mutants phase)",
      ].join("\n"),
    );
  });

  test("an empty stream gives no section", () => {
    expect(foldTiming([])).toBeUndefined();
  });

  test("parseEventsNdjson skips the header and unknown lines, and a cut last line, but not a bad middle one", () => {
    const good = JSON.stringify({ type: "phase-left", phase: "deploy", elapsedMs: 1 });
    const text = [
      JSON.stringify({ ndjsonHeader: true, streamSchemaVersion: 1 }),
      good,
      JSON.stringify({ nothing: 1 }),
      '{"type":"phase-le',
    ].join("\n");
    expect(parseEventsNdjson(text)).toHaveLength(1);
    expect(() => parseEventsNdjson(`{"type":\n${good}\n`)).toThrow(/line 1/);
  });
});
