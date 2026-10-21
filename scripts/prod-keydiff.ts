// Added / removed identity keys between two scripts/prod-identity-keys.ts dumps, grouped by file and operator,
// plus tuples and ordinals moved on the keys present in both. Paths, operators and counts only (never the tuple
// text). usage: bun scripts/prod-keydiff.ts <master.json> <branch.json>
import { readFileSync } from "node:fs";

const [fa, fb] = process.argv.slice(2);
if (fa === undefined || fb === undefined) throw new Error("usage: keydiff.ts <a.json> <b.json>");
type J = { keys?: string[]; error?: string; specs?: number; skipped?: number; hang?: number };
const load = (f: string) => {
  const j = JSON.parse(readFileSync(f, "utf8")) as J;
  if (j.error !== undefined) throw new Error(`${f}: ${j.error}`);
  const m = new Map<string, { tuple: string; ord: string }>();
  for (const l of j.keys ?? []) {
    const [k, rest] = l.split("\t") as [string, string];
    const i = rest.lastIndexOf("|");
    m.set(k, { tuple: rest.slice(0, i), ord: rest.slice(i + 1) });
  }
  return { j, m };
};
const a = load(fa);
const b = load(fb);
const show = (label: string, ks: string[]) => {
  const by = new Map<string, number>();
  for (const k of ks) {
    const [file, op] = k.split("|");
    const g = `${file} ${op}`;
    by.set(g, (by.get(g) ?? 0) + 1);
  }
  console.log(`${label}: ${ks.length}`);
  for (const [g, n] of [...by].sort()) console.log(`  ${n}\t${g}`);
};
show("added", [...b.m.keys()].filter((k) => !a.m.has(k)));
show("removed", [...a.m.keys()].filter((k) => !b.m.has(k)));
let tuples = 0;
let ords = 0;
for (const [k, v] of a.m) {
  const w = b.m.get(k);
  if (w === undefined) continue;
  if (w.tuple !== v.tuple) tuples++;
  else if (w.ord !== v.ord) ords++;
}
console.log(`tuples moved ${tuples}; ordinals moved ${ords}`);
console.log(
  `specs ${a.j.specs} -> ${b.j.specs}; hang ${a.j.hang} -> ${b.j.hang}; skipped ${a.j.skipped} -> ${b.j.skipped}`,
);
