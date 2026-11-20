/**
 * R912: the mutant loop prefetches and scores in WINDOWS, so a stop loses at most one window; the
 * estimate of the covered mutants' test time; and the `--time-budget` clock.
 *
 * A window never changes a verdict: it only decides how many mutants one prefetch holds.
 */
import type { MutantManifestEntry } from "@lethal/schemata";
import { ENTRIES_CHUNK_CAP } from "./al-runner-v3-entries";
import type { TestMethodRef } from "./backend";
import type { RunEvent } from "./events";
import { testKeyOf } from "./selection";

/** A window holds mutants until their estimated covering-test time would pass this. */
export const WINDOW_TIME_CAP_MS = 600_000;

/**
 * PR-99 r6 (§13): the caps of a window under the split prefetch, N lanes: N times the time. Its N lanes share the
 * window, so it still takes about `WINDOW_TIME_CAP_MS` of wall, and the time budget (checked between windows) is
 * still read about that often.
 * PR-121 (a): no entries cap. Under the split each lane prefetches only its own unit, chunked per request
 * (`groupsThatFit`), so a window's entries size no request; the cap only let one dense scope fill a window alone
 * while the other lanes waited at its barrier (32.5% of lane time on a DO slice).
 */
export function splitWindowCaps(lanes: number): {
  readonly timeMs: number;
  readonly entries: number;
} {
  if (!Number.isInteger(lanes) || lanes < 1) throw new Error(`splitWindowCaps: lanes ${lanes}`);
  return { timeMs: WINDOW_TIME_CAP_MS * lanes, entries: Number.POSITIVE_INFINITY };
}

/** The estimate is worth a warning line above this. */
export const ESTIMATE_WARN_MS = 2 * 3_600_000;

/**
 * R940: what the estimate is, said beside it. It sums the covering tests' measured baseline times and
 * is neither a bound nor a forecast of the mutants phase: over nine al-runner-v3 serve runs (R-925's
 * seven apps, R-926's Withholding Tax twice) the phase took 0.74 to 5.84 times it. A kill stops at its
 * first failing test while the estimate sums them all, and a warm daemon can beat the baseline (over);
 * per-request, echo, warm-up and kill-confirm costs are not in it, and vary by app (under).
 * Measured: `/coord/handoff/R-931/estimate.ts`, `estimate.out`.
 */
export const ESTIMATE_NOT_A_BOUND =
  "not a bound or a forecast of this phase: on al-runner v3 serve it took 0.7 to 5.8 times it, R940";

export interface CostModel {
  readonly baselineDuration: ReadonlyMap<string, number>;
  readonly fallbackMs: number;
  readonly wholeCodeunit?: ((codeunitId: number) => boolean) | undefined;
}

/** Each codeunit's whole-suite baseline time: the sum of its tests' durations. */
function codeunitTotals(baselineDuration: ReadonlyMap<string, number>): Map<number, number> {
  const out = new Map<number, number>();
  for (const [key, ms] of baselineDuration) {
    const cu = Number(key.slice(0, key.indexOf("::")));
    out.set(cu, (out.get(cu) ?? 0) + ms);
  }
  return out;
}

/** One mutant's estimated covering-test time and entry count (its codeunits or tests, plus the echo). */
export function mutantCost(
  refs: readonly TestMethodRef[],
  model: CostModel,
  totals: ReadonlyMap<number, number>,
): { readonly ms: number; readonly entries: number } {
  const seen = new Set<string>();
  let ms = 0;
  for (const r of refs) {
    const whole = model.wholeCodeunit?.(r.codeunitId) === true;
    const key = whole ? `cu:${r.codeunitId}` : testKeyOf(r);
    if (seen.has(key)) continue;
    seen.add(key);
    ms += whole
      ? (totals.get(r.codeunitId) ?? model.fallbackMs)
      : (model.baselineDuration.get(testKeyOf(r)) ?? model.fallbackMs);
  }
  return { ms, entries: seen.size + 1 };
}

/**
 * The batch's mutants cut into windows, in manifest order. A window ends when the next covered
 * mutant would pass the time cap or the entry cap; a mutant over either cap goes alone. An uncovered
 * mutant costs nothing and stays in the window it falls in.
 */
export function cutWindows(
  mutants: readonly MutantManifestEntry[],
  perMutantTests: ReadonlyMap<string, readonly TestMethodRef[]>,
  model: CostModel,
  caps: { readonly timeMs: number; readonly entries: number } = {
    timeMs: WINDOW_TIME_CAP_MS,
    entries: ENTRIES_CHUNK_CAP,
  },
): MutantManifestEntry[][] {
  const totals = codeunitTotals(model.baselineDuration);
  const windows: MutantManifestEntry[][] = [];
  let cur: MutantManifestEntry[] = [];
  let ms = 0;
  let entries = 0;
  let curCovered = 0;
  for (const m of mutants) {
    const refs = perMutantTests.get(m.mutantId);
    if (refs === undefined || refs.length === 0) {
      cur.push(m);
      continue;
    }
    const c = mutantCost(refs, model, totals);
    if (curCovered > 0 && (ms + c.ms > caps.timeMs || entries + c.entries > caps.entries)) {
      windows.push(cur);
      cur = [];
      ms = 0;
      entries = 0;
      curCovered = 0;
    }
    cur.push(m);
    ms += c.ms;
    entries += c.entries;
    curCovered += 1;
  }
  if (cur.length > 0) windows.push(cur);
  return windows;
}

/** The estimate before the mutant phase: covered mutants and their summed covering-test time. */
export function estimateCovered(
  mutants: readonly MutantManifestEntry[],
  perMutantTests: ReadonlyMap<string, readonly TestMethodRef[]>,
  model: CostModel,
): { readonly covered: number; readonly ms: number } {
  const totals = codeunitTotals(model.baselineDuration);
  let covered = 0;
  let ms = 0;
  for (const m of mutants) {
    const refs = perMutantTests.get(m.mutantId);
    if (refs === undefined || refs.length === 0) continue;
    covered += 1;
    ms += mutantCost(refs, model, totals).ms;
  }
  return { covered, ms };
}

/** "2.5 h", "7.2 min" or "41 s". */
export function formatEstimate(ms: number): string {
  if (ms >= 3_600_000) return `${(ms / 3_600_000).toFixed(1)} h`;
  if (ms >= 60_000) return `${(ms / 60_000).toFixed(1)} min`;
  return `${Math.round(ms / 1000)} s`;
}

/** The `--time-budget` clock of one session, shared by every batch. */
/** R948: what the memory guard saw when it stopped the session. */
export interface MemoryStop {
  readonly usedBytes: number;
  readonly boundBytes: number;
  /** The cgroup file the limit came from. */
  readonly source: string;
}

/** PR-250: the lane whose daemon churned, and its closes in a row with no mutant scored. */
export interface DaemonChurnStop {
  readonly lane: number;
  readonly closes: number;
}

/**
 * PR-250 (the owner): this many serve-daemon closes in a row on one lane, in the mutant phase, with no
 * mutant scored anywhere in the session in between, stop the session (`al-runner-v3-daemon-churn`).
 * From the events: y2 and y3 reached at most 6 per lane, PERF-10b's churn 10 at minute 42 (the spec).
 */
export const V3_DAEMON_CHURN_CLOSES = 10;

/**
 * PR-250: the churn guard over the session's event stream. `see` returns the stop on the close that
 * reaches `V3_DAEMON_CHURN_CLOSES` on one lane, once; a `mutant-scored` resets every lane. Only closes in
 * the `mutants` phase count (by `phase-entered`; the close's own `phase` says `baseline` for a coverage
 * window or an echo request too, so it is not read).
 */
export class DaemonChurnGuard {
  private readonly runs = new Map<number, number>();
  private inMutants = false;
  private tripped = false;
  see(e: RunEvent): DaemonChurnStop | undefined {
    if (e.type === "phase-entered") this.inMutants = e.phase === "mutants";
    else if (e.type === "mutant-scored") this.runs.clear();
    else if (e.type === "serve-daemon-closed" && this.inMutants && !this.tripped) {
      const lane = e.lane ?? 0;
      const closes = (this.runs.get(lane) ?? 0) + 1;
      this.runs.set(lane, closes);
      if (closes >= V3_DAEMON_CHURN_CLOSES) {
        this.tripped = true;
        return { lane, closes };
      }
    }
    return undefined;
  }
}

export class TimeBudget {
  /** Set by the first `reach`; later calls change nothing. */
  reached:
    | {
        readonly unscheduledCount: number;
        readonly firstUnstartedBatch: number;
        /** R955: set when the budget ran out inside a baseline: its tests run and total. */
        readonly baselineStopped?: {
          readonly testsRun: number;
          readonly testsTotal: number;
          readonly inAutoRebaseline?: true;
        };
      }
    | undefined;
  constructor(
    readonly seconds: number,
    private readonly startMs: number,
    private readonly now: () => number,
  ) {}
  /** R955: set by `stop()` (a SIGTERM or SIGINT); the budget is then spent, whatever the clock says. */
  signalled = false;
  /** R955: spend the budget now. A session with no `--time-budget` has `seconds` of Infinity. */
  stop(): void {
    this.signalled = true;
  }
  /**
   * R948: set by the memory guard: the container stayed over its bound. It spends the budget like a
   * signal (every R955 check and after-call drop applies); the report names memory, not a signal.
   */
  memory: MemoryStop | undefined;
  stopForMemory(info: MemoryStop): void {
    this.memory ??= info;
    this.stop();
  }
  /**
   * PR-250: set by the daemon-churn guard: one lane's serve daemon closed `closes` times in a row with no
   * mutant scored. Spent like the memory guard's stop (it kills nothing); the report names the churn.
   */
  churn: DaemonChurnStop | undefined;
  stopForChurn(info: DaemonChurnStop): void {
    this.churn ??= info;
    this.stop();
  }
  /** A guard (memory, churn) spent the budget, not a signal: nothing in flight was killed. */
  get byGuard(): boolean {
    return this.memory !== undefined || this.churn !== undefined;
  }
  remainingMs(): number {
    if (this.signalled) return 0;
    return this.startMs + this.seconds * 1000 - this.now();
  }
  get exhausted(): boolean {
    return this.reached !== undefined || this.remainingMs() <= 0;
  }
  /** `firstUnstartedBatch`: the first batch index the session never started. */
  reach(
    unscheduledCount: number,
    firstUnstartedBatch: number,
    baselineStopped?: {
      readonly testsRun: number;
      readonly testsTotal: number;
      readonly inAutoRebaseline?: true;
    },
  ): void {
    this.reached ??= {
      unscheduledCount,
      firstUnstartedBatch,
      ...(baselineStopped !== undefined ? { baselineStopped } : {}),
    };
  }
}
