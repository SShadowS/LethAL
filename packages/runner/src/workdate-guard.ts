/**
 * R1131 (PR-196): the start-WorkDate guard of the bcdev backend.
 *
 * Control app 1.0.0.28 returns the start WorkDate each method ran under. A batch's baseline fixes ONE date; any
 * later test-running answer on another date is not scored (a moved start date can change a test's verdict), and
 * neither is anything after it in that batch (ruling A: no re-baseline path). The rows read `error` /
 * `workdate-changed`; a date move can cost a verdict, never invent one.
 */
import type { TestMethodRef, TestVerdict } from "./backend";

/** Two baseline calls of one batch disagreed on the start WorkDate: the batch's baseline is unusable. */
export class BaselineWorkDateUnstableError extends Error {
  constructor(
    readonly first: string,
    readonly second: string,
    readonly ref: TestMethodRef,
  ) {
    super(
      `BaselineWorkDateUnstableError: the baseline's calls disagree on the start WorkDate: ${first}, then ${second} at ${ref.codeunitName}.${ref.method}. No mutant runs on an unstable baseline (R1131). Re-run when no posting or midnight crossing moves the date.`,
    );
    this.name = "BaselineWorkDateUnstableError";
  }
}

/** The one date shared by the verdicts that carry one, or `undefined` when none does or two differ. */
export function commonWorkDate(
  rows: readonly { readonly verdict: Pick<TestVerdict, "workDate"> }[],
): string | undefined {
  let found: string | undefined;
  for (const { verdict } of rows) {
    const d = verdict.workDate;
    if (d === undefined) continue;
    if (found !== undefined && found !== d) return undefined;
    found = d;
  }
  return found;
}

export class WorkDateGuard {
  /** The session's first test-running answer's date: what a reused snapshot must equal. */
  private sessionDate: string | undefined;
  /** The current batch's baseline date. */
  private baselineDate: string | undefined;
  private inBaseline = false;
  /** Set by the first answer of the batch on another date; every later answer is then refused. */
  private moved: { readonly from: string; readonly to: string } | undefined;

  /** `enabled` is false in hub mode: the answers are not compared and nothing is recorded. */
  constructor(private readonly enabled: boolean) {}

  /** A fresh session on a reused backend. */
  resetSession(): void {
    this.sessionDate = undefined;
    this.baselineDate = undefined;
    this.moved = undefined;
  }

  /** The batch's baseline bracket (`baselinePhase`): a new batch starts with no date and no move. */
  baselinePhase(on: boolean): void {
    this.inBaseline = on;
    if (on) {
      this.baselineDate = undefined;
      this.moved = undefined;
    }
  }

  /** The baseline date of the current batch, `undefined` in hub mode or when no answer carried one. */
  batchWorkDate(): string | undefined {
    return this.enabled ? this.baselineDate : undefined;
  }

  /** A reused snapshot stands in for the batch's baseline calls: its date is the batch's. */
  noteReused(rows: readonly { readonly verdict: Pick<TestVerdict, "workDate"> }[]): void {
    if (!this.enabled) return;
    const d = commonWorkDate(rows);
    if (d === undefined) return;
    this.baselineDate = d;
    this.sessionDate ??= d;
  }

  /** Why a snapshot measured on `snapshotDate` is not reused, or `undefined` when it is. */
  refuseReuse(snapshotDate: string | undefined): string | undefined {
    if (!this.enabled) return undefined;
    if (snapshotDate === undefined) {
      return "it records no start WorkDate (stored before control app 1.0.0.28, or no baseline call carried one), so its baseline cannot be compared with this session's (R1131)";
    }
    if (this.sessionDate !== undefined && this.sessionDate !== snapshotDate) {
      return `it ran on start WorkDate ${snapshotDate} and this session's calls start on ${this.sessionDate} (R1131)`;
    }
    return undefined;
  }

  /**
   * Check one test-running answer. Returns it unchanged, an `error` row (`workDateRefusal`) when the date moved
   * from the batch's baseline (or moved earlier in the batch), and throws `BaselineWorkDateUnstableError` when
   * two baseline calls disagree. An answer with no `workDate` (no test ran) passes through untouched.
   */
  check(v: TestVerdict): TestVerdict {
    const d = v.workDate;
    if (!this.enabled || d === undefined) return v;
    this.sessionDate ??= d;
    if (this.inBaseline) {
      if (this.baselineDate === undefined) this.baselineDate = d;
      else if (this.baselineDate !== d)
        throw new BaselineWorkDateUnstableError(this.baselineDate, d, v.ref);
      return v;
    }
    // ponytail: with no baseline date at all (no dated baseline answer) the first answer fixes it; no
    // mutant is sent on a batch with no green baseline test, so this is not reached in a real run.
    this.baselineDate ??= d;
    if (this.moved === undefined && d !== this.baselineDate) {
      this.moved = { from: this.baselineDate, to: d };
    }
    if (this.moved === undefined) return v;
    const { from, to } = this.moved;
    const why =
      d !== this.baselineDate
        ? `${v.ref.method} started on WorkDate ${d}, the batch's baseline on ${from}`
        : `an earlier answer in this batch started on WorkDate ${to}, the batch's baseline on ${from}, so ${v.ref.method} (WorkDate ${d}) is not scored either`;
    return {
      ref: v.ref,
      outcome: "error",
      durationMs: v.durationMs,
      failureMessage: `workdate-changed: ${why}; a start date that moved can change a test's verdict, so the answer is not scored. The rest of this batch is not scored; re-run with --resume (R1131)`,
      workDate: d,
      workDateRefusal: "workdate-changed",
      ...(v.attestation !== undefined ? { attestation: v.attestation } : {}),
    };
  }
}
