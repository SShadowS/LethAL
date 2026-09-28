#!/usr/bin/env bun
/**
 * RUST-01 Q1: every .al file under <dir>, both parsers, lockstep structural comparison with field
 * lookups on, plus flat-link sanity. Exit 1 on any difference.
 *
 *   bun scripts/probe-parser-equivalence.ts <dir>
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  GRAMMAR_PIN,
  initNativeParser,
  parseALNative,
} from "../packages/engine/src/ast/native-parser";
import {
  initWasmParser,
  parseALWasm,
  wasmLanguage,
  wrapWasmRoot,
} from "../packages/engine/src/ast/parser-wasm";
import { wrapFlatRoot } from "../packages/engine/src/ast/syntax-node";
import { corpusEntries } from "./corpus-fingerprint";
import {
  compareStructure,
  flatLinksConsistent,
  wasmKindTableSha256,
} from "./lib/parser-equivalence";

const [dir] = process.argv.slice(2);
if (dir === undefined) throw new Error("usage: probe-parser-equivalence.ts <dir>");
await initWasmParser();
await initNativeParser();
const tablesEqual = wasmKindTableSha256(wasmLanguage()) === GRAMMAR_PIN.kindTableSha256;
const files = await corpusEntries(dir);
let nodes = 0;
let differingFiles = 0;
const sample: string[] = [];
const t0 = performance.now();
for (const rel of files) {
  const source = await readFile(join(dir, rel), "utf8");
  const tree = parseALWasm(source);
  const parsed = parseALNative(source);
  const r = compareStructure(wrapWasmRoot(tree), wrapFlatRoot(parsed), 5);
  tree.delete();
  nodes += r.nodes;
  const links = flatLinksConsistent(parsed.flat);
  const allVisited = r.nodes === parsed.flat.kind.length;
  if (r.diffs.length > 0 || !links || !allVisited) {
    differingFiles++;
    if (!links && sample.length < 20) sample.push(`${rel}\tflat links inconsistent`);
    if (!allVisited && sample.length < 20)
      sample.push(`${rel}\twalk visited ${r.nodes} of ${parsed.flat.kind.length} flat nodes`);
    for (const d of r.diffs) if (sample.length < 20) sample.push(`${rel}\t${JSON.stringify(d)}`);
  }
}
const seconds = Math.round((performance.now() - t0) / 1000);
console.log(
  JSON.stringify({ dir, files: files.length, nodes, differingFiles, tablesEqual, seconds }),
);
for (const s of sample) console.log(s);
// An empty corpus proves nothing: refuse it rather than report a clean Q1.
if (files.length === 0)
  console.error(`probe-parser-equivalence: no .al files under ${dir}, refusing`);
process.exit(files.length > 0 && differingFiles === 0 && tablesEqual ? 0 : 1);
