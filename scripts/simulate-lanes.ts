/**
 * PR-99 (spec 2026-11-16-pr96-split-prefetch, section 10.2): the scheduling bound for an N-lane run, from the
 * per-unit numbers an N = 1 run records.
 *
 *   bun scripts/simulate-lanes.ts <times.json> --lanes 3 --barrier-ms 90000 --lane-start-ms 35000
 *
 * `times.json` is `{ "units": [...], "windows": [...] }` (the backend's `unitTimings()`; an N = 1 run writes it
 * to the file `LETHAL_UNIT_TIMES_OUT` names, only when that is set). Per unit: its scoring wall plus its share of its
 * window's prefetch wall (its entries x the window's prefetch wall per entry). The simulation is
 * `runScopeQueue`'s real greedy under the split, in MANIFEST order (not longest-first): a free lane takes the
 * next unit, and lanes >= 1 start by `tryLaunch`'s rules (the gate, k + 1 untaken units, the drain; spec §11).
 * Windows run one after another. `--barrier-ms` is when the lane gate opens in the first window: lane 0's
 * first MEASURED request after the barrier (PR-98's gate needs a peak reading; a warm-up gives none). A lane's
 * first unit also pays the per-lane start cost, once (its daemons then stay resident).
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
}
export interface SimulationResult {
  readonly wallMs: number;
  readonly perWindowMs: readonly number[];
  /** The lanes that took a unit in each window (the floor "lanes started" reads it). */
  readonly lanesPerWindow: readonly number[];
}

/** A unit's time: its scoring wall plus its entries' share of the window's prefetch wall. */
export function unitMs(u: UnitTime, w: WindowTime | undefined): number {
  const perEntry = w === undefined || w.entries === 0 ? 0 : w.prefetchMs / w.entries;
  return u.scoringMs + u.entries * perEntry;
}

export function simulateLanes(input: SimulationInput): SimulationResult {
  if (!Number.isInteger(input.lanes) || input.lanes < 1)
    throw new Error(`simulate-lanes: lanes must be an integer of 1 or more, got ${input.lanes}`);
  if (input.units.length === 0)
    throw new Error("simulate-lanes: no units; an empty input would simulate a wall of 0");
  const windowIds = [...new Set(input.units.map((u) => u.window))].sort((a, b) => a - b);
  const perWindowMs: number[] = [];
  const lanesPerWindow: number[] = [];
  const resident = new Set<number>([0]); // lanes that paid their start cost (their daemons stay)
  windowIds.forEach((id, wi) => {
    const w = input.windows.find((x) => x.window === id);
    const units = input.units.filter((u) => u.window === id);
    // `runScopeQueue` under the split (`tryLaunch`): lane 0 takes the first unit at 0. Lanes >= 1 are asked
    // for in index order once the gate opens (window 0: `barrierMs`; later windows: at once) and at every unit
    // end (before that lane takes its next unit). Lane k starts only while at least k + 1 units are untaken;
    // once short, no lane above starts in this window (the drain). A launched lane takes its unit at once.
    const gateMs = wi === 0 ? input.barrierMs : 0;
    let nextUnit = 0;
    let nextLane = 1;
    const busyUntil = new Map<number, number>(); // lane -> the end of its current unit
    const take = (k: number, t: number): void => {
      const u = units[nextUnit];
      if (u === undefined) return void busyUntil.delete(k);
      nextUnit += 1;
      const start = resident.has(k) ? 0 : input.laneStartMs;
      resident.add(k);
      busyUntil.set(k, t + start + unitMs(u, w));
    };
    const tryLaunch = (t: number): void => {
      if (t < gateMs) return;
      while (nextLane < input.lanes) {
        if (units.length - nextUnit < nextLane + 1) {
          nextLane = input.lanes;
          return;
        }
        take(nextLane, t);
        nextLane += 1;
        launched += 1;
      }
    };
    let launched = 1;
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
  return { wallMs: perWindowMs.reduce((a, b) => a + b, 0), perWindowMs, lanesPerWindow };
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
      "usage: bun scripts/simulate-lanes.ts <times.json> --lanes N --barrier-ms X --lane-start-ms Y",
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
  });
  console.log(JSON.stringify(res));
}

if (import.meta.main) main(process.argv.slice(2));
