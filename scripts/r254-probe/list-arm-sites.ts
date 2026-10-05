/**
 * R254 phase 1 (probe, uncommitted): which mutants would the draft arm produce once
 * `reportextension` is a carrier? Copies fixtures/sandbox-data to a scratch dir, adds the arm, adds
 * the kind to CARRIER_KINDS AT RUNTIME (the product list is untouched), and lists the arm's specs.
 *
 * Usage: bun scripts/r254-probe/list-arm-sites.ts <scratchDir>
 */
import { cp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { CARRIER_KINDS } from "../../packages/schemata/src/index";
import { generateMutationSet } from "../../packages/runner/src/orchestrator";

const scratch = process.argv[2];
if (scratch === undefined) throw new Error("usage: list-arm-sites.ts <scratchDir>");
const repo = join(import.meta.dir, "..", "..");
const dir = join(scratch, "sandbox-data-arm");
await rm(dir, { recursive: true, force: true });
await mkdir(dir, { recursive: true });
await cp(join(repo, "fixtures", "sandbox-data"), dir, {
  recursive: true,
  filter: (p) => !p.includes(".alpackages") && !p.includes("lethal.config"),
});
await cp(join(import.meta.dir, "arm", "src"), join(dir, "src"), { recursive: true });

const before = await generateMutationSet(dir);
(CARRIER_KINDS as unknown as string[]).push("reportextension_declaration");
const after = await generateMutationSet(dir);

const total = (r: typeof before) => r.files.reduce((n, f) => n + f.specs.length, 0);
console.log(`specs before=${total(before)} after=${total(after)} skippedBefore=${before.skipped.map((s) => s.file).join(",")}`);
// Today the carrier kind alone is not enough: OBJECT_HEADER (project-plan.ts) has no
// `reportextension` keyword, so the file is refused `no-header`. Its coarse tuples still list the
// operator and site of every spec it would have produced.
for (const r of after.refusedFiles) {
  console.log(`REFUSED ${r.file} shape=${r.shape} sites=${r.sites}`);
  for (const t of r.coarseTuples ?? []) console.log(`  ${t}`);
}
// Place each tuple on its FIRST line: re-run with a one-line filter per line (plus one ordinary
// file, so the run is not "nothing left to measure") and record tuples not seen on earlier lines.
const ARM = "src/DataBandExt.ReportExt.al";
const seen = new Set<string>();
for (let line = 1; line <= 60; line++) {
  let r: typeof after;
  try {
    r = await generateMutationSet(dir, {
      emit: () => {},
      lines: [
        { file: ARM, start: line, end: line },
        { file: "src/DataMain.Table.al", start: 1, end: 9999 },
      ],
    });
  } catch {
    continue;
  }
  for (const rf of r.refusedFiles) {
    if (rf.file !== ARM) continue;
    for (const t of rf.coarseTuples ?? []) {
      if (seen.has(t)) continue;
      seen.add(t);
      console.log(`  line ${line}: ${t.split("|").slice(1).join("|")}  ${t.slice(0, 12)}`);
    }
  }
}
for (const f of after.files) {
  if (!f.path.includes("DataBand")) continue;
  for (const s of f.specs) {
    const line = s.before.startPosition.row + 1;
    console.log(`${f.path}:${line} ${s.operatorName} ${JSON.stringify(s.before.text)} -> ${JSON.stringify(s.after.text)}`);
  }
}
