#!/usr/bin/env bun
/**
 * R572's census: the loops whose exit reads a FLAG fed by a call into another project object
 * (`Found := X.NextEntry(..); until not Found`, a same-object wrapper of such a call, or a `var`
 * argument the call writes), and how R572 decides each one (`r572LoopRows` in loop-hazard.ts, the
 * same code production runs, so this cannot drift from the rule).
 *
 * The RE-OPEN shape is printed on its own: a `selfFeed` row that is NOT stateful, i.e. a pure
 * stepper fed its own result (`D := X.Next(D)`). R572 deploys those on purpose (measured: every such
 * loop in DC, DO, CDO, BC.History and the fixtures was safe for a loop-specific reason). Re-open
 * R572 if a project shows one that can hang.
 *
 *   bun scripts/r572-flag-census.ts <project-dir> [--rows]
 *
 * Parse-only. Output is names, paths, lines and counts only, never AL source text (this repo is
 * public, and the intended input is customer AL that must not be committed).
 */
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { type R572Row, r572Census } from "../packages/builtin-tier1/src/loop-hazard";
import {
  evaluateArms,
  initParser,
  normalizeAlName,
  parseAL,
  wrapRoot,
} from "../packages/engine/src/index";
import type { ALSyntaxNode } from "../packages/engine/src/index";
import { buildSemanticContext } from "../packages/engine/src/index";
import { discoveredRelPaths, isEnumeratedAl } from "../packages/runner/src/line-filter";
import { effectiveBuildSymbols } from "../packages/runner/src/preprocessor-symbols";

const [proj, flag] = process.argv.slice(2);
if (proj === undefined) {
  console.error("usage: bun scripts/r572-flag-census.ts <project-dir> [--rows]");
  process.exit(2);
}

await initParser();
const listed = (await readdir(proj, { recursive: true })) as string[];
const files = await Promise.all(
  discoveredRelPaths(listed.filter((e) => isEnumeratedAl(e))).map(async (d) => {
    const source = await readFile(join(proj, d.raw), "utf8");
    return { path: d.rel, source, root: wrapRoot(parseAL(source)) as ALSyntaxNode };
  }),
);
const syms = await effectiveBuildSymbols(proj, [], undefined, { kind: "bcdev" });
const arms = new Map(files.map((f) => [f.root, evaluateArms(f.root, f.source, syms)]));
const ctx = buildSemanticContext(
  files.map((f) => ({ path: f.path, root: f.root })),
  arms,
);
const fileOf = new Map(files.map((f) => [f.root, f.path]));
const where = (n: ALSyntaxNode): string => {
  let r = n;
  while (r.parent !== null) r = r.parent;
  return `${fileOf.get(r) ?? "?"}:${n.startPosition.row + 1}`;
};
const nameOf = (p: ALSyntaxNode): string => {
  let o: ALSyntaxNode | null = p.parent;
  while (o !== null && o.childForFieldName("object_name") === null) o = o.parent;
  const on = o?.childForFieldName("object_name")?.text ?? "?";
  const pn = p.childForFieldName("name")?.text ?? "?";
  return `${o?.rawKind.replace("_declaration", "") ?? "?"} ${normalizeAlName(on)}.${normalizeAlName(pn)}`;
};

const { rows, extra } = r572Census(ctx);
const loops = new Set(rows.map((r) => where(r.loop)));
const statefulLoops = new Set(rows.filter((r) => r.stateful).map((r) => where(r.loop)));
const reopen = rows.filter((r) => r.selfFeed && !r.stateful);
const line = (r: R572Row): string =>
  [
    where(r.loop),
    r.chain.map(nameOf).join(" > "),
    r.stateful ? "stateful" : "pure",
    r.selfFeed ? "self-feed" : "",
    r.varOut ? "var-out" : "",
    r.wrapper === null ? "" : `via ${nameOf(r.wrapper)}`,
    r.writers.length > 0 ? `writers ${r.writers.map(nameOf).join(", ")}` : "",
  ]
    .filter((s) => s !== "")
    .join("\t");
console.log(
  JSON.stringify({
    project: proj,
    flagLoops: loops.size,
    statefulLoops: statefulLoops.size,
    rows: rows.length,
    reopenSelfFeedPure: reopen.length,
    extraProcedures: extra.map(nameOf).sort(),
  }),
);
if (reopen.length > 0) for (const r of reopen) console.log(`RE-OPEN SHAPE\t${line(r)}`);
if (flag === "--rows") for (const r of rows) console.log(line(r));
