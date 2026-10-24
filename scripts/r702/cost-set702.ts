// R-702 gap 1 cost for a corpus: cost702.ts once per project (one process each), summed.
// usage: bun cost-set702.ts <set> <tree> <outdir>   set: do | cdo | dc | baseapp
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [set, tree, outdir] = process.argv.slice(2);
if (set === undefined || tree === undefined || outdir === undefined) throw new Error("usage");
const projs: [string, string][] =
  set === "baseapp"
    ? [["0", "/work/src/BC.History/BaseApp/Source/Base Application"]]
    : readFileSync(`/coord/handoff/R-702/census/${set}/projects.tsv`, "utf8")
        .trim()
        .split("\n")
        .map((l) => l.split("\t") as [string, string]);
mkdirSync(outdir, { recursive: true });
const sum = { off: 0, r696: 0, r702: 0, r702callee: 0, hangOff: 0, hang696: 0, hang702: 0, hang702callee: 0 };
let failed = 0;
const t0 = Date.now();
for (const [i, p] of projs) {
  const out = join(outdir, `${set}-${i}.json`);
  const r = Bun.spawnSync(["bun", "/work/lethal-wt/r702/scripts/r702/cost702.ts", tree, out, p], { cwd: tree, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) {
    failed++;
    console.log(`SKIP ${i} ${p.replace(/^\/work\/src\//, "")}: ${r.stderr.toString().trim().split("\n").slice(-1)[0]?.slice(0, 160)}`);
    continue;
  }
  const j = JSON.parse(readFileSync(out, "utf8"));
  sum.off += j.off.specs;
  sum.r696 += j.r696.specs;
  sum.r702 += j.r702.specs;
  sum.r702callee += j.r702callee.specs;
  sum.hang702callee += j.r702callee.hang;
  sum.hangOff += j.off.hang;
  sum.hang696 += j.r696.hang;
  sum.hang702 += j.r702.hang;
}
const pct = (x: number): number => (sum.off === 0 ? 0 : Math.round((x / sum.off) * 10000) / 100);
const res = {
  set,
  projects: projs.length,
  failed,
  ...sum,
  removedByR696: sum.off - sum.r696,
  removedByR696PlusGap1: sum.off - sum.r702,
  addedByGap1: sum.r696 - sum.r702,
  addedSharePct: pct(sum.r696 - sum.r702),
  addedByGap1WithCalleeSites: sum.r696 - sum.r702callee,
  addedWithCalleeSitesSharePct: pct(sum.r696 - sum.r702callee),
  secs: Math.round((Date.now() - t0) / 1000),
};
writeFileSync(join(outdir, `${set}-total.json`), JSON.stringify(res));
console.log(JSON.stringify(res));
