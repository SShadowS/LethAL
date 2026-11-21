import { appendFileSync, writeFileSync } from "node:fs";

/**
 * PR-298 (R1148): a measure-only trace of the raw baseline reach of every mutant scored in a
 * session. Off unless `LETHAL_REACH_TRACE=<file>` (or `SessionConfig.reachTrace`) is set; it never
 * changes a verdict, the report or the events.
 */

/** Why a reach could not be decided (`null` reach). */
export type ReachNullCause =
  | "non-statement-grain"
  | "all-green"
  | "no-line-evidence"
  | "mode-moved"
  | "empty-set"
  | "other";

export interface ReachTraceRow {
  readonly file: string;
  readonly startLine: number;
  readonly operatorName: string;
  readonly startIndex: number;
  readonly endIndex: number;
  readonly verdict: string;
  readonly reachGrain: string | null;
  readonly reachLine: number | null;
  readonly killingTest: string | null;
  /** `guardReached` of the baseline reach over ALL the mutant's covering tests; null: undecided. */
  readonly reachOverCovering: boolean | null;
  /** The same over the covering tests that ran (what `reachFinal` reads today). */
  readonly reachOverRan: boolean | null;
  /** Whether the killer's own baseline hit `reachLine`; null: no killer, or unknown. */
  readonly killerBaselineHit: boolean | null;
  readonly nullCause: ReachNullCause | null;
  /** The report's `guardReached`; null: undecided. */
  readonly reachFinal: boolean | null;
}

/** A trace that was asked for and cannot be trusted: a refused flag combination or a row-count mismatch. */
export class ReachTraceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReachTraceError";
  }
}

type SiteKeyed = Pick<
  ReachTraceRow,
  "file" | "startLine" | "operatorName" | "startIndex" | "endIndex"
>;

export const reachSiteKey = (s: SiteKeyed): string =>
  JSON.stringify([s.file, s.startLine, s.operatorName, s.startIndex, s.endIndex]);

export class ReachTrace {
  /** Rows written, per site key. */
  readonly written = new Map<string, number>();
  private readonly staged = new Map<string, ReachTraceRow>();

  constructor(readonly path: string) {}

  /** The trace the environment asks for, or `undefined` when the knob is unset. */
  static fromEnv(env: Record<string, string | undefined>): ReachTrace | undefined {
    const path = env.LETHAL_REACH_TRACE;
    return path === undefined || path === "" ? undefined : new ReachTrace(path);
  }

  /** Truncates the file: one session, one trace. */
  start(): void {
    writeFileSync(this.path, "");
  }

  /** The mutant loop's full row, held until the mutant's `mutant-scored` event writes it. */
  stage(mutantId: string, row: ReachTraceRow): void {
    this.staged.set(mutantId, row);
  }

  /** The row a scored mutant gets when the loop staged none (no coverage, an error row, ...). */
  takeStaged(mutantId: string): ReachTraceRow | undefined {
    const row = this.staged.get(mutantId);
    this.staged.delete(mutantId);
    return row;
  }

  /** Synchronous, so a killed session loses no row it had scored. */
  append(row: ReachTraceRow): void {
    appendFileSync(this.path, `${JSON.stringify(row)}\n`);
    const key = reachSiteKey(row);
    this.written.set(key, (this.written.get(key) ?? 0) + 1);
  }

  /** Rows written must equal mutants scored, per site key. */
  verify(scored: ReadonlyMap<string, number>): void {
    const bad: string[] = [];
    for (const key of new Set([...scored.keys(), ...this.written.keys()])) {
      const s = scored.get(key) ?? 0;
      const w = this.written.get(key) ?? 0;
      if (s !== w) bad.push(`${key}: scored ${s}, traced ${w}`);
    }
    if (bad.length > 0) {
      throw new ReachTraceError(
        `reach-trace-count-mismatch: ${this.path} does not hold one row per scored mutant (${bad.length} site(s) differ: ${bad.slice(0, 5).join("; ")}) (PR-298)`,
      );
    }
  }
}
