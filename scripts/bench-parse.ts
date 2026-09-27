#!/usr/bin/env bun
/**
 * RUST-01 workload W1: parse every .al file of a corpus with the engine's current parser, wrap the
 * root, walk every node once, and report parse and walk time. Files are read first, so disk time is
 * not counted. Only the engine's public parse interface is used, so this script measures WASM
 * before the switch-over and native after it.
 *
 *   bun scripts/bench-parse.ts <corpus-dir>
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { initParser, parseAL } from "../packages/engine/src/ast/parser";
import { visit, wrapRoot } from "../packages/engine/src/ast/syntax-node";
import { corpusEntries } from "./corpus-fingerprint";

const [dir] = process.argv.slice(2);
if (dir === undefined) throw new Error("usage: bench-parse.ts <corpus-dir>");
const files = await corpusEntries(dir);
const sources = await Promise.all(files.map((f) => readFile(join(dir, f), "utf8")));
await initParser();
let parseMs = 0;
let walkMs = 0;
let nodes = 0;
let chars = 0;
for (const source of sources) {
  const t0 = performance.now();
  const parsed = parseAL(source);
  const t1 = performance.now();
  visit(wrapRoot(parsed), () => {
    nodes++;
  });
  const t2 = performance.now();
  // A WASM tree lives in a 2 GB heap and must be freed or this aborts near file 9,000 (R292).
  // A native ParsedAL has no delete(): its tree was freed inside the parse call.
  (parsed as unknown as { delete?: () => void }).delete?.();
  parseMs += t1 - t0;
  walkMs += t2 - t1;
  chars += source.length;
}
console.log(
  JSON.stringify({
    files: files.length,
    chars,
    nodes,
    parseMs: Math.round(parseMs),
    walkMs: Math.round(walkMs),
  }),
);
