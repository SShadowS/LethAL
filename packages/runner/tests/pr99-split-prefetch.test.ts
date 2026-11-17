// PR-99 (spec 2026-11-16-pr96-split-prefetch, r4): the prefetch is split across the lanes. Each lane prefetches
// the unit it takes, on its own daemon, with its own prefetch record and its own counters. These tests use the
// lane rig (a scripted serve daemon per spawn) and call counters, never a clock.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { AlRunnerV3ServeFallbackWarmupError, type V3KeptDrift } from "../src/al-runner-v3-backend";
import { AlRunnerV3EntriesRefusedError } from "../src/al-runner-v3-entries";
import type { RunOpts, TestMethodRef, TestVerdict } from "../src/backend";
import { OrderedCommit, runScopeQueue } from "../src/parallel-queue";
import {
  A,
  B,
  CU,
  type FakeRow,
  type LanesRig,
  OPTS,
  type RowsFn,
  SUITE,
  allPass,
  cleanRigs,
  laneBaseline,
  lanesRig,
  ref,
} from "./helpers/v3-lanes-rig";

afterEach(cleanRigs);

const ALL = ["M0001", "M0002", "M0003", "M0004", "M0005", "M0006"];
const plans = (ids: readonly string[], refs = SUITE) => ids.map((mutantId) => ({ mutantId, refs }));
const failing = (rows: FakeRow[], method: string, message: string): FakeRow[] =>
  rows.map((r) => (r.method === method ? { ...r, status: "fail" as const, message } : r));
const UNLISTED = "NotRun: out-of-scope: the install baseline read resource active-mutant.txt";
const KEPT = "NotRun: out-of-scope: conversion of Blob to Integer";
const refusedRow = (x: FakeRow, message = UNLISTED): FakeRow => ({
  ...x,
  status: "error",
  notRun: true,
  message,
});
const GiB = 2 ** 30;

/** The private shape the tests read. */
interface PrivLane {
  readonly index: number;
  pair: unknown;
  readonly prefetch: {
    prefetched: Map<string, Map<number, unknown>>;
    timedOutMutants: Map<string, Set<string>>;
    pairStore: Map<string, unknown>;
    remainingMs: (() => number) | undefined;
  };
  readonly stats: Record<string, number>;
  daemonFor(mode: unknown): { proven?: Set<number>; keptRefusal?: unknown } | undefined;
}
const laneOf = (r: LanesRig, i: number): PrivLane => {
  const l = (r.b as unknown as { laneList: PrivLane[] }).laneList[i];
  if (l === undefined) throw new Error(`no lane ${i}`);
  return l;
};
const view = (r: LanesRig, i: number) => {
  const v = r.views[i];
  if (v === undefined) throw new Error(`no view ${i}`);
  return v;
};
/** The orchestrator's baseline step at N = 1: the backend is its own (only) lane. */
async function soleBaseline(r: LanesRig): Promise<void> {
  r.b.baselinePhase(true);
  try {
    await r.b.activate(null);
    for (const t of SUITE) await r.b.run(t, OPTS);
  } finally {
    r.b.baselinePhase(false);
  }
}
const requestsOf = (r: LanesRig, active: string) =>
  r.serve.requests.filter((q) => q.active.endsWith(active));

describe("PR-99 spec 7.1: N = 1 is unchanged", () => {
  test("the owner prefetches the window on its only lane; no lane counter of the split moves", async () => {
    const r = await lanesRig({ lanes: 0 });
    await soleBaseline(r);
    await r.b.prefetchMutants(plans(["M0001", "M0002"]), { batchPlans: plans(ALL) });
    // every prefetch request is on lane 0's tree
    expect(r.serve.requests.every((q) => q.active.endsWith("/active"))).toBe(true);
    const s = r.b.entriesStats();
    expect(s.prefetchRequests).toBe(1);
    expect(s.unitsPrefetched).toBe(0); // a unit is a split notion
    // N = 1 keeps the 256-entry chunk rule: `size` counts, `ran` can be reset
    const batch = (r.b as unknown as { prefetchBatch: { size: number; ran: boolean } })
      .prefetchBatch;
    expect(batch.size).toBeGreaterThan(0);
    expect(batch.ran).toBe(true);
  });
});

describe("PR-99 spec 7.2/7.3: each lane prefetches its own unit; the record is the lane's", () => {
  const stateRig = async () => {
    const rows: RowsFn = (m) =>
      m === "M0001" || m === "M0002"
        ? failing(allPass(m, 0, 0, 0), "A", "boom")
        : allPass(m, 0, 0, 0);
    const r = await lanesRig({ lanes: 3, rows, pairBatch: true });
    await laneBaseline(r);
    r.b.prepareBatch(plans(ALL));
    const l0 = laneOf(r, 0);
    await view(r, 0).prefetchMutants?.(plans(["M0001"]));
    // lane 0 holds a record of every kind
    l0.prefetch.timedOutMutants.set("M0001", new Set(["codeunit79100.a"]));
    const clamp = () => 5000;
    l0.prefetch.remainingMs = clamp;
    const pending = { mutantId: "M0001", next: "null" };
    l0.pair = pending;
    const snap = {
      prefetched: [...l0.prefetch.prefetched.keys()],
      pairStore: [...l0.prefetch.pairStore.keys()],
      stats: { ...l0.stats },
    };
    expect(snap.prefetched).toEqual(["M0001"]);
    expect(snap.pairStore).toHaveLength(1);
    await view(r, 1).prefetchMutants?.(plans(["M0002"]), { remainingMs: () => 7000 });
    return { r, l0, l1: laneOf(r, 1), clamp, pending, snap };
  };

  test("lane B's unit prefetch leaves lane A's `prefetched` unchanged", async () => {
    const { l0, l1, snap } = await stateRig();
    expect([...l0.prefetch.prefetched.keys()]).toEqual(snap.prefetched);
    expect([...l1.prefetch.prefetched.keys()]).toEqual(["M0002"]);
  });

  test("... `timedOutMutants`", async () => {
    const { l0, l1 } = await stateRig();
    expect([...(l0.prefetch.timedOutMutants.get("M0001") ?? [])]).toEqual(["codeunit79100.a"]);
    expect(l1.prefetch.timedOutMutants.size).toBe(0);
  });

  test("... `pairStore`", async () => {
    const { l0, l1, snap } = await stateRig();
    expect([...l0.prefetch.pairStore.keys()]).toEqual(snap.pairStore);
    expect([...l1.prefetch.pairStore.keys()].every((k) => k.endsWith("|M0002"))).toBe(true);
    expect(l1.prefetch.pairStore.size).toBe(1);
  });

  test("... the pending pair", async () => {
    const { l0, pending } = await stateRig();
    expect(l0.pair).toBe(pending);
  });

  test("... the R912 clamp (lane B's is its own and ends with its prefetch)", async () => {
    const { l0, l1, clamp } = await stateRig();
    expect(l0.prefetch.remainingMs).toBe(clamp);
    expect(l1.prefetch.remainingMs).toBeUndefined();
  });

  test("... the counters; and the lane that sent a request is the one that counts it", async () => {
    const { r, l0, l1, snap } = await stateRig();
    expect(l0.stats).toEqual(snap.stats);
    expect(l1.stats.prefetchRequests).toBe(1);
    expect(l1.stats.unitsPrefetched).toBe(1);
    expect(l0.stats.unitsPrefetched).toBe(1);
    expect(r.b.entriesStats().unitsPrefetched).toBe(2);
    // lane 1's prefetch request is on lane 1's tree, with its own mutants only (and its kill pair's NONE)
    const mine = requestsOf(r, "/active.1").map((q) => q.mutants);
    expect(mine).toContainEqual(["M0002"]);
    expect(mine.flat().every((m) => m === "NONE" || m === "M0002")).toBe(true);
  });

  test("`cutState` and `restoreCutState` of the lane view read and write only that lane's record", async () => {
    const r = await lanesRig({ lanes: 3 });
    const v0 = view(r, 0);
    const v1 = view(r, 1);
    laneOf(r, 0).prefetch.timedOutMutants.set("M0001", new Set(["x"]));
    expect(v1.cutState?.("M0001")).toEqual(new Set());
    v1.restoreCutState?.("M0001", new Set(["y"]));
    expect(v0.cutState?.("M0001")).toEqual(new Set(["x"]));
    expect(laneOf(r, 1).prefetch.timedOutMutants.get("M0001")).toEqual(new Set(["y"]));
  });
});

describe("PR-99 coordinator (a): the totals sum EVERY lane", () => {
  test("a counter incremented on lane 2 only appears in the totals and in the stats line", async () => {
    const r = await lanesRig({ lanes: 3 });
    await laneBaseline(r);
    r.b.prepareBatch(plans(ALL));
    await view(r, 2).prefetchMutants?.(plans(["M0003"]));
    expect(laneOf(r, 2).stats.prefetchRequests).toBe(1);
    expect(laneOf(r, 0).stats.prefetchRequests).toBe(0);
    expect(laneOf(r, 1).stats.prefetchRequests).toBe(0);
    const s = r.b.entriesStats();
    expect(s.prefetchRequests).toBe(1);
    expect(s.unitsPrefetched).toBe(1);
    // R652's identity holds over the sums
    expect(s.boundChecks).toBe(
      s.warmups + s.prefetchRequests + s.liveRequests + s.coverageRequests,
    );
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      await r.b.close();
      const line = warn.mock.calls.map((c) => String(c[0])).find((t) => t.includes("(R635)")) ?? "";
      expect(line).toContain("prefetch 1 / live");
      expect(line).toContain("units prefetched 1, lazy proofs");
      expect(line).toContain("[lane 2: units prefetched 1,");
      expect(line).toContain("[lane 0: units prefetched 0,");
    } finally {
      warn.mockRestore();
    }
  });
});

/** Rows for the drift scenarios: a live request of M0001 leaves a kept refusal on its daemon; M0002 and M0003
 *  (covering B only) then drift on that daemon, and are `freshRefused` (or pass) on any other. */
const driftRows = (o: { freshRefused: boolean }) => {
  let armed: number | undefined;
  const rows: RowsFn = (m, cu, d, n) => {
    const base = allPass(m, cu, d, n);
    if (m === "M0001") {
      armed = d;
      return base.map((x) => (x.method === "A" ? refusedRow(x, KEPT) : x));
    }
    if (m === "M0002" || m === "M0003") {
      if (d === armed)
        return base.map((x) =>
          x.method === "A" ? { ...x, status: "fail" as const, message: "boom" } : x,
        );
      if (o.freshRefused) return base.map((x) => refusedRow(x));
    }
    return base;
  };
  const echo = (m: string, d: number): FakeRow =>
    o.freshRefused && (m === "M0002" || m === "M0003") && d !== armed
      ? { method: "Echo", status: "error", notRun: true, message: UNLISTED }
      : { method: "Echo", status: "fail", message: `LETHAL-ECHO:${m}:true` };
  return { rows, echo, pid: (d: number) => 4000 + d };
};
/** The batch of the drift scenarios: M0002 and M0003 cover B only (the drifting row, A, runs before it). */
const driftBatch = [
  ...plans(["M0001"]),
  ...plans(["M0002", "M0003"], [B]),
  ...plans(["M0004", "M0005", "M0006"]),
];

describe("PR-99 spec 7.3a: `prefetchBatch` is shared; at N > 1 `ran` is a latch", () => {
  const refusedRows = (refuse: ReadonlySet<string>) => ({
    rows: ((m, cu, d, n) =>
      refuse.has(m)
        ? allPass(m, cu, d, n).map((x) => refusedRow(x))
        : allPass(m, cu, d, n)) as RowsFn,
    echo: (m: string): FakeRow =>
      refuse.has(m)
        ? { method: "Echo", status: "error", notRun: true, message: UNLISTED }
        : { method: "Echo", status: "fail", message: `LETHAL-ECHO:${m}:true` },
  });
  const four = plans(ALL.slice(0, 4));

  const lane1Case = async (earlier: boolean) => {
    const r = await lanesRig({ lanes: 3, serve: refusedRows(new Set(["M0002", "M0003"])) });
    await laneBaseline(r);
    r.b.prepareBatch(four);
    if (earlier) await view(r, 0).prefetchMutants?.(plans(["M0001"]));
    const out = await view(r, 1)
      .prefetchMutants?.(plans(["M0002", "M0003"]))
      .then(() => "ran")
      .catch((e: unknown) => (e instanceof AlRunnerV3EntriesRefusedError ? "refused" : String(e)));
    return out ?? "no view";
  };
  const oneCase = async (earlier: boolean) => {
    const r = await lanesRig({ lanes: 0, serve: refusedRows(new Set(["M0002", "M0003"])) });
    await soleBaseline(r);
    if (earlier) await r.b.prefetchMutants(plans(["M0001"]), { batchPlans: four });
    return r.b
      .prefetchMutants(plans(["M0002", "M0003"]), earlier ? undefined : { batchPlans: four })
      .then(() => "ran")
      .catch((e: unknown) => (e instanceof AlRunnerV3EntriesRefusedError ? "refused" : String(e)));
  };

  test("a request on lane 1 after a prefetch entry ran on lane 0 never speaks for the batch", async () => {
    expect(await lane1Case(true)).toBe("ran");
  });

  test("... and with no entry run before it, the same request does speak (the other direction)", async () => {
    expect(await lane1Case(false)).toBe("refused");
  });

  test("the same request at N = 1 and at N = 3 gets the same judgement, in both directions", async () => {
    const [one, three] = [await oneCase(true), await lane1Case(true)];
    expect(one).toBe(three);
    const [oneFirst, threeFirst] = [await oneCase(false), await lane1Case(false)];
    expect(oneFirst).toBe(threeFirst);
  });

  test("at N > 1 `size` is unused and the 256-entry chunk rule never resets `ran`", async () => {
    const r = await lanesRig({ lanes: 3, serve: refusedRows(new Set(["M0002", "M0003"])) });
    await laneBaseline(r);
    r.b.prepareBatch(four);
    const batch = (r.b as unknown as { prefetchBatch: { size: number; ran: boolean } })
      .prefetchBatch;
    await view(r, 0).prefetchMutants?.(plans(["M0001"]));
    batch.size = 10_000; // far past the chunk cap: N = 1 would reset `ran` at the next request
    // lane 1's request is refused whole; were `ran` reset it would speak for the batch and stop the session
    await view(r, 1).prefetchMutants?.(plans(["M0002", "M0003"]));
    expect(batch.ran).toBe(true);
    expect(batch.size).toBe(10_000); // unused at N > 1
  });

  test("PR-56's restore never writes `ran` at N > 1 (its re-run is not a batch refusal), and does at N = 1", async () => {
    const run = async (lanes: 0 | 3): Promise<string> => {
      const r = await lanesRig({ lanes, serve: driftRows({ freshRefused: true }) });
      if (lanes === 0) await soleBaseline(r);
      else await laneBaseline(r);
      const target = lanes === 0 ? r.b : view(r, 1);
      const four2 = driftBatch.slice(0, 4);
      if (lanes === 0) await r.b.prefetchMutants([], { batchPlans: four2 });
      else r.b.prepareBatch(four2);
      // a live request leaves a kept refusal on this lane's daemon ...
      await target.activate("M0001");
      await target.run(A, OPTS);
      // ... so the first prefetch request drifts, is re-run on a fresh daemon whose rows are all refused
      const out = await target
        .prefetchMutants?.(plans(["M0002", "M0003"], [B]))
        .then(() => "ran")
        .catch((e: unknown) =>
          e instanceof AlRunnerV3EntriesRefusedError ? "refused" : String(e),
        );
      return out ?? "no prefetchMutants";
    };
    expect(await run(3)).toBe("ran");
    expect(await run(0)).toBe("refused");
  });
});

describe("PR-99 spec 7.4: a unit's kill pairs are served on the lane that scored the kill", () => {
  test("lane 1's own batch serves lane 1's kill with no request; lane 0 holds none", async () => {
    const rows: RowsFn = (m) =>
      m === "M0002" ? failing(allPass(m, 0, 0, 0), "A", "boom") : allPass(m, 0, 0, 0);
    const r = await lanesRig({ lanes: 3, rows, pairBatch: true });
    await laneBaseline(r);
    r.b.prepareBatch(plans(ALL));
    const v1 = view(r, 1);
    await v1.prefetchMutants?.(plans(["M0002"]));
    expect(laneOf(r, 1).stats.pairBatchStored).toBe(1);
    expect(laneOf(r, 0).prefetch.pairStore.size).toBe(0);
    await v1.activate("M0002");
    expect((await v1.run(A, OPTS)).outcome).toBe("fail");
    const n = r.serve.requests.length;
    await v1.sendKillPair("M0002", A);
    expect(r.serve.requests.length).toBe(n); // served from lane 1's store
    expect(laneOf(r, 1).stats.pairBatchServed).toBe(1);
    expect(laneOf(r, 0).stats.pairBatchServed).toBe(0);
  });
});

describe("PR-99 spec 7.5: the barrier, in the backend", () => {
  test("lane 0's first unit with no serve groups still starts lane 0's daemon and warms the union first", async () => {
    const r = await lanesRig({ lanes: 3 });
    await laneBaseline(r);
    r.b.prepareBatch(plans(ALL)); // the batch's union holds the serve codeunit
    (r.b as unknown as { oneShotCodeunits: Set<number> }).oneShotCodeunits = new Set([79101]);
    expect(r.b.barrierPassed()).toBe(false);
    const before = requestsOf(r, "/active").length;
    const oneShotOnly = [{ mutantId: "M0001", refs: [{ ...ref("A"), codeunitId: 79101 }] }];
    await view(r, 0).prefetchMutants?.(oneShotOnly);
    expect(r.b.barrierPassed()).toBe(true);
    expect(requestsOf(r, "/active").length).toBe(before + 1); // the warm-up: a NONE entry for the union
    expect(requestsOf(r, "/active").at(-1)?.mutants).toEqual(["NONE"]);
  });

  test("the barrier opens on lane 0's session-first warm-up, once, and tells the watcher", async () => {
    const r = await lanesRig({ lanes: 3 });
    await laneBaseline(r);
    r.b.prepareBatch(plans(ALL));
    let told = 0;
    r.b.watchLaneGate(() => {
      told += 1;
    });
    expect(r.b.barrierPassed()).toBe(false);
    await view(r, 0).prefetchMutants?.(plans(["M0001"]));
    expect(r.b.barrierPassed()).toBe(true);
    expect(told).toBeGreaterThan(0);
    const after = told;
    await view(r, 0).prefetchMutants?.(plans(["M0002"]));
    // a second unit on lane 0 opens nothing (the only event is a measured request, and the rig reads none)
    expect(told).toBe(after);
  });

  // R960 (spec 10.6): a flag, not a read of the (per-lane) counters.
  const refusingRig = async () => {
    let from = Number.POSITIVE_INFINITY;
    const rows: RowsFn = (m, cu, d, n) =>
      n >= from ? allPass(m, cu, d, n).map((x) => refusedRow(x)) : allPass(m, cu, d, n);
    const echo = (m: string, _d: number, n: number): FakeRow =>
      n >= from
        ? { method: "Echo", status: "error", notRun: true, message: UNLISTED }
        : { method: "Echo", status: "fail", message: `LETHAL-ECHO:${m}:true` };
    const r = await lanesRig({ lanes: 3, serve: { rows, echo } });
    (r.b as unknown as { cfg: { transportSource: string } }).cfg.transportSource = "default";
    await laneBaseline(r);
    r.b.prepareBatch(plans(ALL));
    return {
      r,
      refuseNow: () => {
        from = r.serve.requests.length;
      },
    };
  };

  test("R960's fallback still fires at lane 0's first warm-up (the barrier is not yet passed)", async () => {
    const { r, refuseNow } = await refusingRig();
    refuseNow();
    const err = await view(r, 0)
      .prefetchMutants?.(plans(["M0001"]))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AlRunnerV3ServeFallbackWarmupError);
  });

  test("N = 1 (build review #4): a first warm-up lost to a request error makes the next one a LATER warm-up, as on master", async () => {
    let refuse = false;
    let eofSent = false;
    const rows: RowsFn = (m, cu, d, n) =>
      refuse ? allPass(m, cu, d, n).map((x) => refusedRow(x)) : allPass(m, cu, d, n);
    const r = await lanesRig({
      lanes: 0,
      serve: {
        rows,
        echo: (m) =>
          refuse
            ? { method: "Echo", status: "error", notRun: true, message: UNLISTED }
            : { method: "Echo", status: "fail", message: `LETHAL-ECHO:${m}:true` },
        // the first request after the baseline (the first warm-up) dies: a server request error
        eofAt: () => {
          if (!refuse || eofSent) return false;
          eofSent = true;
          return true;
        },
      },
    });
    (r.b as unknown as { cfg: { transportSource: string } }).cfg.transportSource = "default";
    await soleBaseline(r);
    refuse = true;
    const first = await r.b.prefetchMutants(plans(["M0001"])).catch((e: unknown) => e);
    expect(eofSent).toBe(true);
    const err =
      first instanceof Error
        ? first
        : await r.b
            .activate("M0001")
            .then(() => r.b.run(A, OPTS))
            .catch((e: unknown) => e);
    expect(r.b.entriesStats()).toMatchObject({ warmups: 2, prefetchDropped: 1 });
    // red with `!firstWarmupDone` as the guard: the second warm-up takes R960's fallback (a session re-run)
    // instead of failing by name
    expect(err).not.toBeInstanceOf(AlRunnerV3ServeFallbackWarmupError);
    expect((err as TestVerdict).failureMessage).toContain("al-runner-v3-entries-batch-refused");
  });

  test("a lane >= 1 reaching startDaemon after the barrier passed, and after a deploy, never takes R960's path", async () => {
    const { r, refuseNow } = await refusingRig();
    await view(r, 0).prefetchMutants?.(plans(["M0001"])); // the session-first warm-up passes
    expect(r.b.barrierPassed()).toBe(true);
    await r.b.deploy(r.batch);
    await laneBaseline(r); // a new layout: baseline rows again; the flag is the session's, kept
    r.b.prepareBatch(plans(ALL));
    refuseNow();
    const err = await view(r, 1)
      .prefetchMutants?.(plans(["M0002"]))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AlRunnerV3EntriesRefusedError);
    expect(err).not.toBeInstanceOf(AlRunnerV3ServeFallbackWarmupError);
  });
});

describe("PR-99 spec 7.7: lazy start and the reservations", () => {
  test("a launched lane's first daemon is spawned restarted and proves lazily; an unlaunched lane warms the union", async () => {
    const r = await lanesRig({ lanes: 3 });
    await laneBaseline(r);
    r.b.prepareBatch(plans(ALL));
    await view(r, 0).prefetchMutants?.(plans(["M0001"]));
    const calls: string[] = [];
    const priv = r.b as unknown as Record<string, (...a: unknown[]) => unknown>;
    for (const name of ["startDaemon", "spawnRestarted"] as const) {
      const orig = priv[name]?.bind(r.b);
      if (orig === undefined) throw new Error(name);
      priv[name] = (...a: unknown[]) => {
        calls.push(`${name}:${(a[0] as PrivLane).index}`);
        return orig(...a);
      };
    }
    r.b.launchLane(1);
    await view(r, 1).prefetchMutants?.(plans(["M0002"]));
    await view(r, 2).prefetchMutants?.(plans(["M0003"])); // never launched: the old path
    expect(calls).toEqual(["spawnRestarted:1", "startDaemon:2"]);
    expect(laneOf(r, 1).stats.lazyProofs).toBe(1);
    expect(laneOf(r, 2).stats.lazyProofs).toBe(0);
  });

  test("the mark is re-applied at every launch, after every deploy", async () => {
    const r = await lanesRig({ lanes: 3 });
    await laneBaseline(r);
    r.b.prepareBatch(plans(ALL));
    r.b.launchLane(1);
    await r.b.deploy(r.batch); // resetLayoutState clears the mark
    const lazy = () =>
      (r.b as unknown as { lazyLanes: WeakSet<object> }).lazyLanes.has(laneOf(r, 1));
    expect(lazy()).toBe(false);
    r.b.launchLane(1);
    expect(lazy()).toBe(true);
  });

  test("N launched lanes hold N reservations until measured; a lane that ends without one releases its own", async () => {
    const r = await lanesRig({ lanes: 4, serve: { pid: (d) => 4000 + d } });
    r.b.seams.requestRssReader = () => GiB; // every request gives a peak reading (1 GiB)
    await laneBaseline(r);
    r.b.prepareBatch(plans(ALL));
    const charged = (k: number) =>
      (r.b as unknown as { lanesCharged(k: number): number }).lanesCharged(k);
    expect(r.b.reservedLaneList()).toEqual([]);
    r.b.launchLane(1);
    r.b.launchLane(2);
    r.b.launchLane(3);
    expect(r.b.reservedLaneList()).toEqual([1, 2, 3]);
    // an ask for lane 1 is charged lanes 0 and 1 AND the two other reserved lanes
    expect(charged(1)).toBe(4);
    // lane 1's first measured request ends its reservation
    await view(r, 1).prefetchMutants?.(plans(["M0001"]));
    expect(r.b.reservedLaneList()).toEqual([2, 3]);
    // lane 2 ends without a measured request: the queue releases its own (and only its own)
    r.b.releaseLane(2);
    expect(r.b.reservedLaneList()).toEqual([3]);
    r.b.releaseLane(3);
    expect(r.b.reservedLaneList()).toEqual([]);
    r.b.releaseLane(3); // releasing twice is harmless
  });

  test("a serve-request-sized reading carries its lane; a refusal close and a drift carry theirs", async () => {
    const r = await lanesRig({ lanes: 3, serve: driftRows({ freshRefused: false }) });
    r.b.seams.requestRssReader = () => GiB;
    const sized: (number | undefined)[] = [];
    const closed: { lane?: number; reason: string }[] = [];
    const drifts: V3KeptDrift[] = [];
    r.b.setRequestSizedSink((e) => sized.push(e.lane));
    r.b.setDaemonCloseSink((c) =>
      closed.push({ ...(c.lane !== undefined ? { lane: c.lane } : {}), reason: c.reason }),
    );
    r.b.setKeptDriftSink((d) => drifts.push(d));
    await laneBaseline(r);
    r.b.prepareBatch(driftBatch);
    const v1 = view(r, 1);
    await v1.activate("M0001");
    await v1.run(A, OPTS);
    await v1.prefetchMutants?.(plans(["M0002", "M0003"], [B])); // drifts on lane 1's daemon
    expect(sized).toContain(1);
    expect(drifts.map((d) => d.lane)).toEqual([1]);
    expect(closed).toEqual([{ lane: 1, reason: "kept-refusal-drift" }]);
  });
});

describe("PR-99 coordinator (b): PR-56's drift restore is the sending lane's", () => {
  test("lane 1's drift re-run leaves lane 0's and lane 2's counters untouched", async () => {
    const r = await lanesRig({ lanes: 3, serve: driftRows({ freshRefused: false }) });
    await laneBaseline(r);
    r.b.prepareBatch(driftBatch);
    // lane 2 has its own history; so has lane 0 (the baseline)
    await view(r, 2).prefetchMutants?.(plans(["M0004"]));
    const l0 = { ...laneOf(r, 0).stats };
    const l2 = { ...laneOf(r, 2).stats };
    expect(l2.prefetchRequests).toBe(1);
    const v1 = view(r, 1);
    await v1.activate("M0001");
    await v1.run(A, OPTS);
    await v1.prefetchMutants?.(plans(["M0002", "M0003"], [B]));
    const l1 = laneOf(r, 1).stats;
    expect(l1.keptDrifts).toBe(1);
    // the drifted send is uncounted and its re-run counted: lane 1 shows ONE prefetch request
    expect(l1.prefetchRequests).toBe(1);
    expect(laneOf(r, 0).stats).toEqual(l0);
    expect(laneOf(r, 2).stats).toEqual(l2);
  });
});

describe("PR-99 spec 7.8: a kept refusal inside a warm-up does not arm the drift guard", () => {
  const keptInNone: RowsFn = (m, cu, d, n) =>
    allPass(m, cu, d, n).map((x) =>
      (m === "NONE" || m === "STATIC") && x.method === "B" ? refusedRow(x, KEPT) : x,
    );

  /** The one-shot fake cannot say `notRun`; the baseline's B row is made the kept refusal the daemon's NONE rows hold. */
  const keptInBaseline = (r: LanesRig) => {
    const rows = (r.b as unknown as { baselineRows: Map<number, { method: string }[]> })
      .baselineRows;
    rows.set(
      CU,
      (rows.get(CU) ?? []).map((x) =>
        x.method === "B" ? { ...x, status: "error", notRun: true, message: KEPT } : x,
      ),
    );
  };

  const case8 = async (lanes: 0 | 3) => {
    const r = await lanesRig({ lanes, rows: keptInNone });
    const events: V3KeptDrift[] = [];
    r.b.setKeptDriftSink((e) => events.push(e));
    if (lanes === 0) {
      await soleBaseline(r);
      keptInBaseline(r);
      await r.b.prefetchMutants(plans(["M0001"]), { batchPlans: plans(ALL) });
      await r.b.prefetchMutants(plans(["M0002"]));
      return { r, events, l: laneOf(r, 0) };
    }
    await laneBaseline(r);
    keptInBaseline(r);
    r.b.prepareBatch(plans(ALL));
    r.b.launchLane(1);
    await view(r, 1).prefetchMutants?.(plans(["M0001"]));
    await view(r, 1).prefetchMutants?.(plans(["M0002"]));
    return { r, events, l: laneOf(r, 1) };
  };

  for (const lanes of [0, 3] as const) {
    test(`N = ${lanes === 0 ? 1 : 3}: the warm-up held the refusal (counted per lane), no request is armed by it`, async () => {
      const { events, l } = await case8(lanes);
      expect(l.stats.warmupsHeldKept).toBeGreaterThan(0);
      expect(l.stats.armedRequests).toBe(0);
      expect(events).toEqual([]);
    });
  }

  test("a warm-up that follows a request which left a kept refusal set is counted apart", async () => {
    const live: RowsFn = (m, cu, d, n) =>
      allPass(m, cu, d, n).map((x) =>
        m === "M0001" && x.method === "A" ? refusedRow(x, KEPT) : x,
      );
    const r = await lanesRig({ lanes: 3, rows: live });
    await laneBaseline(r);
    r.b.prepareBatch(plans(ALL));
    r.b.launchLane(1);
    const v1 = view(r, 1);
    await v1.prefetchMutants?.(plans(["M0001"]));
    const l1 = laneOf(r, 1);
    expect(l1.stats.warmupsAfterKept).toBe(0);
    // the lane's daemon left `keptRefusal` set; make its next codeunit need a lazy proof again
    const daemons = (
      l1 as unknown as { daemons: Map<string, { proven?: Set<number>; keptRefusal?: unknown }> }
    ).daemons;
    const d = [...daemons.values()][0];
    expect(d?.keptRefusal).toBeDefined();
    d?.proven?.delete(CU);
    await v1.prefetchMutants?.(plans(["M0002"]));
    expect(l1.stats.warmupsAfterKept).toBe(1);
  });
});

describe("PR-99 spec 7.9: verdicts of N = 1 and N = 3 are equal on a fake that keeps state per daemon", () => {
  // A daemon that sees a mutant a SECOND time answers from its cache and passes: state per daemon. Each
  // mutant is asked once in a run that keeps the prefetch per lane; if one lane's prefetch wipes another's,
  // the wiped lane asks again, live, on the same daemon, and its verdict changes.
  const statefulRows = () => {
    const seen = new Map<number, Set<string>>();
    const rows: RowsFn = (m, cu, d, n) => {
      const mine = seen.get(d) ?? new Set<string>();
      seen.set(d, mine);
      const again = mine.has(m);
      mine.add(m);
      const base = allPass(m, cu, d, n);
      return m === "NONE" || m === "STATIC" || again ? base : failing(base, "A", "boom");
    };
    return rows;
  };
  const units = [
    ["M0001", "M0002"],
    ["M0003", "M0004"],
  ];

  const verdicts = async (lanes: 0 | 3) => {
    const r = await lanesRig({ lanes, rows: statefulRows() });
    const out = new Map<string, string>();
    const score = async (
      v: {
        activate(id: string | null): Promise<void>;
        run(ref: TestMethodRef, opts: RunOpts): Promise<TestVerdict>;
      },
      ids: readonly string[],
    ) => {
      for (const id of ids) {
        await v.activate(id);
        out.set(id, (await v.run(A, OPTS)).outcome);
      }
    };
    if (lanes === 0) {
      await soleBaseline(r);
      await r.b.prefetchMutants(plans(ALL), { batchPlans: plans(ALL) });
      // N = 1: one prefetch, then the scoring
      for (const u of units) await score(r.b, u);
    } else {
      await laneBaseline(r);
      r.b.prepareBatch(plans(ALL));
      const [v0, v1] = [view(r, 0), view(r, 1)];
      const [u0, u1] = [units[0] ?? [], units[1] ?? []];
      await v0.prefetchMutants?.(plans(u0));
      await v1.prefetchMutants?.(plans(u1)); // lane 1's prefetch happens before lane 0 scores
      await score(v0, u0);
      await score(v1, u1);
    }
    return [...out].sort(([a], [b]) => a.localeCompare(b));
  };

  test("N = 1 and N = 3 give the same verdict for every mutant", async () => {
    const one = await verdicts(0);
    const three = await verdicts(3);
    expect(one.map(([, v]) => v)).toEqual(["fail", "fail", "fail", "fail"]);
    expect(three).toEqual(one);
  });
});

describe("PR-99 spec 7.5/7.7: the queue under the split", () => {
  const CODES = ["M0", "M1", "M2", "M3", "M4", "M5"];
  const unitsOf = (n: number) => Array.from({ length: n }, (_, i) => [{ mutantId: `M${i}` }]);
  const tick = () => new Promise<void>((r) => setImmediate(r));

  function harness(o: { barrier: boolean; measured?: boolean; admit?: (k: number) => boolean }) {
    let passed = o.barrier;
    let measured = o.measured ?? true;
    const watchers = new Set<() => void>();
    const log: string[] = [];
    const launched: number[] = [];
    const ended: number[] = [];
    const fire = () => {
      for (const w of [...watchers]) w();
    };
    const split = {
      barrierPassed: () => passed,
      measured: () => measured,
      watch: (cb: () => void) => {
        watchers.add(cb);
        return () => void watchers.delete(cb);
      },
      onLaunch: (k: number) => launched.push(k),
      onEnd: (k: number) => ended.push(k),
    };
    return {
      log,
      launched,
      ended,
      split,
      pass: () => {
        passed = true;
        log.push("barrier");
        fire();
      },
      setMeasured: () => {
        measured = true;
        fire();
      },
      unmeasure: () => {
        measured = false;
      },
      admit: o.admit ?? (() => true),
    };
  }
  const run = (
    h: ReturnType<typeof harness>,
    n: number,
    lanes: number,
    body: (k: number, i: number) => Promise<void>,
  ) => {
    const commit = new OrderedCommit(CODES.slice(0, n), () => undefined, lanes);
    return runScopeQueue({
      units: unitsOf(n),
      lanes,
      split: h.split,
      mayStart: h.admit,
      commit,
      isUnsafe: () => false,
      runUnit: async (k, unit, sink) => {
        const id = unit[0]?.mutantId ?? "";
        sink.begin(id);
        h.log.push(`take ${k} ${id}`);
        await body(k, Number(id.slice(1)));
        sink.finish(id, () => {});
      },
    });
  };

  test("no lane >= 1 takes a unit before the barrier; the callback launches them while lane 0 is still in its first unit", async () => {
    const h = harness({ barrier: false });
    await run(h, 6, 3, async (k, i) => {
      if (k === 0 && i === 0) {
        await tick();
        h.pass(); // lane 0's session-first warm-up passes inside its first unit
        for (let t = 0; t < 5; t++) await tick();
        h.log.push("unit 0 ends");
      } else await tick();
    });
    const first = h.log.findIndex((l) => /^take [12] /.test(l));
    expect(h.log.indexOf("barrier")).toBeGreaterThan(-1);
    expect(first).toBeGreaterThan(h.log.indexOf("barrier"));
    expect(first).toBeLessThan(h.log.indexOf("unit 0 ends")); // the callback, not the unit end
    expect(h.launched.sort()).toEqual([1, 2]); // each lane index launched once
  });

  test("a barrier that passed in an earlier window launches the lanes at queue start", async () => {
    const h = harness({ barrier: true });
    await run(h, 6, 3, async (k, i) => {
      await tick();
      if (k === 0 && i === 0) h.log.push("unit 0 ends");
    });
    // all three lanes hold a unit before lane 0's first unit ends (not launched at a unit boundary)
    expect(h.log.slice(0, 3)).toEqual(["take 0 M0", "take 1 M1", "take 2 M2"]);
    expect(h.log.indexOf("unit 0 ends")).toBeGreaterThan(2);
  });

  test("one launcher: events and unit ends together never launch a lane twice", async () => {
    const h = harness({ barrier: false, measured: false });
    await run(h, 6, 3, async (k, i) => {
      if (k === 0 && i === 0) {
        h.pass();
        h.setMeasured();
        h.setMeasured();
        await tick();
        h.setMeasured();
      } else await tick();
    });
    expect([...h.launched].sort()).toEqual([1, 2]);
    expect(new Set(h.launched).size).toBe(h.launched.length);
  });

  test("r6 (§13): a lane starts while any unit is untaken, and none once the window has none", async () => {
    // lane 0 takes unit 0 first: with 3 units, lanes 1 and 2 each take one (the r4 rule, k + 1, started only lane 1)
    const h = harness({ barrier: true });
    await run(h, 3, 3, async () => tick());
    expect(h.launched).toEqual([1, 2]);
    // 2 units: lane 1 takes the second; nothing is left for lane 2
    const h2 = harness({ barrier: true });
    await run(h2, 2, 3, async () => tick());
    expect(h2.launched).toEqual([1]);
    // 1 unit: lane 0 has it; no lane above starts
    const h1 = harness({ barrier: true });
    await run(h1, 1, 3, async () => tick());
    expect(h1.launched).toEqual([]);
  });

  test("it does not start when the gate says no; it starts at the next event once the gate admits", async () => {
    let open = false;
    const h = harness({ barrier: true, admit: () => open });
    await run(h, 6, 2, async (k, i) => {
      if (k === 0 && i === 0) {
        await tick();
        expect(h.launched).toEqual([]);
        open = true;
        h.setMeasured();
        await tick();
      } else await tick();
    });
    expect(h.launched).toEqual([1]);
  });

  test("an unmeasured gate starts no lane; a lane that ends without a unit still releases (onEnd)", async () => {
    const h = harness({ barrier: true, measured: false });
    await run(h, 4, 3, async () => tick());
    expect(h.launched).toEqual([]);
    const h2 = harness({ barrier: true });
    // lane 1 launches, and its unit throws before any request is measured: the reservation is released
    await run(h2, 4, 2, async (k) => {
      if (k === 1) throw new Error("boom");
      await tick();
    }).catch(() => undefined);
    expect(h2.launched).toEqual([1]);
    expect(h2.ended).toEqual([1]);
  });
});

describe("PR-99 spec 2.6 (test 10): PR-94's flag is decided per request, the same at N = 1 and N = 3", () => {
  // The backend's own lists never make a gap (#8059 is guarded), so the list is forced: M0001 excludes A and
  // keeps B after it (a gap: no flag, counted refused); M0002 excludes B, the tail (a clean cut: flagged).
  const EXCLUDES: Record<string, string[]> = {
    M0001: [`Codeunit${CU}.A`],
    M0002: [`Codeunit${CU}.B`],
  };
  const force = (r: LanesRig) => {
    (
      r.b as unknown as { mutantExcludes: (l: unknown, cu: number, m: string) => unknown }
    ).mutantExcludes = (_l, _cu, m) => EXCLUDES[m];
  };
  const decisions = (r: LanesRig) =>
    ["M0001", "M0002"].map((m) =>
      r.serve.requests.filter((q) => q.mutants.includes(m)).map((q) => q.selectedOnly),
    );

  const atOne = async () => {
    const r = await lanesRig({ lanes: 0 });
    await soleBaseline(r);
    force(r);
    for (const m of ["M0001", "M0002"])
      await r.b.prefetchMutants(plans([m], m === "M0001" ? [B] : [A]));
    return {
      r,
      stats: (r.b as unknown as { entriesStats(): Record<string, number> }).entriesStats(),
    };
  };
  const atThree = async () => {
    const r = await lanesRig({ lanes: 3 });
    await laneBaseline(r);
    force(r);
    r.b.prepareBatch(plans(["M0001", "M0002"]));
    await view(r, 1).prefetchMutants?.(plans(["M0001"], [B]));
    await view(r, 2).prefetchMutants?.(plans(["M0002"], [A]));
    return r;
  };

  test("a gapped entry's request is unflagged and a clean cut's is flagged, on any lane", async () => {
    const one = await atOne();
    const three = await atThree();
    // red if the split changed the per-request decision (for example a lane that skipped PR-94's check)
    expect(decisions(one.r)).toEqual([[false], [true]]);
    expect(decisions(three)).toEqual(decisions(one.r));
  });

  test("the counters are the sending lane's, and their totals equal N = 1's", async () => {
    const one = await atOne();
    const three = await atThree();
    const pick = (s: Record<string, number>) => ({
      selectedOnlyRequests: s.selectedOnlyRequests,
      selectedOnlyRefusedGapped: s.selectedOnlyRefusedGapped,
    });
    expect(pick(one.stats)).toEqual({ selectedOnlyRequests: 1, selectedOnlyRefusedGapped: 1 });
    expect(pick(laneOf(three, 1).stats)).toEqual({
      selectedOnlyRequests: 0,
      selectedOnlyRefusedGapped: 1,
    });
    expect(pick(laneOf(three, 2).stats)).toEqual({
      selectedOnlyRequests: 1,
      selectedOnlyRefusedGapped: 0,
    });
    expect(pick(laneOf(three, 0).stats)).toEqual({
      selectedOnlyRequests: 0,
      selectedOnlyRefusedGapped: 0,
    });
  });
});
