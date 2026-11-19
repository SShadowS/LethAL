/**
 * R1131 (PR-196): the start-WorkDate guard of the bcdev backend.
 *
 * Control app 1.0.0.28 returns the start WorkDate each method ran under, and `HarnessInfo` returns the date a
 * test-running call would start on now. A batch's baseline fixes ONE date; any later test-running answer on
 * another date is not scored (a moved start date can change a test's verdict), and neither is anything after it
 * in that batch (ruling A: no re-baseline path). The rows read `error` / `workdate-changed`; a date move can cost
 * a verdict, never invent one.
 */
import type { TestMethodRef, TestVerdict } from "./backend";

/** Two baseline calls of one batch disagreed on the start WorkDate: the session stops, by name. */
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

/** A test-running answer arrived in a batch that has no baseline date: nothing to compare it with. */
export class NoBaselineWorkDateError extends Error {
  constructor(
    readonly date: string,
    readonly ref: TestMethodRef,
  ) {
    super(
      `NoBaselineWorkDateError: ${ref.codeunitName}.${ref.method} answered on start WorkDate ${date}, but this batch has no baseline date to compare it with (no dated baseline call, and no reused snapshot). A mutant's answer never sets the batch's date (R1131).`,
    );
    this.name = "NoBaselineWorkDateError";
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
  /** The current batch's baseline date: from its live baseline answers, or the COMPARED date on reuse. */
  private baselineDate: string | undefined;
  /** The fresh date a reuse decision accepted, handed to the batch by `noteReused`. */
  private compared: string | undefined;
  private inBaseline = false;
  /** Set by the first answer of the batch on another date; every later answer is then refused. */
  private moved: { readonly from: string; readonly to: string } | undefined;

  /** `enabled` is false in hub mode: the answers are not compared and nothing is recorded. */
  constructor(private readonly enabled: boolean) {}

  /** A fresh session on a reused backend. */
  resetSession(): void {
    this.baselineDate = undefined;
    this.compared = undefined;
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

  /** The baseline date of the current batch, `undefined` in hub mode or when none is known. */
  batchWorkDate(): string | undefined {
    return this.enabled ? this.baselineDate : undefined;
  }

  /**
   * A reused snapshot stands in for the batch's baseline calls: the batch's date is the date the reuse decision
   * COMPARED (the fresh read, equal to the snapshot's), never one re-derived from the surviving rows.
   */
  noteReused(): void {
    if (!this.enabled) return;
    if (this.compared === undefined) {
      throw new Error(
        "WorkDateGuard.noteReused: no reuse decision accepted a date first — caller-contract violation (R1131)",
      );
    }
    this.baselineDate = this.compared;
    this.compared = undefined;
  }

  /**
   * Why a snapshot measured on `snapshotDate` is not reused, or `undefined` when it is. `fresh` is the server's
   * date read at this batch's deploy (`HarnessInfo`): reuse needs it present and equal to the snapshot's.
   */
  refuseReuse(snapshotDate: string | undefined, fresh: string | undefined): string | undefined {
    if (!this.enabled) return undefined;
    this.compared = undefined;
    if (snapshotDate === undefined) {
      return "it records no start WorkDate (stored before control app 1.0.0.28, or no baseline call carried one), so its baseline cannot be compared with this session's (R1131)";
    }
    if (fresh === undefined) {
      return "this batch's deploy read no fresh start WorkDate from the server, so the snapshot's cannot be compared (R1131)";
    }
    if (fresh !== snapshotDate) {
      return `it ran on start WorkDate ${snapshotDate} and the server's start date is now ${fresh} (R1131)`;
    }
    this.compared = fresh;
    return undefined;
  }

  /**
   * Check one test-running answer. Returns it unchanged, an `error` row (`workDateRefusal`) when the date moved
   * from the batch's baseline (or moved earlier in the batch), and throws `BaselineWorkDateUnstableError` when
   * two baseline calls disagree, `NoBaselineWorkDateError` when a mutant-phase answer has no baseline date to
   * compare with. An answer with no `workDate` (no test ran) passes through untouched.
   */
  check(v: TestVerdict): TestVerdict {
    const d = v.workDate;
    if (!this.enabled || d === undefined) return v;
    if (this.inBaseline) {
      if (this.baselineDate === undefined) this.baselineDate = d;
      else if (this.baselineDate !== d)
        throw new BaselineWorkDateUnstableError(this.baselineDate, d, v.ref);
      return v;
    }
    const baseline = this.baselineDate;
    if (baseline === undefined) throw new NoBaselineWorkDateError(d, v.ref);
    if (this.moved === undefined && d !== baseline) this.moved = { from: baseline, to: d };
    if (this.moved === undefined) return v;
    const { from, to } = this.moved;
    const why =
      d !== baseline
        ? `${v.ref.method} started on WorkDate ${d}, the batch's baseline on ${from}`
        : `an earlier answer in this batch started on WorkDate ${to}, the batch's baseline on ${from}, so ${v.ref.method} (WorkDate ${d}) is not scored either`;
    // The verdict's own fields stay (stop accounting, sessionId, attestation); the outcome and note change.
    return {
      ...v,
      outcome: "error",
      failureMessage: `workdate-changed: ${why}; a start date that moved can change a test's verdict, so the answer is not scored. The rest of this batch is not scored; re-run (R1131)`,
      workDateRefusal: "workdate-changed",
    };
  }
}
