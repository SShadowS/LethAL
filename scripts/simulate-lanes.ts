/**
 * PR-99 (spec 2026-11-16-pr96-split-prefetch, sections 10.2, 11.5, 13): the scheduling bound for an N-lane run,
 * from the per-unit numbers an N = 1 run records.
 *
 *   bun scripts/simulate-lanes.ts <times.json> --lanes 3 --barrier-ms 90000 --lane-start-ms 35000 [--merge-windows 3]
 *
 * `times.json` is `{ "units": [...], "windows": [...] }` (the backend's `unitTimings()`; an N = 1 run writes it
 * to the file `LETHAL_UNIT_TIMES_OUT` names, only when that is set). Per unit: its scoring wall plus its share of its
 * window's prefetch wall (its entries x the window's prefetch wall per entry). The simulation is
 * `runScopeQueue`'s real greedy under the split, in MANIFEST order (not longest-first): a free lane takes the
 * next unit, and lanes >= 1 start by `tryLaunch`'s rules (the gate; r6: while any unit is untaken; spec §13).
 * Windows run one after another. `--barrier-ms` is when the lane gate opens in the first window: lane 0's
 * first MEASURED request after the barrier (PR-98's gate needs a peak reading; a warm-up gives none). A lane's
 * first unit also pays the per-lane start cost, once (its daemons then stay resident).
 *
 * `--merge-windows M` (r6): the N-lane run cuts its windows at M x the N = 1 caps (`splitWindowCaps`). Groups of M
 * consecutive N = 1 windows hold at most what one such window holds (each N = 1 window is at most one cap), so the
 * real windows are at least as big: the merged layout has at least as many window ends, which only lengthens the
 * simulated wall. Each piece keeps its own N = 1 window's prefetch share; pieces of one scope that end up next to
 * each other become one unit.
 */
import { readFileSync } from "node:fs";

export interface UnitTime {
  readonly window: number;
  readonly scope: string;
  readonly mutants: number;
  readonly entries: number;
  readonly scoringMs: number;
}
export interface WindowTime {
  readonly window: number;
  readonly mutants: number;
  readonly entries: number;
  readonly prefetchMs: number;
}
export interface SimulationInput {
  readonly units: readonly UnitTime[];
  readonly windows: readonly WindowTime[];
  readonly lanes: number;
  /** When the lane gate opens in the first window: lane 0's first measured request (ms after the window starts). */
  readonly barrierMs: number;
  /** A lane above 0's own start cost (its first daemon's recompile and lazy proof). */
  readonly laneStartMs: number;
  /** r6: N = 1 windows per simulated window (default 1). */
  readonly mergeWindows?: number;
}
export interface SimulationResult {
  readonly wallMs: number;
  readonly perWindowMs: readonly number[];
  /** The lanes that took a unit in each window (the floor "lanes started" reads it). */
  readonly lanesPerWindow: readonly number[];
  /** The units in each simulated window. */
  readonly unitsPerWindow: readonly number[];
}

/** A unit's time: its scoring wall plus its entries' share of the window's prefetch wall. */
export function unitMs(u: UnitTime, w: WindowTime | undefined): number {
  const perEntry = w === undefined || w.entries === 0 ? 0 : w.prefetchMs / w.entries;
  return u.scoringMs + u.entries * perEntry;
}

/** The simulated windows: per window, its units' times in manifest order (merged by `mergeWindows`). */
export function layout(input: SimulationInput): number[][] {
  const merge = input.mergeWindows ?? 1;
  if (!Number.isInteger(merge) || merge < 1)
    throw new Error(
      `simulate-lanes: --merge-windows must be an integer of 1 or more, got ${merge}`,
    );
  const windowIds = [...new Set(input.units.map((u) => u.window))].sort((a, b) => a - b);
  const out: { scope: string; ms: number }[][] = [];
  windowIds.forEach((id, wi) => {
    const w = input.windows.find((x) => x.window === id);
    if (wi % merge === 0) out.push([]);
    const cur = out[out.length - 1] ?? [];
    for (const u of input.units.filter((x) => x.window === id)) {
      const last = cur[cur.length - 1];
      if (last !== undefined && last.scope === u.scope) last.ms += unitMs(u, w);
      else cur.push({ scope: u.scope, ms: unitMs(u, w) });
    }
  });
  return out.map((ws) => ws.map((u) => u.ms));
}

export function simulateLanes(input: SimulationInput): SimulationResult {
  if (!Number.isInteger(input.lanes) || input.lanes < 1)
    throw new Error(`simulate-lanes: lanes must be an integer of 1 or more, got ${input.lanes}`);
  if (input.units.length === 0)
    throw new Error("simulate-lanes: no units; an empty input would simulate a wall of 0");
  const perWindowMs: number[] = [];
  const lanesPerWindow: number[] = [];
  const windows = layout(input);
  const resident = new Set<number>([0]); // lanes that paid their start cost (their daemons stay)
  windows.forEach((units, wi) => {
    // `runScopeQueue` under the split (`tryLaunch`): lane 0 takes the first unit at 0. Lanes >= 1 are asked
    // for in index order once the gate opens (window 0: `barrierMs`; later windows: at once) and at every unit
    // end (before that lane takes its next unit). r6: lane k starts while any unit is untaken; once none is
    // left, no lane above starts in this window (the drain). A launched lane takes its unit at once.
    const gateMs = wi === 0 ? input.barrierMs : 0;
    let nextUnit = 0;
    let nextLane = 1;
    let launched = 1;
    const busyUntil = new Map<number, number>(); // lane -> the end of its current unit
    const take = (k: number, t: number): void => {
      const ms = units[nextUnit];
      if (ms === undefined) return void busyUntil.delete(k);
      nextUnit += 1;
      const start = resident.has(k) ? 0 : input.laneStartMs;
      resident.add(k);
      busyUntil.set(k, t + start + ms);
    };
    const tryLaunch = (t: number): void => {
      if (t < gateMs) return;
      while (nextLane < input.lanes) {
        if (units.length - nextUnit < 1) {
          nextLane = input.lanes;
          return;
        }
        take(nextLane, t);
        nextLane += 1;
        launched += 1;
      }
    };
    take(0, 0);
    tryLaunch(0);
    let gateAsked = gateMs <= 0;
    let end = 0;
    for (;;) {
      let lane = -1;
      let t = Number.POSITIVE_INFINITY;
      for (const [k, at] of busyUntil) if (at < t || (at === t && k < lane)) [lane, t] = [k, at];
      if (!gateAsked && gateMs <= t) {
        gateAsked = true;
        tryLaunch(gateMs);
        continue;
      }
      if (lane < 0) break;
      end = Math.max(end, t);
      tryLaunch(t);
      take(lane, t);
    }
    perWindowMs.push(end);
    lanesPerWindow.push(launched);
  });
  return {
    wallMs: perWindowMs.reduce((a, b) => a + b, 0),
    perWindowMs,
    lanesPerWindow,
    unitsPerWindow: windows.map((w) => w.length),
  };
}

function main(argv: readonly string[]): void {
  const file = argv[0];
  const flag = (name: string, dflt: number): number => {
    const i = argv.indexOf(name);
    const v = i < 0 ? undefined : argv[i + 1];
    return v === undefined ? dflt : Number(v);
  };
  if (file === undefined || file.startsWith("--")) {
    throw new Error(
      "usage: bun scripts/simulate-lanes.ts <times.json> --lanes N --barrier-ms X --lane-start-ms Y [--merge-windows M]",
    );
  }
  const t = JSON.parse(readFileSync(file, "utf8")) as {
    units: UnitTime[];
    windows: WindowTime[];
  };
  const res = simulateLanes({
    units: t.units,
    windows: t.windows,
    lanes: flag("--lanes", 3),
    barrierMs: flag("--barrier-ms", 0),
    laneStartMs: flag("--lane-start-ms", 0),
    mergeWindows: flag("--merge-windows", 1),
  });
  console.log(JSON.stringify(res));
}

if (import.meta.main) main(process.argv.slice(2));
