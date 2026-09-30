// R-371 measurement: if each test's digest covered every TEST-APP procedure it can reach, how many
// tests would one helper edit turn "new" in `lethal verify`, and what would that cost verify's
// requests? Usage: bun scripts/r371-reach-measure/measure.ts <label> <test-dir>
// Prints names and counts only, never AL source (this repo is PUBLIC).
// Relative imports: scripts/ is outside the workspaces (see scripts/r236c-testpage-census.ts).
import { initParser, normalizeAlName, parseAL } from "../../packages/engine/src/index";
import { discoverTests } from "../../packages/runner/src/discovery";
import { readTestAppSources } from "../../packages/runner/src/testpage-scan";
import { type Proc, Scanner, type TestState, type Unit, scanFile } from "./walk";

const [label, dir] = process.argv.slice(2);
if (label === undefined || dir === undefined) throw new Error("usage: measure.ts <label> <dir>");

let peakRss = 0;
const sample = (): void => {
  peakRss = Math.max(peakRss, process.memoryUsage().rss);
};
const mb = (b: number): string => `${(b / 1024 / 1024).toFixed(0)} MB`;
const log = (s: string): void => console.log(s);

await initParser();
sample();
const t0 = performance.now();
const tests = await discoverTests(dir);
const files = await readTestAppSources(dir);
const tRead = performance.now();
const units: Unit[] = [];
const suspect: string[] = [];
const others = new Map<string, Set<string>>();
for (const f of files) {
  scanFile(f.path, parseAL(f.text), units, suspect, others);
  sample();
}
const tParse = performance.now();
const rssAfterParse = peakRss;
const scanner = new Scanner(units, others);

const allProcs = units.flatMap((u) => u.procs);
const reach = new Map<Proc, number>();
/** Proc -> the one test codeunit id whose tests reach it, or -1 when tests of several do. */
const owner = new Map<Proc, number>();
const testProcs = new Set<Proc>();
const perTestReach: number[] = [];
const kindTests = new Map<string, number>(); // kind -> tests with >= 1 edge of that kind
const targetTests = new Map<string, number>(); // "kind: target" -> tests
let testsWithUnresolved = 0;
let testsWithHandlers = 0;
let testsHittingLibrary = 0;
const missing: string[] = [];

for (const [i, t] of tests.entries()) {
  const decls = units
    .filter((u) => u.id === t.codeunitId)
    .flatMap((u) => u.procs.filter((p) => p.name === normalizeAlName(t.method) && p.params === 0));
  if (decls.length === 0) {
    missing.push(`${t.codeunitName}.${t.method}`);
    continue;
  }
  const st: TestState = {
    visited: new Set(),
    unresolved: new Map(),
    reached: new Set(),
    unresolvedTargets: new Set(),
    problems: [],
    reason: undefined,
  };
  for (const d of decls) {
    testProcs.add(d);
    scanner.walk(d, [], st);
  }
  if (decls.some((d) => d.handlers.length > 0)) testsWithHandlers += 1;
  perTestReach.push(st.visited.size);
  for (const p of st.visited) {
    reach.set(p, (reach.get(p) ?? 0) + 1);
    const o = owner.get(p);
    if (o === undefined) owner.set(p, t.codeunitId);
    else if (o !== t.codeunitId) owner.set(p, -1);
  }
  if (st.unresolved.size > 0) testsWithUnresolved += 1;
  // A name heuristic only: a test-library codeunit (Library - Sales, Library Assert) versus the app
  // under test, which a test-app digest need not cover.
  const outside = [...(st.unresolved.get("codeunit outside the test app") ?? [])];
  if (outside.some((n) => /library|assert/i.test(n))) testsHittingLibrary += 1;
  for (const [kind, targets] of st.unresolved) {
    kindTests.set(kind, (kindTests.get(kind) ?? 0) + 1);
    for (const tg of targets) {
      const k = `${kind}: ${tg}`;
      targetTests.set(k, (targetTests.get(k) ?? 0) + 1);
    }
  }
  if (i % 50 === 0) sample();
}
sample();
const tWalk = performance.now();

const pct = (sorted: readonly number[], q: number): number =>
  sorted.length === 0 ? 0 : (sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)] ?? 0);
const name = (p: Proc): string => `${p.display}/${p.params}`;
const walked = tests.length - missing.length;

log(`=== ${label}: ${dir}`);
log(
  `files ${files.length}, codeunits ${units.length}, procedures ${allProcs.length}, non-codeunit objects ${others.size}`,
);
log(
  `tests discovered ${tests.length}, walked ${walked}, no declaration found ${missing.length}${missing.length > 0 ? ` (first: ${missing.slice(0, 5).join(", ")})` : ""}`,
);
log(`parse-error sites (inside a codeunit or outside every object): ${suspect.length}`);
log(`tests carrying [HandlerFunctions]: ${testsWithHandlers}`);
log(
  `event subscriber procedures in the test app (never walked from a test): ${allProcs.filter((p) => p.isSubscriber).length}`,
);
log(
  `time: read ${((tRead - t0) / 1000).toFixed(1)} s, parse ${((tParse - tRead) / 1000).toFixed(1)} s, walk ${((tWalk - tParse) / 1000).toFixed(1)} s; peak RSS ${mb(peakRss)} (${mb(rssAfterParse)} of it reached by the end of parsing)`,
);

const ptr = [...perTestReach].sort((a, b) => a - b);
log(
  `\nper test, reachable test-app procedures (incl. the test): p50 ${pct(ptr, 0.5)}, p90 ${pct(ptr, 0.9)}, max ${pct(ptr, 1)}`,
);
const pctU = walked === 0 ? 0 : (100 * testsWithUnresolved) / walked;
log(
  `tests with >= 1 edge the walk did not follow: ${testsWithUnresolved} of ${walked} (${pctU.toFixed(1)}%)`,
);
for (const [kind, n] of [...kindTests].sort((a, b) => b[1] - a[1]))
  log(`  ${kind}: ${n} tests (${((100 * n) / walked).toFixed(1)}%)`);
log(
  `  of which a codeunit outside the test app named like a library (/library|assert/i): ${testsHittingLibrary} tests (${((100 * testsHittingLibrary) / walked).toFixed(1)}%)`,
);
log("most common unfollowed targets (tests hitting each):");
for (const [k, n] of [...targetTests].sort((a, b) => b[1] - a[1]).slice(0, 15)) log(`  ${n}  ${k}`);

const reachedAll = [...reach.values()].sort((a, b) => a - b);
log(`\nsharing: ${reach.size} of ${allProcs.length} procedures are reached by >= 1 test`);
log(
  `tests reaching a procedure (over reached procedures): p50 ${pct(reachedAll, 0.5)}, p90 ${pct(reachedAll, 0.9)}, p99 ${pct(reachedAll, 0.99)}, max ${pct(reachedAll, 1)}`,
);
const helpers = [...reach].filter(([p]) => !testProcs.has(p)).sort((a, b) => a[1] - b[1]);
const hv = helpers.map(([, n]) => n);
log(
  `over reached NON-test procedures (${helpers.length}): p50 ${pct(hv, 0.5)}, p90 ${pct(hv, 0.9)}, p99 ${pct(hv, 0.99)}, max ${pct(hv, 1)}`,
);
log("top 10 procedures by reach:");
for (const [p, n] of [...reach].sort((a, b) => b[1] - a[1]).slice(0, 10))
  log(`  ${n}  ${name(p)}${testProcs.has(p) ? " [test]" : ""}`);

// The five edits. Today's per-method digest turns new only a test whose OWN method is edited.
const at = (q: number): [Proc, number] | undefined =>
  helpers[Math.max(0, Math.ceil(q * helpers.length) - 1)];
const handlerProcs = new Set<Proc>();
for (const u of units)
  for (const p of u.procs)
    for (const h of p.handlers) for (const c of u.procs) if (c.name === h) handlerProcs.add(c);
const handlerPick = helpers.filter(([p]) => handlerProcs.has(p)).at(-1);
const local = helpers.filter(([p]) => owner.get(p) === p.unit.id);
const localPick = local[Math.max(0, Math.ceil(0.5 * local.length) - 1)];
log(
  `\nhandlers reached: ${helpers.filter(([p]) => handlerProcs.has(p)).length}; codeunit-local helpers (reached only by tests of their own codeunit): ${local.length}`,
);
const edits: Array<[string, [Proc, number] | undefined]> = [
  ["1 most-shared helper", helpers.at(-1)],
  ["2 p90-shared helper", at(0.9)],
  ["3 median helper", at(0.5)],
  ["4 most-shared handler", handlerPick],
  ["5 median codeunit-local helper", localPick],
];
log(
  "\nedit | procedure | tests new (reach digest) | tests new (per-method digest today) | extra executions S=10 | S=100 | multiplier vs N=1",
);
const row: string[] = [];
for (const [what, pick] of edits) {
  if (pick === undefined) {
    log(`${what} | none | - | - | - | - | -`);
    row.push("-");
    continue;
  }
  const [p, n] = pick;
  // Verify adds every new test to every survivor's request, plus two unmutated runs per new test.
  // Upper bound: a new test that already covers a survivor is deduplicated there.
  const extra = (s: number): number => s * n + 2 * n;
  log(`${what} | ${name(p)} | ${n} | 0 | ${extra(10)} | ${extra(100)} | ${n}x`);
  row.push(String(n));
}
log(
  `\nSUMMARY | ${label} | ${walked} | ${pctU.toFixed(1)}% | ${pct(hv, 1)}/${pct(hv, 0.9)}/${pct(hv, 0.5)} | ${row.join(" / ")} | ${mb(peakRss)} | ${((tWalk - t0) / 1000).toFixed(1)} s`,
);
