// R-371 measurement, r2 (the r1 version is in commit eb250b2c): with a fail-closed edge classifier,
// with-receivers resolved, subscriber codeunits folded into every digest and object parts counted,
// how many tests sit on the broad (whole-test-app) fallback, and how many tests does one ordinary
// edit turn "new" in `lethal verify`?
// Usage: bun scripts/r371-reach-measure/measure.ts <label> <test-dir> <symbol-packages-dir | ->
// Prints names and counts only, never AL source (this repo is PUBLIC).
// Relative imports: scripts/ is outside the workspaces (see scripts/r236c-testpage-census.ts).
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { initParser, normalizeAlName, parseAL } from "../../packages/engine/src/index";
import { readPackageEntry } from "../../packages/runner/src/app-package";
import { discoverTests } from "../../packages/runner/src/discovery";
import { readTestAppSources } from "../../packages/runner/src/testpage-scan";
import {
  type DependencyIndex,
  type OtherObject,
  type Proc,
  Scanner,
  type TestState,
  type Unit,
  lastSegment,
  newState,
  scanFile,
} from "./walk";

const [label, dir, symbolsDir] = process.argv.slice(2);
if (label === undefined || dir === undefined || symbolsDir === undefined)
  throw new Error("usage: measure.ts <label> <test-dir> <symbol-packages-dir | ->");

let peakRss = 0;
const sample = (): void => {
  peakRss = Math.max(peakRss, process.memoryUsage().rss);
};
const mb = (b: number): string => `${(b / 1024 / 1024).toFixed(0)} MB`;
const secs = (a: number, b: number): string => `${((b - a) / 1000).toFixed(1)} s`;
const log = (s: string): void => console.log(s);
const pct = (sorted: readonly number[], q: number): number =>
  sorted.length === 0 ? 0 : (sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)] ?? 0);
const share = (n: number, d: number): string => `${d === 0 ? "0.0" : ((100 * n) / d).toFixed(1)}%`;
const sortNum = (xs: Iterable<number>): number[] => [...xs].sort((a, b) => a - b);

// 1. Dependency symbols, one package at a time, each dropped after its names are taken.
const SYMBOL_KINDS: ReadonlyArray<[string, string]> = [
  ["Tables", "table"],
  ["Codeunits", "codeunit"],
  ["Pages", "page"],
  ["Reports", "report"],
  ["Queries", "query"],
  ["XmlPorts", "xmlport"],
];
const t0 = performance.now();
sample();
const declared = new Set<string>();
let packagesRead = 0;
if (symbolsDir !== "-") {
  for (const f of readdirSync(symbolsDir).filter((x) => x.toLowerCase().endsWith(".app"))) {
    const entry = readPackageEntry(readFileSync(join(symbolsDir, f)), "SymbolReference.json");
    if (entry === null) continue;
    let text = entry.toString("utf8");
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const ingest = (scope: Record<string, unknown>): void => {
      for (const [key, kind] of SYMBOL_KINDS) {
        for (const o of (scope[key] as Array<{ Id?: number; Name?: string }> | undefined) ?? []) {
          if (typeof o.Name === "string") declared.add(`${kind}:${lastSegment(`"${o.Name}"`)}`);
          if (typeof o.Id === "number") declared.add(`${kind}:${o.Id}`);
        }
      }
      for (const n of (scope.Namespaces as Array<Record<string, unknown>> | undefined) ?? [])
        ingest(n);
    };
    ingest(JSON.parse(text) as Record<string, unknown>);
    packagesRead += 1;
    sample();
  }
}
const deps: DependencyIndex = {
  mode: symbolsDir === "-" ? "not-in-test-app" : "symbols",
  declared,
};
const tSymbols = performance.now();
const rssAfterSymbols = peakRss;

// 2. Parse.
await initParser();
const tests = await discoverTests(dir);
const files = await readTestAppSources(dir);
const units: Unit[] = [];
const suspect: string[] = [];
const others = new Map<string, OtherObject>();
for (const f of files) {
  scanFile(f.path, parseAL(f.text), units, suspect, others);
  sample();
}
const totalChars = files.reduce((s, f) => s + f.text.length, 0);
const tParse = performance.now();
const rssAfterParse = peakRss;
const scanner = new Scanner(units, others, deps);
const allProcs = units.flatMap((u) => u.procs);

// 3. Subscribers (C2): their codeunits go into EVERY test's digest.
const subscriberUnits = new Set(units.filter((u) => u.procs.some((p) => p.isSubscriber)));
const bound = new Set<Unit>();
for (const p of allProcs) {
  for (const s of p.sites ?? []) {
    if (s.kind !== "bare" || !/^bindsubscription$/i.test(s.name) || s.arg0 === undefined) continue;
    const types =
      p.scope.get(normalizeAlName(s.arg0)) ?? p.unit.globals.get(normalizeAlName(s.arg0)) ?? [];
    for (const t of types) for (const u of scanner.unitsFor(t)) bound.add(u);
  }
}

// 4. Walk every test.
const T = tests.length;
type Obj = Unit | string;
const objOf = (p: Proc): Obj => p.unit;
const procReachAll = new Map<Proc, number>();
/** Proc -> the one test codeunit id whose tests reach it, or -1. */
const ownerCu = new Map<Proc, number>();
const objReachAll = new Map<Obj, number>();
const procReachNF = { strict: new Map<Proc, number>(), relaxed: new Map<Proc, number>() };
const objReachNF = { strict: new Map<Obj, number>(), relaxed: new Map<Obj, number>() };
const fallback = { strict: 0, relaxed: 0 };
const kindTests = new Map<string, number>();
const onlyKindTests = new Map<string, number>();
const targetTests = new Map<string, number>();
const externalTests = new Map<string, number>();
const objsPerTest: number[] = [];
let edgesFollowed = 0;
let edgesExternal = 0;
let edgesUnfollowed = 0;
const missing: string[] = [];
const bump = <K>(m: Map<K, number>, k: K): void => {
  m.set(k, (m.get(k) ?? 0) + 1);
};
for (const [i, t] of tests.entries()) {
  const decls = units
    .filter((u) => u.id === t.codeunitId)
    .flatMap((u) =>
      u.procs.filter((p) => !p.isTrigger && p.name === normalizeAlName(t.method) && p.params === 0),
    );
  if (decls.length === 0) {
    missing.push(`${t.codeunitName}.${t.method}`);
    continue;
  }
  const st: TestState = newState();
  for (const d of decls) scanner.walk(d, [], st);
  const objs: Obj[] = [...st.reached, ...st.reachedOthers];
  objsPerTest.push(objs.length);
  edgesFollowed += st.followed;
  for (const s of st.external.values()) edgesExternal += s.size;
  for (const [k, s] of st.external) for (const x of s) bump(externalTests, `${k} ${x}`);
  for (const s of st.unfollowed.values()) edgesUnfollowed += s.size;
  const kinds = [...st.unfollowed.keys()];
  for (const k of kinds) bump(kindTests, k);
  const [only] = kinds;
  if (kinds.length === 1 && only !== undefined) bump(onlyKindTests, only);
  for (const [k, s] of st.unfollowed) for (const x of s) bump(targetTests, `${k}: ${x}`);
  const strictFb = kinds.length > 0;
  const relaxedFb = kinds.some((k) => k !== "BindSubscription/UnbindSubscription");
  if (strictFb) fallback.strict += 1;
  if (relaxedFb) fallback.relaxed += 1;
  for (const p of st.visited) {
    bump(procReachAll, p);
    const o = ownerCu.get(p);
    if (o === undefined) ownerCu.set(p, t.codeunitId);
    else if (o !== t.codeunitId) ownerCu.set(p, -1);
    if (!strictFb) bump(procReachNF.strict, p);
    if (!relaxedFb) bump(procReachNF.relaxed, p);
  }
  for (const o of objs) {
    bump(objReachAll, o);
    if (!strictFb) bump(objReachNF.strict, o);
    if (!relaxedFb) bump(objReachNF.relaxed, o);
  }
  if (i % 50 === 0) sample();
}
sample();
const tWalk = performance.now();

// With-receivers (I4), per call site: a bare call inside a with that its own codeunit does not
// declare, which is the only case where the with-target decides the callee.
let withSites = 0;
let withResolved = 0;
for (const p of allProcs) {
  for (const s of p.sites ?? []) {
    if (s.kind !== "bare" || s.withRecv.length === 0) continue;
    const nn = normalizeAlName(s.name);
    if (p.unit.procs.some((c) => !c.isTrigger && c.name === nn && c.params === s.args)) continue;
    withSites += 1;
    if (scanner.resolveWith(p, s.withRecv) !== undefined) withResolved += 1;
  }
}

const walked = T - missing.length;
log(`=== ${label}: ${dir}`);
log(
  `dependency objects: ${deps.mode === "symbols" ? `read from ${packagesRead} symbol packages in ${symbolsDir} (${declared.size} kind:name/id keys)` : 'no symbol packages: "not in the test app" is taken as a dependency object'}`,
);
log(
  `files ${files.length} (${totalChars} chars), codeunits ${units.length}, codeunit procedures+triggers ${allProcs.length}, non-codeunit objects ${others.size} (${[...others.values()].reduce((s, o) => s + o.procCount, 0)} procedures)`,
);
log(
  `tests discovered ${T}, walked ${walked}, no declaration found ${missing.length}; parse-error sites ${suspect.length}`,
);
log(
  `time: symbols ${secs(t0, tSymbols)}, read+parse ${secs(tSymbols, tParse)}, walk ${secs(tParse, tWalk)}; peak RSS ${mb(peakRss)} (after symbols ${mb(rssAfterSymbols)}, after parse ${mb(rssAfterParse)})`,
);

log("\n-- edges (per test, distinct targets; summed over tests)");
log(`followed ${edgesFollowed}, external ${edgesExternal}, unfollowed ${edgesUnfollowed}`);
log(
  `broad fallback, strict (any UNFOLLOWED edge): ${fallback.strict} of ${walked} (${share(fallback.strict, walked)})`,
);
log(
  `broad fallback, if BindSubscription were not a trigger (subscribers are in every digest anyway): ${fallback.relaxed} (${share(fallback.relaxed, walked)})`,
);
log("tests per UNFOLLOWED kind (and tests where it is the ONLY kind):");
for (const [k, n] of [...kindTests].sort((a, b) => b[1] - a[1]))
  log(`  ${n} (${share(n, walked)}), only: ${onlyKindTests.get(k) ?? 0}  ${k}`);
log("most common UNFOLLOWED targets (tests):");
for (const [k, n] of [...targetTests].sort((a, b) => b[1] - a[1]).slice(0, 15)) log(`  ${n}  ${k}`);
log("most common EXTERNAL targets (tests):");
for (const [k, n] of [...externalTests].sort((a, b) => b[1] - a[1]).slice(0, 8))
  log(`  ${n}  ${k}`);
log(
  `with-receivers (I4): ${withSites} bare-call sites inside a with that their own codeunit does not declare; ${withResolved} resolve through the with-target's declared type (${share(withResolved, withSites)}), ${withSites - withResolved} stay UNFOLLOWED`,
);

log("\n-- subscribers (C2)");
const subProcs = allProcs.filter((p) => subscriberUnits.has(p.unit));
const allProcCount = allProcs.length + [...others.values()].reduce((s, o) => s + o.procCount, 0);
const subChars = [...subscriberUnits].reduce((s, u) => s + u.chars, 0);
const manual = [...subscriberUnits].filter((u) => u.manualBinding);
log(
  `subscriber codeunits ${subscriberUnits.size} (manual binding ${manual.length}, automatic ${subscriberUnits.size - manual.length}); [EventSubscriber] procedures ${allProcs.filter((p) => p.isSubscriber).length}`,
);
log(
  `codeunits named in a BindSubscription call: ${bound.size} (${[...bound].filter((u) => subscriberUnits.has(u)).length} of them hold subscribers)`,
);
log(
  `procedures in subscriber codeunits: ${subProcs.length} of ${allProcCount} test-app procedures+triggers (${share(subProcs.length, allProcCount)}); chars ${subChars} of ${totalChars} (${share(subChars, totalChars)})`,
);
log(
  `=> a uniformly random procedure edit touches a subscriber codeunit, turning EVERY test new, with probability ${share(subProcs.length, allProcCount)}`,
);

log("\n-- object parts (C1)");
const opt = sortNum(objsPerTest);
const avg = opt.reduce((s, x) => s + x, 0) / Math.max(1, opt.length);
log(
  `reached objects per test: avg ${avg.toFixed(1)}, p50 ${pct(opt, 0.5)}, p90 ${pct(opt, 0.9)}, max ${pct(opt, 1)}`,
);
const objName = (o: Obj): string =>
  typeof o === "string" ? (others.get(o)?.display ?? o) : `codeunit ${o.display}`;
const ov = sortNum(objReachAll.values());
log(
  `tests reaching an object (over ${objReachAll.size} reached objects): p50 ${pct(ov, 0.5)}, p90 ${pct(ov, 0.9)}, p99 ${pct(ov, 0.99)}, max ${pct(ov, 1)}`,
);
log("top 5 objects by reach:");
for (const [o, n] of [...objReachAll].sort((a, b) => b[1] - a[1]).slice(0, 5))
  log(`  ${n}  ${objName(o)}`);
// r1's five edits re-picked on this walk: procedure-level vs object-level (a global/header/trigger
// edit to the helper's own object).
const testProcs = new Set<Proc>();
for (const t of tests)
  for (const u of units)
    if (u.id === t.codeunitId)
      for (const p of u.procs)
        if (!p.isTrigger && p.name === normalizeAlName(t.method) && p.params === 0)
          testProcs.add(p);
const helpers = [...procReachAll].filter(([p]) => !testProcs.has(p)).sort((a, b) => a[1] - b[1]);
const at = (q: number): [Proc, number] | undefined =>
  helpers[Math.max(0, Math.ceil(q * helpers.length) - 1)];
const handlerProcs = new Set<Proc>();
for (const u of units)
  for (const p of u.procs)
    for (const h of p.handlers) for (const c of u.procs) if (c.name === h) handlerProcs.add(c);
const local = helpers.filter(([p]) => ownerCu.get(p) === p.unit.id);
const localPick = local[Math.max(0, Math.ceil(0.5 * local.length) - 1)];
const edits: Array<[string, [Proc, number] | undefined]> = [
  ["1 most-shared helper", helpers.at(-1)],
  ["2 p90-shared helper", at(0.9)],
  ["3 median helper", at(0.5)],
  ["4 most-shared handler", helpers.filter(([p]) => handlerProcs.has(p)).at(-1)],
  ["5 median codeunit-local helper", localPick],
];
log(
  "edit | procedure | tests reaching the procedure | tests reaching its object (global/header/trigger edit)",
);
for (const [what, pick] of edits) {
  if (pick === undefined) {
    log(`${what} | none | - | -`);
    continue;
  }
  const [p, n] = pick;
  log(`${what} | ${p.display}/${p.params} | ${n} | ${objReachAll.get(objOf(p)) ?? 0}`);
}

// 5. The headline: one ordinary edit, uniform over procedures, and over objects.
log("\n-- one ordinary edit (N = tests turned new)");
const dist = (ns: number[]): string => {
  const s = sortNum(ns);
  const over = s.filter((x) => x > 50).length;
  return `p50 ${pct(s, 0.5)}, p90 ${pct(s, 0.9)}, p99 ${pct(s, 0.99)}, max ${pct(s, 1)}, P(N>50) ${share(over, s.length)} (over ${s.length})`;
};
const headline: string[] = [];
for (const mode of ["strict", "relaxed"] as const) {
  const F = fallback[mode];
  const procN: number[] = [];
  for (const p of allProcs)
    procN.push(subscriberUnits.has(p.unit) ? walked : (procReachNF[mode].get(p) ?? 0) + F);
  for (const o of others.values()) for (let k = 0; k < o.procCount; k += 1) procN.push(F);
  const objN: number[] = [];
  for (const u of units)
    objN.push(subscriberUnits.has(u) ? walked : (objReachNF[mode].get(u) ?? 0) + F);
  for (const o of others.values()) objN.push((objReachNF[mode].get(o.key) ?? 0) + F);
  log(`${mode}: fallback F = ${F} (${share(F, walked)})`);
  log(`  procedure edit: ${dist(procN)}`);
  log(`  global/header/trigger edit, per object: ${dist(objN)}`);
  const s = sortNum(procN);
  const so = sortNum(objN);
  headline.push(
    `${mode} F ${share(F, walked)} | proc ${pct(s, 0.5)}/${pct(s, 0.9)}/${pct(s, 1)} P>50 ${share(s.filter((x) => x > 50).length, s.length)} | obj ${pct(so, 0.5)}/${pct(so, 0.9)}/${pct(so, 1)} P>50 ${share(so.filter((x) => x > 50).length, so.length)}`,
  );
}
log(
  `\nSUMMARY | ${label} | tests ${walked} | subscriber share ${share(subProcs.length, allProcCount)} | ${headline.join(" || ")} | RSS ${mb(peakRss)} | ${secs(t0, tWalk)}`,
);
