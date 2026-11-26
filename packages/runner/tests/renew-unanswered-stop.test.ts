/**
 * R1227 / PR-454: the session stops scoring after unanswered lease renews, and the degraded window
 * is dropped from the store and from `--resume`. Every test drives the REAL `LeaseSession.pulse`
 * through the timer seam and a scripted renew fake; the stop's 100 s is read from `clock.mono`
 * (PR-252), which the rig steps. No wall-clock waiting anywhere.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IDENTITY_SCHEME } from "@lethal/schemata";
import { clock } from "../src/clock";
import type { RunEventInput } from "../src/events";
import type { LeaseApi } from "../src/lease";
import {
  DegradedWindowNotStoredError,
  LeaseSession,
  RENEW_UNANSWERED_STOP_MS,
  invalidateDegradedWindow,
} from "../src/orchestrator";
import { QuarantineStore } from "../src/quarantine-store";
import { CARRYABLE_VERDICTS, buildResumeIndex } from "../src/resume";
import { SessionSafety } from "../src/session-safety";
import { type MutantVerdict, ResultsStore } from "../src/store";

const realMono = clock.mono;
afterEach(() => {
  clock.mono = realMono;
});

const NOTE_PREFIX = "lease-renew-unanswered:";

function newRun(store: ResultsStore): number {
  return store.createRun({
    testScope: [],
    coverageMode: "procedure",
    identityScheme: IDENTITY_SCHEME,
    buildSymbols: [],
    projectPath: "/p",
    backend: "bcdev",
    appVersion: "1",
    configFingerprint: "fp",
    testAppHash: "package:t",
    testAppProven: true,
    testAppDeps: "D",
  });
}

function addRow(
  store: ResultsStore,
  runId: number,
  name: string,
  verdict: MutantVerdict = "survived",
  over: Partial<Parameters<ResultsStore["recordMutant"]>[1]> = {},
): number {
  return store.recordMutant(runId, {
    mutantCode: name,
    astHash: `h-${name}`,
    codeunitName: "Sandbox Logic",
    procedureName: "Post",
    operatorName: "lethal.negate-conditional",
    operatorMajor: 1,
    file: "src/SandboxLogic.Codeunit.al",
    line: 1,
    verdict,
    durationMs: 1,
    batchIndex: 0,
    ...over,
  });
}

function rig(opts: { failMsPerCall?: number } = {}) {
  let mono = 1_000_000;
  clock.mono = () => mono;
  const store = new ResultsStore(":memory:");
  const runId = newRun(store);
  const dir = mkdtempSync(join(tmpdir(), "r1227-"));
  const quarantine = new QuarantineStore(dir);
  const events: RunEventInput[] = [];
  const safety = new SessionSafety();
  const state = {
    mode: "fail" as "fail" | "ok" | "lost",
    failMs: opts.failMsPerCall ?? 30_000,
    renewCalls: 0,
    released: 0,
    statusThrows: false,
    onRenew: undefined as ((n: number) => void) | undefined,
    lost: 0,
    degraded: 0,
    cleared: 0,
    fn: undefined as (() => unknown) | undefined,
  };
  const client = {
    renew: async () => {
      state.renewCalls += 1;
      state.onRenew?.(state.renewCalls);
      if (state.mode === "fail") {
        mono += state.failMs;
        throw new Error("503");
      }
      return state.mode === "lost"
        ? { renewed: false as const }
        : { renewed: true as const, expiresAt: "2026-11-26T12:00:00.000Z" };
    },
    getOperationStatus: async () => {
      if (state.statusThrows) throw new Error("status unreadable");
      return {
        opKind: "none",
        opAttemptId: "",
        opSeq: 0,
        lastCompletedOpSeq: 0,
        completed: false,
      };
    },
    release: async () => {
      state.released += 1;
      return { released: true as const };
    },
  } as unknown as LeaseApi;
  const session = new LeaseSession({
    client,
    lease: {
      epoch: 1,
      token: "t",
      serverGeneration: "g",
      lastCompletedOpSeq: 0,
      expiresAt: "2026-11-26T12:00:00.000Z",
    },
    safety,
    ttlSeconds: 15,
    timers: {
      setInterval: (fn) => {
        state.fn = fn;
        return 1;
      },
      clearInterval: () => {
        state.cleared += 1;
      },
    },
    sleep: async () => {},
    quarantineStore: quarantine,
    resourceKey: "tier",
    nowIso: () => "2026-11-26T10:00:00.000Z",
    runId,
    emit: (e) => events.push(e),
    onLost: () => {
      state.lost += 1;
    },
    windowMark: () => ({ ...store.windowMark(runId), scoredSeq: 0 }),
    onDegraded: (w, note) => {
      state.degraded += 1;
      store.markDegradedWindow(runId, w.afterMutantId, w.afterSnapshotId, note);
    },
  });
  session.start();
  const tick = async () => {
    await state.fn?.();
  };
  const ticks = async (n: number) => {
    for (let i = 0; i < n; i++) await tick();
  };
  const stops = () =>
    events.filter((e) => e.type === "warning" && e.code === "lease-renew-unanswered-stop").length;
  const verdicts = () =>
    new Map(
      (
        store.db
          .query("SELECT mutant_code AS c, verdict AS v FROM mutants WHERE run_id = ?")
          .all(runId) as Array<{ c: string; v: string }>
      ).map((r) => [r.c, r.v]),
    );
  return {
    store,
    runId,
    quarantine,
    events,
    safety,
    state,
    session,
    tick,
    ticks,
    stops,
    verdicts,
    stepMono: (ms: number) => {
      mono += ms;
    },
  };
}

describe("R1227 group 1: the stop rule", () => {
  test("two unanswered warnings with 100 s or more since the last answer stop; the heartbeat keeps going", async () => {
    const r = rig();
    await r.ticks(2); // a blip, then the first unanswered warning (streak 1)
    expect(r.stops()).toBe(0);
    expect(r.safety.isUnsafe).toBe(false);
    await r.tick(); // streak 2, 180 s since the start
    expect(r.stops()).toBe(1);
    expect(r.safety.isUnsafe).toBe(true);
    expect(r.safety.reason?.startsWith(NOTE_PREFIX)).toBe(true);
    expect(r.state.cleared).toBe(0); // not stop(): the lease must not lapse under the op in flight
    expect(r.events.filter((e) => e.type === "degraded-window")).toHaveLength(1);
  });

  test("an answered renew between two unanswered warnings resets the streak", async () => {
    const r = rig();
    await r.ticks(2); // streak 1
    r.state.mode = "ok";
    await r.tick(); // answered: streak 0
    r.state.mode = "fail";
    await r.ticks(2); // blip, streak 1 again, 120 s since the answer
    expect(r.stops()).toBe(0);
    expect(r.safety.isUnsafe).toBe(false);
  });

  test("fast failures do not stop, however many; the same streak after 100 s does", async () => {
    const r = rig({ failMsPerCall: 0 });
    await r.ticks(8);
    expect(
      r.events.filter((e) => e.type === "warning" && e.code === "lease-renew-unanswered"),
    ).toHaveLength(7);
    expect(r.stops()).toBe(0);
    r.state.failMs = RENEW_UNANSWERED_STOP_MS; // the next tick takes 200 s
    await r.tick();
    expect(r.stops()).toBe(1);
  });

  test("a single unanswered warning does not stop, however old", async () => {
    const r = rig({ failMsPerCall: 50_000 });
    await r.ticks(2); // blip, one unanswered, 200 s since the start
    expect(r.stops()).toBe(0);
    expect(r.safety.isUnsafe).toBe(false);
  });

  test("the stop fires once: later warnings add no second warning, event or write", async () => {
    const r = rig();
    await r.ticks(6);
    expect(r.stops()).toBe(1);
    expect(r.events.filter((e) => e.type === "degraded-window")).toHaveLength(1);
    expect(r.state.degraded).toBe(1);
  });
});

describe("R1227 group 2: where the window starts", () => {
  test("rows recorded before the first renew, between its failure and the retry, and by dropped ticks are inside; earlier rows are kept", async () => {
    const r = rig();
    addRow(r.store, r.runId, "A", "killed", { killingTest: "T" });
    addRow(r.store, r.runId, "B");
    r.state.mode = "ok";
    await r.tick(); // answered: the mark follows
    addRow(r.store, r.runId, "PRE", "survived"); // recorded after the answered tick, before the stall
    r.state.mode = "fail";
    r.state.onRenew = (n) => {
      // call 2 is the first failing tick's first renew; call 3 its retry
      if (n === 2) addRow(r.store, r.runId, "DURING", "killed", { killingTest: "T" });
      if (n === 3) {
        addRow(r.store, r.runId, "BETWEEN");
        void r.state.fn?.(); // a tick dropped behind the stalled one
        addRow(r.store, r.runId, "DROPPED");
      }
    };
    await r.tick(); // the first failing tick: dropped tick makes it unanswered (streak 1)
    await r.tick(); // streak 2, 120 s
    expect(r.stops()).toBe(1);
    const v = r.verdicts();
    expect(v.get("A")).toBe("killed");
    expect(v.get("B")).toBe("survived");
    expect(v.get("PRE")).toBe("survived"); // recorded before the first failed renew began
    for (const c of ["DURING", "BETWEEN", "DROPPED"]) expect(v.get(c)).toBe("error");
  });

  test("a window that opens at a blip: rows before the blip stand, rows from it on do not", async () => {
    const r = rig();
    addRow(r.store, r.runId, "X", "killed", { killingTest: "T" });
    r.state.mode = "ok";
    await r.tick();
    addRow(r.store, r.runId, "Y");
    r.state.mode = "fail";
    r.state.onRenew = (n) => {
      if (n === 2) addRow(r.store, r.runId, "Z");
    };
    await r.ticks(3); // blip (opens the window), unanswered, unanswered: stop
    expect(r.stops()).toBe(1);
    const v = r.verdicts();
    expect(v.get("X")).toBe("killed");
    expect(v.get("Y")).toBe("survived");
    expect(v.get("Z")).toBe("error");
  });

  test("a run with no rows opens its window at 0, and a later row is inside", async () => {
    const r = rig();
    await r.ticks(3);
    const w = r.store.db
      .query("SELECT after_mutant_id AS a, after_snapshot_id AS s FROM degraded_windows")
      .all() as Array<{ a: number; s: number }>;
    expect(w).toEqual([{ a: 0, s: 0 }]);
    addRow(r.store, r.runId, "LATE");
    invalidateDegradedWindow(r.store, r.runId, r.session, () => {}, undefined, undefined);
    expect(r.verdicts().get("LATE")).toBe("error");
  });

  test("an answered renew clears the window: a stall that ends opens none", async () => {
    const r = rig();
    await r.ticks(2); // streak 1, window open
    r.state.mode = "ok";
    await r.tick(); // answered
    addRow(r.store, r.runId, "AFTER");
    r.state.mode = "fail";
    await r.ticks(2);
    expect(r.stops()).toBe(0);
    expect(r.store.db.query("SELECT COUNT(*) AS n FROM degraded_windows").get()).toEqual({ n: 0 });
  });
});

describe("R1227 group 4/5: the store write and the teardown's second chance", () => {
  test("the teardown rewrites a row recorded after the stop", async () => {
    const r = rig();
    await r.ticks(3);
    addRow(r.store, r.runId, "INFLIGHT", "killed", { killingTest: "T" }); // the op still running
    expect(r.verdicts().get("INFLIGHT")).toBe("killed");
    invalidateDegradedWindow(r.store, r.runId, r.session, () => {}, undefined, undefined);
    expect(r.verdicts().get("INFLIGHT")).toBe("error"); // the raw row, not a read-time view
  });

  test("a failing teardown write throws DegradedWindowNotStoredError naming the run", async () => {
    const r = rig();
    await r.ticks(3);
    r.store.db.close();
    const err = (() => {
      try {
        invalidateDegradedWindow(r.store, r.runId, r.session, () => {}, undefined, undefined);
        return undefined;
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(DegradedWindowNotStoredError);
    expect((err as Error).message).toContain(`do not --resume run ${r.runId}`);
  });

  test("no stop, no write", () => {
    const r = rig();
    invalidateDegradedWindow(r.store, r.runId, r.session, () => {}, undefined, undefined);
    expect(r.store.db.query("SELECT COUNT(*) AS n FROM degraded_windows").get()).toEqual({ n: 0 });
  });
});

describe("R1227 group 6: --resume", () => {
  const CARRY = [...CARRYABLE_VERDICTS];

  test("exactly the window's rows are re-run; a stranded row in it is re-run once, not skipped", async () => {
    const r = rig();
    addRow(r.store, r.runId, "A", "killed", { killingTest: "T", killReproduced: true });
    addRow(r.store, r.runId, "B");
    r.state.onRenew = (n) => {
      if (n === 1) {
        addRow(r.store, r.runId, "C", "killed", { killingTest: "T" });
        addRow(r.store, r.runId, "D", "error", { failureNote: "quarantined: in-flight-unknown" });
        addRow(r.store, r.runId, "E");
      }
    };
    await r.ticks(3);
    // a row recorded after the stop that no teardown has rewritten (a crash): the READER refuses it
    addRow(r.store, r.runId, "POST", "killed", { killingTest: "T" });
    const index = buildResumeIndex(r.store.mutantVerdicts(r.runId));
    expect(index.carryable.size).toBe(2); // A and B only
    expect(index.degradedWindowRows).toBe(4); // C, D, E, POST
    expect(index.strandedKeys.size).toBe(0);
    const note = r.store.mutantVerdicts(r.runId).find((v) => v.astHash === "h-C")?.failureNote;
    expect(note?.startsWith(NOTE_PREFIX)).toBe(true); // never an error with a NULL note
  });

  test("with no window nothing more is re-run, and a stranded row is still skipped", () => {
    const store = new ResultsStore(":memory:");
    const id = newRun(store);
    addRow(store, id, "A", "killed", { killingTest: "T" });
    addRow(store, id, "D", "error", { failureNote: "quarantined: in-flight-unknown" });
    const index = buildResumeIndex(store.mutantVerdicts(id));
    expect(index.degradedWindowRows).toBe(0);
    expect(index.strandedKeys.size).toBe(1);
  });

  test("findResumableRun skips a run whose only carryable rows are inside the window", () => {
    const store = new ResultsStore(":memory:");
    const older = newRun(store);
    addRow(store, older, "O");
    const newer = newRun(store);
    const q = {
      projectPath: "/p",
      backend: "bcdev",
      configFingerprint: "fp",
      carryableVerdicts: CARRY,
    };
    addRow(store, newer, "N", "killed", { killingTest: "T" });
    expect(store.findResumableRun(q)).toBe(newer);
    // a window written BEFORE the row: nothing rewrites it, so only the reader's predicate refuses it
    store.db.query("DELETE FROM mutants WHERE run_id = ?").run(newer);
    store.markDegradedWindow(newer, 0, 0, "window");
    addRow(store, newer, "N2", "killed", { killingTest: "T" });
    expect(store.findResumableRun(q)).toBe(older);
  });
});

describe("R1227 group 7: no lease-loss semantics", () => {
  test("the stop calls no onLost and writes no lost_batches row; renewed:false still is a loss", async () => {
    const r = rig();
    await r.ticks(3);
    expect(r.stops()).toBe(1);
    expect(r.state.lost).toBe(0);
    expect(r.session.lostBatchIndex).toBeUndefined();
    expect(r.store.db.query("SELECT COUNT(*) AS n FROM lost_batches").get()).toEqual({ n: 0 });
    // the heartbeat still runs: a later answer of renewed:false is the loss it always was
    r.state.mode = "lost";
    await r.tick();
    expect(r.state.lost).toBe(1);
    expect(r.session.lostBatchIndex).toBeDefined();
    expect(r.safety.reason?.startsWith(NOTE_PREFIX)).toBe(true); // the first reason is kept
  });
});

describe("R1227 group 8: baseline snapshots", () => {
  function snap(r: ReturnType<typeof rig>, batch: number): void {
    r.store.recordBaselineSnapshot({
      runId: r.runId,
      batchIndex: batch,
      batchHash: `b${batch}`,
      testAppHash: "package:t",
      baseline: [],
    });
  }
  const find = (r: ReturnType<typeof rig>, batch: number) =>
    r.store.findBaselineSnapshot(`b${batch}`, "package:t", "D", "procedure")?.batchIndex ?? null;

  test("a snapshot recorded after the window began is never lent; earlier ones are", async () => {
    const r = rig();
    snap(r, 0);
    r.state.onRenew = (n) => {
      if (n === 1) snap(r, 1); // while the first stalled renew waits
    };
    await r.ticks(3);
    snap(r, 2); // after the stop, by the op in flight
    invalidateDegradedWindow(r.store, r.runId, r.session, () => {}, undefined, undefined);
    expect(find(r, 0)).toBe(0);
    expect(find(r, 1)).toBeNull();
    expect(find(r, 2)).toBeNull();
    expect(r.store.snapshotBatchHash(r.runId, 1)).toBeNull();
    expect(r.store.snapshotBatchHash(r.runId, 0)).not.toBeNull();
  });
});

describe("R1227 group 9: the durable recycle record", () => {
  test("finish() records container-needs-recycle naming the renew stop, with no ForceResetLease, and releases cleanly", async () => {
    const r = rig();
    await r.ticks(3);
    await r.session.finish();
    const rec = await r.quarantine.read("tier");
    expect(rec?.opKind).toBe("container-needs-recycle");
    expect(rec?.detail).toContain("stopped answering lease renews");
    expect(rec?.detail).toContain("restart the service tier");
    expect(rec?.detail).not.toContain("ForceResetLease");
    expect(r.state.released).toBe(1);
  });

  test("it is recorded even when the marker read at finish() fails", async () => {
    const r = rig();
    await r.ticks(3);
    r.state.statusThrows = true;
    await r.session.finish();
    expect((await r.quarantine.read("tier"))?.opKind).toBe("container-needs-recycle");
  });

  test("a session that never stopped records nothing", async () => {
    const r = rig();
    r.state.mode = "ok";
    await r.ticks(3);
    await r.session.finish();
    expect(await r.quarantine.read("tier")).toBeNull();
  });
});
