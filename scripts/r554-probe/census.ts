// R554 census: DEPLOYED mutants inside a `requestpage`, per project, split by whether the file contains any `#if`.
// Each project goes through the runner's own `generateMutationSet`, so dispatch and hang refusals apply as in a run,
// then the runner's own per-file dedup (`dedupeSpecs` with `operatorTiers`), the set a run deploys. Like the
// runner, files under dot-folders (`.dependencies`) count; only `.alpackages` is skipped. Only projects with a
// file mentioning `requestpage` are run. Prints counts and paths only, never source text.
// Usage: bun scripts/r554-probe/census.ts <checkout> <projects.tsv> > out.tsv
//   projects.tsv: one project per line, `<n>\t<project dir>` (the corpus dump cache's format).
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const [root = "", tsv = ""] = process.argv.slice(2);
const orch = await import(join(root, "packages/runner/src/orchestrator.ts"));
const { dedupeSpecs } = await import(join(root, "packages/schemata/src/index.ts"));
const tierOf = (name: string) => orch.operatorTiers.get(name);

type Node = { rawKind: string; parent: Node | null };
const inRequestPage = (n: Node): boolean => {
  for (let p: Node | null = n; p !== null; p = p.parent)
    if (/requestpage/i.test(p.rawKind)) return true;
  return false;
};
const alFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((e) => {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) return e === ".alpackages" ? [] : alFiles(p);
    return p.toLowerCase().endsWith(".al") ? [p] : [];
  });
const norm = (p: string) => p.replaceAll("\\", "/");

const projects = readFileSync(tsv, "utf8")
  .trim()
  .split("\n")
  .map((l) => l.split("\t")[1] ?? "")
  .filter((d) => d !== "");
const totals = {
  projectsMentioning: 0,
  projectsWithMutants: 0,
  filesMentioning: 0,
  filesWithMutants: 0,
  filesNotGenerated: 0,
  deployed: 0,
  deployedInIfFiles: 0,
  ifFilesWithMutants: 0,
};
for (const proj of projects) {
  const withRp = alFiles(proj).filter((f) => /\brequestpage\b/i.test(readFileSync(f, "utf8")));
  if (withRp.length === 0) continue;
  totals.projectsMentioning++;
  const set = await orch.generateMutationSet(proj, { emit: () => {} });
  let projectCount = 0;
  for (const abs of withRp) {
    const r = norm(relative(proj, abs));
    const f = (set.files as { path: string; specs: { before: Node }[] }[]).find(
      (x) => norm(x.path) === r || norm(x.path).endsWith(`/${r}`) || norm(x.path) === norm(abs),
    );
    totals.filesMentioning++;
    if (f === undefined) totals.filesNotGenerated++;
    const deployed = f === undefined ? [] : (dedupeSpecs(f.specs, tierOf) as { before: Node }[]);
    const rp = deployed.filter((s) => inRequestPage(s.before)).length;
    const hasIf = /^\s*#if\b/im.test(readFileSync(abs, "utf8"));
    projectCount += rp;
    totals.deployed += rp;
    if (rp > 0) totals.filesWithMutants++;
    if (hasIf) totals.deployedInIfFiles += rp;
    if (hasIf && rp > 0) totals.ifFilesWithMutants++;
    console.log(
      `${hasIf ? "if" : "plain"}\t${rp}\t${f === undefined ? "not-generated" : "generated"}\t${norm(proj)}\t${r}`,
    );
  }
  if (projectCount > 0) totals.projectsWithMutants++;
}
console.log(`TOTAL\t${JSON.stringify(totals)}`);
