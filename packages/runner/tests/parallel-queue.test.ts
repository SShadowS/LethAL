// R766 step (b): the ordered commit, the stop rule and the pull queue of `--workers N` on al-runner v3.
// Pure fakes: the "lanes" are scripted calls, so the order of events is the test's, never a clock's.
import { describe, expect, test } from "bun:test";
import {
  type LaneReason,
  type Latch,
  OrderedCommit,
  ParallelStopError,
  lanesNotice,
  runScopeQueue,
} from "../src/parallel-queue";

const CODES = ["M0", "M1", "M2", "M3", "M4", "M5"];

function setup(workers = 3) {
  const latch: { value: ReturnType<Latch> } = { value: undefined };
  const log: string[] = [];
  const commit = new OrderedCommit(CODES, () => latch.value, workers);
  const rec = (code: string) => () => void log.push(code);
  return { commit, latch, log, rec };
}

describe("OrderedCommit: records come in manifest order", () => {
  test("a mutant that finishes early waits for the ones before it", () => {
    const { commit, log, rec } = setup();
    const [a, b, c] = [commit.laneSink().sink, commit.laneSink().sink, commit.laneSink().sink];
    a.begin("M0");
    b.begin("M1");
    c.begin("M2");
    c.finish("M2", rec("M2"));
    b.finish("M1", rec("M1"));
    expect(log).toEqual([]); // M0 is still running
    a.finish("M0", rec("M0"));
    expect(log).toEqual(["M0", "M1", "M2"]);
  });

  test("an uncovered mutant (markDone) is a hole the order skips, not a wait", () => {
    const { commit, log, rec } = setup();
    commit.markDone("M0");
    const { sink } = commit.laneSink();
    sink.begin("M1");
    sink.finish("M1", rec("M1"));
    expect(log).toEqual(["M1"]);
  });
});

describe("OrderedCommit: the stop rule", () => {
  test("a latch keeps the finished mutants before the latcher and the latcher; discards the rest, in flight or finished", () => {
    const { commit, latch, log, rec } = setup();
    const [a, b, c] = [commit.laneSink().sink, commit.laneSink().sink, commit.laneSink().sink];
    for (const [s, m] of [
      [a, "M0"],
      [b, "M1"],
      [c, "M2"],
    ] as const) {
      s.begin(m);
    }
    b.finish("M1", rec("M1")); // clean, but M0 (in flight) is before it: waits
    c.begin("M3");
    c.begin("M4");
    c.finish("M4", rec("M4")); // clean and finished, but AFTER the latcher in manifest order
    latch.value = { mutantId: "M2", why: "batchBlind: a Sleep line is not in v3's coverage" };
    a.finish("M0", rec("M0")); // finishes after the latch: it could have read the latch: discarded
    expect(commit.closed).toBe(true);
    // M1 finished before the latch and comes before M2: kept now (M0 will never be recorded).
    expect(log).toEqual(["M1"]);
    c.finish("M2", rec("M2")); // the latcher: kept, as N = 1 records it
    expect(log).toEqual(["M1", "M2"]);
    expect(() => commit.conclude()).toThrow(ParallelStopError);
    try {
      commit.conclude();
    } catch (e) {
      const err = e as ParallelStopError;
      // M0 finished after the latch, M3 was still running, M4 finished but is after M2: none recorded.
      expect(err.discarded).toEqual(["M0", "M3", "M4"]);
      expect(err.message).toContain("M0, M3, M4");
      expect(err.message).toContain("batchBlind");
      expect(err.message).toContain("--workers 3");
    }
  });

  test("a throw before the record keeps the finished mutants before it, and not the thrower", () => {
    const { commit, log, rec } = setup();
    const [a, b, c] = [commit.laneSink(), commit.laneSink(), commit.laneSink()];
    a.sink.begin("M0");
    b.sink.begin("M1");
    c.sink.begin("M2");
    c.sink.begin("M3");
    c.sink.finish("M3", rec("M3")); // finished clean but after the thrower: discarded
    b.sink.finish("M1", rec("M1")); // waits for M0
    const err = new Error(
      "al-runner-v3: refusing to start v3: an .al file changed after the alc proof",
    );
    commit.fail(a.current(), err); // M0's lane throws
    // M0 is the thrower (index 0): nothing before it, and it was never recorded.
    expect(log).toEqual([]);
    expect(() => commit.conclude()).toThrow(/an \.al file changed after the alc proof/);
  });

  test("a throw in the middle: finished mutants before it are kept (even past a hole), higher ones are not", () => {
    const { commit, log, rec } = setup();
    const lanes = [commit.laneSink(), commit.laneSink(), commit.laneSink()];
    const [a, b, c] = lanes;
    if (a === undefined || b === undefined || c === undefined) throw new Error("lanes");
    a.sink.begin("M0"); // in flight when the stop comes: discarded
    b.sink.begin("M1");
    b.sink.finish("M1", rec("M1"));
    c.sink.begin("M3");
    c.sink.finish("M3", rec("M3")); // after the thrower
    b.sink.begin("M2");
    commit.fail(b.current(), new Error("selection")); // M2 throws before its record
    expect(log).toEqual(["M1"]);
    a.sink.finish("M0", rec("M0")); // late: discarded
    expect(log).toEqual(["M1"]);
    try {
      commit.conclude();
      throw new Error("conclude did not throw");
    } catch (e) {
      expect((e as ParallelStopError).discarded).toEqual(["M0", "M2", "M3"]);
    }
  });

  test("a throw AFTER the record keeps the thrower itself and drops what finished after it", () => {
    const { commit, log, rec } = setup();
    const [a, b] = [commit.laneSink().sink, commit.laneSink().sink];
    a.begin("M0");
    a.finish("M0", rec("M0"));
    b.begin("M3");
    b.finish("M3", rec("M3")); // buffered behind the hole at M1, M2
    a.begin("M1");
    a.finish("M1", rec("M1"));
    a.begin("M2");
    a.finish("M2", rec("M2"), new Error("backend transport error: two consecutive run() failures"));
    expect(log).toEqual(["M0", "M1", "M2"]);
    expect(() => commit.conclude()).toThrow(/two consecutive run\(\) failures/);
  });

  test("the session's safety break is N = 1's own: kept up to the mutant, and conclude does not throw", () => {
    const { commit, log, rec } = setup();
    const [a, b] = [commit.laneSink().sink, commit.laneSink().sink];
    a.begin("M0");
    b.begin("M1");
    b.finish("M1", rec("M1"));
    a.finish("M0", rec("M0"));
    a.unsafeBreak("M0");
    b.begin("M2");
    b.finish("M2", rec("M2")); // after the break: discarded
    expect(log).toEqual(["M0", "M1"]);
    expect(() => commit.conclude()).not.toThrow();
  });

  test("a second cause is named, not lost", () => {
    const { commit } = setup();
    const [a, b] = [commit.laneSink(), commit.laneSink()];
    a.sink.begin("M0");
    b.sink.begin("M1");
    commit.fail(a.current(), new Error("first cause"));
    commit.fail(b.current(), new Error("second cause"));
    try {
      commit.conclude();
      throw new Error("conclude did not throw");
    } catch (e) {
      const err = e as ParallelStopError;
      expect(err.message).toContain("first cause");
      expect(err.message).toContain("Also seen: Error: second cause");
    }
  });

  test("a latch is the cause even when its mutant then throws before its record", () => {
    const { commit, latch } = setup();
    const a = commit.laneSink();
    a.sink.begin("M1");
    latch.value = { mutantId: "M1", why: "entriesRefused: scripted" };
    commit.fail(a.current(), new Error("the latcher then threw"));
    try {
      commit.conclude();
      throw new Error("conclude did not throw");
    } catch (e) {
      const msg = (e as ParallelStopError).message;
      expect(msg).toContain("the batch latched on M1: entriesRefused: scripted");
      expect(msg).toContain("Also seen: Error: the latcher then threw");
    }
  });

  test("an error that closes the latch stop in finish() is named once, not again by fail()", () => {
    const { commit, latch, rec } = setup();
    const a = commit.laneSink();
    a.sink.begin("M0");
    latch.value = { mutantId: "M0", why: "batchBlind: scripted" };
    const err = new Error("transport abort");
    a.sink.finish("M0", rec("M0"), err);
    commit.fail(a.current(), err);
    try {
      commit.conclude();
      throw new Error("conclude did not throw");
    } catch (e) {
      const msg = (e as ParallelStopError).message;
      expect(msg.split("transport abort").length - 1).toBe(1);
    }
  });
});

describe("OrderedCommit: a session with no stop must have recorded every mutant", () => {
  test("a mutant that never finished makes conclude() throw by name, naming it", () => {
    const { commit, rec } = setup();
    const a = commit.laneSink().sink;
    for (const c of CODES) if (c !== "M2") commit.markDone(c);
    a.begin("M0"); // never finishes
    expect(() => commit.conclude()).toThrow(/never finished or recorded: M2/);
  });

  test("all recorded: conclude() is quiet", () => {
    const { commit, rec } = setup();
    const a = commit.laneSink().sink;
    for (const c of CODES) {
      a.begin(c);
      a.finish(c, rec(c));
    }
    expect(() => commit.conclude()).not.toThrow();
  });
});

describe("runScopeQueue: the pull queue", () => {
  const ticks = async (n: number) => {
    for (let i = 0; i < n; i++) await new Promise<void>((r) => setImmediate(r));
  };
  const unitsOf = (n: number) =>
    Array.from({ length: n }, (_, i) => [{ mutantId: `U${String(i).padStart(2, "0")}` }]);

  test("each unit is handed out exactly once, whichever lane is quick", async () => {
    const units = unitsOf(24);
    const codes = units.flat().map((m) => m.mutantId);
    const commit = new OrderedCommit(codes, () => undefined, 4);
    const handed = new Map<string, number[]>();
    await runScopeQueue({
      units,
      lanes: 4,
      mayStart: () => true,
      commit,
      isUnsafe: () => false,
      runUnit: async (lane, unit, sink) => {
        for (const m of unit) {
          handed.set(m.mutantId, [...(handed.get(m.mutantId) ?? []), lane]);
          sink.begin(m.mutantId);
          await ticks((m.mutantId.charCodeAt(2) + lane) % 5);
          sink.finish(m.mutantId, () => {});
        }
      },
    });
    expect([...handed.keys()].sort()).toEqual(codes);
    for (const lanes of handed.values()) expect(lanes).toHaveLength(1);
    expect(commit.committedCodes).toEqual(codes);
  });

  test("a lane held back by the memory check does not start; the others finish the queue", async () => {
    const units = unitsOf(6);
    const commit = new OrderedCommit(
      units.flat().map((m) => m.mutantId),
      () => undefined,
      3,
    );
    const used = new Set<number>();
    const asked: number[] = [];
    await runScopeQueue({
      units,
      lanes: 3,
      mayStart: (k) => {
        asked.push(k);
        return false;
      },
      commit,
      isUnsafe: () => false,
      runUnit: async (lane, unit, sink) => {
        used.add(lane);
        for (const m of unit) {
          sink.begin(m.mutantId);
          await ticks(1);
          sink.finish(m.mutantId, () => {});
        }
      },
    });
    expect(asked).toEqual([1, 2]); // lane 0 is never asked
    expect([...used]).toEqual([0]);
    expect(commit.committedCodes).toHaveLength(6);
  });

  test("once the queue closes no further unit is handed out, and the stop is thrown after every lane ended", async () => {
    const units = unitsOf(10);
    const commit = new OrderedCommit(
      units.flat().map((m) => m.mutantId),
      () => undefined,
      2,
    );
    const handed: string[] = [];
    const ended: number[] = [];
    const run = runScopeQueue({
      units,
      lanes: 2,
      mayStart: () => true,
      commit,
      isUnsafe: () => false,
      runUnit: async (lane, unit, sink) => {
        for (const m of unit) {
          handed.push(m.mutantId);
          sink.begin(m.mutantId);
          await ticks(lane === 0 ? 1 : 4);
          if (lane === 0) throw new Error("lane 0 hit a stop");
          sink.finish(m.mutantId, () => {});
        }
        ended.push(lane);
      },
    });
    await expect(run).rejects.toThrow(ParallelStopError);
    // Each lane took one unit before the close; neither took a second.
    expect(handed).toHaveLength(2);
    expect(ended).toEqual([1]);
  });
});

// R785: `--workers N` is an upper bound; an extra lane starts only while the queued live work is longer
// than lane 0's warm-up. A fake clock that only lane 0 moves (COST ms per live mutant): call counters
// and ids, never wall-clock time.
describe("runScopeQueue: R785 lanes start by the queued live work", () => {
  const ticks = async (n: number) => {
    for (let i = 0; i < n; i++) await new Promise<void>((r) => setImmediate(r));
  };
  const COST = 100;
  /** `live[i]` = live mutants of unit i (0 = prefetched, about 0 ms). */
  async function run(o: {
    live: number[];
    lanes: number;
    warm: number;
    mayStart?: boolean;
    /** Unit indexes during which lane 0 restarts its daemon (epoch moves, the clock jumps 5000). */
    restarts?: number[];
    /** The clock moves this much per live mutant on lanes above 0 (default 0). */
    otherMs?: number;
    /** isUnsafe turns true once this many units have finished (the flag only: the run then rejects). */
    unsafeAfter?: number;
    /** After this many units the lane ends the commit with `unsafeBreak`, as the loop's safety break does. */
    breakAfter?: number;
    /** Event-loop turns a lane-0 mutant takes (others take 1). */
    slow0?: number;
  }) {
    const units = o.live.map((n, i) =>
      Array.from({ length: Math.max(n, 1) }, (_, j) => ({
        mutantId: `U${String(i).padStart(3, "0")}.${j}`,
        live: n > 0,
      })),
    );
    const codes = units.flat().map((m) => m.mutantId);
    const commit = new OrderedCommit(codes, () => undefined, o.lanes);
    let clock = 0;
    let finished = 0;
    const finishedAtAsk: number[] = [];
    const used = new Set<number>();
    let epoch = 0;
    const res = await runScopeQueue({
      units,
      lanes: o.lanes,
      mayStart: (k) => {
        finishedAtAsk.push(finished);
        return o.mayStart ?? k > 0;
      },
      commit,
      isUnsafe: () => o.unsafeAfter !== undefined && finished >= o.unsafeAfter,
      pace: {
        warmupMs: () => o.warm,
        weight: (u) => u.filter((m) => m.live).length,
        now: () => clock,
        epoch: () => epoch,
      },
      runUnit: async (lane, unit, sink) => {
        used.add(lane);
        const idx = Number(unit[0]?.mutantId.slice(1, 4));
        if (lane === 0 && o.restarts?.includes(idx)) {
          epoch += 1;
          clock += 5000;
        }
        for (const m of unit) {
          sink.begin(m.mutantId);
          if (m.live) clock += lane === 0 ? COST : (o.otherMs ?? 0);
          await ticks(lane === 0 ? (o.slow0 ?? 1) : 1);
          sink.finish(m.mutantId, () => {});
          if (o.breakAfter !== undefined && finished + 1 >= o.breakAfter) {
            finished += 1;
            sink.unsafeBreak(m.mutantId); // the loop's safety `break`
            return;
          }
        }
        finished += 1;
      },
    }).catch((e: unknown) => {
      // An unsafe flag with no break leaves mutants unfinished: the queue refuses to read green.
      if (o.unsafeAfter === undefined) throw e;
      return { started: -1, warmupMs: 0, reason: "closed" as const };
    });
    if (o.unsafeAfter === undefined && o.breakAfter === undefined)
      expect(commit.committedCodes).toEqual(codes); // all recorded, in manifest order
    return { ...res, used, finishedAtAsk };
  }

  test("(a) short queued work: no extra lane starts", async () => {
    // 1 + 2 queued units x 100 ms = 200 ms is under a 1000 ms warm-up.
    const r = await run({ live: [1, 1, 1], lanes: 4, warm: 1000 });
    expect(r.started).toBe(1);
    expect([...r.used]).toEqual([0]);
  });

  test("(b) long queued work: an extra lane starts, and more while work remains; none at queue start", async () => {
    const r = await run({ live: Array(60).fill(1), lanes: 4, warm: 1000 });
    expect(r.started).toBe(4);
    expect(r.used.size).toBe(4);
    // Every start was asked only after a unit had finished (the cost was known).
    expect(Math.min(...r.finishedAtAsk)).toBeGreaterThanOrEqual(1);
  });

  test("(c) never past N, never past the memory hold", async () => {
    const two = await run({ live: Array(60).fill(1), lanes: 2, warm: 1000 });
    expect(two.started).toBe(2);
    const held = await run({ live: Array(60).fill(1), lanes: 4, warm: 1000, mayStart: false });
    expect(held.started).toBe(1);
    expect(held.finishedAtAsk).toHaveLength(1); // asked once, then it stays at the lanes it has
  });

  test("(d) units with no live work (prefetched) do not count", async () => {
    const live = Array<number>(60).fill(0);
    live[0] = 1;
    live[1] = 1;
    const r = await run({ live, lanes: 4, warm: 1000 });
    expect(r.started).toBe(1); // 58 queued units, but only a little live work
    // The control: the same 60 units, all live, do spread.
    expect((await run({ live: Array(60).fill(1), lanes: 4, warm: 1000 })).started).toBeGreaterThan(
      1,
    );
  });

  test("(e) N = 1 is unchanged: one lane, no start decision", async () => {
    const r = await run({ live: Array(60).fill(1), lanes: 1, warm: 1000 });
    expect(r.started).toBe(1);
    expect(r.finishedAtAsk).toEqual([]);
  });

  test("(i) every unit prefetched (weight 0): no cost, one lane, never a NaN start", async () => {
    const r = await run({ live: Array(20).fill(0), lanes: 4, warm: 1000 });
    expect(r.started).toBe(1);
    expect(r.finishedAtAsk).toEqual([]);
    expect(r.reason).toBe("unmeasured");
  });

  test("(ii) a warm-up that is not measured (0): no extra lane", async () => {
    const r = await run({ live: Array(60).fill(1), lanes: 4, warm: 0 });
    expect(r.started).toBe(1);
    expect(r.reason).toBe("unmeasured");
  });

  test("(iii) only lane 0's units feed the cost", async () => {
    // Lane 0 is slow; the other lanes finish many units at no clock time. Fed in, they would pull the
    // cost down and stop the ramp at 3 lanes. Lane 0 alone: 16 queued units spread over all 4.
    const r = await run({ live: Array(16).fill(1), lanes: 4, warm: 1000, slow0: 6 });
    expect(r.started).toBe(4);
  });

  test("(iv) the rule follows the queue as it drains: a medium queue starts some lanes, not all", async () => {
    const r = await run({ live: Array(13).fill(1), lanes: 4, warm: 1000 });
    expect(r.started).toBe(2);
    expect(r.reason).toBe("cost");
  });

  test("(v) a closed queue or an unsafe session asks no mayStart and starts no lane", async () => {
    // The unsafe flag alone (no break yet): the queue hands out nothing more and starts no lane.
    const unsafe = await run({ live: Array(60).fill(1), lanes: 4, warm: 1000, unsafeAfter: 1 });
    expect(unsafe.finishedAtAsk).toEqual([]);
    expect([...unsafe.used]).toEqual([0]);
    // A closed commit (the loop's safety break), the unsafe flag still false.
    const closed = await run({ live: Array(60).fill(1), lanes: 4, warm: 1000, breakAfter: 1 });
    expect(closed.finishedAtAsk).toEqual([]);
    expect(closed.started).toBe(1);
    expect(closed.reason).toBe("closed");
  });

  test("(vii) the boundary: queued work equal to one warm-up starts no lane", async () => {
    // After unit 0, 10 units x 100 ms = 1000 ms = the warm-up: not longer, so no start. One more unit starts one.
    const eq = await run({ live: Array(11).fill(1), lanes: 4, warm: 1000 });
    expect(eq.started).toBe(1);
    const over = await run({ live: Array(12).fill(1), lanes: 4, warm: 1000 });
    expect(over.started).toBeGreaterThan(1);
  });

  test("(viii) a lane-0 unit that restarted its daemon gives no cost (it carries a warm-up)", async () => {
    // Unit 0 restarts lane 0 (+5000 ms on the clock). Counted, its cost would be 5100 ms per mutant
    // and the 5 queued units would start a lane; skipped, the next unit's 100 ms keeps one lane.
    const r = await run({ live: Array(6).fill(1), lanes: 4, warm: 1000, restarts: [0] });
    expect(r.started).toBe(1);
    expect(r.reason).toBe("cost");
  });

  test("the notice names the reason that ended the starts", () => {
    const t = (reason: LaneReason, started = 2, cap = 4) =>
      lanesNotice(started, 4, cap, reason, 7100);
    expect(t("cap")).toBe(
      "2 of 4 lanes started: all asked lanes started: queued live work stayed longer than one warm-up (lane 0's warm-up 7.1 s)",
    );
    expect(t("cap", 2, 2)).toContain("memory allowed only 2 lanes and all of them started");
    expect(t("memory")).toContain("the memory hold refused the next lane");
    expect(t("cost")).toContain("the queued live work was not longer than one warm-up");
    expect(t("drained")).toContain("the queue had no live work left");
    expect(t("closed")).toContain("the queue closed (a stop or an unsafe session)");
    expect(t("unmeasured")).toContain("no lane 0 live unit finished with a measured warm-up");
  });

  test("the reason is memory when the hold refuses, and cost survives a drained queue", async () => {
    const held = await run({ live: Array(60).fill(1), lanes: 4, warm: 1000, mayStart: false });
    expect(held.reason).toBe("memory");
    const short = await run({ live: [1, 1, 1], lanes: 4, warm: 1000 });
    expect(short.reason).toBe("cost"); // the queue then drained, but cost was the cause
  });
});
