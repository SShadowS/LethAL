// PR-466 part 2 (R1228): the tier-slowdown monitor. Spec: docs/superpowers/specs/2026-11-27-pr466-tier-slowdown-stop.md (r5).
// A passing mutant row whose own duration is far over its baseline own duration says the BC tier got slow.
// Every such row is stamped with a monotonic time. After every 50th row, the median ratio of the rows of the last
// 60 minutes is checked (a FIRST CUT). By default the monitor only SHADOWS: it records that it would have stopped.
import { readFileSync } from "node:fs";
import type { ResultsStore } from "./store";

export const TIER_SLOWDOWN_WINDOW_MS = 3_600_000;
export const TIER_SLOWDOWN_CHECK_EVERY = 50;
export const TIER_SLOWDOWN_MIN_ROWS = 50;
export const TIER_SLOWDOWN_STOP = 2.5;
export const TIER_SLOWDOWN_MAX_PSI = 20;
export const TIER_SLOWDOWN_MIN_REF_MS = 50;

/** The note a degraded window carries when the slowdown stop opened it (a renew window's begins `lease-renew-unanswered:`). */
export const TIER_SLOWDOWN_REASON_PREFIX = "tier-slowdown-stop:";

/** Where the window starts: rows with an id after `afterMutantId` and events with a seq after `afterSeq`. */
export interface TierSlowdownWindow {
  readonly afterMutantId: number;
  readonly afterSeq: number;
  readonly afterSnapshotId: number;
}

/** What the texts print: the window's median ratio, its row count and span, and the host's CPU pressure (percent). */
export interface TierSlowdownReading {
  readonly median: number;
  readonly rows: number;
  readonly spanMs: number;
  readonly psi: number;
}

/** A trigger: the figures at the check, and the window that starts at the onset row. */
export interface TierSlowdownStop extends TierSlowdownWindow, TierSlowdownReading {
  /** Milliseconds from the session's first fed row to the check (monotonic). */
  readonly atMs: number;
  /** `/proc/loadavg` load1 at the check, or `null` when unreadable (never 0). */
  readonly load1: number | null;
}

/** The figures of a shadow trigger, as the event and `SessionReport.tierSlowdownWouldStop` carry them. */
export interface TierSlowdownWouldStop {
  readonly atMs: number;
  readonly median: number;
  readonly rows: number;
  readonly spanMs: number;
  readonly psi: number;
  readonly load1: number | null;
  readonly onsetMutantId: number;
  readonly onsetSeq: number;
}

export function medianOf(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  const mid = s[Math.floor(n / 2)];
  const low = s[Math.floor((n - 1) / 2)];
  if (mid === undefined || low === undefined) throw new Error("medianOf: no values");
  return (low + mid) / 2;
}

/** `some avg60=` of `/proc/pressure/cpu` text, in percent; `null` when the text has none. */
export function parsePsiCpuAvg60(text: string): number | null {
  const m = /^some\s.*\bavg60=(\d+(?:\.\d+)?)/m.exec(text);
  const v = m?.[1];
  return v === undefined ? null : Number(v);
}

/** The host's CPU pressure, or `null` on ANY read error (never 0: an unreadable PSI never triggers). */
export function readPsiCpuAvg60(
  read: () => string = () => readFileSync("/proc/pressure/cpu", "utf8"),
): number | null {
  try {
    return parsePsiCpuAvg60(read());
  } catch {
    return null;
  }
}

/** `/proc/loadavg`'s load1, or `null` on any read error or odd text (never 0). */
export function readLoad1(
  read: () => string = () => readFileSync("/proc/loadavg", "utf8"),
): number | null {
  try {
    const t = read().trim().split(/\s+/)[0];
    if (t === undefined || t === "") return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

const minutesOf = (ms: number): number => Math.round(ms / 60_000);

/** The note the window's rows carry in the report and in the store. */
export function tierSlowdownNote(r: TierSlowdownReading): string {
  return `${TIER_SLOWDOWN_REASON_PREFIX} the BC tier slowed down (passing tests ran at ${r.median.toFixed(1)}× their baseline own duration, the median of the last ${r.rows} passing rows over ${minutesOf(r.spanMs)} min, host CPU pressure ${r.psi.toFixed(1)}%; a FIRST CUT, R1228); this verdict was recorded after the window began and is dropped: re-run it with --resume`;
}

/** The warning `tier-slowdown-stop`, naming the STORED window (`storedAfterMutantId`, `storedAfterSeq`). */
export function tierSlowdownWarning(
  stop: TierSlowdownReading & { readonly afterMutantId: number },
  stored: { readonly afterMutantId: number; readonly afterSeq: number },
): string {
  const earlier =
    stored.afterMutantId < stop.afterMutantId
      ? ` An EARLIER window already stands (the slowdown began after row ${stop.afterMutantId}); the drop starts at the earlier one.`
      : "";
  return `[lethal] tier-slowdown-stop: the BC tier slowed down: passing tests ran at ${stop.median.toFixed(1)}× their baseline own duration (the median of the last ${stop.rows} passing rows over ${minutesOf(stop.spanMs)} min; threshold ${TIER_SLOWDOWN_STOP.toFixed(1)}, host CPU pressure ${stop.psi.toFixed(1)}%, a FIRST CUT, R1228). The session stops scheduling. Mutant rows after row ${stored.afterMutantId} (events after ${stored.afterSeq}) are dropped from the report and re-run by --resume. Whether the tier needs a restart is not measured.${earlier}`;
}

/** The shadow mode's one console line. */
export function tierSlowdownWouldStopLine(
  s: TierSlowdownReading & { readonly afterMutantId: number },
): string {
  return `[lethal] tier-slowdown-would-stop (shadow: nothing was stopped, R1228): passing tests ran at ${s.median.toFixed(1)}× their baseline own duration (the median of the last ${s.rows} passing rows over ${minutesOf(s.spanMs)} min; threshold ${TIER_SLOWDOWN_STOP.toFixed(1)}, host CPU pressure ${s.psi.toFixed(1)}%). The slowdown began after row ${s.afterMutantId}. Pass --tier-slowdown-stop to make this stop the session.`;
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
  /** A monotonic clock in ms (`clock.mono`): never the wall clock. */
  readonly now: () => number;
  /** The host's CPU pressure `some avg60` in percent; `null` when unreadable. */
  readonly psi: () => number | null;
  /** The host's load1; `null` when unreadable. */
  readonly load1: () => number | null;
  /** True when a trigger stops the session (`--tier-slowdown-stop`); false in shadow mode. */
  readonly stopMode: boolean;
  /** Called once, synchronously, from the `feed` whose check triggers. */
  readonly onTrigger: (stop: TierSlowdownStop) => void;
}

interface FedRow {
  readonly t: number;
  readonly ratio: number;
  readonly mark: TierSlowdownWindow;
}

export class TierSlowdownMonitor {
  fed = 0;
  skippedNoReference = 0;
  skippedUnderMin = 0;
  checks = 0;
  psiUnreadable = 0;
  /** The highest window median any check saw (`undefined` before the first check). */
  highestMedian: number | undefined;
  /** The PSI read when the baseline ended (`undefined` when never read, `null` when unreadable). */
  baselinePsi: number | null | undefined;
  /**
   * PR-466 review S1: errors caught in SHADOW mode (a store read, the trigger's emit, the console line). Shadow changes
   * nothing, a failure of the monitor included: it is counted here and printed on the arming line, never rethrown.
   */
  shadowErrors = 0;
  firstShadowError: string | undefined;

  noteShadowError(e: unknown): void {
    this.shadowErrors += 1;
    this.firstShadowError ??= e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  }
  #rows: FedRow[] = [];
  #firstT: number | undefined;
  #trigger: TierSlowdownStop | undefined;
  constructor(private readonly d: TierSlowdownDeps) {}

  /** The trigger, whatever the mode (it is set once per session). */
  get triggered(): TierSlowdownStop | undefined {
    return this.#trigger;
  }

  /** The stop that spends the budget and opens a window: the trigger, in stop mode only. */
  get stop(): TierSlowdownStop | undefined {
    return this.d.stopMode ? this.#trigger : undefined;
  }

  get stopMode(): boolean {
    return this.d.stopMode;
  }

  /** Called when a baseline ends; the FIRST call remembers the host's PSI, for the arming line (a loaded baseline hides a slowdown). */
  noteBaselineEnd(): void {
    if (this.baselinePsi === undefined) this.baselinePsi = this.d.psi();
  }

  /**
   * One passing mutant row, fed right after its `record()` (the mutant row and its `mutant-scored` event
   * exist, so the row's mark is read here: the onset mutant is INSIDE the window).
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
    if (this.#trigger !== undefined) return; // once per session: later rows are only counted
    const t = this.d.now();
    this.#firstT ??= t;
    this.#rows.push({
      t,
      ratio: row.ownMs / ref,
      mark: {
        afterMutantId: mutantRowId - 1,
        afterSeq: this.d.scoredSeq() - 1,
        afterSnapshotId: this.d.snapshotId(),
      },
    });
    if (this.fed % TIER_SLOWDOWN_CHECK_EVERY === 0) this.#check(t, this.#firstT);
  }

  #check(now: number, firstT: number): void {
    // W: the fed rows of the last 60 minutes, ending at this row.
    const cutoff = now - TIER_SLOWDOWN_WINDOW_MS;
    let drop = 0;
    while (drop < this.#rows.length && (this.#rows[drop]?.t ?? now) < cutoff) drop += 1;
    if (drop > 0) this.#rows = this.#rows.slice(drop);
    const w = this.#rows;
    const first = w[0];
    this.checks += 1;
    const psi = this.d.psi();
    if (psi === null) this.psiUnreadable += 1;
    if (first === undefined) return;
    const median = medianOf(w.map((r) => r.ratio));
    if (this.highestMedian === undefined || median > this.highestMedian)
      this.highestMedian = median;
    if (now - firstT < TIER_SLOWDOWN_WINDOW_MS) return; // the window is not full
    if (w.length < TIER_SLOWDOWN_MIN_ROWS) return;
    if (median < TIER_SLOWDOWN_STOP) return;
    if (psi === null || psi >= TIER_SLOWDOWN_MAX_PSI) return; // an unreadable PSI never triggers
    this.#trigger = {
      ...first.mark,
      median,
      rows: w.length,
      spanMs: now - first.t,
      psi,
      atMs: now - firstT,
      load1: this.d.load1(),
    };
    this.#rows = [];
    this.d.onTrigger(this.#trigger);
  }

  /** The session-end console line (not an event: no warning set moves). */
  armingLine(): string {
    const skipped = this.skippedNoReference + this.skippedUnderMin;
    const high = this.highestMedian === undefined ? "none" : `${this.highestMedian.toFixed(2)}×`;
    const base =
      this.baselinePsi === undefined || this.baselinePsi === null
        ? "unread"
        : `${this.baselinePsi.toFixed(1)}%`;
    const errors =
      this.shadowErrors === 0
        ? ""
        : `; ${this.shadowErrors} monitor error(s) caught in shadow mode (first: ${this.firstShadowError ?? "?"})`;
    return `[lethal] tier-slowdown monitor: mode ${this.d.stopMode ? "stop" : "shadow"}; fed ${this.fed} passing rows, skipped ${skipped} (no reference ${this.skippedNoReference}, under ${TIER_SLOWDOWN_MIN_REF_MS} ms ${this.skippedUnderMin}); ${this.checks} check(s), highest window median ${high}, PSI unreadable ${this.psiUnreadable} time(s), baseline PSI ${base}; ${this.#trigger === undefined ? "not triggered" : "TRIGGERED"}${errors}`;
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
