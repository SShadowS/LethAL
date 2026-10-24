// R-717 reach and cost, by parse, on a scratch tree carrying the R717/R718 measurement seams
// (r702Seam.r717: refuse ONLY a one-hop callee's movers and their writes; r718Seam: the walked
// variable's own Insert is no mover). One child process per project, summed per corpus. Counts and
// names (object, procedure, line) only, no source text.
// usage: bun cost717.ts <tree> <set> <outdir>    set: do | cdo | dc | baseapp
//        bun cost717.ts <tree> --one <project-dir> <out.json>
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [tree, a1, a2, a3] = process.argv.slice(2);
if (tree === undefined || a1 === undefined || a2 === undefined) throw new Error("usage");
if (a1 === "--one") {
  if (a3 === undefined) throw new Error("usage");
  const orch = await import(join(tree, "packages/runner/src/orchestrator.ts"));
  const lh = await import(join(tree, "packages/builtin-tier1/src/loop-hazard.ts"));
  type Set_ = { files: { path: string; specs: unknown[] }[] };
  const gen = async (r717: boolean, r718: boolean, whole = false, fix = false) => {
    lh.r702Seam.fix = fix;
    lh.r717Fix.length = 0;
    lh.r702Seam.on = r717;
    lh.r702Seam.callee = r717;
    lh.r702Seam.r717 = r717;
    lh.r702Seam.whole = whole;
    lh.r718Seam.on = r718;
    lh.r702ExtraReset();
    lh.r717Hits.length = 0;
    lh.r718Seam.dropped.length = 0;
    const set = (await orch.generateMutationSet(a2, { emit: () => {} })) as Set_;
    return {
      specs: set.files.reduce((a, f) => a + f.specs.length, 0),
      fixLoops: [...new Set<string>(lh.r717Fix)],
      perFile: Object.fromEntries(set.files.map((f) => [f.path, f.specs.length])) as Record<
        string,
        number
      >,
      hits: [...lh.r717Hits],
      dropped: [...new Set<string>(lh.r718Seam.dropped)],
    };
  };
  const base = await gen(false, false);
  const r717 = await gen(true, false);
  const r718 = await gen(false, true);
  const r717w = await gen(true, false, true);
  const fixc = await gen(false, false, false, true);
  const changed = (x: typeof base) =>
    Object.keys(base.perFile).filter((p) => base.perFile[p] !== x.perFile[p]);
  writeFileSync(
    a3,
    JSON.stringify({
      base: base.specs,
      r717: r717.specs,
      r718: r718.specs,
      r717w: r717w.specs,
      fix: fixc.specs,
      fixLoops: fixc.fixLoops,
      r717wFiles: changed(r717w),
      r717Files: changed(r717),
      r718Files: changed(r718),
      r717Hits: r717.hits,
      r718Dropped: r718.dropped,
    }),
  );
  process.exit(0);
}
const projs: [string, string][] =
  a1 === "baseapp"
    ? [["0", "/work/src/BC.History/BaseApp/Source/Base Application"]]
    : readFileSync(`/coord/handoff/R-702/census/${a1}/projects.tsv`, "utf8")
        .trim()
        .split("\n")
        .map((l) => l.split("\t") as [string, string]);
mkdirSync(a2, { recursive: true });
const sum = { base: 0, r717: 0, r717w: 0, fix: 0, fixLoops: 0, r718: 0, failed: 0 };
const per: unknown[] = [];
for (const [i, p] of projs) {
  const out = join(a2, `${a1}-${i}.json`);
  const r = Bun.spawnSync(["bun", import.meta.path, tree, "--one", p, out], {
    cwd: tree,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (r.exitCode !== 0) {
    sum.failed++;
    console.log(`SKIP ${i}: ${r.stderr.toString().trim().split("\n").slice(-1)[0]?.slice(0, 160)}`);
    continue;
  }
  const j = JSON.parse(readFileSync(out, "utf8"));
  sum.base += j.base;
  sum.r717 += j.r717;
  sum.r718 += j.r718;
  sum.r717w += j.r717w;
  sum.fix += j.fix;
  sum.fixLoops += j.fixLoops.length;
  per.push({
    i,
    fixLoops: j.fixLoops,
    r717wFiles: j.r717wFiles,
    r717Files: j.r717Files,
    r718Files: j.r718Files,
    r717Hits: j.r717Hits,
    r718Dropped: j.r718Dropped,
  });
}
const pct = (x: number): number => (sum.base === 0 ? 0 : Math.round((x / sum.base) * 10000) / 100);
const res = {
  set: a1,
  projects: projs.length,
  ...sum,
  r717Removes: sum.base - sum.r717,
  r717Pct: pct(sum.base - sum.r717),
  r717wRemoves: sum.base - sum.r717w,
  r717wPct: pct(sum.base - sum.r717w),
  fixRemoves: sum.base - sum.fix,
  fixPct: pct(sum.base - sum.fix),
  r718Returns: sum.r718 - sum.base,
  r718Pct: pct(sum.r718 - sum.base),
};
writeFileSync(join(a2, `${a1}-total.json`), JSON.stringify({ ...res, per }));
console.log(JSON.stringify(res));
