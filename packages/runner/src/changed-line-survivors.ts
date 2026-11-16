// PR-77: the survivors of a line-narrowed run, split into the ones that count and the ones listed
// apart because al-runner-v3 gives their site a caveat. Spec: docs/superpowers/specs/2026-11-16-pr77-changed-line-survivors.md
import { ACCEPT_LIST_FILENAME } from "./accept-list";
import type { AcceptResult } from "./accept-list";
import { SURVIVING_VERDICTS } from "./equivalence-marks";
import { mutantRef } from "./report";
import type { MutantOutcome, SessionReport } from "./report";

// Positive signals only. An unknown flag (serve rows carry none, upstream #7954) or an unrecorded
// one (a resumed run) never puts a survivor apart: it counts, and the section says how many.
export type ApartReason = "baselineFlagged" | "coverageOff" | "restrictiveDefault";

export interface ChangedLineSurvivor {
  readonly batchIndex: number;
  readonly mutantCode: string;
  readonly file: string;
  readonly line: number;
  readonly operatorName: string;
  readonly procedureName: string;
}

export interface ApartSurvivor extends ChangedLineSurvivor {
  readonly reasons: readonly ApartReason[];
}

/** PR-79: a survivor an entry of `lethal.accepted.json` accepts, with the entry's reason. */
export interface AcceptedSurvivor extends ChangedLineSurvivor {
  readonly reason: string;
}

export interface ChangedLineSurvivors {
  readonly counted: readonly ChangedLineSurvivor[];
  /** Taken out of `counted` and `apart` by the accept list; never counted. */
  readonly accepted: readonly AcceptedSurvivor[];
  readonly apart: readonly ApartSurvivor[];
  /** Counted survivors with a covering test whose al-runner flag is unknown or unrecorded (v3 only). */
  readonly unknownFlagCount: number;
  /** Set when the run stopped early (quarantine or time budget): the lists are not complete. */
  readonly partial?: string;
}

// Only `validity` is required: `exitCodeForReport` is also called with a bare validity in tests, and a
// report that is line-narrowed but lacks `mutants` has no survivors to list.
export type ReportView = {
  readonly validity: { readonly caveats: readonly string[] };
} & Partial<
  Pick<
    SessionReport,
    | "backend"
    | "mutants"
    | "testMethods"
    | "coverageOffFiles"
    | "restrictiveDefault"
    | "resumedFrom"
    | "quarantined"
  >
>;

const byFileLineCode = (a: ChangedLineSurvivor, b: ChangedLineSurvivor): number =>
  a.file.localeCompare(b.file) ||
  a.line - b.line ||
  a.batchIndex - b.batchIndex ||
  a.mutantCode.localeCompare(b.mutantCode);

/**
 * `undefined` when the run was not line-narrowed. Otherwise every `survived` mutant, split into
 * `counted` and `apart`. Only an al-runner-v3 report (its own `backend` field) can put a survivor
 * apart; on any other backend `apart` is empty. PR-79: a survivor in `accept.accepted` is listed
 * under `accepted` instead, whatever else it is. Equivalence marks never take a survivor out.
 */
export function changedLineSurvivors(
  report: ReportView,
  accept?: Pick<AcceptResult, "accepted">,
): ChangedLineSurvivors | undefined {
  if (!report.validity.caveats.includes("line-narrowed")) return undefined;
  const v3 = report.backend === "al-runner-v3";
  const flagged = new Set<string>();
  const unknown = new Set<string>();
  for (const t of report.testMethods ?? []) {
    if (t.baselineFlagged === true) flagged.add(t.name);
    if (t.baselineFlaggedUnknown === true) unknown.add(t.name);
  }
  // The rule for the summary line: a covering test is "unknown" when it is marked
  // baselineFlaggedUnknown, or, on a RESUMED report (`resumedFrom` present, which records no flags),
  // when it is not marked baselineFlagged. A fresh run without either mark is truly unflagged.
  const resumed = report.resumedFrom !== undefined;
  const isUnknown = (t: string) => unknown.has(t) || (resumed && !flagged.has(t));
  const coverageOff = new Set(report.coverageOffFiles ?? []);
  const restrictive = new Set(report.restrictiveDefault?.survivors ?? []);

  const reasonsOf = (m: MutantOutcome): ApartReason[] => {
    if (!v3) return [];
    const reasons: ApartReason[] = [];
    if (m.coveringTests.some((t) => flagged.has(t))) reasons.push("baselineFlagged");
    if (coverageOff.has(m.file)) reasons.push("coverageOff");
    if (restrictive.has(mutantRef(m.batchIndex, m.mutantCode))) reasons.push("restrictiveDefault");
    return reasons;
  };

  const counted: ChangedLineSurvivor[] = [];
  const apart: ApartSurvivor[] = [];
  const accepted: AcceptedSurvivor[] = [];
  let unknownFlagCount = 0;
  for (const m of report.mutants ?? []) {
    if (!SURVIVING_VERDICTS.has(m.verdict)) continue;
    const row = {
      batchIndex: m.batchIndex,
      mutantCode: m.mutantCode,
      file: m.file,
      line: m.line,
      operatorName: m.operatorName,
      procedureName: m.procedureName,
    };
    const reason = accept?.accepted.get(mutantRef(m.batchIndex, m.mutantCode));
    if (reason !== undefined) {
      accepted.push({ ...row, reason });
      continue;
    }
    const reasons = reasonsOf(m);
    if (reasons.length === 0) {
      counted.push(row);
      if (v3 && m.coveringTests.some(isUnknown)) unknownFlagCount++;
    } else apart.push({ ...row, reasons });
  }
  const stopped =
    report.quarantined !== undefined
      ? "the run was quarantined"
      : report.validity.caveats.includes("time-budget-reached")
        ? "the run was stopped by its time budget"
        : undefined;
  return {
    counted: counted.sort(byFileLineCode),
    accepted: accepted.sort(byFileLineCode),
    apart: apart.sort(byFileLineCode),
    unknownFlagCount,
    ...(stopped !== undefined ? { partial: stopped } : {}),
  };
}

/**
 * The console section; call only with a defined result. PR-79: with the run's accept result it also
 * lists the accepted survivors, one line per entry that is not accepted, and a ready entry under
 * each counted survivor.
 */
export function renderChangedLineSurvivors(s: ChangedLineSurvivors, accept?: AcceptResult): string {
  const row = (m: ChangedLineSurvivor) =>
    `  ${mutantRef(m.batchIndex, m.mutantCode)} ${m.file}:${m.line} ${m.operatorName} ${m.procedureName}`;
  const head =
    s.partial !== undefined
      ? `SURVIVORS ON THE CHANGED LINES (partial: ${s.partial}; the counts are not a full list)`
      : "SURVIVORS ON THE CHANGED LINES";
  const lines = ["", head, `counted: ${s.counted.length}`];
  for (const m of s.counted) {
    lines.push(row(m));
    const ready = accept?.ready.get(mutantRef(m.batchIndex, m.mutantCode));
    if (ready === undefined) continue;
    lines.push(
      "entry" in ready
        ? `    to accept it, add to ${ACCEPT_LIST_FILENAME} "accepted" (write the reason): ${JSON.stringify(ready.entry)}`
        : `    ${ready.cannot}`,
    );
  }
  if (accept !== undefined && s.counted.length > 0 && !accept.fileFound) {
    lines.push(`no ${ACCEPT_LIST_FILENAME} at ${accept.path}`);
  }
  if (s.accepted.length > 0) {
    lines.push(`accepted (never counted): ${s.accepted.length}`);
    for (const m of s.accepted) lines.push(`${row(m)}  accepted: ${m.reason}`);
  }
  for (const l of accept?.entryLines ?? []) lines.push(l);
  if (s.unknownFlagCount > 0) {
    lines.push(
      `${s.unknownFlagCount} survivor(s) on the changed lines have a covering test whose al-runner flag is unknown or not recorded (serve rows carry none, upstream #7954): they are counted.`,
    );
  }
  lines.push(`listed apart (al-runner-v3 caveat, never fails): ${s.apart.length}`);
  for (const m of s.apart) lines.push(`${row(m)}  [${m.reasons.join(", ")}]`);
  return lines.join("\n");
}
