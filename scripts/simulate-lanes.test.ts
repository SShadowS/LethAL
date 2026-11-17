import { describe, expect, test } from "bun:test";
import { simulateLanes, unitMs } from "./simulate-lanes.ts";

const u = (window: number, scope: string, scoringMs: number, entries: number) => ({
  window,
  scope,
  mutants: 1,
  entries,
  scoringMs,
});

describe("simulate-lanes (PR-99, section 10.2)", () => {
  test("a unit's time is its scoring wall plus its entries' share of the window's prefetch wall", () => {
    expect(unitMs(u(0, "a", 100, 4), { window: 0, mutants: 8, entries: 8, prefetchMs: 80 })).toBe(
      140,
    );
    // no window record, or a window with no entries: the share is 0, never NaN
    expect(unitMs(u(0, "a", 100, 4), undefined)).toBe(100);
    expect(unitMs(u(0, "a", 100, 4), { window: 0, mutants: 0, entries: 0, prefetchMs: 80 })).toBe(
      100,
    );
  });

  test("the greedy runs in MANIFEST order, not longest first", () => {
    // Manifest order 10, 10, 30 on two lanes: lane 0 takes 10, lane 1 takes 10, lane 0 (free at 10) takes 30.
    // Longest-first would give 30 | 10 + 10 = 30; manifest order gives 40.
    const r = simulateLanes({
      units: [u(0, "a", 10, 0), u(0, "b", 10, 0), u(0, "c", 30, 0)],
      windows: [{ window: 0, mutants: 3, entries: 0, prefetchMs: 0 }],
      lanes: 2,
      barrierMs: 0,
      laneStartMs: 0,
    });
    expect(r.wallMs).toBe(40);
  });

  const win = (window: number) => ({ window, mutants: 0, entries: 0, prefetchMs: 0 });
  test("lanes above 0 start when the gate opens, and pay their start cost once", () => {
    const base = {
      units: [
        u(0, "a", 100, 0),
        u(0, "b", 100, 0),
        u(0, "c", 10, 0),
        u(1, "d", 100, 0),
        u(1, "e", 100, 0),
        u(1, "f", 10, 0),
      ],
      windows: [win(0), win(1)],
      lanes: 2,
    };
    // Window 0: lane 0 takes a (0-100); the gate opens at 30 with 2 untaken, so lane 1 takes b (30 + 20 + 100 =
    // 150); lane 0 takes c (100-110): 150 ms. Window 1: the gate is open, lane 1 is resident: d and e at 0,
    // f on lane 0 at 100: 110 ms.
    const r = simulateLanes({ ...base, barrierMs: 30, laneStartMs: 20 });
    expect(r.perWindowMs).toEqual([150, 110]);
    expect(r.lanesPerWindow).toEqual([2, 2]);
    expect(r.wallMs).toBe(260);
    // One lane: the gate and the start cost do not matter.
    expect(simulateLanes({ ...base, lanes: 1, barrierMs: 30, laneStartMs: 20 }).wallMs).toBe(420);
  });

  test("tryLaunch's r6 rule: a lane starts while any unit is untaken; with none left the window drains", () => {
    const units = (n: number) => Array.from({ length: n }, (_, i) => u(0, `s${i}`, 100, 0));
    const at = (n: number) =>
      simulateLanes({ units: units(n), windows: [win(0)], lanes: 3, barrierMs: 0, laneStartMs: 0 });
    // 1 unit: lane 0 has it; nothing for lane 1
    expect(at(1)).toMatchObject({ lanesPerWindow: [1], wallMs: 100 });
    // 2 units: lane 1 takes the second (r4's k + 1 rule ran both on lane 0: 200 ms)
    expect(at(2)).toMatchObject({ lanesPerWindow: [2], wallMs: 100 });
    // 3 units: every lane takes one (r4: 2 lanes, 200 ms)
    expect(at(3)).toMatchObject({ lanesPerWindow: [3], wallMs: 100 });
    // a gate that opens after lane 0 took more units: 5 units, lane 0 has run s0 and s1 and holds s2 at 250;
    // 2 are untaken, so lanes 1 and 2 both start
    expect(
      simulateLanes({
        units: units(5),
        windows: [win(0)],
        lanes: 3,
        barrierMs: 250,
        laneStartMs: 0,
      }).lanesPerWindow,
    ).toEqual([3]);
  });

  test("--merge-windows groups consecutive windows; a scope split across them becomes one unit", () => {
    const base = {
      units: [
        u(0, "a", 100, 0),
        u(0, "b", 50, 0),
        u(1, "b", 50, 0),
        u(1, "c", 100, 0),
        u(2, "d", 30, 0),
      ],
      windows: [win(0), win(1), win(2)],
      lanes: 3,
      barrierMs: 0,
      laneStartMs: 0,
    };
    const r = simulateLanes({ ...base, mergeWindows: 2 });
    // windows 0+1: a (100), b (50 + 50), c (100) on three lanes: 100 ms; window 2: d alone: 30 ms
    expect(r.unitsPerWindow).toEqual([3, 1]);
    expect(r.lanesPerWindow).toEqual([3, 1]);
    expect(r.perWindowMs).toEqual([100, 30]);
    // unmerged: [a, b] and [b, c] on two lanes each, then d: 100 + 100 + 30
    expect(simulateLanes(base)).toMatchObject({ unitsPerWindow: [2, 2, 1], wallMs: 230 });
    expect(() => simulateLanes({ ...base, mergeWindows: 0 })).toThrow(/merge-windows/);
  });

  test("a lane first launched in a later window pays its start cost there", () => {
    const r = simulateLanes({
      units: [u(0, "a", 100, 0), u(1, "b", 100, 0), u(1, "c", 100, 0), u(1, "d", 10, 0)],
      windows: [win(0), win(1)],
      lanes: 2,
      barrierMs: 0,
      laneStartMs: 20,
    });
    // window 0: one unit, lane 1 never starts; window 1: lane 1 takes c at 0 and ends at 120
    expect(r.perWindowMs).toEqual([100, 120]);
    expect(r.lanesPerWindow).toEqual([1, 2]);
  });

  test("refuses an empty input and a bad lane count by name", () => {
    expect(() =>
      simulateLanes({ units: [], windows: [], lanes: 2, barrierMs: 0, laneStartMs: 0 }),
    ).toThrow(/no units/);
    expect(() =>
      simulateLanes({
        units: [u(0, "a", 1, 0)],
        windows: [],
        lanes: 0,
        barrierMs: 0,
        laneStartMs: 0,
      }),
    ).toThrow(/lanes must be/);
  });
});
