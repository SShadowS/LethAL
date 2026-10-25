// R737 cost of the built rule: generateMutationSet with `r737Seam` off, then on, one child process
// per project; records per changed file {off, on} and separate removed/added totals. Counts and
// paths only, no source text.
// usage: bun cost.ts <set> <outdir>    set: do | cdo | dc | baseapp | fixtures
//        bun cost.ts --one <project-dir> <out.json>
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const tree = join(import.meta.dir, "../..");
const [a1, a2, a3] = process.argv.slice(2);
if (a1 === "--one") {
  if (a2 === undefined || a3 === undefined) throw new Error("usage");
  const orch = await import(join(tree, "packages/runner/src/orchestrator.ts"));
  const lh = await import(join(tree, "packages/builtin-tier1/src/loop-hazard.ts"));
  type Set_ = { files: { path: string; specs: unknown[] }[] };
  const gen = async (on: boolean) => {
    lh.r737Seam.on = on;
    const set = (await orch.generateMutationSet(a2, { emit: () => {} })) as Set_;
    return Object.fromEntries(set.files.map((f) => [f.path, f.specs.length])) as Record<
      string,
      number
    >;
  };
  const t0 = Date.now();
  const off = await gen(false);
  const tOff = Date.now() - t0;
  const t1 = Date.now();
  const on = await gen(true);
  const tOn = Date.now() - t1;
  const sum = (x: Record<string, number>) => Object.values(x).reduce((a, b) => a + b, 0);
  const files = [...new Set([...Object.keys(off), ...Object.keys(on)])]
    .filter((p) => (off[p] ?? 0) !== (on[p] ?? 0))
    .map((p) => ({ path: p, off: off[p] ?? 0, on: on[p] ?? 0 }));
  writeFileSync(a3, JSON.stringify({ off: sum(off), on: sum(on), files, tOff, tOn }));
  process.exit(0);
}
if (a1 === undefined || a2 === undefined) throw new Error("usage");
const projs: [string, string][] =
  a1 === "baseapp"
    ? [["0", "/work/src/BC.History/BaseApp/Source/Base Application"]]
    : a1 === "fixtures"
      ? readdirSync(join(tree, "fixtures"))
          .filter((d) => statSync(join(tree, "fixtures", d)).isDirectory())
          .filter((d) => {
            try {
              statSync(join(tree, "fixtures", d, "app.json"));
              return true;
            } catch {
              return false;
            }
          })
          .map((d, i) => [String(i), join(tree, "fixtures", d)] as [string, string])
      : readFileSync(`/coord/handoff/R-702/census/${a1}/projects.tsv`, "utf8")
          .trim()
          .split("\n")
          .map((l) => l.split("\t") as [string, string]);
mkdirSync(a2, { recursive: true });
const res = {
  set: a1,
  projects: projs.length,
  off: 0,
  on: 0,
  removed: 0,
  added: 0,
  failed: 0,
  tOff: 0,
  tOn: 0,
  files: [] as { project: string; path: string; off: number; on: number }[],
};
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
  res.tOff += j.tOff;
  res.tOn += j.tOn;
  for (const f of j.files) {
    res.files.push({ project: i, ...f });
    if (f.on < f.off) res.removed += f.off - f.on;
    else res.added += f.on - f.off;
  }
}
writeFileSync(join(a2, `${a1}-total.json`), JSON.stringify(res));
console.log(JSON.stringify({ ...res, files: res.files.length }));
