// PR-241: LETHAL_V3_PACK_ENTRIES packs a lane's consecutive prefetch units into one request (A/B knob, off
// by default). Fakes and call counters only, never a clock.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { PACK_ENTRIES_ENV, readPackEntries } from "../src/al-runner-v3-backend";
import { type LaneSink, OrderedCommit, runScopeQueue } from "../src/parallel-queue";
import {
  A,
  B,
  CU,
  type LanesRig,
  OPTS,
  type RowsFn,
  SUITE,
  allPass,
  cleanRigs,
  laneBaseline,
  lanesRig,
} from "./helpers/v3-lanes-rig";

afterEach(cleanRigs);

type U = { readonly mutantId: string };
const ticks = async (n = 8) => {
  for (let i = 0; i < n; i++) await new Promise<void>((r) => setImmediate(r));
};
const gate = () => {
  let open!: () => void;
  const p = new Promise<void>((r) => {
    open = r;
  });
  return { p, open };
};

describe("PR-241 queue: packing consecutive units of one lane", () => {
  /** One unit per code `u<i>`, 10 entries each; `windows[i]` is the unit's window. */
  const rig = (
    windows: readonly number[],
    lanes: number,
    o: {
      cap?: number;
      body?: (id: string, k: number) => Promise<void>;
      fitsThrows?: boolean;
    } = {},
  ) => {
    const codes = windows.map((_, i) => `u${i}`);
    const units: U[][] = codes.map((c) => [{ mutantId: c }]);
    const log: string[] = [];
    const batches: { lane: number; units: string[] }[] = [];
    const commit = new OrderedCommit(codes, () => undefined, lanes);
    const pack =
      o.cap === undefined
        ? undefined
        : {
            fits: (batch: readonly (readonly U[])[]) => {
              if (o.fitsThrows === true) throw new Error("fits blew up");
              return batch.length * 10 <= (o.cap ?? 0);
            },
            prefetch: async (k: number, batch: readonly (readonly U[])[], _s: LaneSink) => {
              const ids = batch.map((u) => u[0]?.mutantId ?? "");
              batches.push({ lane: k, units: ids });
              log.push(`prefetch ${k} ${ids.join(",")}`);
            },
          };
    const done = runScopeQueue({
      units,
      lanes,
      mayStart: () => true,
      commit,
      isUnsafe: () => false,
      lookAhead: {
        windowOf: (u) => windows[Number((u[0]?.mutantId ?? "u0").slice(1))] ?? 0,
        budgetSpent: () => false,
      },
      split: {
        barrierPassed: () => true,
        measured: () => true,
        watch: () => () => {},
      },
      ...(pack !== undefined ? { pack } : {}),
      runUnit: async (k, unit, sink) => {
        const id = unit[0]?.mutantId ?? "";
        sink.begin(id);
        log.push(`run ${k} ${id}`);
        await o.body?.(id, k);
        sink.finish(id, () => {});
        log.push(`end ${k} ${id}`);
      },
    });
    return { done, log, batches };
  };

  test("1: off (no pack) prefetches nothing in the queue and runs each unit as today", async () => {
    const r = rig([0, 0, 0], 1);
    await r.done;
    expect(r.batches).toEqual([]);
    expect(r.log).toEqual(["run 0 u0", "end 0 u0", "run 0 u1", "end 0 u1", "run 0 u2", "end 0 u2"]);
  });

  test("2: on, a lane takes consecutive units up to the cap, in queue order, then the next batch", async () => {
    const r = rig(Array(12).fill(0), 1, { cap: 60 });
    await r.done;
    expect(r.batches).toEqual([
      { lane: 0, units: ["u0", "u1", "u2", "u3", "u4", "u5"] },
      { lane: 0, units: ["u6", "u7", "u8", "u9", "u10", "u11"] },
    ]);
  });

  test("a throw in `fits` fails the session by name and ends the lane; nothing hangs", async () => {
    const r = rig([0, 0, 0], 1, { cap: 60, fitsThrows: true });
    await expect(r.done).rejects.toThrow("fits blew up");
    expect(r.batches).toEqual([]);
  });

  test("3: never across lanes: each lane's batch is its own consecutive run", async () => {
    const hold = gate();
    const r = rig(Array(12).fill(0), 2, { cap: 60, body: () => hold.p });
    await ticks();
    expect(r.batches).toEqual([
      { lane: 0, units: ["u0", "u1", "u2", "u3", "u4", "u5"] },
      { lane: 1, units: ["u6", "u7", "u8", "u9", "u10", "u11"] },
    ]);
    hold.open();
    await r.done;
  });

  test("look-ahead: a unit beyond the bound is not taken early, even if it would fit", async () => {
    // windows 0,0,1,2: u3 (window 2) is beyond oldest(0) + 1 while u0 is unended
    const r = rig([0, 0, 1, 2], 1, { cap: 400 });
    await r.done;
    expect(r.batches.map((b) => b.units)).toEqual([["u0", "u1", "u2"], ["u3"]]);
  });

  test("5: each unit ends as it finishes: a waiting lane takes a unit as soon as the bound opens", async () => {
    const hold = gate();
    const r = rig([0, 0, 1, 2], 2, {
      cap: 400,
      body: (id, k) => (id === "u2" && k === 0 ? hold.p : Promise.resolve()),
    });
    await ticks();
    // lane 0 holds u0,u1,u2; u2 is still running, yet u0 and u1 ended, so u3 (window 2) is open to lane 1
    expect(r.log).toContain("run 1 u3");
    expect(r.log).not.toContain("end 0 u2");
    hold.open();
    await r.done;
    expect(r.log.filter((l) => l.startsWith("run 0"))).toEqual([
      "run 0 u0",
      "run 0 u1",
      "run 0 u2",
    ]);
  });
});

describe("PR-241 backend: one packed prefetch call", () => {
  const ids = Array.from({ length: 40 }, (_, i) => `M${String(i + 1).padStart(4, "0")}`);
  const unitPlans = (u: number, size = 5, refs = SUITE) =>
    ids.slice(u * size, u * size + size).map((mutantId) => ({ mutantId, refs }));
  /** The prefetch requests: the daemon's warm-up (NONE, STATIC) is left out. */
  const real = (r: LanesRig) =>
    r.serve.requests.filter((q) => q.mutants.some((m) => m !== "NONE" && m !== "STATIC"));
  const sizesOf = (r: LanesRig) => real(r).map((q) => q.mutants.length);
  const priv = (r: LanesRig) =>
    r.b as unknown as {
      costByCall: Map<number, number[]>;
      cutAfterLastCovering: (cu: number, m: string, base: unknown) => unknown;
      modeOfCall: (cu: number) => unknown;
      laneList: {
        stats: Record<string, number>;
        prefetch: { prefetched: Map<string, unknown> };
        daemonFor: (m: unknown) => { keptRefusal?: unknown } | undefined;
      }[];
    };
  const start = async (
    packEntries?: number,
    extra: { pairBatch?: boolean; rows?: RowsFn } = {},
  ) => {
    const r = await lanesRig({
      lanes: 3,
      mutants: ids,
      ...(packEntries !== undefined ? { packEntries } : {}),
      ...extra,
    });
    await laneBaseline(r);
    r.b.prepareBatch(ids.map((mutantId) => ({ mutantId, refs: SUITE })));
    const v = r.views[1];
    if (v?.prefetchMutants === undefined) throw new Error("no lane 1");
    return { r, prefetch: v.prefetchMutants.bind(v) };
  };

  test("1: unit by unit (off) sends one request per unit, today's sequence", async () => {
    const { r, prefetch } = await start();
    for (let u = 0; u < 6; u++) await prefetch(unitPlans(u));
    expect(real(r).map((q) => q.mutants)).toEqual(
      Array.from({ length: 6 }, (_, u) => ids.slice(u * 5, u * 5 + 5)),
    );
  });

  test("2 and 4: packed, the request is cut by the 16-unmeasured cap at a whole unit", async () => {
    const { r, prefetch } = await start(64);
    const all = Array.from({ length: 6 }, (_, u) => unitPlans(u)).flat();
    await prefetch(all, { unitSizes: [5, 5, 5, 5, 5, 5] });
    // 16 unmeasured groups fit; unit 3 would be cut in half, so it waits: 15, 15
    expect(sizesOf(r)).toEqual([15, 15]);
    expect(real(r).flatMap((q) => q.mutants)).toEqual(all.map((p) => p.mutantId));
  });

  test("4: the byte budget still splits a packed request", async () => {
    const { r, prefetch } = await start(64);
    priv(r).costByCall.set(CU, [3 * 2 ** 30]); // two groups would cost 6 GiB of the 4 GiB budget
    const all = [unitPlans(0), unitPlans(1)].flat();
    await prefetch(all, { unitSizes: [5, 5] });
    expect(sizesOf(r)).toEqual(Array(10).fill(1));
  });

  /** R1151: a killed mutant fails test A of the codeunit; every other mutant (and NONE) passes all. */
  const killing =
    (killed: ReadonlySet<string>): RowsFn =>
    (m, cu, d, n) =>
      allPass(m, cu, d, n).map((x) =>
        killed.has(m) && x.method === "A" ? { ...x, status: "fail" as const, message: "boom" } : x,
      );
  type Answer = { readonly rows: unknown; readonly excluded?: unknown };
  const pairsOf = (r: LanesRig) => {
    const store = (
      priv(r).laneList[1]?.prefetch as unknown as {
        pairStore: Map<string, { cu: number; none: Answer; m: Answer; through?: string }>;
      }
    ).pairStore;
    // What a pair confirms: its codeunit, both answers' rows and left-out tests, and PR-102's cut. Left out:
    // `seq`, `wallMs` and `callId`, which name the request (one merged request where per unit there were several).
    const ans = (a: Answer) => [a.rows, a.excluded ?? null];
    return new Map(
      [...store].map(([k, v]) => [
        k,
        JSON.stringify([v.cu, ans(v.none), ans(v.m), v.through ?? null]),
      ]),
    );
  };

  test("R1151: the kill pairs of a packed call go in ONE batch (they went per unit before)", async () => {
    const { r, prefetch } = await start(64, {
      pairBatch: true,
      rows: killing(new Set(["M0001", "M0002"])),
    });
    const all = [unitPlans(0, 1), unitPlans(1, 1)].flat(); // one killed mutant per unit
    await prefetch(all, { unitSizes: [1, 1] });
    const s = r.b.entriesStats();
    expect(s.pairBatchStored).toBe(2);
    expect(s.pairBatchRequests).toBe(1);
  });

  test("R1151: pair for pair, a packed call stores exactly what the same units store prefetched one by one", async () => {
    const killed = new Set(["M0001", "M0003", "M0007", "M0012"]); // unit 1 (M0004-M0006) has none
    const units = [0, 1, 2, 3].map((u) => unitPlans(u, 3));
    const packed = await start(64, { pairBatch: true, rows: killing(killed) });
    await packed.prefetch(units.flat(), { unitSizes: [3, 3, 3, 3] });
    const oneByOne = await start(undefined, { pairBatch: true, rows: killing(killed) });
    // Each prefetch call starts its own store, so the one-by-one pairs are read after each unit.
    const b = new Map<string, string>();
    for (const u of units) {
      await oneByOne.prefetch(u);
      for (const [k, v] of pairsOf(oneByOne.r)) b.set(k, v);
    }
    const a = pairsOf(packed.r);
    expect(a.size).toBe(4);
    expect([...a.keys()].map((k) => k.split("|")[1]).sort()).toEqual([...killed].sort());
    expect(a).toEqual(b);
    expect(packed.r.b.entriesStats().pairBatchRequests).toBe(1);
    expect(oneByOne.r.b.entriesStats().pairBatchRequests).toBe(3); // one per unit with a kill
    // Review SF1: every merged pair is SERVED to its own kill (seq after the kill's prefetch), with no send;
    // a mutant that was not killed has no pair.
    const v = packed.r.views[1];
    if (v === undefined) throw new Error("no lane 1");
    for (const m of [...killed].sort()) {
      await v.activate(m);
      expect((await v.run(A, OPTS)).outcome).toBe("fail");
      const sent = packed.r.serve.requests.length;
      await v.sendKillPair(m, A);
      expect(packed.r.serve.requests.length).toBe(sent);
    }
    expect(packed.r.b.entriesStats()).toMatchObject({ pairBatchServed: 4, pairBatchRefused: 0 });
    expect(a.has(`${[...a.keys()][0]?.split("|")[0]}|M0002`)).toBe(false);
  });

  test("R1151: the byte budget still splits a merged batch, whole kills only", async () => {
    const { r, prefetch } = await start(64, {
      pairBatch: true,
      rows: killing(new Set(["M0001", "M0002"])),
    });
    priv(r).costByCall.set(CU, [3 * 2 ** 30]); // a kill's two 3 GiB groups exceed the 4 GiB budget, so each kill goes alone
    await prefetch([unitPlans(0, 1), unitPlans(1, 1)].flat(), { unitSizes: [1, 1] });
    const s = r.b.entriesStats();
    expect(s.pairBatchStored).toBe(2);
    expect(s.pairBatchRequests).toBe(2);
  });

  test("R1151: an unpacked call is unchanged: one batch for its own kills", async () => {
    const { r, prefetch } = await start(undefined, {
      pairBatch: true,
      rows: killing(new Set(["M0001", "M0002"])),
    });
    await prefetch(unitPlans(0, 2));
    const s = r.b.entriesStats();
    expect(s.pairBatchStored).toBe(2);
    expect(s.pairBatchRequests).toBe(1);
  });

  test("5: every unit's rows land on its own mutants; the units are counted", async () => {
    const { r, prefetch } = await start(64);
    const all = [unitPlans(0), unitPlans(1), unitPlans(2)].flat();
    await prefetch(all, { unitSizes: [5, 5, 5] });
    const lane1 = priv(r).laneList[1];
    expect([...(lane1?.prefetch.prefetched.keys() ?? [])]).toEqual(all.map((p) => p.mutantId));
    expect(lane1?.stats.unitsPrefetched).toBe(3);
    expect(sizesOf(r)).toEqual([15]);
  });

  describe("PR-94's flag is per request: no unit changes another's flag", () => {
    // M0001 keeps B after an excluded A (a gap: unflagged); the others exclude the tail B (flagged).
    const EXCLUDES: Record<string, string[]> = {
      M0001: [`Codeunit${CU}.A`],
      M0002: [`Codeunit${CU}.B`],
      M0003: [`Codeunit${CU}.B`],
    };
    const mix = async (order: string[]) => {
      const { r, prefetch } = await start(64);
      priv(r).cutAfterLastCovering = (_cu, m) => EXCLUDES[m];
      const refsOf = (m: string) => (m === "M0001" ? [B] : [A]);
      const plans = order.map((mutantId) => ({ mutantId, refs: refsOf(mutantId) }));
      await prefetch(plans, { unitSizes: order.map(() => 1) });
      return real(r).map((q) => ({ m: q.mutants, flag: q.selectedOnly }));
    };

    test("a flaggable unit then an unflaggable one go in two requests", async () => {
      expect(await mix(["M0002", "M0001"])).toEqual([
        { m: ["M0002"], flag: true },
        { m: ["M0001"], flag: false },
      ]);
    });

    test("two flaggable units share one flagged request", async () => {
      expect(await mix(["M0002", "M0003"])).toEqual([{ m: ["M0002", "M0003"], flag: true }]);
    });
  });

  test("3: after a kept refusal only the NEXT request holds one unit; the one after packs again", async () => {
    const { r, prefetch } = await start(64);
    await prefetch(unitPlans(0)); // starts lane 1's daemon
    const l1 = priv(r).laneList[1];
    const d = l1?.daemonFor(priv(r).modeOfCall(CU));
    if (d === undefined) throw new Error("no daemon");
    d.keptRefusal = { text: "kept", test: "A" };
    r.serve.requests.length = 0;
    // the fake's answer to the first request leaves no kept refusal, so the guard is spent
    await prefetch([unitPlans(1), unitPlans(2), unitPlans(3)].flat(), { unitSizes: [5, 5, 5] });
    const ofUnits = (...us: number[]) => us.flatMap((u) => unitPlans(u).map((p) => p.mutantId));
    expect(real(r).map((q) => q.mutants)).toEqual([ofUnits(1), ofUnits(2, 3)]);
  });
});

describe("PR-241 validation", () => {
  test("6: unset or empty is off; a positive whole number is on; anything else throws by name", () => {
    expect(readPackEntries(undefined)).toBeUndefined();
    expect(readPackEntries("")).toBeUndefined();
    expect(readPackEntries("64")).toBe(64);
    for (const bad of ["0", "-3", "1.5", "abc", "64x", " 64", "1e3"])
      expect(() => readPackEntries(bad)).toThrow(/^lethal-v3-pack-entries-refused: /);
  });

  test("PR-395 (R1200): the backend's lanes() prints no pack notice (the orchestrator says it, knowing the budget)", async () => {
    const was = process.env[PACK_ENTRIES_ENV];
    process.env[PACK_ENTRIES_ENV] = "64";
    const said = spyOn(console, "warn").mockImplementation(() => {});
    try {
      await lanesRig({ lanes: 2 });
      expect(said.mock.calls.some((c) => String(c[0]).includes("pack-entries"))).toBe(false);
    } finally {
      said.mockRestore();
      if (was === undefined) delete process.env[PACK_ENTRIES_ENV];
      else process.env[PACK_ENTRIES_ENV] = was;
    }
  });

  test("6: a bad env value refuses at construction, before any run", async () => {
    const was = process.env[PACK_ENTRIES_ENV];
    process.env[PACK_ENTRIES_ENV] = "banana";
    try {
      await expect(lanesRig({ lanes: 0 })).rejects.toThrow(/lethal-v3-pack-entries-refused/);
    } finally {
      if (was === undefined) delete process.env[PACK_ENTRIES_ENV];
      else process.env[PACK_ENTRIES_ENV] = was;
    }
  });
});

void OPTS;
void allPass;
