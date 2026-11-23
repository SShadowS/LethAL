// PR-277 (R1158; docs/superpowers/specs/2026-11-20-pr277-stopped-run-recheck.md): the recheck driver's stop skip,
// its 0-test skip (no daemon) and its abort; the stop names; and the default signal registration's second signal.
// Session-level cases (signal, budget, churn, a blocking recheck) are in pr144-session-hook.test.ts.
import { describe, expect, test } from "bun:test";
import type { MutantManifestEntry } from "@lethal/schemata";
import { V3_NOT_RUN_SUFFIX } from "../src/al-runner-v3-backend";
import { TIME_BUDGET_EXIT_CODE } from "../src/cli";
import type { RunEvent, RunEventInput } from "../src/events";
import { SIGNAL_STOP_EXIT_CODE, registerProcessStopSignal } from "../src/orchestrator";
import {
  type NestedRecheckResult,
  RECHECK_SKIPPED_CODE,
  RECHECK_SKIPPED_STOPPED_CODE,
  type RecheckRequest,
  runWithheldRecheck,
  stopNameOf,
} from "../src/withheld-recheck";

const WITHHELD = `NotRun: out-of-scope: a test before this one in the codeunit did not pass (T0: failed with X) and left state; this failure is not trusted: Expected 1 got 2 ${V3_NOT_RUN_SUFFIX}`;

function manifest(id: string): MutantManifestEntry {
  return {
    mutantId: id,
    file: "src/A.al",
    startIndex: 10,
    endIndex: 20,
    startLine: 3,
    operatorName: "lethal.empty-block",
    operatorVersion: "1.0.0",
    astHash: `hash-${id}`,
    objectType: "codeunit",
    codeunitId: 50100,
    codeunitName: "A",
    procedureName: "P",
    originalText: "x",
    mutatedText: "y",
  };
}

/** One baseline batch and one withheld kill M1 covered by `K.K1`. */
const EVENTS = [
  {
    type: "baseline-batch-finished",
    batchIndex: 0,
    verdicts: [{ name: "K.K1", outcome: "pass", classification: [] }],
  },
  {
    type: "mutant-scored",
    mutant: manifest("M1"),
    verdict: "error",
    batchIndex: 0,
    durationMs: 1,
    cause: "runner-refused",
    failureNote: WITHHELD,
    coveringTests: ["K.K1"],
  },
].map((e, i) => ({ ...e, seq: i + 1 })) as unknown as RunEvent[];

const NESTED: NestedRecheckResult = {
  rows: [],
  baseline: [{ name: "K.K1", outcome: "pass" }],
  baselineElapsedMs: 1,
  identity: {},
};

async function drive(o: {
  stopped?: string;
  abort?: AbortSignal;
  stopSignal?: AbortSignal;
  notPass?: readonly string[];
  runner?: (req: RecheckRequest) => Promise<NestedRecheckResult>;
  /** Runs inside the pre-recheck `closeDaemons`. */
  duringClose?: () => void;
}) {
  const log: string[] = [];
  const emitted: RunEventInput[] = [];
  /** PR-370: the recheck phase's own events, kept apart so the lists below keep their meaning. */
  const phases: string[] = [];
  const summary = await runWithheldRecheck({
    events: EVENTS,
    notPassOf: () => o.notPass ?? ["K.K1"],
    emit: (e) => {
      if ((e.type === "phase-entered" || e.type === "phase-left") && e.phase === "recheck")
        phases.push(e.type);
      else emitted.push(e);
    },
    main: {},
    budgetSeconds: 10,
    runner:
      o.runner ??
      (async () => {
        log.push("runner");
        return NESTED;
      }),
    backend: {
      serveEntries: true,
      closeDaemons: async () => {
        log.push("closeDaemons");
        o.duringClose?.();
      },
    },
    ...(o.stopped !== undefined ? { stopped: o.stopped } : {}),
    ...(o.abort !== undefined ? { abort: o.abort } : {}),
    ...(o.stopSignal !== undefined ? { stopSignal: o.stopSignal } : {}),
  });
  return { log, emitted, phases, summary };
}

describe("stopNameOf: what stopped the session", () => {
  test("each stop is named, and an unstopped session has none", () => {
    expect(stopNameOf({ signalled: false })).toBeUndefined();
    expect(stopNameOf({ signalled: true })).toContain("SIGTERM or SIGINT");
    expect(stopNameOf({ signalled: false, reached: {} })).toContain("--time-budget");
    expect(stopNameOf({ signalled: false, reached: {}, churn: {} })).toContain("daemon-churn");
    // The memory guard also sets `signalled`; it is named as memory.
    expect(stopNameOf({ signalled: true, reached: {}, memory: {} })).toContain("memory guard");
  });
});

describe("runWithheldRecheck: a stopped session (PR-277 part 1)", () => {
  test("stopped: no daemon is closed, the runner never runs, one skip warning names the stop", async () => {
    const r = await drive({ stopped: "a SIGTERM or SIGINT (R955)" });
    expect(r.log).toEqual([]);
    expect(r.phases).toEqual([]); // PR-370: a skip emits no recheck phase
    expect(r.emitted).toHaveLength(1);
    expect(r.emitted[0]).toMatchObject({ type: "warning", code: RECHECK_SKIPPED_STOPPED_CODE });
    const msg = r.emitted[0]?.type === "warning" ? r.emitted[0].message : "";
    expect(msg).toContain("a SIGTERM or SIGINT (R955)");
    expect(msg).toContain("1 withheld kill(s) stay error");
    expect(r.summary).toEqual({
      targets: 1,
      recovered: 0,
      skipped: "stopped by a SIGTERM or SIGINT (R955)",
    });
  });

  test("not stopped: the recheck runs (control)", async () => {
    const r = await drive({});
    expect(r.log).toEqual(["closeDaemons", "runner"]);
    expect(r.emitted.map((e) => e.type)).toEqual(["recheck-baseline-finished", "mutant-rechecked"]);
    expect(r.phases).toEqual(["phase-entered", "phase-left"]);
  });
});

describe("runWithheldRecheck: targets but 0 tests (PR-277 part 3)", () => {
  test("0 tests: no daemon is closed or started, no baseline event, a skip warning names the case", async () => {
    const r = await drive({ notPass: [] });
    expect(r.log).toEqual([]);
    expect(r.phases).toEqual([]);
    expect(r.emitted).toHaveLength(1);
    expect(r.emitted[0]).toMatchObject({ type: "warning", code: RECHECK_SKIPPED_CODE });
    const msg = r.emitted[0]?.type === "warning" ? r.emitted[0].message : "";
    expect(msg).toContain("no withheld kill has a covering test");
    expect(msg).toContain("1 withheld kill(s) stay error");
  });

  test("with tests: the nested baseline runs on exactly them (control)", async () => {
    const seen: RecheckRequest[] = [];
    const r = await drive({
      runner: async (req) => {
        seen.push(req);
        return NESTED;
      },
    });
    expect(seen.map((q) => q.tests)).toEqual([["K.K1"]]);
    expect(r.emitted[0]).toMatchObject({ type: "recheck-baseline-finished", tests: 1 });
  });
});

describe("runWithheldRecheck: a signal during the recheck (PR-277 part 2)", () => {
  test("a runner that would block is abandoned at once; the runner sees the abort; rows stay error", async () => {
    const ac = new AbortController();
    let seen: AbortSignal | undefined;
    const r = await drive({
      abort: ac.signal,
      runner: (req) => {
        seen = req.signal;
        queueMicrotask(() => ac.abort());
        return new Promise<never>(() => {});
      },
    });
    expect(seen?.aborted).toBe(true);
    expect(r.phases).toEqual(["phase-entered", "phase-left"]); // PR-370: a failed run still leaves the phase, once
    expect(r.emitted).toHaveLength(1);
    expect(r.emitted[0]).toMatchObject({ type: "warning", code: "withheld-recheck-failed" });
    expect(r.summary.recovered).toBe(0);
  });
});

describe("runWithheldRecheck: the first signal during the recheck (amendment 1)", () => {
  test("the runner gets the stop signal; a run it stopped part-way recovers nothing (no baseline event, no row)", async () => {
    const ac = new AbortController();
    let got: AbortSignal | undefined;
    const r = await drive({
      stopSignal: ac.signal,
      runner: async (req) => {
        got = req.stop;
        ac.abort(); // the first signal arrives while the nested session runs; it then returns gracefully
        return NESTED;
      },
    });
    expect(got).toBe(ac.signal);
    expect(r.phases).toEqual(["phase-entered", "phase-left"]);
    expect(r.emitted).toHaveLength(1);
    expect(r.emitted[0]).toMatchObject({ type: "warning", code: "withheld-recheck-failed" });
    expect(r.summary.recovered).toBe(0);
  });

  test("a signal during the pre-recheck closeDaemons: the runner never runs; the stopped skip warning", async () => {
    const ac = new AbortController();
    const r = await drive({ stopSignal: ac.signal, duringClose: () => ac.abort() });
    expect(r.log).toEqual(["closeDaemons"]);
    expect(r.phases).toEqual(["phase-entered", "phase-left"]); // entered before the close, so it pairs
    expect(r.emitted).toHaveLength(1);
    expect(r.emitted[0]).toMatchObject({ type: "warning", code: RECHECK_SKIPPED_STOPPED_CODE });
    expect(r.summary.skipped).toContain("SIGTERM or SIGINT");
  });

  test("a stop signal that never fired: the rows are rechecked (control)", async () => {
    const r = await drive({ stopSignal: new AbortController().signal });
    expect(r.emitted.map((e) => e.type)).toEqual(["recheck-baseline-finished", "mutant-rechecked"]);
  });
});

describe("registerProcessStopSignal: the second signal (PR-277 part 2)", () => {
  test("the remover clears a pending grace timer, so exit(7) never fires after the session ended", () => {
    const order: string[] = [];
    const pending = new Map<number, () => void>();
    let next = 0;
    const off = registerProcessStopSignal(
      () => order.push("stop"),
      () => order.push("again"),
      {
        exit: (code) => order.push(`exit ${code}`),
        timer: {
          set: (fn) => {
            next += 1;
            pending.set(next, fn);
            return next;
          },
          clear: (h) => {
            pending.delete(h as number);
          },
        },
      },
    );
    process.emit("SIGTERM");
    process.emit("SIGTERM");
    expect(pending.size).toBe(1);
    off();
    expect(pending.size).toBe(0);
    expect(order).toEqual(["stop", "again"]);
  });

  test("first spends the budget; second runs `again` and ends the process after the grace; third ends it at once", async () => {
    const order: string[] = [];
    const off = registerProcessStopSignal(
      () => order.push("stop"),
      () => order.push("again"),
      { exit: (code) => order.push(`exit ${code}`), graceMs: 0 },
    );
    try {
      process.emit("SIGTERM");
      expect(order).toEqual(["stop"]);
      process.emit("SIGINT");
      expect(order).toEqual(["stop", "again"]);
      await new Promise((r) => setTimeout(r, 5));
      expect(order).toEqual(["stop", "again", `exit ${SIGNAL_STOP_EXIT_CODE}`]);
      process.emit("SIGTERM");
      expect(order.at(-1)).toBe(`exit ${SIGNAL_STOP_EXIT_CODE}`);
      expect(order).toHaveLength(4);
    } finally {
      off();
    }
  });

  test("the exit code is the time-budget stop's", () => {
    expect(SIGNAL_STOP_EXIT_CODE).toBe(TIME_BUDGET_EXIT_CODE);
    expect(TIME_BUDGET_EXIT_CODE).toBe(7);
  });
});
