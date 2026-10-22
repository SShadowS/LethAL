// R-606 tables (scratch worktree only, never committed): per-mutant comparison of one leg's report
// with a gate baseline, the leg-to-leg comparison, killReproduced per kill, and the serve tap figures.
//   bun scripts/r586-probe/r606-tables-analyse.ts <dir> <leg> [<other leg>]
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseGateBaseline } from "../../packages/runner/itest/baseline-guard";
import { compareMutants, normalizeForComparison } from "../../packages/runner/itest/mutant-equality";
import type { SessionReport } from "../../packages/runner/src/report";

const [dir, leg, other] = process.argv.slice(2);
if (dir === undefined || leg === undefined) throw new Error("usage: <dir> <leg> [<other leg>]");
const load = (l: string): SessionReport =>
  JSON.parse(readFileSync(join(dir, `${l}.report.json`), "utf8")) as SessionReport;
const r = load(leg);
const after = normalizeForComparison(r);
const itest = join(import.meta.dir, "../../packages/runner/itest");
for (const [name, file] of [
  ["R-A2", "al-runner-v3.tables.baseline.json"],
  ["R-BC", "tables.baseline.json"],
] as const) {
  const raw = readFileSync(join(itest, file), "utf8");
  const base = parseGateBaseline(raw, file, "");
  const cmp = compareMutants(base.entries, after, {
    sameScheme: base.identityScheme !== undefined && base.identityScheme === r.identityScheme,
  });
  console.log(`== ${leg} vs ${name}: differences=${cmp.differences.length} textVerified=${cmp.textVerified} textUnverified=${cmp.textUnverified}`);
  for (const d of cmp.differences) console.log(`  - ${d}`);
}
if (other !== undefined) {
  const o = load(other);
  const cmp = compareMutants(normalizeForComparison(o), after, { sameScheme: o.identityScheme === r.identityScheme });
  console.log(`== ${leg} vs ${other}: differences=${cmp.differences.length} textVerified=${cmp.textVerified}`);
  for (const d of cmp.differences) console.log(`  - ${d}`);
}
const kills = r.mutants.filter((m) => m.verdict === "killed" || m.verdict === "timeout-killed");
const repro = kills.filter((m) => (m as { killReproduced?: true }).killReproduced === true);
console.log(`== ${leg} counts=${JSON.stringify(r.counts)} baselineGreen=${r.baselineGreen} coverageMode=${r.coverageMode}`);
console.log(`killReproduced: ${repro.length} of ${kills.length} kills`);
for (const m of kills.filter((k) => !repro.includes(k))) console.log(`  not reproduced: ${m.mutantCode} ${m.procedureName} ${m.operatorName} ${m.killingTest}`);
const summaries = readFileSync(join(dir, `${leg}.serve-out.ndjson`), "utf8")
  .split("\n")
  .filter((l) => l.trim() !== "")
  .map((l) => JSON.parse(l) as { type?: string; cached?: boolean; wallSeconds?: number; error?: string });
const reqs = readFileSync(join(dir, `${leg}.serve-in.ndjson`), "utf8")
  .split("\n")
  .filter((l) => l.trim() !== "")
  .map((l) => JSON.parse(l) as { command?: string });
const med = (xs: number[]): string => {
  if (xs.length === 0) return "none";
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return (s.length % 2 === 1 ? (s[mid] ?? 0) : ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2).toFixed(1);
};
const sum = summaries.filter((s) => s.type === "summary");
const ms = (c: boolean) => sum.filter((s) => s.cached === c).map((s) => (s.wallSeconds ?? 0) * 1000);
console.log(
  `serve: runTests=${reqs.filter((q) => q.command === "runTests").length} other=${reqs.filter((q) => q.command !== "runTests").length} summaries=${sum.length} errors=${summaries.length - sum.length} cached=${ms(true).length} median=${med(ms(true))}ms uncached=${ms(false).length} median=${med(ms(false))}ms`,
);
