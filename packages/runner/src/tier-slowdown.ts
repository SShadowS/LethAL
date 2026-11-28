// PR-466 part 2 (R1228): the tier-slowdown STOP. Spec: docs/superpowers/specs/2026-11-27-pr466-tier-slowdown-stop.md.
// A passing mutant row whose own duration is far over its baseline own duration says the BC tier got slow.
// Blocks of 50 such rows; 3 blocks in a row with a median at or over 4.0 stop the session (a FIRST CUT).
import type { ResultsStore } from "./store";

export const TIER_SLOWDOWN_BLOCK = 50;
export const TIER_SLOWDOWN_STOP = 4.0;
export const TIER_SLOWDOWN_HOLD = 3;
export const TIER_SLOWDOWN_MIN_REF_MS = 50;

/** The note a degraded window carries when the slowdown stop opened it (a renew window's begins `lease-renew-unanswered:`). */
export const TIER_SLOWDOWN_REASON_PREFIX = "tier-slowdown-stop:";

/** Where the window starts: rows with an id after `afterMutantId` and events with a seq after `afterSeq`. */
export interface TierSlowdownWindow {
  readonly afterMutantId: number;
  readonly afterSeq: number;
  readonly afterSnapshotId: number;
}

export interface TierSlowdownStop extends TierSlowdownWindow {
  /** The three block medians (ratio to the baseline own duration), oldest first. */
  readonly medians: readonly number[];
}

export function medianOf(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  const mid = s[Math.floor(n / 2)];
  const low = s[Math.floor((n - 1) / 2)];
  if (mid === undefined || low === undefined) throw new Error("medianOf: no values");
  return (low + mid) / 2;
}

function ratios(medians: readonly number[]): string {
  const f = medians.map((m) => `${m.toFixed(1)}×`);
  const last = f.pop();
  return f.length === 0 ? (last ?? "") : `${f.join(", ")} and ${last}`;
}

/** The note the window's rows carry in the report and in the store. */
export function tierSlowdownNote(medians: readonly number[]): string {
  return `${TIER_SLOWDOWN_REASON_PREFIX} the BC tier slowed down (passing tests ran at ${ratios(medians)} their baseline own duration over ${TIER_SLOWDOWN_BLOCK * TIER_SLOWDOWN_HOLD} passing rows; a FIRST CUT, R1228); this verdict was recorded after the window began and is dropped: re-run it with --resume`;
}

/** The warning `tier-slowdown-stop`, naming the STORED window (`storedAfterMutantId`, `storedAfterSeq`). */
export function tierSlowdownWarning(
  stop: TierSlowdownStop,
  stored: { readonly afterMutantId: number; readonly afterSeq: number },
): string {
  const earlier =
    stored.afterMutantId < stop.afterMutantId
      ? ` An EARLIER window already stands (the slowdown began after row ${stop.afterMutantId}); the drop starts at the earlier one.`
      : "";
  return `[lethal] tier-slowdown-stop: the BC tier slowed down: passing tests ran at ${ratios(stop.medians)} their baseline own duration over the last ${TIER_SLOWDOWN_BLOCK * TIER_SLOWDOWN_HOLD} passing rows (blocks of ${TIER_SLOWDOWN_BLOCK}; threshold ${TIER_SLOWDOWN_STOP.toFixed(1)}, a FIRST CUT, R1228). The session stops scheduling. Mutant rows after row ${stored.afterMutantId} (events after ${stored.afterSeq}) are dropped from the report and re-run by --resume. Whether the tier needs a restart is not measured.${earlier}`;
}

export interface TierSlowdownDeps {
  /** The reference own duration (ms) of a test, or `undefined` when there is none. */
  readonly reference: (
    codeunitId: number,
    method: string,
    batchIndex: number,
  ) => number | undefined;
  /** The `seq` of the last `mutant-scored` event. */
  readonly scoredSeq: () => number;
  /** The id of the last baseline snapshot this process recorded. */
  readonly snapshotId: () => number;
  /** Called once, synchronously, from the `feed` that completes the third block. */
  readonly onStop: (stop: TierSlowdownStop) => void;
}

export class TierSlowdownMonitor {
  fed = 0;
  skippedNoReference = 0;
  skippedUnderMin = 0;
  #block: number[] = [];
  #blockMark: TierSlowdownWindow | undefined;
  #streak: Array<{ readonly median: number; readonly mark: TierSlowdownWindow }> = [];
  #stop: TierSlowdownStop | undefined;
  constructor(private readonly d: TierSlowdownDeps) {}

  get stop(): TierSlowdownStop | undefined {
    return this.#stop;
  }

  /**
   * One passing mutant row, fed right after its `record()` (the mutant row and its `mutant-scored` event
   * exist, so the mark of a block's first row is read here: the onset mutant is INSIDE the window).
   */
  feed(
    row: {
      readonly codeunitId: number;
      readonly method: string;
      readonly batchIndex: number;
      readonly ownMs: number;
    },
    mutantRowId: number,
  ): void {
    if (this.#stop !== undefined) return;
    const ref = this.d.reference(row.codeunitId, row.method, row.batchIndex);
    if (ref === undefined) {
      this.skippedNoReference += 1;
      return;
    }
    if (ref < TIER_SLOWDOWN_MIN_REF_MS) {
      this.skippedUnderMin += 1;
      return;
    }
    this.fed += 1;
    this.#blockMark ??= {
      afterMutantId: mutantRowId - 1,
      afterSeq: this.d.scoredSeq() - 1,
      afterSnapshotId: this.d.snapshotId(),
    };
    this.#block.push(row.ownMs / ref);
    if (this.#block.length < TIER_SLOWDOWN_BLOCK) return;
    const median = medianOf(this.#block);
    const mark = this.#blockMark;
    this.#block = [];
    this.#blockMark = undefined;
    if (median < TIER_SLOWDOWN_STOP) {
      this.#streak = [];
      return;
    }
    this.#streak.push({ median, mark });
    const [first] = this.#streak;
    if (this.#streak.length < TIER_SLOWDOWN_HOLD || first === undefined) return;
    this.#stop = { ...first.mark, medians: this.#streak.map((s) => s.median) };
    this.d.onStop(this.#stop);
  }

  /** The session-end console line (not an event: no warning set moves). */
  armingLine(): string {
    const skipped = this.skippedNoReference + this.skippedUnderMin;
    const armed = this.fed >= TIER_SLOWDOWN_BLOCK * TIER_SLOWDOWN_HOLD;
    return `[lethal] tier-slowdown monitor: fed ${this.fed} passing rows, skipped ${skipped} (no reference ${this.skippedNoReference}, under ${TIER_SLOWDOWN_MIN_REF_MS} ms ${this.skippedUnderMin}); ${armed ? "armed" : `not armed (< ${TIER_SLOWDOWN_BLOCK * TIER_SLOWDOWN_HOLD} fed)`}`;
  }
}

/**
 * The reference of a test: this run's passing baseline own duration (median of several). On a resume, the
 * SMALLER of that and the prior run's, only when both runs record the same non-null test-app hash. The
 * prior's baseline rows recorded inside its own degraded window are left out (`baselineOwnDurations`).
 * LIMITS: one level (a resume of a resume sees its direct prior); a value is read once per test (a miss is
 * asked again in a later batch).
 */
export function storeReference(
  store: ResultsStore,
  runId: number,
  priorRunId: number | undefined,
): TierSlowdownDeps["reference"] {
  const cache = new Map<string, { readonly batch: number; readonly value: number | undefined }>();
  let priorUsable: boolean | undefined;
  const usePrior = (): boolean => {
    if (priorRunId === undefined) return false;
    priorUsable ??= (() => {
      const own = store.getRun(runId)?.testAppHash;
      const prior = store.getRun(priorRunId)?.testAppHash;
      return own !== null && own !== undefined && own === prior;
    })();
    return priorUsable;
  };
  return (codeunitId, method, batch) => {
    const key = `${codeunitId}::${method.toLowerCase()}`;
    const hit = cache.get(key);
    if (hit !== undefined && (hit.value !== undefined || hit.batch === batch)) return hit.value;
    const own = store.baselineOwnDurations(runId, codeunitId, method);
    const prior =
      priorRunId !== undefined && usePrior()
        ? store.baselineOwnDurations(priorRunId, codeunitId, method)
        : [];
    const o = own.length > 0 ? medianOf(own) : undefined;
    const p = prior.length > 0 ? medianOf(prior) : undefined;
    const value = o === undefined ? p : p === undefined ? o : Math.min(o, p);
    cache.set(key, { batch, value });
    return value;
  };
}
