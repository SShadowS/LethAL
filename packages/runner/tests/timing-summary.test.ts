// PR-100: the TIMING section folded from a run's events. Spec
// docs/superpowers/specs/2026-11-17-pr100-timing-visibility.md §3 and addendum 1.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunEvent } from "../src/events";
import { foldTiming, foldTimingFile } from "../src/timing-summary";

const ev = (e: Record<string, unknown>): RunEvent => e as unknown as RunEvent;
const phase = (p: string, elapsedMs: number) => ev({ type: "phase-left", phase: p, elapsedMs });
const timed = (e: Record<string, unknown>) => ev({ type: "serve-request-timed", ...e });
const oneShot = (e: Record<string, unknown>) => ev({ type: "baseline-one-shot-timed", ...e });
const closed = (e: Record<string, unknown>) => ev({ type: "serve-daemon-closed", ...e });
let nextMutant = 0;
const scored = (verdict: string, mutantId = `M${nextMutant++}`, batchIndex = 0) =>
  ev({ type: "mutant-scored", verdict, batchIndex, mutant: { mutantId } });
const finished = ev({ type: "session-finished", elapsedMs: 1 });

const FIXED: RunEvent[] = [
  phase("generate", 9_900),
  phase("deploy", 26_400),
  phase("baseline", 300_600),
  phase("mutants", 1_830_000),
  phase("teardown", 0),
  // PR-113: two baseline requests with al-runner timings, three baseline one-shot calls
  timed({
    kind: "baseline",
    lane: 0,
    wallMs: 3_000,
    entries: 1,
    tests: 4,
    timings: { setupMs: 100, engineMs: 200 },
  }),
  timed({
    kind: "baseline",
    lane: 0,
    wallMs: 4_000,
    entries: 1,
    tests: 2,
    timings: { engineMs: 300 },
  }),
  oneShot({ codeunit: 1, wallMs: 5_000, reason: "cross-check" }),
  oneShot({ codeunit: 2, wallMs: 6_000, reason: "cross-check" }),
  oneShot({ codeunit: 3, wallMs: 20_000, reason: "too-slow" }),
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
        "TIMING",
        "  phases: generate 9.9 s, deploy 26.4 s, baseline 300.6 s, mutants 1,830.0 s, teardown 0.0 s",
        "  serve requests: baseline 2 (7.0 s), warm-up 4 (22.1 s), prefetch 2 (1,231.5 s), live 2 (574.0 s); selected-only 2",
        "    warm-ups by cause: first 2 (5.1 s), after-refusal 1 (10.2 s), recycle 1 (6.8 s)",
        "    al-runner inside baseline requests: setup 0.1 s, engine 0.5 s",
        "    al-runner inside prefetch requests: setup 1.0 s, tests 900.0 s, coverage 0.0 s",
        "    al-runner inside live requests: setup 0.2 s, compile 12.0 s, engine 3.1 s, baseline 1.9 s, tests 700.0 s, other 7.3 s",
        "  baseline one-shots: 3 (31.0 s; cross-check 2, too-slow 1, other 0)",
        "  daemon restarts: 4 — refusal/WithEvents subscriber … in prefetch 2, recycle 1, timeout in live 1",
        "  timeouts: 1 mutant timeout-killed, 1 answer cut at a timeout row",
        "  per covered mutant: 457.50 s (4 scored with coverage over the mutants phase)",
      ].join("\n"),
    );
  });

  test("PR-113: no baseline one-shots, no line; baseline timings do not enter the live line", () => {
    const text = foldTiming([
      timed({
        kind: "baseline",
        lane: 0,
        wallMs: 1_000,
        entries: 1,
        tests: 1,
        timings: { engineMs: 900 },
      }),
      timed({
        kind: "live",
        lane: 0,
        wallMs: 1_000,
        entries: 1,
        tests: 1,
        timings: { engineMs: 100 },
      }),
      finished,
    ]);
    expect(text).not.toContain("baseline one-shots");
    expect(text).toContain("al-runner inside baseline requests: engine 0.9 s");
    expect(text).toContain("al-runner inside live requests: engine 0.1 s");
  });

  test("counts take the plural form from 2 up, and a baseline-phase restart reads 'in baseline'", () => {
    const text = foldTiming([
      scored("timeout-killed"),
      scored("timeout-killed"),
      timed({ kind: "prefetch", lane: 0, wallMs: 1, entries: 1, tests: 1, cut: true }),
      timed({ kind: "prefetch", lane: 0, wallMs: 1, entries: 1, tests: 1, cut: true }),
      closed({ reason: "timeout", phase: "baseline" }),
      finished,
    ]);
    expect(text).toContain("2 mutants timeout-killed, 2 answers cut at a timeout row");
    expect(text).toContain("timeout in baseline 1");
  });

  test("a restart family is cut at 40 characters", () => {
    const text = foldTiming([
      closed({ reason: "refusal", family: "x".repeat(60), phase: "live" }),
      finished,
    ]);
    expect(text).toContain(`refusal/${"x".repeat(40)} in live 1`);
    expect(text).not.toContain("x".repeat(41));
  });

  test("PR-108: capped walks are counted by verdict from the cap note, and the line is omitted at 0", () => {
    const note =
      "the walk stopped after 3 timeouts (PR-108, R1057's cap); 2 covering test(s) after them were not run";
    const cappedScore = (verdict: string, mutantId: string) =>
      ev({
        type: "mutant-scored",
        verdict,
        batchIndex: 0,
        mutant: { mutantId },
        failureNote: note,
      });
    const text = foldTiming([
      cappedScore("timeout-killed", "A"),
      cappedScore("timeout-killed", "B"),
      cappedScore("error", "C"),
      scored("killed"),
      finished,
    ]);
    expect(text).toContain("  capped walks: 3 (timeout-killed 2, error 1)");
    expect(foldTiming([scored("killed"), finished]) ?? "").not.toContain("capped walks");
  });

  test("PR-108: a mutant scored capped and then uncapped is not counted; scored capped twice, the last verdict wins", () => {
    const note =
      "the walk stopped after 3 timeouts (PR-108, R1057's cap); 0 covering test(s) after them were not run";
    const score = (verdict: string, mutantId: string, failureNote?: string) =>
      ev({
        type: "mutant-scored",
        verdict,
        batchIndex: 0,
        mutant: { mutantId },
        ...(failureNote !== undefined ? { failureNote } : {}),
      });
    // red without `else capped.delete`: the rescored-uncapped mutant still counts
    const rescored = foldTiming([score("error", "A", note), score("killed", "A"), finished]);
    expect(rescored ?? "").not.toContain("capped walks");
    const twice = foldTiming([
      score("error", "B", note),
      score("timeout-killed", "B", note),
      finished,
    ]);
    expect(twice).toContain("  capped walks: 1 (timeout-killed 1)");
  });

  test("per covered mutant excludes no-coverage and known-survivor", () => {
    const base = [phase("mutants", 10_000), finished];
    const one = foldTiming([
      ...base,
      scored("killed"),
      scored("no-coverage"),
      scored("known-survivor"),
      scored("no-coverage"),
    ]);
    expect(one).toContain("per covered mutant: 10.00 s (1 scored with coverage");
    const two = foldTiming([...base, scored("killed"), scored("survived")]);
    expect(two).toContain("per covered mutant: 5.00 s (2 scored");
  });

  test("a mutant scored again after batch-invalidated counts once, by its last verdict", () => {
    const text = foldTiming([
      phase("mutants", 10_000),
      scored("killed", "M1", 0),
      scored("killed", "M2", 0),
      // batch 0 was invalidated and re-run: both mutants are scored again
      scored("killed", "M1", 0),
      scored("no-coverage", "M2", 0),
      // the same id in another batch is another mutant
      scored("survived", "M1", 1),
      finished,
    ]);
    expect(text).toContain("per covered mutant: 5.00 s (2 scored");
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

  test("the header says serve times are summed when more than one lane ran", () => {
    const lane = (n: number) =>
      timed({ kind: "live", lane: n, wallMs: 1_000, entries: 1, tests: 1 });
    expect(foldTiming([lane(0), lane(0), finished])?.split("\n")[0]).toBe("TIMING");
    expect(foldTiming([lane(0), lane(1), finished])?.split("\n")[0]).toBe(
      "TIMING (serve times are summed over lanes)",
    );
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
        "TIMING",
        "  phases: deploy 2.0 s, mutants 6.0 s",
        "  per covered mutant: 2.00 s (3 scored with coverage over the mutants phase)",
      ].join("\n"),
    );
  });

  test("an empty stream gives no section", () => {
    expect(foldTiming([])).toBeUndefined();
  });
});

describe("PR-100: foldTimingFile streams the events file", () => {
  const scratchFile = (lines: string[]): { path: string; done: () => void } => {
    const dir = mkdtempSync(join(tmpdir(), "lethal-pr100-events-"));
    const path = join(dir, "events.ndjson");
    writeFileSync(path, lines.join("\n"), "utf8");
    return { path, done: () => rmSync(dir, { recursive: true, force: true }) };
  };

  test("a generated 200,000-line file folds to the right counts", async () => {
    const lines = [JSON.stringify({ ndjsonHeader: true, streamSchemaVersion: 1 })];
    lines.push(JSON.stringify({ type: "phase-left", phase: "mutants", elapsedMs: 200_000 }));
    for (let i = 0; i < 199_995; i++)
      lines.push(
        JSON.stringify({
          type: "mutant-scored",
          verdict: i % 2 === 0 ? "killed" : "no-coverage",
          batchIndex: 0,
          mutant: { mutantId: `M${i}` },
        }),
      );
    lines.push(JSON.stringify({ type: "from-the-future", x: 1 }));
    lines.push(JSON.stringify({ type: "session-finished", elapsedMs: 1 }));
    lines.push('{"type":"phase-le'); // a killed run's cut last write
    expect(lines.length).toBe(200_000);
    const f = scratchFile(lines);
    try {
      const text = await foldTimingFile(f.path);
      // 99,998 covered of 199,995 scored, over 200 s
      expect(text).toContain("per covered mutant: 0.00 s (99998 scored with coverage");
      expect(text?.split("\n")[0]).toBe("TIMING");
    } finally {
      f.done();
    }
  });

  test("a corrupt line names its real file line, blank lines counted; a cut last line is skipped", async () => {
    const good = JSON.stringify({ type: "phase-left", phase: "deploy", elapsedMs: 1000 });
    const bad = scratchFile([good, "", "", '{"type":', good]);
    try {
      await expect(foldTimingFile(bad.path)).rejects.toThrow(
        "events file line 4 is not valid JSON",
      );
    } finally {
      bad.done();
    }
    const cut = scratchFile([good, "", '{"type":"phase-le', ""]);
    try {
      expect(await foldTimingFile(cut.path)).toContain("deploy 1.0 s");
    } finally {
      cut.done();
    }
  });
});
