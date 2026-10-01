/**
 * Summarises a LethAL SessionReport (`lethal run --out <file>`).
 *
 *   bun scripts/report-summary.ts <report.json>
 *
 * Prints totals by verdict, verdicts by operator, and the group counters (`groupedCalls`,
 * `warmKills`) when the report has them. Counts are taken from `mutants[]` itself, not from the
 * report's own `counts` block, so a summary cannot agree with a block that disagrees with its rows.
 * A file that is not a report (no `mutants` array, a mutant without `verdict`/`operatorName`)
 * is refused.
 */

import { readFileSync } from "node:fs";
import type { MutantOutcome, SessionReport } from "../packages/runner/src/report";

export class ReportFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReportFileError";
  }
}

/** Parses and minimally checks a SessionReport. Throws naming the file on anything else. */
export function parseReport(text: string, source: string): SessionReport {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new ReportFileError(`${source}: not JSON`);
  }
  const mutants = (data as { mutants?: unknown } | null)?.mutants;
  if (!Array.isArray(mutants)) throw new ReportFileError(`${source}: no 'mutants' array`);
  mutants.forEach((m: Partial<MutantOutcome>, i) => {
    if (typeof m?.verdict !== "string" || typeof m.operatorName !== "string") {
      throw new ReportFileError(`${source}: mutants[${i}] has no string 'verdict'/'operatorName'`);
    }
  });
  return data as SessionReport;
}

export function loadReport(path: string): SessionReport {
  return parseReport(readFileSync(path, "utf8"), path);
}

function tally(keys: readonly string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const k of keys) m.set(k, (m.get(k) ?? 0) + 1);
  return new Map([...m].sort(([a], [b]) => a.localeCompare(b)));
}

export function summarize(report: SessionReport): string {
  const out: string[] = [`mutants: ${report.mutants.length}`];
  const byVerdict = tally(report.mutants.map((m) => m.verdict));
  out.push(`by verdict: ${[...byVerdict].map(([v, n]) => `${v} ${n}`).join(" / ") || "(none)"}`);
  out.push("by operator:");
  const ops = tally(report.mutants.map((m) => m.operatorName));
  for (const op of ops.keys()) {
    const v = tally(report.mutants.filter((m) => m.operatorName === op).map((m) => m.verdict));
    out.push(`  ${op}: ${[...v].map(([k, n]) => `${k} ${n}`).join(" / ")}`);
  }
  if (report.groupedCalls !== undefined) out.push(`groupedCalls: ${report.groupedCalls}`);
  if (report.warmKills !== undefined) out.push(`warmKills: ${report.warmKills}`);
  return out.join("\n");
}

if (import.meta.main) {
  const [path, ...extra] = process.argv.slice(2);
  if (path === undefined || extra.length > 0) {
    console.error("usage: bun scripts/report-summary.ts <report.json>");
    process.exit(2);
  }
  try {
    console.log(summarize(loadReport(path)));
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(2);
  }
}
