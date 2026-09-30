// R-371 build: the plan's r2 cost table, re-measured through the PRODUCT walk (testpage-scan's
// Scanner.reach, with cases 14 to 16 followed by walking the object's code and the subscriber
// closure in every digest), offline.
// Usage: bun scripts/r371-reach-measure/product-measure.ts <label> <test-dir>
// N for an edit is the number of tests whose v2 digest it changes:
// - a procedure edit (every procedure and trigger in turn): tests that reach it, or every test
//   when it is in the subscriber closure, plus every test on the whole-source fallback;
// - an object edit (a codeunit's header, properties, globals or triggers; any edit to another
//   object): tests that reach the object, or every test when a subscriber reaches it or it is a
//   subscriber codeunit, plus every fallback test.
// Prints counts only, never AL source (this repo is PUBLIC).
import { initParser, normalizeAlName } from "../../packages/engine/src/index";
import { discoverTests } from "../../packages/runner/src/discovery";
import {
  type Proc,
  Scanner,
  type Unit,
  buildTestAppModel,
  newReachState,
  readTestAppSources,
} from "../../packages/runner/src/testpage-scan";

const [label, dir] = process.argv.slice(2);
if (label === undefined || dir === undefined)
  throw new Error("usage: product-measure.ts <label> <test-dir>");
await initParser();
const tests = await discoverTests(dir);
const model = buildTestAppModel(await readTestAppSources(dir));
const scanner = new Scanner(model);

const closure = newReachState();
for (const u of model.units)
  if (u.subscriber) for (const p of [...u.procs, ...u.triggers]) scanner.reach(p, closure);
const closureFallback = closure.fallback !== undefined;

const procCount = new Map<Proc, number>();
const unitCount = new Map<Unit, number>();
let fallback = 0;
const why = new Map<string, number>();
for (const t of tests) {
  const st = newReachState();
  for (const u of model.units.filter((x) => x.id === t.codeunitId))
    for (const p of u.procs.filter((x) => x.name === normalizeAlName(t.method)))
      scanner.reach(p, st);
  if (closureFallback || st.fallback !== undefined) {
    fallback += 1;
    const kind = (st.fallback ?? "closure").replace(
      /^.*? (calls|runs|names|dispatches|is called|may run|on a|inside|is not in|does not parse|handler)\b.*$/,
      "$1",
    );
    why.set(kind, (why.get(kind) ?? 0) + 1);
    continue;
  }
  for (const p of st.procs) procCount.set(p, (procCount.get(p) ?? 0) + 1);
  for (const u of st.units) unitCount.set(u, (unitCount.get(u) ?? 0) + 1);
}
const T = tests.length;
const all = [...model.units, ...model.objects];
const procN: number[] = [];
const objN: number[] = [];
for (const u of all) {
  const everyTest = u.subscriber || closure.units.has(u);
  objN.push(everyTest ? T : Math.min(T, (unitCount.get(u) ?? 0) + fallback));
  for (const p of [...u.procs, ...u.triggers]) {
    const inClosure = closure.procs.has(p) || u.subscriber;
    // Another object's parts are its whole text: a procedure edit there is an object edit.
    const reached = u.kind === "codeunit" ? (procCount.get(p) ?? 0) : (unitCount.get(u) ?? 0);
    procN.push(inClosure ? T : Math.min(T, reached + fallback));
  }
}
const pct = (xs: number[], q: number): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length === 0 ? 0 : (s[Math.max(0, Math.ceil(q * s.length) - 1)] ?? 0);
};
const over = (xs: number[]): string =>
  `${((100 * xs.filter((n) => n > 50).length) / Math.max(1, xs.length)).toFixed(1)}%`;
console.log(
  `${label}: ${T} tests; broad fallback ${fallback} (${((100 * fallback) / T).toFixed(1)}%), subscriber closure on the fallback: ${closureFallback ? "yes" : "no"}`,
);
console.log(
  `  fallback by first reason: ${[...why].map(([k, n]) => `${k} ${n}`).join(", ") || "none"}`,
);
console.log(
  `  procedure edit (${procN.length}): p50 ${pct(procN, 0.5)}, p90 ${pct(procN, 0.9)}, max ${Math.max(...procN)}, P(N>50) ${over(procN)}`,
);
console.log(
  `  object edit (${objN.length}): p50 ${pct(objN, 0.5)}, p90 ${pct(objN, 0.9)}, max ${Math.max(...objN)}, P(N>50) ${over(objN)}`,
);
console.log(
  `  subscriber closure: ${closure.procs.size} procedures, ${closure.units.size} objects`,
);
