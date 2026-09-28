#!/usr/bin/env bun
/**
 * RUST-03 S2.2: parse every .al file under <dir> through the native addon directly (not parseAL,
 * which is still WASM until S3) and compare the summary line with --expect. --expect is required,
 * so a workflow that forgets it fails instead of passing on "nonzero".
 *
 *   bun scripts/native-parse-smoke.ts <dir> --expect "files <n> nodes <total> errors <files>"
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { initNativeParser, parseALNative } from "../packages/engine/src/ast/native-parser";
import { FLAG_HAS_ERROR } from "../packages/engine/src/ast/syntax-node";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { expect: { type: "string" } },
});
const [dir] = positionals;
if (dir === undefined) throw new Error("usage: native-parse-smoke.ts <dir> --expect <line>");
await initNativeParser();
const files = readdirSync(dir, { recursive: true, encoding: "utf8" })
  .filter((f) => f.toLowerCase().endsWith(".al"))
  .sort();
let nodes = 0;
let errors = 0;
for (const f of files) {
  const { flat } = parseALNative(readFileSync(join(dir, f), "utf8"));
  nodes += flat.kind.length;
  if (((flat.flags[0] ?? 0) & FLAG_HAS_ERROR) !== 0) errors++;
}
const line = `files ${files.length} nodes ${nodes} errors ${errors}`;
console.log(line);
if (files.length === 0 || nodes === 0) {
  console.error("native-parse-smoke: nothing was parsed");
  process.exit(1);
}
if (values.expect === undefined || values.expect === "") {
  console.error("native-parse-smoke: --expect is required");
  process.exit(1);
}
if (line !== values.expect) {
  console.error(`native-parse-smoke: expected ${values.expect}`);
  process.exit(1);
}
