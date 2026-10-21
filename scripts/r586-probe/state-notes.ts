// R586 plan r3 (F7): predict the `v3-codeunit-state-possible` note per killed mutant from MEASURED data.
// The note is set when the credited killer is not the first failing covering row in v3's row order, OR an
// earlier covering row of the same codeunit passed. Both cases reduce to one fact we can compute:
// there is a covering test of the killer's codeunit that comes BEFORE the killer in v3's row order
// (if it failed, the killer is not the first failing row; if it passed, the second case holds).
// Inputs: a SessionReport (coveringTests, killingTest per mutant) and a v3 --output-json document whose
// tests[] order is v3's run order. Prints the count and the mutant codes. Measurement tool only.
// Usage: bun state-notes.ts <report.json> <v3 document.json> [label]
import { readFileSync } from "node:fs";

const [reportPath, docPath, label] = process.argv.slice(2);
if (reportPath === undefined || docPath === undefined)
  throw new Error("usage: state-notes.ts <report.json> <v3 document.json> [label]");
type Row = { codeunitName: string; method: string };
type Mutant = {
  mutantCode: string;
  batchIndex?: number;
  verdict: string;
  killingTest?: string | null;
  coveringTests?: readonly string[];
};
const doc = JSON.parse(readFileSync(docPath, "utf8")) as { tests: Row[] };
const report = JSON.parse(readFileSync(reportPath, "utf8")) as { mutants: Mutant[] };
const fold = (s: string) => s.toLowerCase();
const order = new Map<string, number>();
doc.tests.forEach((t, i) => order.set(fold(`${t.codeunitName}.${t.method}`), i));
const codeunitOf = (q: string) => q.slice(0, q.lastIndexOf("."));
const noted: string[] = [];
let killed = 0;
for (const m of report.mutants) {
  if (m.verdict !== "killed" || m.killingTest == null) continue;
  killed++;
  const covering = m.coveringTests ?? [];
  const killerQ = covering.find(
    (c) => fold(c.slice(c.lastIndexOf(".") + 1)) === fold(m.killingTest ?? ""),
  );
  if (killerQ === undefined)
    throw new Error(`${m.mutantCode}: killer ${m.killingTest} not among its covering tests`);
  const k = order.get(fold(killerQ));
  if (k === undefined) throw new Error(`${m.mutantCode}: killer ${killerQ} not in the v3 document`);
  const earlier = covering.some((c) => {
    if (c === killerQ || codeunitOf(c) !== codeunitOf(killerQ)) return false;
    const i = order.get(fold(c));
    if (i === undefined) throw new Error(`${m.mutantCode}: covering ${c} not in the v3 document`);
    return i < k;
  });
  if (earlier) noted.push(`${m.batchIndex ?? 0}/${m.mutantCode}`);
}
console.log(`${label ?? reportPath}: killed=${killed} v3-codeunit-state-possible=${noted.length}`);
console.log(`  ${noted.join(" ")}`);
