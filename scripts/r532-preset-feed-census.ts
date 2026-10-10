#!/usr/bin/env bun
/**
 * R532's census: where the value of every preset exit name write comes from (R500 shape 1).
 *
 *   bun scripts/r532-preset-feed-census.ts <project-dir> [<label>]
 *
 * Parse only: no compile, no server. Prints ONE JSON line: `{ label, project, files, writes,
 * classes, rows }`, where `classes` counts the rows per tag and each row is one write outside
 * open-item code (`r532PresetFeedCensus` in `packages/builtin-tier1/src/loop-hazard.ts`). Output is
 * counts and names only (file paths, object, procedure and variable names, line numbers, classes),
 * never AL source text: the intended inputs are BC.History and customer corpora, and this repo is
 * public.
 *
 * Classes: `A-<kind>` a call into another project object; `A'` a same-object call (`A'open` when
 * open-item code reaches it); `A?-*` a call that does not resolve to project code; `B` a name fed
 * by assignments in the same scope; `B-obj-preset` a global written in another procedure of the
 * object that is itself a preset exit name (shape 1 refuses that write); `B-obj-other` such a global
 * that is not (a cross-procedure feed, not refused); `P` a parameter; `C` a constant or literal (`C-clear` a Clear); `F`, `L-unwritten`,
 * `G-unwritten` a field, or a local or global nothing in the object writes. `V:` prefixes the class
 * of a `var`-argument write, `B>` that of a call inside a feed.
 *
 * R532 closed the cross-object part (A, A', P) by ruling. RE-RUN this on each BC.History or
 * customer-corpus bump, and read any new A or P site whose loop has an EXIT OR BOUND that is a
 * preset exit name fed indirectly and whose item is not bounded on its own: that is R532's
 * re-open condition.
 */
import { r532PresetFeedCensus } from "../packages/builtin-tier1/src/loop-hazard";
import { initParser } from "../packages/engine/src/ast/parser";
import { buildSemanticContext } from "../packages/engine/src/semantic/context";
import { collectAlFiles } from "./lib/collect-al-files";

const [projectDir, label] = process.argv.slice(2);
if (projectDir === undefined) {
  console.error("usage: bun scripts/r532-preset-feed-census.ts <project-dir> [<label>]");
  process.exit(2);
}
await initParser();
const files = await collectAlFiles(projectDir);
const rows = r532PresetFeedCensus(buildSemanticContext(files));
const classes: Record<string, number> = {};
for (const r of rows) for (const t of r.tags) classes[t] = (classes[t] ?? 0) + 1;
console.log(
  JSON.stringify({
    label: label ?? projectDir,
    project: projectDir,
    files: files.length,
    writes: rows.length,
    classes,
    rows,
  }),
);
