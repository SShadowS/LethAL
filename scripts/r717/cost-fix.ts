// R717 cost of the BUILT rule: generateMutationSet with `r717Seam` off, then on, one child process
// per project, summed per corpus. Counts and changed file paths only, no source text.
// usage: bun cost-fix.ts <set> <outdir>    set: do | cdo | dc | baseapp
//        bun cost-fix.ts --one <project-dir> <out.json>
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const tree = join(import.meta.dir, "../..");
const [a1, a2, a3] = process.argv.slice(2);
if (a1 === "--one") {
  if (a2 === undefined || a3 === undefined) throw new Error("usage");
  const orch = await import(join(tree, "packages/runner/src/orchestrator.ts"));
  const lh = await import(join(tree, "packages/builtin-tier1/src/loop-hazard.ts"));
  type Set_ = { files: { path: string; specs: unknown[] }[] };
  const gen = async (on: boolean) => {
    lh.r717Seam.on = on;
    const set = (await orch.generateMutationSet(a2, { emit: () => {} })) as Set_;
    return Object.fromEntries(set.files.map((f) => [f.path, f.specs.length])) as Record<
      string,
      number
    >;
  };
  const off = await gen(false);
  const on = await gen(true);
  const sum = (x: Record<string, number>) => Object.values(x).reduce((a, b) => a + b, 0);
  const files = Object.keys(off).filter((p) => off[p] !== on[p]);
  writeFileSync(a3, JSON.stringify({ off: sum(off), on: sum(on), files }));
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
const res = { set: a1, projects: projs.length, off: 0, on: 0, failed: 0, files: [] as string[] };
for (const [i, p] of projs) {
  const out = join(a2, `${a1}-${i}.json`);
  const r = Bun.spawnSync(["bun", import.meta.path, "--one", p, out], {
    cwd: tree,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (r.exitCode !== 0) {
    res.failed++;
    console.log(`SKIP ${i}: ${r.stderr.toString().trim().split("\n").slice(-1)[0]?.slice(0, 160)}`);
    continue;
  }
  const j = JSON.parse(readFileSync(out, "utf8"));
  res.off += j.off;
  res.on += j.on;
  for (const f of j.files) res.files.push(`${i}:${f}`);
}
writeFileSync(join(a2, `${a1}-total.json`), JSON.stringify(res));
console.log(JSON.stringify({ ...res, removed: res.off - res.on }));
