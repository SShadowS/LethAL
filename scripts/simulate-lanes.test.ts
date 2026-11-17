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

  test("lanes above 0 start at the barrier plus their start cost, in the first window only", () => {
    const base = {
      units: [u(0, "a", 100, 0), u(0, "b", 100, 0), u(1, "c", 100, 0), u(1, "d", 100, 0)],
      windows: [
        { window: 0, mutants: 2, entries: 0, prefetchMs: 0 },
        { window: 1, mutants: 2, entries: 0, prefetchMs: 0 },
      ],
      lanes: 2,
    };
    // Window 0: lane 0 takes a (0-100); lane 1 is free at 30 + 20 = 50 and takes b (50-150): 150 ms.
    // Window 1: both lanes are ready at 0: 100 ms.
    const r = simulateLanes({ ...base, barrierMs: 30, laneStartMs: 20 });
    expect(r.perWindowMs).toEqual([150, 100]);
    expect(r.wallMs).toBe(250);
    // One lane: the barrier and the start cost do not matter.
    expect(simulateLanes({ ...base, lanes: 1, barrierMs: 30, laneStartMs: 20 }).wallMs).toBe(400);
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
