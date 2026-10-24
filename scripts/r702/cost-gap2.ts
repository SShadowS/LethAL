// R-702 gap 2 reach and cost: generateMutationSet with the R702 temp-walk rule off, then on, one
// child process per project (memory), summed per corpus. Counts only, no source text.
// usage: bun cost-gap2.ts <set> <outdir>    set: do | cdo | dc | baseapp
//        bun cost-gap2.ts --one <project-dir> <out.json>
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const tree = join(import.meta.dir, "../..");
const [a1, a2, a3] = process.argv.slice(2);
if (a1 === "--one") {
  if (a2 === undefined || a3 === undefined) throw new Error("usage");
  const orch = await import(join(tree, "packages/runner/src/orchestrator.ts"));
  const lh = await import(join(tree, "packages/builtin-tier1/src/loop-hazard.ts"));
  type Set_ = { files: { path: string; specs: unknown[] }[]; hangRefused: { sites: number }[] };
  const gen = async (on: boolean) => {
    lh.r702Seam.on = on;
    const set = (await orch.generateMutationSet(a2, { emit: () => {} })) as Set_;
    return {
      specs: set.files.reduce((a, f) => a + f.specs.length, 0),
      hang: set.hangRefused.reduce((a, h) => a + h.sites, 0),
      perFile: Object.fromEntries(set.files.map((f) => [f.path, f.specs.length])),
    };
  };
  const off = await gen(false);
  const on = await gen(true);
  const files = Object.keys(off.perFile).filter((p) => off.perFile[p] !== on.perFile[p]);
  writeFileSync(
    a3,
    JSON.stringify({ off: off.specs, on: on.specs, hangOff: off.hang, hangOn: on.hang, files }),
  );
  process.exit(0);
}
if (a1 === undefined || a2 === undefined) throw new Error("usage");
const projs: [string, string][] =
  a1 === "baseapp"
    ? [["0", "/work/src/BC.History/BaseApp/Source/Base Application"]]
    : readFileSync(`/coord/handoff/R-702/census/${a1}/projects.tsv`, "utf8")
        .trim()
        .split("\n")
        .map((l) => l.split("\t") as [string, string]);
mkdirSync(a2, { recursive: true });
const sum = { off: 0, on: 0, hangOff: 0, hangOn: 0, failed: 0, files: [] as string[] };
for (const [i, p] of projs) {
  const out = join(a2, `${a1}-${i}.json`);
  const r = Bun.spawnSync(["bun", import.meta.path, "--one", p, out], {
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
  sum.off += j.off;
  sum.on += j.on;
  sum.hangOff += j.hangOff;
  sum.hangOn += j.hangOn;
  for (const f of j.files) sum.files.push(`${i}:${f}`);
}
const added = sum.off - sum.on;
const res = {
  set: a1,
  projects: projs.length,
  ...sum,
  added,
  addedPct: sum.off === 0 ? 0 : Math.round((added / sum.off) * 10000) / 100,
};
writeFileSync(join(a2, `${a1}-total.json`), JSON.stringify(res));
console.log(JSON.stringify(res));
