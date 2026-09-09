// A/B diff of two `census-operator-sites.ts` outputs, the PER-SITE half of a grammar bump's proof.
//
// MULTISETS keyed by the whole row, so a bump that moves WHICH sites an operator claims shows up
// even when the totals match, and so two same-start nested sites cannot collapse into one key.
// Reports the delta per operator, which is what makes a result readable: the 4.3.0 bump's 137
// removals were all one operator and one shape, and that is the shape of an explained bump.
//
// SKIP_OPERATOR=<name> excludes one operator, for isolating a suspected instrument fault from a
// real grammar change (see R218, where it separated unsorted-readdir noise from the real delta).
import { readFile } from "node:fs/promises";
const [aPath, bPath] = process.argv.slice(2);
const load = async (p: string): Promise<Map<string, number>> => {
  const rows = JSON.parse(await readFile(p ?? "", "utf8")) as Array<Record<string, unknown>>;
  const m = new Map<string, number>();
  const skip = process.env.SKIP_OPERATOR;
  for (const r of rows) {
    if (skip !== undefined && r.operator === skip) continue;
    const k = JSON.stringify([r.operator, r.file, r.line, r.column, r.before, r.after]);
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return m;
};
const [a, b] = await Promise.all([load(aPath ?? ""), load(bPath ?? "")]);
const keys = new Set([...a.keys(), ...b.keys()]);
const onlyA: string[] = [],
  onlyB: string[] = [];
let sizeA = 0,
  sizeB = 0;
for (const [, v] of a) sizeA += v;
for (const [, v] of b) sizeB += v;
for (const k of keys) {
  const x = a.get(k) ?? 0,
    y = b.get(k) ?? 0;
  if (x > y) for (let i = 0; i < x - y; i++) onlyA.push(k);
  if (y > x) for (let i = 0; i < y - x; i++) onlyB.push(k);
}
const perOp = (list: string[]): string => {
  const m = new Map<string, number>();
  for (const k of list) {
    const op = String(JSON.parse(k)[0]);
    m.set(op, (m.get(op) ?? 0) + 1);
  }
  return (
    [...m]
      .sort((p, q) => q[1] - p[1])
      .map(([o, c]) => `${o} ${c}`)
      .join(", ") || "(none)"
  );
};
console.log(`A rows: ${sizeA}   B rows: ${sizeB}   delta: ${sizeB - sizeA}`);
console.log(`only in A (REMOVED by the bump): ${onlyA.length}   [${perOp(onlyA)}]`);
console.log(`only in B (ADDED by the bump):   ${onlyB.length}   [${perOp(onlyB)}]`);
for (const k of onlyA.slice(0, 6)) console.log(`   - ${k.slice(0, 150)}`);
for (const k of onlyB.slice(0, 6)) console.log(`   + ${k.slice(0, 150)}`);
