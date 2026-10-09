// R554 census: deployed mutants inside a `requestpage`, per project, split by whether the file's object is
// `#if`-wrapped. Each project goes through the runner's own `generateMutationSet` (so dispatch refusals and
// hang refusals apply exactly as in a run); only projects with a file mentioning `requestpage` are run.
// Prints counts and repo-relative paths only, never source text.
// Usage: bun scripts/r554-probe/census.ts <checkout> <projects.tsv> > out.tsv
//   projects.tsv: one project per line, `<n>\t<project dir>` (the corpus dump cache's format).
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const [root = "", tsv = ""] = process.argv.slice(2);
const orch = await import(join(root, "packages/runner/src/orchestrator.ts"));

type Node = { rawKind: string; parent: Node | null };
const inRequestPage = (n: Node): boolean => {
  for (let p: Node | null = n; p !== null; p = p.parent)
    if (/requestpage/i.test(p.rawKind)) return true;
  return false;
};
const alFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((e) => {
    const p = join(dir, e);
    if (statSync(p).isDirectory())
      return e === ".alpackages" || e.startsWith(".") ? [] : alFiles(p);
    return p.toLowerCase().endsWith(".al") ? [p] : [];
  });
const norm = (p: string) => p.replaceAll("\\", "/");

const projects = readFileSync(tsv, "utf8")
  .trim()
  .split("\n")
  .map((l) => l.split("\t")[1] ?? "")
  .filter((d) => d !== "");
const totals = {
  projects: 0,
  files: 0,
  wrappedFiles: 0,
  deployed: 0,
  deployedWrapped: 0,
  hangRefused: 0,
};
for (const proj of projects) {
  const withRp = alFiles(proj).filter((f) => /\brequestpage\b/i.test(readFileSync(f, "utf8")));
  if (withRp.length === 0) continue;
  totals.projects++;
  const set = await orch.generateMutationSet(proj, { emit: () => {} });
  const rel = new Map(withRp.map((f) => [norm(relative(proj, f)), f]));
  for (const [r, abs] of rel) {
    const f = (set.files as { path: string; specs: { before: Node }[] }[]).find(
      (x) => norm(x.path) === r || norm(x.path).endsWith(`/${r}`) || norm(x.path) === norm(abs),
    );
    const rp = (f?.specs ?? []).filter((s) => inRequestPage(s.before)).length;
    const wrapped = /^\s*#if\b/im.test(readFileSync(abs, "utf8"));
    const hang = (set.hangRefused as { file: string; sites: number }[])
      .filter((h) => norm(h.file) === r || norm(h.file).endsWith(`/${r}`))
      .reduce((n, h) => n + h.sites, 0);
    totals.files++;
    if (wrapped) totals.wrappedFiles++;
    totals.deployed += rp;
    if (wrapped) totals.deployedWrapped += rp;
    totals.hangRefused += hang;
    console.log(
      `${wrapped ? "wrapped" : "plain"}\t${rp}\t${norm(proj)}\t${r}\thangRefusedInFile=${hang}`,
    );
  }
}
console.log(
  `TOTAL\t${JSON.stringify({ ...totals, deployedPlain: totals.deployed - totals.deployedWrapped })}`,
);
