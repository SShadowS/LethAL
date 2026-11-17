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
 * `--by-line` joins on (file, line, operatorName) instead (startIndex and endIndex added if a report has two
 * mutants on one such key; still ambiguous refuses), and lists differences, only-in-a and
 * only-in-b separately. `--subset` (needs `--by-line`) treats mutants only in a as "not in the
 * subset", not differences: a full run (a) against a `--changed-since` / `--lines` run (b).
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

export interface LineComparison {
  readonly differences: string[]; // fields that differ on a mutant present in both
  readonly onlyInA: string[];
  readonly onlyInB: string[];
  readonly shared: number;
  readonly keyedBy: string;
}

type LineRow = {
  file?: unknown;
  line?: unknown;
  operatorName?: unknown;
  startIndex?: unknown;
  endIndex?: unknown;
};

function groupBy(rows: readonly LineRow[], withStart: boolean): Map<string, number[]> {
  const g = new Map<string, number[]>();
  rows.forEach((r, i) => {
    const k = `${r.file} line ${r.line}|${r.operatorName}${withStart ? `|@${r.startIndex}-${r.endIndex}` : ""}`;
    g.set(k, [...(g.get(k) ?? []), i]);
  });
  return g;
}

/** `--by-line`: join on (file, line, operatorName), widening to startIndex and endIndex (nested
 *  operators share a start) if either report has
 *  two mutants on one such key; still ambiguous throws. With `subset`, rows only in `a` are not
 *  differences (a full run against a `--changed-since` run). Compares verdict, killingTest,
 *  coverageFiltered, errorClass and the mutated-text hash where both rows carry one. */
export function compareByLine(a: SessionReport, b: SessionReport, subset = false): LineComparison {
  if (a.mutants.length === 0 && b.mutants.length === 0) {
    throw new ReportDiffRefusal("both reports have zero mutants; nothing to compare");
  }
  const ar = a.mutants as unknown as LineRow[];
  const br = b.mutants as unknown as LineRow[];
  const dup = (g: Map<string, number[]>) => [...g].filter(([, v]) => v.length > 1).map(([k]) => k);
  const coarse = [...dup(groupBy(ar, false)), ...dup(groupBy(br, false))];
  const withStart = coarse.length > 0;
  const ga = groupBy(ar, withStart);
  const gb = groupBy(br, withStart);
  const still = [...dup(ga), ...dup(gb)];
  if (still.length > 0) {
    throw new ReportDiffRefusal(
      `ambiguous mutant keys even with startIndex and endIndex (${still.length}): ${[...new Set(still)].join("; ")}`,
    );
  }
  const na = normalizeForComparison(a);
  const nb = normalizeForComparison(b);
  const differences: string[] = [];
  const onlyInA: string[] = [];
  const onlyInB: string[] = [];
  let shared = 0;
  for (const [k, [i]] of ga) {
    const j = gb.get(k)?.[0];
    const x = i === undefined ? undefined : na[i];
    const y = j === undefined ? undefined : nb[j];
    if (x === undefined) continue;
    if (y === undefined) {
      onlyInA.push(k);
      continue;
    }
    shared++;
    const f: string[] = [];
    if (x.verdict !== y.verdict) f.push(`verdict ${x.verdict} -> ${y.verdict}`);
    if (x.killingTest !== y.killingTest) f.push(`killingTest ${x.killingTest} -> ${y.killingTest}`);
    if (x.coverageFiltered !== y.coverageFiltered) {
      f.push(`coverageFiltered ${x.coverageFiltered} -> ${y.coverageFiltered}`);
    }
    if (x.errorClass !== y.errorClass) f.push(`errorClass ${x.errorClass} -> ${y.errorClass}`);
    if (
      x.mutatedTextSha256 !== undefined &&
      y.mutatedTextSha256 !== undefined &&
      x.mutatedTextSha256 !== y.mutatedTextSha256
    ) {
      f.push("mutated text differs");
    }
    if (f.length > 0) differences.push(`mutant ${k}: ${f.join("; ")}`);
  }
  for (const k of gb.keys()) if (!ga.has(k)) onlyInB.push(k);
  return {
    differences,
    onlyInA,
    onlyInB,
    shared,
    keyedBy: withStart ? "file, line, operator, startIndex, endIndex" : "file, line, operator",
  };
}

export function formatLineDiff(c: LineComparison, aCount: number, bCount: number, subset: boolean) {
  const out = [
    `a (before): ${aCount} mutants, b (after): ${bCount} mutants; keyed by ${c.keyedBy}; ${c.shared} in both`,
  ];
  out.push(`differences: ${c.differences.length}`);
  for (const d of c.differences) out.push(`  ${d}`);
  out.push(`only in b: ${c.onlyInB.length}`);
  for (const d of c.onlyInB) out.push(`  ${d}`);
  out.push(
    subset
      ? `not in the subset (only in a, not a difference): ${c.onlyInA.length}`
      : `only in a: ${c.onlyInA.length}`,
  );
  if (!subset) for (const d of c.onlyInA) out.push(`  ${d}`);
  const bad = c.differences.length + c.onlyInB.length + (subset ? 0 : c.onlyInA.length);
  out.push(bad === 0 ? "IDENTICAL" : "DIFFERENT");
  return out.join("\n");
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
  const args = process.argv.slice(2);
  const byLine = args.includes("--by-line");
  const subset = args.includes("--subset");
  const [pa, pb, ...extra] = args.filter((x) => x !== "--by-line" && x !== "--subset");
  if (pa === undefined || pb === undefined || extra.length > 0) {
    console.error("usage: bun scripts/report-diff.ts [--by-line [--subset]] <a.json> <b.json>");
    process.exit(2);
  }
  if (subset && !byLine) {
    console.error("REFUSED: --subset only works with --by-line");
    process.exit(2);
  }
  try {
    const a = loadReport(pa);
    const b = loadReport(pb);
    if (byLine) {
      const c = compareByLine(a, b, subset);
      console.log(formatLineDiff(c, a.mutants.length, b.mutants.length, subset));
      const bad = c.differences.length + c.onlyInB.length + (subset ? 0 : c.onlyInA.length);
      process.exit(bad === 0 ? 0 : 1);
    }
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
