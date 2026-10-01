/**
 * Per-mutant diff of two LethAL SessionReports.
 *
 *   bun scripts/report-diff.ts <a.json> <b.json>
 *
 * Joins mutants on `keyOf` from `packages/runner/itest/mutant-equality.ts`, the exact key the
 * frozen `*.baseline.json` files use (`astHash|object|procedure|operator|major[|ordinal]`), and
 * prints keys added, removed, and changed (verdict or killingTest), then IDENTICAL or DIFFERENT.
 *
 * Exit codes: 0 IDENTICAL, 1 DIFFERENT, 2 refused. Refused when either side holds a duplicate
 * key (a one-to-one join would silently pick one record; the gates' own multiset compare is
 * `diffMutants` in the same file), or when BOTH sides have zero mutants: empty-vs-empty
 * "matching" proves nothing and is never printed as IDENTICAL.
 */

import { keyOf } from "../packages/runner/itest/mutant-equality";
import type { MutantOutcome, SessionReport } from "../packages/runner/src/report";
import { loadReport } from "./report-summary.ts";

export class ReportDiffRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReportDiffRefusal";
  }
}

export interface ReportDiff {
  readonly added: string[];
  readonly removed: string[];
  readonly changed: string[];
}

function byKey(report: SessionReport, side: string): Map<string, MutantOutcome> {
  const map = new Map<string, MutantOutcome>();
  for (const m of report.mutants) {
    const key = keyOf(m);
    if (map.has(key)) throw new ReportDiffRefusal(`${side} has duplicate key ${key}`);
    map.set(key, m);
  }
  return map;
}

export function diffReports(a: SessionReport, b: SessionReport): ReportDiff {
  if (a.mutants.length === 0 && b.mutants.length === 0) {
    throw new ReportDiffRefusal("both reports have zero mutants; nothing to compare");
  }
  const left = byKey(a, "a");
  const right = byKey(b, "b");
  const added = [...right.keys()].filter((k) => !left.has(k)).sort();
  const removed = [...left.keys()].filter((k) => !right.has(k)).sort();
  const changed: string[] = [];
  for (const [key, before] of left) {
    const after = right.get(key);
    if (after === undefined) continue;
    const parts: string[] = [];
    if (before.verdict !== after.verdict)
      parts.push(`verdict ${before.verdict} -> ${after.verdict}`);
    const kb = before.killingTest ?? null;
    const ka = after.killingTest ?? null;
    if (kb !== ka) parts.push(`killingTest ${kb} -> ${ka}`);
    if (parts.length > 0) changed.push(`${key}: ${parts.join(", ")}`);
  }
  return { added, removed, changed: changed.sort() };
}

export function formatDiff(d: ReportDiff, aCount: number, bCount: number): string {
  const out = [`a: ${aCount} mutants, b: ${bCount} mutants`];
  for (const [label, list] of [
    ["added", d.added],
    ["removed", d.removed],
    ["changed", d.changed],
  ] as const) {
    out.push(`${label}: ${list.length}`);
    for (const k of list) out.push(`  ${k}`);
  }
  const same = d.added.length + d.removed.length + d.changed.length === 0;
  out.push(same ? "IDENTICAL" : "DIFFERENT");
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
    const d = diffReports(a, b);
    const text = formatDiff(d, a.mutants.length, b.mutants.length);
    console.log(text);
    process.exit(text.endsWith("IDENTICAL") ? 0 : 1);
  } catch (e) {
    console.error(`REFUSED: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  }
}
