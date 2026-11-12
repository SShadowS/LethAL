/**
 * R912: the mutant loop prefetches and scores in WINDOWS, so a stop loses at most one window; the
 * estimate of the covered mutants' test time; and the `--time-budget` clock.
 *
 * A window never changes a verdict: it only decides how many mutants one prefetch holds.
 */
import type { MutantManifestEntry } from "@lethal/schemata";
import { ENTRIES_CHUNK_CAP } from "./al-runner-v3-entries";
import type { TestMethodRef } from "./backend";
import { testKeyOf } from "./selection";

/** A window holds mutants until their estimated covering-test time would pass this. */
export const WINDOW_TIME_CAP_MS = 600_000;

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
export class TimeBudget {
  /** Set by the first `reach`; later calls change nothing. */
  reached:
    | {
        readonly unscheduledCount: number;
        readonly firstUnstartedBatch: number;
        /** R955: set when the budget ran out inside a baseline: its tests run and total. */
        readonly baselineStopped?: { readonly testsRun: number; readonly testsTotal: number };
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
    baselineStopped?: { readonly testsRun: number; readonly testsTotal: number },
  ): void {
    this.reached ??= {
      unscheduledCount,
      firstUnstartedBatch,
      ...(baselineStopped !== undefined ? { baselineStopped } : {}),
    };
  }
}
