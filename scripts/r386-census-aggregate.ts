#!/usr/bin/env bun
/**
 * R-386: total the per-app JSON files of `scripts/r386-fallback-census.ts` into one markdown table.
 *   bun scripts/r386-census-aggregate.ts <census-dir>
 * Columns: shape, tests on that shape, whether R-386 lists it as open, apps with any.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2];
if (dir === undefined) {
  console.error("usage: bun scripts/r386-census-aggregate.ts <census-dir>");
  process.exit(2);
}
const rows = new Map<string, { tests: number; r386: boolean; apps: number }>();
let tests = 0;
let on = 0;
let apps = 0;
let unclassified = 0;
for (const f of readdirSync(dir)
  .filter((e) => e.endsWith(".json"))
  .sort()) {
  const j = JSON.parse(await Bun.file(join(dir, f)).text()) as {
    tests: number;
    onFallback: number;
    shapes: Record<string, { tests: number; r386: boolean }>;
    unclassified: Record<string, number>;
  };
  apps++;
  tests += j.tests;
  on += j.onFallback;
  for (const [k, v] of Object.entries(j.shapes)) {
    const r = rows.get(k) ?? { tests: 0, r386: v.r386, apps: 0 };
    r.tests += v.tests;
    r.apps++;
    rows.set(k, r);
  }
  for (const n of Object.values(j.unclassified)) unclassified += n;
}
console.log(`${apps} apps, ${tests} tests, ${on} on fallback, ${unclassified} unclassified\n`);
console.log("| shape | tests | r386 | apps with any |\n|---|---:|---|---:|");
for (const [k, v] of [...rows].sort((a, b) => b[1].tests - a[1].tests))
  console.log(`| ${k} | ${v.tests} | ${v.r386 ? "yes" : "no"} | ${v.apps} |`);
