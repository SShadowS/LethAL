/**
 * Per-mutant diff of two LethAL SessionReports, by the live gates' own comparison.
 *
 *   bun scripts/report-diff.ts <a.json> <b.json>
 *
 * Reuses `normalizeForComparison` + `compareMutants` from `packages/runner/itest/mutant-equality.ts`,
 * the per-mutant compare the frozen `*.baseline.json` gates run: keyed by `keyOf`
 * (`astHash|object|procedure|operator|major[|ordinal]`), a MULTISET per key (twins sharing a key
 * are compared as canonically ordered groups), on verdict, killingTest, coverageFiltered and
 * errorClass, plus (R556) the mutated-text hash where both rows carry one. It is NOT a gate: a gate
 * also refuses an unhashed row against a hashed baseline and reads the scheme from the build, while
 * this compares two reports as they are, taking `sameScheme` from their own `identityScheme`
 * fields, and prints how many rows' text it could not check (a redacted or clipped text, a report
 * from before R556, a twin's shared hash across schemes) before IDENTICAL or DIFFERENT.
 *
 * Exit codes: 0 IDENTICAL, 1 DIFFERENT, 2 refused. Refused when BOTH sides have zero mutants:
 * empty-vs-empty "matching" proves nothing and is never printed as IDENTICAL.
 */

import {
  type MutantComparison,
  compareMutants,
  normalizeForComparison,
} from "../packages/runner/itest/mutant-equality";
import type { SessionReport } from "../packages/runner/src/report";
import { loadReport } from "./report-summary.ts";

export class ReportDiffRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReportDiffRefusal";
  }
}

/** `a` as "before", `b` as "after". Hashes compare row by row only when both reports record the
 *  same identity scheme (R556, see `compareMutants`). */
export function compareReports(a: SessionReport, b: SessionReport): MutantComparison {
  if (a.mutants.length === 0 && b.mutants.length === 0) {
    throw new ReportDiffRefusal("both reports have zero mutants; nothing to compare");
  }
  const sa: unknown = a.identityScheme;
  const sb: unknown = b.identityScheme;
  const sameScheme = Number.isInteger(sa) && sa === sb;
  return compareMutants(normalizeForComparison(a), normalizeForComparison(b), { sameScheme });
}

/** The differences alone; empty means identical. */
export function diffReports(a: SessionReport, b: SessionReport): string[] {
  return compareReports(a, b).differences;
}

export function formatDiff(
  diffs: readonly string[],
  aCount: number,
  bCount: number,
  textUnverified = 0,
): string {
  const out = [`a (before): ${aCount} mutants, b (after): ${bCount} mutants`];
  out.push(`differences: ${diffs.length}`);
  for (const d of diffs) out.push(`  ${d}`);
  if (textUnverified > 0) {
    out.push(
      `${textUnverified} mutant(s) text-UNVERIFIED (no mutated-text hash on one side, or a twin's hash shared within its group across identity schemes): a mutant changed under an unchanged key is not caught there`,
    );
  }
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
    const cmp = compareReports(a, b);
    console.log(
      formatDiff(cmp.differences, a.mutants.length, b.mutants.length, cmp.textUnverified),
    );
    process.exit(cmp.differences.length === 0 ? 0 : 1);
  } catch (e) {
    console.error(`REFUSED: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  }
}
