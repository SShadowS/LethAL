/**
 * R85 instrument (b) — extract the swap kill rate from the run report.
 *
 * Written BEFORE the run finished and before any verdict was seen, for the same reason
 * `rung0.precommit.md` was: an analysis chosen after the data is an analysis chosen to suit it.
 *
 * It computes exactly what the pre-commitment named and nothing else:
 *   - the swap kill rate over `killed + timeout-killed + survived`, with `no-coverage` and `error`
 *     reported separately rather than folded into either side;
 *   - a Wilson 95% interval, because the pre-commitment fixed that ~30 observations give roughly
 *     +/-18 points and that limit must appear beside the number, not in a footnote;
 *   - every killed swap's `killingTestFailure` (R86), quoted in full, so the false-kill split is
 *     performed by a reader on the evidence rather than by a rule. R121 is open precisely because
 *     the only proposed discriminator was measured wrong at a 75% false-positive rate, so this
 *     script deliberately does NOT classify.
 */
import { readFileSync } from "node:fs";

interface Outcome {
  readonly mutantCode: string;
  readonly file: string;
  readonly line: number;
  readonly operatorName: string;
  readonly verdict: string;
  readonly killingTest?: string;
  readonly killingTestFailure?: string;
  readonly failureNote?: string;
  readonly cause?: string;
  readonly coverageAttribution?: string;
  readonly guardObserved?: boolean;
  readonly originalText?: string;
  readonly mutatedText?: string;
}

const reportPath = process.argv[2];
if (reportPath === undefined) throw new Error("usage: analyse.ts <report.json>");
const report = JSON.parse(readFileSync(reportPath, "utf8")) as {
  mutants: Outcome[];
  counts: Record<string, number>;
};

const SWAP = "lethal.swap-call-arguments";
const swaps = report.mutants.filter((m) => m.operatorName === SWAP);
const by = (v: string) => swaps.filter((m) => m.verdict === v);

const killed = [...by("killed"), ...by("timeout-killed")];
const survived = by("survived");
const noCoverage = by("no-coverage");
const errored = by("error");
const scored = killed.length + survived.length;

/** Wilson score interval — honest at small n, unlike the normal approximation. */
function wilson(k: number, n: number): [number, number] {
  if (n === 0) return [0, 0];
  const z = 1.959963985;
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const s = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [Math.max(0, (c - s) / d), Math.min(1, (c + s) / d)];
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
console.log(`# R85 — swap kill rate\n`);
console.log(`whole run: ${JSON.stringify(report.counts)}`);
console.log(`\nswap mutants deployed: ${swaps.length}`);
console.log(`  killed (incl. timeout-killed): ${killed.length}`);
console.log(`  survived:                      ${survived.length}`);
console.log(`  no-coverage (excluded):        ${noCoverage.length}`);
console.log(`  error (excluded):              ${errored.length}`);
if (scored > 0) {
  const [lo, hi] = wilson(killed.length, scored);
  console.log(`\nRAW KILL RATE = ${killed.length}/${scored} = ${pct(killed.length / scored)}`);
  console.log(`  Wilson 95% interval: ${pct(lo)} .. ${pct(hi)}  <- the number is this wide`);
} else {
  console.log(
    "\nNO SCORED SWAP MUTANTS — no rate exists. This is a result, not a failure to report.",
  );
}

console.log(`\n## every killed swap, with the text that killed it (R86)\n`);
for (const m of killed) {
  console.log(`- ${m.mutantCode} ${m.file}:${m.line}  killedBy=${m.killingTest ?? "<none>"}`);
  console.log(`    was: ${JSON.stringify(m.originalText ?? "")}`);
  console.log(`    now: ${JSON.stringify(m.mutatedText ?? "")}`);
  console.log(`    why: ${m.killingTestFailure ?? "<NO TEXT RECORDED — cannot be classified>"}`);
}

console.log(`\n## every surviving swap (candidates for equivalence review)\n`);
for (const m of survived) {
  console.log(
    `- ${m.mutantCode} ${m.file}:${m.line}  attribution=${m.coverageAttribution ?? "<none>"} guardObserved=${String(m.guardObserved)}`,
  );
  console.log(`    was: ${JSON.stringify(m.originalText ?? "")}`);
  console.log(`    now: ${JSON.stringify(m.mutatedText ?? "")}`);
}
