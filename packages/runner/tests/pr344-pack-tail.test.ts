// PR-344 (docs/superpowers/specs/2026-11-22-pr344-pack-tail-alone.md): with `refusedCutTail` on, the green tail
// tests of one mutant that the walk would run ALONE are sent as ONE request (one entry per test, one R652 bound
// check). A stored row is the row the alone call would get, read once; anything that could differ (a cut, a
// refusal, a missing row, a failed pack) is never stored and is sent alone as today. The lane rig (a scripted
// serve daemon); call counters on the requests only, never time.
import { afterEach, describe, expect, test } from "bun:test";
import type { TestVerdict } from "../src/backend";
import {
  CU,
  type FakeRow,
  type LanesRig,
  OPTS,
  type Req,
  TIMEOUT_1S,
  cleanRigs,
  lanesRig,
  ref,
} from "./helpers/v3-lanes-rig";

afterEach(cleanRigs);

const UNLISTED = "NotRun: out-of-scope: the install baseline read resource active-mutant.txt";
const [A, B, C, D, E] = ["A", "B", "C", "D", "E"].map(ref) as [
  ReturnType<typeof ref>,
  ReturnType<typeof ref>,
  ReturnType<typeof ref>,
  ReturnType<typeof ref>,
  ReturnType<typeof ref>,
];
const MUTANTS = ["M0001", "M0002", "M0003", "M0004", "M0005", "M0006", "M0007", "M0008"];
const whole = (q: Req) => q.tests.some((t) => t.endsWith("."));

/**
 * [A, B, R (refused at the baseline), C, D, E]: the tail is C, D, E.
 * M0001: D fails. M0002: nothing fails. M0003: D times out (j = 1). M0004: C times out (entry 0).
 * M0005: a PACK request ends in EOF (a crash). M0006: D is refused. M0007: D has no row. M0008: E times out (j = 2).
 */
async function packRig(o: { flag: boolean; noPack?: boolean }): Promise<LanesRig> {
  const held: { rig?: LanesRig } = {};
  const r = await lanesRig({
    lanes: 0,
    methods: ["A", "B", "R", "C", "D", "E"],
    refusedCutTail: o.flag,
    serve: {
      honorExcludes: true,
      eofAt: (_n, req) =>
        req.mutants[0] === "M0005" &&
        req.tests.length > 1 &&
        req.tests.every((t) => !t.endsWith(".")),
    },
    mutants: MUTANTS,
    rows: (m) => {
      const tail = (method: string): FakeRow | undefined => {
        if (m === "M0001" && method === "D")
          return { method, status: "fail", message: "killed by D" };
        // a timeout row as v3 streams it (notRun), so the client cuts the answer there (R895)
        if (m === "M0003" && method === "D")
          return { method, status: "error", notRun: true, message: TIMEOUT_1S };
        if (m === "M0004" && method === "C")
          return { method, status: "error", notRun: true, message: TIMEOUT_1S };
        if (m === "M0008" && method === "E")
          return { method, status: "error", notRun: true, message: TIMEOUT_1S };
        if (m === "M0006" && method === "D")
          return { method, status: "error", notRun: true, message: UNLISTED };
        if (m === "M0007" && method === "D") return undefined;
        return { method, status: "pass" };
      };
      const rows: FakeRow[] = [
        { method: "A", status: "pass" },
        { method: "B", status: "pass" },
        { method: "R", status: "error", notRun: true, message: UNLISTED },
      ];
      for (const t of ["C", "D", "E"]) {
        const row = tail(t);
        if (row !== undefined) rows.push(row);
      }
      return rows;
    },
  });
  held.rig = r;
  if (o.noPack === true) (r.b.seams as { noTailPack?: true }).noTailPack = true;
  return r;
}

async function baseline(r: LanesRig): Promise<void> {
  r.b.baselinePhase(true);
  try {
    await r.b.activate(null);
    for (const t of r.suite) await r.b.run(t, OPTS);
  } finally {
    await r.b.baselinePhase(false, true);
  }
}

const prefetch = (r: LanesRig, mutant: string, refs: readonly ReturnType<typeof ref>[]) =>
  r.b.prefetchMutants([{ mutantId: mutant, refs }], {
    batchPlans: MUTANTS.map((mutantId) => ({ mutantId, refs })),
  });

/** What a walk reads of a verdict (never wall time). */
const sum = (v: TestVerdict) => [
  v.ref.method,
  v.outcome,
  v.runnerRow ?? "",
  v.selection ?? "",
  v.failureMessage ?? "",
];

async function start(r: LanesRig, m: string, order: readonly ReturnType<typeof ref>[]) {
  await prefetch(r, m, order);
  await r.b.activate(m);
}
async function walk(r: LanesRig, m: string, order: readonly ReturnType<typeof ref>[]) {
  await start(r, m, order);
  const out: string[][] = [];
  for (const t of order) out.push(sum(await r.b.run(t, OPTS)));
  return out;
}

/** The requests that carry tail tests (no whole-codeunit entry), for a mutant, as `Method` lists. */
const tails = (r: LanesRig, m: string): string[][] =>
  r.serve.requests
    .filter((q) => q.mutants[0] === m && !whole(q))
    .map((q) => q.tests.map((t) => t.slice(`Codeunit${CU}.`.length)));
const sig = (q: Req) => JSON.stringify([q.mutants, q.tests, q.selectedOnly, q.excludes]);
// The mutant's whole-codeunit requests. NONE warm-ups are left out: a restarted daemon proves its codeunits again,
// and a failed or cut pack can cost one restart the unpacked walk does not (the spec's Limit 1).
const others = (r: LanesRig) =>
  r.serve.requests.filter((q) => whole(q) && q.mutants[0] !== "NONE").map(sig);

/** The same walk with the pack and with it disabled: equal verdicts, equal non-tail requests. */
async function both(m: string, order: readonly ReturnType<typeof ref>[]) {
  const on = await packRig({ flag: true });
  await baseline(on);
  const off = await packRig({ flag: true, noPack: true });
  await baseline(off);
  const a = await walk(on, m, order);
  const b = await walk(off, m, order);
  expect(a).toEqual(b);
  expect(others(on)).toEqual(others(off));
  return { on, off, verdicts: a };
}

describe("PR-344: one send for a mutant's tail alone calls", () => {
  test("1a: a kill on a NON-first tail test: packed equals unpacked, the log differs by the pack only", async () => {
    const { on, off, verdicts } = await both("M0001", [A, C, D, E]);
    const d = verdicts.find((v) => v[0] === "D");
    expect(d?.[1]).toBe("fail");
    expect(d?.[3]).toBe("alone");
    expect(d?.[4]).toContain("killed by D");
    expect(tails(on, "M0001")).toEqual([["C", "D", "E"]]);
    expect(tails(off, "M0001")).toEqual([["C"], ["D"], ["E"]]);
  });

  test("1b: a non-tail test of the same codeunit between two tail tests is untouched", async () => {
    const { on, off, verdicts } = await both("M0001", [A, C, B, D, E]);
    const b = verdicts.find((v) => v[0] === "B");
    expect(b?.slice(1)).toEqual(["pass", "", "", ""]);
    expect(tails(on, "M0001")).toEqual([["C", "D", "E"]]);
    expect(tails(off, "M0001")).toEqual([["C"], ["D"], ["E"]]);
  });

  test("1c: a timeout at entry j > 0: the pack records no cut, entries after it go alone, the walk is the unpacked walk", async () => {
    const { on, off, verdicts } = await both("M0003", [A, C, B, D, E]);
    expect(verdicts.find((v) => v[0] === "D")?.[1]).toBe("timeout");
    // B sits between C and D: a pack that marked D's timeout would route B alone (a request, a selection)
    expect(verdicts.find((v) => v[0] === "B")?.[3]).toBe("");
    expect(tails(on, "M0003")).toEqual([["C", "D", "E"], ["D"], ["E"]]);
    expect(tails(off, "M0003")).toEqual([["C"], ["D"], ["E"]]);
  });

  test("1c2: the pack itself marks no cut in timedOutMutants; the walk's own read of D does", async () => {
    const r = await packRig({ flag: true });
    await baseline(r);
    await start(r, "M0003", [A, C, B, D, E]);
    const cuts = () =>
      (
        r.b as unknown as {
          lane: { prefetch: { timedOutMutants: Map<string, Set<string>> } };
        }
      ).lane.prefetch.timedOutMutants.get("M0003");
    await r.b.run(A, OPTS);
    await r.b.run(C, OPTS); // the pack went out, D timed out inside it
    expect(tails(r, "M0003")).toEqual([["C", "D", "E"]]);
    expect(cuts()).toBeUndefined();
    await r.b.run(D, OPTS); // D alone: its own read of its own timeout
    expect([...(cuts() ?? [])]).toEqual([`codeunit${CU}.d`]);
  });

  test("1d: a pack whose daemon crashes: T is sent alone and gets its own row, nothing is stored", async () => {
    const { on, off, verdicts } = await both("M0005", [A, C, D, E]);
    expect(verdicts.find((v) => v[0] === "C")?.slice(1, 4)).toEqual(["pass", "", "alone"]);
    expect(verdicts.map((v) => v[1])).toEqual(["pass", "pass", "pass", "pass"]);
    expect(tails(on, "M0005")).toEqual([["C", "D", "E"], ["C"], ["D"], ["E"]]);
    expect(tails(off, "M0005")).toEqual([["C"], ["D"], ["E"]]);
    expect(on.b.refusedCutTailStats()).toMatchObject({ failedPacks: 1, packs: 1 });
  });

  test("1e: entry 0 is the cut row: T's answer is today's alone answer", async () => {
    const { on, verdicts } = await both("M0004", [A, C, B, D, E]);
    const c = verdicts.find((v) => v[0] === "C");
    expect(c?.[1]).toBe("timeout");
    expect(c?.[3]).toBe("alone");
    expect(tails(on, "M0004")[0]).toEqual(["C", "D", "E"]);
  });

  test("5: a cut at entry j > 0: entries before it are read from the store, j and later are sent alone", async () => {
    const { on, off } = await both("M0008", [A, C, D, E]);
    // D was stored and served without a request; E was cut and went alone
    expect(tails(on, "M0008")).toEqual([["C", "D", "E"], ["E"]]);
    expect(tails(off, "M0008")).toEqual([["C"], ["D"], ["E"]]);
  });

  test("7a: a refusal row in the pack is not stored: sent alone when asked", async () => {
    const { on, verdicts } = await both("M0006", [A, C, D, E]);
    expect(verdicts.find((v) => v[0] === "D")?.[1]).not.toBe("pass");
    expect(tails(on, "M0006")).toEqual([["C", "D", "E"], ["D"], ["E"]]);
  });

  test("7b: a missing row in the pack is not stored: sent alone when asked (the next entry, no cut, is stored)", async () => {
    const { on } = await both("M0007", [A, C, D, E]);
    expect(tails(on, "M0007")).toEqual([["C", "D", "E"], ["D"]]);
  });

  test("2: k tail tests are ONE request with k entries and k distinct ids; the bound is checked k-1 times fewer", async () => {
    const on = await packRig({ flag: true });
    await baseline(on);
    const off = await packRig({ flag: true, noPack: true });
    await baseline(off);
    await walk(on, "M0002", [A, C, D, E]);
    await walk(off, "M0002", [A, C, D, E]);
    const packs = on.serve.requests.filter((q) => q.mutants[0] === "M0002" && !whole(q));
    expect(packs).toHaveLength(1);
    const pack = packs[0];
    expect(pack?.tests).toEqual([`Codeunit${CU}.C`, `Codeunit${CU}.D`, `Codeunit${CU}.E`]);
    expect(new Set(pack?.ids).size).toBe(pack?.ids.length ?? -1);
    expect(off.b.entriesStats().boundChecks - on.b.entriesStats().boundChecks).toBe(2);
    expect(on.b.refusedCutTailStats()).toMatchObject({ packs: 1, failedPacks: 0 });
  });

  test("3: a forced alone call never packs and never reads the store", async () => {
    const r = await packRig({ flag: true });
    await baseline(r);
    // no pack yet: a forced call is one single-entry request
    await start(r, "M0002", [A, C, D, E]);
    const c = await r.b.run(C, { ...OPTS, alone: true });
    expect(c.selection).toBe("alone");
    expect(tails(r, "M0002")).toEqual([["C"]]);
    // the walk's own call packs and stores D and E
    await r.b.run(C, OPTS);
    expect(tails(r, "M0002")).toEqual([["C"], ["C", "D", "E"]]);
    // a forced D sends its own request and leaves the stored D alone ...
    await r.b.run(D, { ...OPTS, alone: true });
    expect(tails(r, "M0002")).toEqual([["C"], ["C", "D", "E"], ["D"]]);
    // ... so the walk's D is still served from the store: no new request
    await r.b.run(D, OPTS);
    expect(tails(r, "M0002")).toHaveLength(3);
  });

  test("3b: a stored row is read once", async () => {
    const r = await packRig({ flag: true });
    await baseline(r);
    await start(r, "M0002", [A, C, D, E]);
    await r.b.run(C, OPTS);
    await r.b.run(D, OPTS); // from the store
    expect(tails(r, "M0002")).toEqual([["C", "D", "E"]]);
    await r.b.run(D, OPTS); // gone: alone, never a second pack
    expect(tails(r, "M0002")).toEqual([["C", "D", "E"], ["D"]]);
  });

  test("4: the store is cleared on every activation (the NONE confirm and a re-activation start empty)", async () => {
    const r = await packRig({ flag: true });
    await baseline(r);
    await start(r, "M0002", [A, C, D, E]);
    await r.b.run(C, OPTS);
    await r.b.activate(null);
    await r.b.activate("M0002");
    await r.b.run(D, OPTS);
    // D was not served from the old store: a new request, a new pack (D first, then C and E)
    expect(tails(r, "M0002")).toEqual([
      ["C", "D", "E"],
      ["D", "C", "E"],
    ]);
  });

  test("8: flag off: no pack, the request log has no tail request at all (today's)", async () => {
    const r = await packRig({ flag: false });
    await baseline(r);
    await walk(r, "M0002", [A, C, D, E]);
    expect(tails(r, "M0002")).toEqual([]);
    expect(r.serve.requests.filter((q) => q.tests.length > 1 && !whole(q))).toEqual([]);
  });
});
