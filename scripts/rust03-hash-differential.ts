/**
 * RUST-03 S4.2d, AMENDMENT 8 Guard 2, on a corpus outside the repo: the pre-S4.2d reference
 * `astSubtreeHash` against the product's, on every node of every `.al` under a directory, through
 * the flat, generic and `withText` paths. Prints one JSON line of counts; exits 1 on any difference.
 *
 *   bun scripts/rust03-hash-differential.ts "U:/Git/BC.History/System Application"
 */
import { join } from "node:path";
import { Glob } from "bun";
import { initParser } from "../packages/engine/src/ast/parser";
import { hashDifferential } from "../packages/engine/tests/ast/hash-differential";

if (import.meta.main) {
  const dir = process.argv[2];
  if (dir === undefined) {
    console.error("usage: bun scripts/rust03-hash-differential.ts <directory>");
    process.exit(2);
  }
  await initParser();
  const files = [...new Glob("**/*.al").scanSync(dir)].sort().map((f) => join(dir, f));
  const started = performance.now();
  const r = hashDifferential(files);
  console.log(
    JSON.stringify({
      dir,
      files: r.files,
      nodes: r.nodes,
      named: r.named,
      differences: r.differences.length,
      firstDifferences: r.differences.slice(0, 20),
      seconds: Math.round((performance.now() - started) / 1000),
    }),
  );
  process.exit(r.differences.length === 0 ? 0 : 1);
}
