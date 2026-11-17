/**
 * PR-99 (spec 2026-11-16-pr96-split-prefetch, section 10.2): the scheduling bound for an N-lane run, from the
 * per-unit numbers an N = 1 run records.
 *
 *   bun scripts/simulate-lanes.ts <times.json> --lanes 3 --barrier-ms 90000 --lane-start-ms 35000
 *
 * `times.json` is `{ "units": [...], "windows": [...] }` (the backend's `unitTimings()`; the N = 1 run prints
 * it as the line "al-runner-v3 unit times (PR-99 ...)"). Per unit: its scoring wall plus its share of its
 * window's prefetch wall (its entries x the window's prefetch wall per entry). The simulation is
 * `runScopeQueue`'s real greedy, in MANIFEST order (not longest-first): a free lane takes the next unit.
 * Windows run one after another. Lane 0 starts at 0; in the first window lane k >= 1 starts at the barrier
 * time plus the measured per-lane start cost (their daemons then stay resident).
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
  /** When lane 0's session-first warm-up passes (ms after the first window starts). */
  readonly barrierMs: number;
  /** A lane above 0's own start cost (its first daemon's recompile and lazy proof). */
  readonly laneStartMs: number;
}
export interface SimulationResult {
  readonly wallMs: number;
  readonly perWindowMs: readonly number[];
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
  windowIds.forEach((id, wi) => {
    const w = input.windows.find((x) => x.window === id);
    const units = input.units.filter((u) => u.window === id);
    // Lane free times, relative to the window's start.
    const free = Array.from({ length: input.lanes }, (_, k) =>
      wi === 0 && k > 0 ? input.barrierMs + input.laneStartMs : 0,
    );
    let end = 0;
    for (const u of units) {
      let best = 0;
      for (let k = 1; k < free.length; k++) if ((free[k] ?? 0) < (free[best] ?? 0)) best = k;
      const done = (free[best] ?? 0) + unitMs(u, w);
      free[best] = done;
      end = Math.max(end, done);
    }
    perWindowMs.push(end);
  });
  return { wallMs: perWindowMs.reduce((a, b) => a + b, 0), perWindowMs };
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
