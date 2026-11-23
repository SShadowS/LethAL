// PR-370 (R1189; docs/superpowers/specs/2026-11-23-pr370-recheck-phase.md): the withheld-kill recheck is a phase of its
// own, `recheck`, carrying its nested session's phases, and the TIMING banner prints it. Skips and the stop paths are
// pinned in pr277-stopped-recheck.test.ts; the existing banner (no recheck) in timing-summary.test.ts.
import { describe, expect, test } from "bun:test";
import type { MutantManifestEntry } from "@lethal/schemata";
import { V3_NOT_RUN_SUFFIX } from "../src/al-runner-v3-backend";
import type { RunEvent, RunEventInput } from "../src/events";
import { foldTiming } from "../src/timing-summary";
import { type NestedRecheckResult, nestedSplit, runWithheldRecheck } from "../src/withheld-recheck";

const WITHHELD = `NotRun: out-of-scope: a test before this one in the codeunit did not pass (T0: failed with X) and left state; this failure is not trusted: Expected 1 got 2 ${V3_NOT_RUN_SUFFIX}`;

const M1: MutantManifestEntry = {
  mutantId: "M1",
  file: "src/A.al",
  startIndex: 10,
  endIndex: 20,
  startLine: 3,
  operatorName: "lethal.empty-block",
  operatorVersion: "1.0.0",
  astHash: "hash-M1",
  objectType: "codeunit",
  codeunitId: 50100,
  codeunitName: "A",
  procedureName: "P",
  originalText: "x",
  mutatedText: "y",
};

const EVENTS = [
  {
    type: "baseline-batch-finished",
    batchIndex: 0,
    verdicts: [{ name: "K.K1", outcome: "pass", classification: [] }],
  },
  {
    type: "mutant-scored",
    mutant: M1,
    verdict: "error",
    batchIndex: 0,
    durationMs: 1,
    cause: "runner-refused",
    failureNote: WITHHELD,
    coveringTests: ["K.K1"],
  },
].map((e, i) => ({ ...e, seq: i + 1 })) as unknown as RunEvent[];

const PHASES = [
  { phase: "generate", elapsedMs: 12_000 },
  { phase: "deploy", elapsedMs: 41_200 },
  { phase: "baseline", elapsedMs: 386_100 },
  { phase: "mutants", elapsedMs: 401_700 },
  { phase: "teardown", elapsedMs: 0 },
];

const NESTED: NestedRecheckResult = {
  rows: [
    {
      file: M1.file,
      startIndex: M1.startIndex,
      endIndex: M1.endIndex,
      operatorName: M1.operatorName,
      mutatedText: M1.mutatedText,
      verdict: "killed",
      killingTest: "K.K1",
      coveringTests: ["K.K1"],
      durationMs: 1,
    },
  ],
  baseline: [{ name: "K.K1", outcome: "pass" }],
  baselineElapsedMs: 386_100,
  identity: {},
  phases: PHASES,
};

/** Every event in emit order, with the runner's and the close's calls logged in the same list. */
async function drive(runner: () => Promise<NestedRecheckResult>) {
  const log: string[] = [];
  const emitted: RunEventInput[] = [];
  await runWithheldRecheck({
    events: EVENTS,
    notPassOf: () => ["K.K1"],
    emit: (e) => {
      emitted.push(e);
      log.push(
        e.type === "phase-entered" || e.type === "phase-left" ? `${e.type} ${e.phase}` : e.type,
      );
    },
    main: {},
    budgetSeconds: 10,
    runner: async () => {
      log.push("runner");
      return runner();
    },
    backend: { serveEntries: true, closeDaemons: async () => void log.push("closeDaemons") },
  });
  return { log, emitted };
}

describe("PR-370: the recheck phase", () => {
  test("entered before the daemons close, left after the last row; the nested phases are its detail", async () => {
    const { log, emitted } = await drive(async () => NESTED);
    expect(log).toEqual([
      "phase-entered recheck",
      "closeDaemons",
      "runner",
      "recheck-baseline-finished",
      "mutant-rechecked",
      "phase-left recheck",
    ]);
    expect(emitted[0]).toMatchObject({
      type: "phase-entered",
      phase: "recheck",
      detail:
        "1 withheld kill(s), 1 test(s): a nested session (its own daemons, baseline and mutant phase)",
    });
    const left = emitted.at(-1);
    expect(left).toMatchObject({
      type: "phase-left",
      phase: "recheck",
      detail:
        "nested: generate 12.0 s, deploy 41.2 s, baseline 386.1 s, mutants 401.7 s, teardown 0.0 s",
    });
    expect(left?.type === "phase-left" ? left.elapsedMs : -1).toBeGreaterThanOrEqual(0);
  });

  test("a nested run with no phases: phase-left carries no detail", async () => {
    const { phases: _drop, ...bare } = NESTED;
    const { emitted } = await drive(async () => bare);
    const left = emitted.at(-1);
    expect(left).toMatchObject({ type: "phase-left", phase: "recheck" });
    expect(left !== undefined && "detail" in left).toBe(false);
  });

  test("a nested run that throws: phase-left once, then the unchanged failed warning", async () => {
    const { log, emitted } = await drive(async () => {
      throw new Error("boom");
    });
    expect(log).toEqual([
      "phase-entered recheck",
      "closeDaemons",
      "runner",
      "phase-left recheck",
      "warning",
    ]);
    expect(emitted.at(-1)).toMatchObject({ type: "warning", code: "withheld-recheck-failed" });
    const msg =
      emitted.at(-1)?.type === "warning"
        ? String((emitted.at(-1) as { message: string }).message)
        : "";
    expect(msg).toContain("boom");
  });

  test("an emit that throws after phase-left (a stop during the close): the catch does not leave the phase twice", async () => {
    const stop = new AbortController();
    const types: string[] = [];
    let thrown = false;
    await runWithheldRecheck({
      events: EVENTS,
      notPassOf: () => ["K.K1"],
      emit: (e) => {
        types.push(
          e.type === "phase-entered" || e.type === "phase-left" ? `${e.type} ${e.phase}` : e.type,
        );
        if (e.type === "phase-left" && !thrown) {
          thrown = true;
          throw new Error("subscriber failed");
        }
      },
      main: {},
      budgetSeconds: 10,
      runner: async () => NESTED,
      stopSignal: stop.signal,
      backend: { serveEntries: true, closeDaemons: async () => stop.abort() },
    });
    expect(types.filter((t) => t === "phase-left recheck")).toHaveLength(1);
    expect(types.at(-1)).toBe("warning");
  });

  test("nestedSplit formats each phase in order, in seconds", () => {
    expect(nestedSplit([{ phase: "baseline", elapsedMs: 1_050 }])).toBe("nested: baseline 1.1 s");
  });
});

describe("PR-370: the TIMING banner", () => {
  const ev = (e: Record<string, unknown>): RunEvent => e as unknown as RunEvent;
  test("recheck is listed after teardown, with its nested split under the phases line", () => {
    const text = foldTiming([
      ev({ type: "phase-left", phase: "teardown", elapsedMs: 0 }),
      ev({ type: "phase-left", phase: "recheck", elapsedMs: 874_000, detail: nestedSplit(PHASES) }),
      ev({ type: "session-finished", elapsedMs: 1 }),
    ]);
    expect(text?.split("\n").slice(0, 3)).toEqual([
      "TIMING",
      "  phases: teardown 0.0 s, recheck 874.0 s",
      "  recheck (withheld kills, PR-144): nested: generate 12.0 s, deploy 41.2 s, baseline 386.1 s, mutants 401.7 s, teardown 0.0 s",
    ]);
  });
});
