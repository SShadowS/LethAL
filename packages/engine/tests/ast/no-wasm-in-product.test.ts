import { expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Glob } from "bun";

// RUST-03: WASM is a reference instrument. No product source may import it, so a missing native
// binary can never be papered over by a silent WASM parse.
// becomes it() in S3.4, the switch
it.todo("no product source imports parser-wasm or web-tree-sitter", () => {
  const root = join(import.meta.dir, "..", "..", "..", "..");
  const hits: string[] = [];
  for (const f of new Glob("packages/*/src/**/*.ts").scanSync(root)) {
    if (f.replaceAll("\\", "/").endsWith("engine/src/ast/parser-wasm.ts")) continue;
    const text = readFileSync(join(root, f), "utf8");
    if (/from\s+["'][^"']*(parser-wasm|web-tree-sitter)["']/.test(text)) hits.push(f);
  }
  expect(hits).toEqual([]);
});
