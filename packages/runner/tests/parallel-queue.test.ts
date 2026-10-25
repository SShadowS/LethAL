// R766 step (b): the ordered commit, the stop rule and the pull queue of `--workers N` on al-runner v3.
// Pure fakes: the "lanes" are scripted calls, so the order of events is the test's, never a clock's.
import { describe, expect, test } from "bun:test";
import { type Latch, OrderedCommit, ParallelStopError, runScopeQueue } from "../src/parallel-queue";

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
