/**
 * R85 rung 2 — extract the swap kill rate from the run report.
 *
 * Written and committed BEFORE the run, for the same reason `rung2.precommit.md` was: an analysis
 * chosen after the data is an analysis chosen to suit it.
 *
 * Descended from `docs/campaign/2026-08-07-r85-swap-rate/analyse.ts`, with ONE addition: the
 * first-party / vendored partition the pre-commitment fixes. That partition is decided by path
 * (`.dependencies/` anywhere in it), a variable settled before the run and unable to be influenced
 * by any verdict.
 *
 * It computes exactly what the pre-commitment named and nothing else:
 *   - the swap kill rate over `killed + timeout-killed + survived`, with `no-coverage` and `error`
 *     reported separately rather than folded into either side;
 *   - the same, split first-party / vendored / whole, with the bar applying to the FIRST-PARTY one;
 *   - a Wilson 95% interval beside every rate, because a rate quoted without one is the failure
 *     rung 1 avoided at n=3;
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
  validity?: { caveats?: string[]; reliability?: string; scoreDescribes?: string };
  operators?: { names: string[]; excludedSiteCount: number };
  baselineTests?: unknown[];
  unsupportedTests?: unknown[];
};

const SWAP = "lethal.swap-call-arguments";

/** The partition fixed by `rung2.precommit.md`, by PATH, before the run. */
function isVendored(file: string): boolean {
  return file.replaceAll("\\", "/").includes("/.dependencies/") || file.startsWith(".dependencies");
}

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

function partition(name: string, swaps: Outcome[]): { killed: Outcome[]; survived: Outcome[] } {
  const by = (v: string) => swaps.filter((m) => m.verdict === v);
  const killed = [...by("killed"), ...by("timeout-killed")];
  const survived = by("survived");
  const noCoverage = by("no-coverage");
  const errored = by("error");
  const scored = killed.length + survived.length;
  console.log(`\n## ${name}`);
  console.log(`  swap mutants deployed:         ${swaps.length}`);
  console.log(`  killed (incl. timeout-killed): ${killed.length}`);
  console.log(`  survived:                      ${survived.length}`);
  console.log(`  no-coverage (excluded):        ${noCoverage.length}`);
  console.log(`  error (excluded):              ${errored.length}`);
  if (scored > 0) {
    const [lo, hi] = wilson(killed.length, scored);
    console.log(`  RAW KILL RATE = ${killed.length}/${scored} = ${pct(killed.length / scored)}`);
    console.log(`  Wilson 95% interval: ${pct(lo)} .. ${pct(hi)}  <- the number is this wide`);
    if (scored < 30) {
      console.log(
        "  n < 30: the pre-committed bar is NOT applied to this partition (rung2.precommit.md).",
      );
    }
  } else {
    console.log("  NO SCORED SWAP MUTANTS — no rate exists. A result, not a failure to report.");
  }
  return { killed, survived };
}

const swaps = report.mutants.filter((m) => m.operatorName === SWAP);
const other = report.mutants.filter((m) => m.operatorName !== SWAP);

console.log("# R85 rung 2 — swap kill rate over the WHOLE swap population\n");
console.log(`whole run counts: ${JSON.stringify(report.counts)}`);
console.log(`report mutants:   ${report.mutants.length}`);
console.log(`  of which swap:  ${swaps.length}`);
console.log(
  `  of which NOT swap: ${other.length}${other.length > 0 ? "  <- GATE FAILURE: --operator was supposed to make this 0" : ""}`,
);
console.log(`validity: ${JSON.stringify(report.validity ?? {})}`);
console.log(`operators block: ${JSON.stringify(report.operators ?? null)}`);
console.log(
  `baseline: ${report.baselineTests?.length ?? "?"} discovered, ${report.unsupportedTests?.length ?? "?"} not passing`,
);

const firstParty = swaps.filter((m) => !isVendored(m.file));
const vendored = swaps.filter((m) => isVendored(m.file));

// The bar applies to this one, and the pre-commitment says so before any number existed.
const fp = partition("FIRST-PARTY (Al/**) — THE BAR APPLIES HERE", firstParty);
partition("VENDORED (.dependencies/**) — reported, bar does not apply", vendored);
const all = partition("WHOLE PROJECT — reported, bar does not apply", swaps);

console.log("\n# every killed swap, with the text that killed it (R86)\n");
console.log(
  "The false-kill split is a READER's judgement performed on this evidence — R121 is open and",
);
console.log("nothing here classifies. A kill with no text is UNCLASSIFIABLE, never a real kill.\n");
for (const m of all.killed) {
  const tag = isVendored(m.file) ? "vendored" : "first-party";
  console.log(
    `- ${m.mutantCode} [${tag}] ${m.file}:${m.line}  killedBy=${m.killingTest ?? "<none>"}`,
  );
  console.log(`    was: ${JSON.stringify(m.originalText ?? "")}`);
  console.log(`    now: ${JSON.stringify(m.mutatedText ?? "")}`);
  console.log(`    why: ${m.killingTestFailure ?? "<NO TEXT RECORDED — cannot be classified>"}`);
}

console.log("\n# every surviving swap (candidates for equivalence review)\n");
for (const m of all.survived) {
  const tag = isVendored(m.file) ? "vendored" : "first-party";
  console.log(
    `- ${m.mutantCode} [${tag}] ${m.file}:${m.line}  attribution=${m.coverageAttribution ?? "<none>"} guardObserved=${String(m.guardObserved)}`,
  );
  console.log(`    was: ${JSON.stringify(m.originalText ?? "")}`);
  console.log(`    now: ${JSON.stringify(m.mutatedText ?? "")}`);
}

console.log(
  `\n# first-party scored n = ${fp.killed.length + fp.survived.length} (bar applies at >= 30)`,
);
