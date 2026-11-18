// PR-151: the split queue hands units out with no window barrier and a bounded look-ahead.
// Deterministic fakes (gates a test opens by hand, event-loop turns), never the wall clock.
import { describe, expect, test } from "bun:test";
import {
  type LaneSink,
  OrderedCommit,
  ParallelStopError,
  runScopeQueue,
} from "../src/parallel-queue";

type U = { readonly mutantId: string };
const ticks = async (n = 5) => {
  for (let i = 0; i < n; i++) await new Promise<void>((r) => setImmediate(r));
};
const gate = () => {
  let open!: () => void;
  const p = new Promise<void>((r) => {
    open = r;
  });
  return { p, open };
};

/** One unit per code `M<i>`; `windows[i]` is its window. */
function rig(
  windows: readonly number[],
  lanes: number,
  o: {
    body: (id: string, sink: LaneSink, k: number) => Promise<void>;
    budgetSpent?: () => boolean;
    isUnsafe?: () => boolean;
    split?: ReturnType<typeof splitHarness>;
  },
) {
  const codes = windows.map((_, i) => `M${i}`);
  const recorded: string[] = [];
  const log: string[] = [];
  const commit = new OrderedCommit(codes, () => undefined, lanes);
  const units: U[][] = codes.map((c) => [{ mutantId: c }]);
  const done = runScopeQueue({
    units,
    lanes,
    mayStart: () => true,
    commit,
    isUnsafe: o.isUnsafe ?? (() => false),
    lookAhead: {
      windowOf: (u) => windows[Number((u[0]?.mutantId ?? "M0").slice(1))] ?? 0,
      budgetSpent: o.budgetSpent ?? (() => false),
    },
    ...(o.split !== undefined ? { split: o.split.split } : {}),
    runUnit: async (k, unit, sink) => {
      const id = unit[0]?.mutantId ?? "";
      sink.begin(id);
      log.push(`take ${k} ${id}`);
      await o.body(id, sink, k);
      sink.finish(id, () => void recorded.push(id));
    },
  });
  return { done, commit, recorded, log, codes };
}

function splitHarness() {
  const launched: number[] = [];
  const ended: number[] = [];
  return {
    launched,
    ended,
    split: {
      barrierPassed: () => true,
      measured: () => true,
      watch: () => () => {},
      onLaunch: (k: number) => void launched.push(k),
      onEnd: (k: number) => void ended.push(k),
    },
  };
}

describe("PR-151: no window barrier", () => {
  test("1: lane 1 takes window 1's unit while lane 0 is still busy in window 0", async () => {
    const hold = gate();
    const r = rig([0, 0, 1], 2, { body: (id) => (id === "M0" ? hold.p : Promise.resolve()) });
    await ticks();
    // red with a barrier-like bound (window <= oldest window): M2 waits for M0
    expect(r.log).toContain("take 1 M2");
    hold.open();
    await r.done;
    expect(r.recorded).toEqual(["M0", "M1", "M2"]);
  });

  test("2 and 5: no unit of window 2 is taken until window 0 is finished; the waiting lane resumes and is not ended", async () => {
    const hold = gate();
    const h = splitHarness();
    const r = rig([0, 0, 1, 2], 2, {
      split: h,
      body: (id) => (id === "M0" ? hold.p : Promise.resolve()),
    });
    await ticks();
    expect(r.log).toContain("take 1 M2"); // window 1: inside the bound
    // red without the bound: M3 (window 2) was taken while window 0's unit was still busy
    expect(r.log).not.toContain("take 1 M3");
    expect(h.ended).toEqual([]); // lane 1 waits: it is not drained
    hold.open();
    await r.done;
    expect(r.log.some((l) => /^take \d M3$/.test(l))).toBe(true);
    expect(r.recorded).toEqual(["M0", "M1", "M2", "M3"]);
    expect(h.ended).toEqual([1]);
  });
});

describe("PR-151: the commit order across windows", () => {
  test("3a: a later window's result waits for an earlier one; records come in manifest order", async () => {
    const hold = gate();
    const r = rig([0, 1], 2, { body: (id) => (id === "M0" ? hold.p : Promise.resolve()) });
    await ticks();
    expect(r.recorded).toEqual([]); // M1 finished first but waits for M0
    hold.open();
    await r.done;
    expect(r.recorded).toEqual(["M0", "M1"]);
  });

  test("3b: a stop in window 1 keeps the finished window-0 result and drops what follows the stopping mutant", async () => {
    const hold = gate();
    const r = rig([0, 1, 1], 2, {
      body: async (id) => {
        if (id === "M1") {
          await hold.p;
          throw new Error("boom");
        }
      },
    });
    await ticks(); // M0 recorded, M2 finished and waiting behind M1
    hold.open();
    const err = await r.done.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ParallelStopError);
    expect(r.commit.committedCodes).toEqual(["M0"]);
    expect(r.recorded).toEqual(["M0"]);
  });
});

describe("PR-151: the budget at the unit edge", () => {
  test("4: once spent, no unit is taken; units in flight finish and are recorded; the rest count as unrecorded", async () => {
    const hold = gate();
    let spent = false;
    const r = rig([0, 0, 0, 0], 2, {
      budgetSpent: () => spent,
      body: async (id) => {
        if (id === "M0") await hold.p;
        else if (id === "M1") spent = true; // M0 and M1 are in flight when the budget runs out
      },
    });
    await ticks();
    hold.open();
    await r.done; // no throw
    expect(r.commit.stoppedByGuard).toBe(true);
    expect(r.log.filter((l) => /M[23]$/.test(l))).toEqual([]);
    expect(r.recorded).toEqual(["M0", "M1"]);
    expect(r.commit.unrecorded(r.codes)).toEqual(["M2", "M3"]);
  });

  test("7 (F1): one lane, budget spent between two units: no throw, the first is recorded, the second is counted", async () => {
    let spent = false;
    const r = rig([0, 0], 1, {
      budgetSpent: () => spent,
      body: async (id) => {
        if (id === "M0") spent = true;
      },
    });
    // red without the unit-edge close: conclude() throws "never finished or recorded" (R766)
    await r.done;
    expect(r.recorded).toEqual(["M0"]);
    expect(r.commit.stoppedByGuard).toBe(true);
    expect(r.commit.unrecorded(r.codes)).toEqual(["M1"]);
  });
});

describe("PR-151: a lane that waits cannot wait forever", () => {
  const hangs = (p: Promise<unknown>) =>
    Promise.race([p.then(() => "done").catch(() => "done"), ticks(40).then(() => "hang")]);

  test("8a (F2): a lane throws while another waits on the bound: ParallelStopError, not a hang", async () => {
    const hold = gate();
    const r = rig([0, 0, 2], 2, {
      body: async (id) => {
        if (id === "M0") {
          await hold.p;
          throw new Error("boom");
        }
      },
    });
    await ticks(); // lane 1 finished M1 and now waits for M2
    expect(r.log).not.toContain("take 1 M2");
    hold.open();
    // red without the wake in the unit's finally: lane 1 sleeps for ever
    expect(await hangs(r.done)).toBe("done");
    expect(await r.done.catch((e: unknown) => e)).toBeInstanceOf(ParallelStopError);
  });

  test("8b (F2): the unsafe latch while another lane waits ends the session, not a hang", async () => {
    const hold = gate();
    let unsafe = false;
    const r = rig([0, 0, 2], 2, {
      isUnsafe: () => unsafe,
      body: async (id, sink) => {
        if (id === "M0") {
          await hold.p;
          unsafe = true;
          sink.unsafeBreak(id);
        }
      },
    });
    await ticks();
    hold.open();
    expect(await hangs(r.done)).toBe("done");
    expect(r.log).not.toContain("take 1 M2");
  });
});

describe("PR-151 F6: lane launching", () => {
  test("9: no lane is launched while the next unit is beyond the bound; it is when the bound moves", async () => {
    const hold = gate();
    const h = splitHarness();
    const r = rig([0, 2], 3, {
      split: h,
      body: (id) => (id === "M0" ? hold.p : Promise.resolve()),
    });
    await ticks();
    // red without the bound in tryLaunch: lane 1 launches and only waits
    expect(h.launched).toEqual([]);
    hold.open();
    await r.done;
    expect(r.recorded).toEqual(["M0", "M1"]);
  });
});
