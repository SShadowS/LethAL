#!/usr/bin/env bun
/**
 * R594: per-mutant comparison of a bc3 bcdev report with R546's Cronus28 bcdev oracle, using
 * `scripts/r546-bucket.ts`'s `bucket` (keyed by `keyOf`, each key once per side, same
 * file/startIndex/endIndex/text). That script's own CLI insists on one bcdev and one al-runner
 * report, so this is the bcdev-vs-bcdev entry. Both reports must be REDACTED (the oracle is), or the
 * text fields differ by construction.
 *
 *   bun scripts/r594/compare.ts <oracle report.json> <bc3 report.json>
 *
 * Exit 0 when every row agrees on verdict and killing test, 1 when any row differs (a FINDING,
 * listed per mutant), 2 when the comparison is refused.
 */
import { type R546Class, bucket } from "../r546-bucket.ts";
import { loadReport } from "../report-summary.ts";

const [oraclePath, bc3Path] = process.argv.slice(2);
if (oraclePath === undefined || bc3Path === undefined) {
  console.error("usage: bun scripts/r594/compare.ts <oracle report.json> <bc3 report.json>");
  process.exit(2);
}
const oracle = loadReport(oraclePath);
const bc3 = loadReport(bc3Path);
if (oracle.backend !== "bcdev" || bc3.backend !== "bcdev") {
  console.error(`REFUSED: both reports must be bcdev (got ${oracle.backend}, ${bc3.backend})`);
  process.exit(2);
}
let rows: ReturnType<typeof bucket>;
try {
  rows = bucket(oracle.mutants, bc3.mutants);
} catch (e) {
  console.error(`REFUSED: ${(e as Error).message}`);
  process.exit(2);
}
console.log(
  `oracle ${oraclePath}: coverageMode ${oracle.coverageMode}, identityScheme ${oracle.identityScheme}`,
);
console.log(
  `bc3    ${bc3Path}: coverageMode ${bc3.coverageMode}, identityScheme ${bc3.identityScheme}`,
);
console.log(
  `mutants (union of keys): ${rows.length}; oracle ${oracle.mutants.length}, bc3 ${bc3.mutants.length}`,
);
const classes: readonly R546Class[] = [
  "agree",
  "kill-vs-survive",
  "verdict-vs-no-coverage",
  "error-timeout",
  "one-side-only",
];
for (const c of classes) console.log(`  ${c}: ${rows.filter((r) => r.cls === c).length}`);
const killerDiffers = rows.filter((r) => r.cls === "agree" && r.bcKillingTest !== r.arKillingTest);
console.log(`  agree but killingTest differs: ${killerDiffers.length}`);
const verdicts = (side: "bc" | "ar") => {
  const n: Record<string, number> = {};
  for (const r of rows) {
    const v = r[side] ?? "absent";
    n[v] = (n[v] ?? 0) + 1;
  }
  return JSON.stringify(n);
};
console.log(`verdicts: oracle ${verdicts("bc")}, bc3 ${verdicts("ar")}`);
const differing = rows.filter((r) => r.cls !== "agree" || r.bcKillingTest !== r.arKillingTest);
for (const r of differing) {
  console.log(
    `DIFF ${r.cls} ${r.procedure} line ${r.line} ${r.operator}: oracle ${r.bc} (${r.bcKillingTest}) vs bc3 ${r.ar} (${r.arKillingTest}) [${r.key}]`,
  );
}
process.exit(differing.length === 0 ? 0 : 1);
