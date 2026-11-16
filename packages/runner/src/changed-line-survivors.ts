// PR-77: the survivors of a line-narrowed run, split into the ones that count and the ones listed
// apart because al-runner-v3 gives their site a caveat. Spec: docs/superpowers/specs/2026-11-16-pr77-changed-line-survivors.md
import { mutantRef } from "./report";
import type { MutantOutcome, SessionReport } from "./report";

export type ApartReason =
  | "baselineFlagged"
  | "baselineFlaggedUnknown"
  | "coverageOff"
  | "restrictiveDefault";

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

export interface ChangedLineSurvivors {
  readonly counted: readonly ChangedLineSurvivor[];
  readonly apart: readonly ApartSurvivor[];
}

// Only `validity` is required: `exitCodeForReport` is also called with a bare validity in tests, and a
// report that is line-narrowed but lacks `mutants` has no survivors to list.
export type ReportView = {
  readonly validity: { readonly caveats: readonly string[] };
} & Partial<
  Pick<
    SessionReport,
    "backend" | "mutants" | "testMethods" | "coverageOffFiles" | "restrictiveDefault"
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
 * apart; on any other backend `apart` is empty.
 */
export function changedLineSurvivors(report: ReportView): ChangedLineSurvivors | undefined {
  if (!report.validity.caveats.includes("line-narrowed")) return undefined;
  const v3 = report.backend === "al-runner-v3";
  const flagged = new Set<string>();
  const unknown = new Set<string>();
  for (const t of report.testMethods ?? []) {
    if (t.baselineFlagged === true) flagged.add(t.name);
    if (t.baselineFlaggedUnknown === true) unknown.add(t.name);
  }
  const coverageOff = new Set(report.coverageOffFiles ?? []);
  const restrictive = new Set(report.restrictiveDefault?.survivors ?? []);

  const reasonsOf = (m: MutantOutcome): ApartReason[] => {
    if (!v3) return [];
    const reasons: ApartReason[] = [];
    if (m.coveringTests.some((t) => flagged.has(t))) reasons.push("baselineFlagged");
    if (m.coveringTests.some((t) => unknown.has(t))) reasons.push("baselineFlaggedUnknown");
    if (coverageOff.has(m.file)) reasons.push("coverageOff");
    if (restrictive.has(mutantRef(m.batchIndex, m.mutantCode))) reasons.push("restrictiveDefault");
    return reasons;
  };

  const counted: ChangedLineSurvivor[] = [];
  const apart: ApartSurvivor[] = [];
  for (const m of report.mutants ?? []) {
    if (m.verdict !== "survived") continue;
    const row = {
      batchIndex: m.batchIndex,
      mutantCode: m.mutantCode,
      file: m.file,
      line: m.line,
      operatorName: m.operatorName,
      procedureName: m.procedureName,
    };
    const reasons = reasonsOf(m);
    if (reasons.length === 0) counted.push(row);
    else apart.push({ ...row, reasons });
  }
  return { counted: counted.sort(byFileLineCode), apart: apart.sort(byFileLineCode) };
}

/** The console section; call only with a defined result. */
export function renderChangedLineSurvivors(s: ChangedLineSurvivors): string {
  const row = (m: ChangedLineSurvivor) =>
    `  ${mutantRef(m.batchIndex, m.mutantCode)} ${m.file}:${m.line} ${m.operatorName} ${m.procedureName}`;
  const lines = ["", "SURVIVORS ON THE CHANGED LINES", `counted: ${s.counted.length}`];
  for (const m of s.counted) lines.push(row(m));
  lines.push(`listed apart (al-runner-v3 caveat, never fails): ${s.apart.length}`);
  for (const m of s.apart) lines.push(`${row(m)}  [${m.reasons.join(", ")}]`);
  return lines.join("\n");
}
