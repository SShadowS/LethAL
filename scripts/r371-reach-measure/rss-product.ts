// R-371: peak RSS and time of the PRODUCT test-digest path, offline: what `lethal verify`'s
// planVerify runs on a test project (one read, ONE parse, the TestPage scan and the v2 digests),
// with a fixed dependency fingerprint (no server). Also counts the tests on the whole-source
// fallback, and whether the subscriber fold took it (not part of the timed path).
// Usage: bun scripts/r371-reach-measure/rss-product.ts <test-dir>
// Prints counts, time and RSS only, never AL source (this repo is PUBLIC).
// The "before" figure in the R-371 report was taken with this script's first version, which
// called scanTestPageSources and R-278's testDigestsOfSources: two parses.
import { initParser, normalizeAlName } from "../../packages/engine/src/index";
import { appInputsOfAppJson, readAppJsonInputs } from "../../packages/runner/src/digest-inputs";
import { discoverTests } from "../../packages/runner/src/discovery";
import { testDigestsOfModel } from "../../packages/runner/src/test-digest";
import {
  Scanner,
  buildTestAppModel,
  newReachState,
  readTestAppSources,
  scanTestPageModel,
} from "../../packages/runner/src/testpage-scan";

const [dir] = process.argv.slice(2);
if (dir === undefined) throw new Error("usage: rss-product.ts <test-dir>");
let peak = 0;
const sample = (): void => {
  peak = Math.max(peak, process.memoryUsage().rss);
};
const timer = setInterval(sample, 5);
const mb = (b: number): string => `${(b / 1048576).toFixed(0)} MB`;
const t0 = performance.now();
sample();
const start = process.memoryUsage().rss;
await initParser();
const tests = await discoverTests(dir);
const model = buildTestAppModel(await readTestAppSources(dir));
const refused = scanTestPageModel(model, tests);
sample();
const inputs = {
  dependencies: "offline",
  buildInputs: ((await readAppJsonInputs(dir)) ?? appInputsOfAppJson({})).buildInputs,
};
const { digests } = testDigestsOfModel(model, tests, inputs);
sample();
clearInterval(timer);
const ms = performance.now() - t0;

const scanner = new Scanner(model);
const subs = newReachState();
let subscriberUnits = 0;
for (const u of model.units) {
  if (!u.subscriber) continue;
  subscriberUnits += 1;
  for (const p of [...u.procs, ...u.triggers]) scanner.reach(p, subs);
}
let fallback = 0;
for (const t of tests) {
  const st = newReachState();
  for (const u of model.units.filter((x) => x.id === t.codeunitId))
    for (const p of u.procs.filter((x) => x.name === normalizeAlName(t.method)))
      scanner.reach(p, st);
  if (st.fallback !== undefined) fallback += 1;
}
console.log(
  `${model.fileHashes.length} files, ${tests.length} tests, ${refused.size} TestPage-refused, ${Object.keys(digests).length} digests; ${(ms / 1000).toFixed(1)} s; RSS at start ${mb(start)}, peak ${mb(peak)}`,
);
console.log(
  `subscriber codeunits ${subscriberUnits}; subscriber fold on the fallback: ${subs.fallback === undefined ? "no" : `YES: ${subs.fallback}`}; tests on the fallback by their own reach: ${fallback}`,
);
