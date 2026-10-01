/**
 * Per-mutant diff of two LethAL SessionReports, by the live gates' own comparison.
 *
 *   bun scripts/report-diff.ts <a.json> <b.json>
 *
 * Reuses `normalizeForComparison` + `diffMutants` from `packages/runner/itest/mutant-equality.ts`,
 * the exact compare the frozen `*.baseline.json` gates run: keyed by `keyOf`
 * (`astHash|object|procedure|operator|major[|ordinal]`), a MULTISET per key (twins sharing a key
 * are compared as canonically ordered groups), on verdict, killingTest, coverageFiltered and
 * errorClass. So this accepts exactly what a gate accepts and prints the same differences, then
 * IDENTICAL or DIFFERENT.
 *
 * Exit codes: 0 IDENTICAL, 1 DIFFERENT, 2 refused. Refused when BOTH sides have zero mutants:
 * empty-vs-empty "matching" proves nothing and is never printed as IDENTICAL.
 */

import { diffMutants, normalizeForComparison } from "../packages/runner/itest/mutant-equality";
import type { SessionReport } from "../packages/runner/src/report";
import { loadReport } from "./report-summary.ts";

export class ReportDiffRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReportDiffRefusal";
  }
}

/** The gates' differences, `a` as "before" and `b` as "after"; empty means identical. */
export function diffReports(a: SessionReport, b: SessionReport): string[] {
  if (a.mutants.length === 0 && b.mutants.length === 0) {
    throw new ReportDiffRefusal("both reports have zero mutants; nothing to compare");
  }
  return diffMutants(normalizeForComparison(a), normalizeForComparison(b));
}

export function formatDiff(diffs: readonly string[], aCount: number, bCount: number): string {
  const out = [`a (before): ${aCount} mutants, b (after): ${bCount} mutants`];
  out.push(`differences: ${diffs.length}`);
  for (const d of diffs) out.push(`  ${d}`);
  out.push(diffs.length === 0 ? "IDENTICAL" : "DIFFERENT");
  return out.join("\n");
}

if (import.meta.main) {
  const [pa, pb, ...extra] = process.argv.slice(2);
  if (pa === undefined || pb === undefined || extra.length > 0) {
    console.error("usage: bun scripts/report-diff.ts <a.json> <b.json>");
    process.exit(2);
  }
  try {
    const a = loadReport(pa);
    const b = loadReport(pb);
    const diffs = diffReports(a, b);
    console.log(formatDiff(diffs, a.mutants.length, b.mutants.length));
    process.exit(diffs.length === 0 ? 0 : 1);
  } catch (e) {
    console.error(`REFUSED: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  }
}
