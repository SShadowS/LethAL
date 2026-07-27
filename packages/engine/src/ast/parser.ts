import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
// Thin adapter over web-tree-sitter. Returns raw tree-sitter Tree;
// the ALSyntaxNode facade (Task 4) is where AL semantics live.
import { Language, Parser, type Tree } from "web-tree-sitter";

let parser: Parser | null = null;
let initPromise: Promise<void> | null = null;

const PARSER_WASM_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../vendor/tree-sitter-al.wasm",
);

export function initParser(): Promise<void> {
  if (initPromise !== null) return initPromise;
  initPromise = (async () => {
    await Parser.init();
    const wasmBytes = await readFile(PARSER_WASM_PATH).catch((cause: unknown) => {
      throw new Error(
        `tree-sitter-al.wasm not found at ${PARSER_WASM_PATH}. ` +
          "Run the vendor step in packages/engine/vendor/README.md.",
        { cause },
      );
    });
    const alLanguage = await Language.load(wasmBytes);
    const p = new Parser();
    p.setLanguage(alLanguage);
    parser = p;
  })();
  return initPromise;
}

export function parseAL(source: string): Tree {
  if (parser === null) {
    throw new Error("parser not initialized — call initParser() first");
  }
  const tree = parser.parse(source);
  if (tree === null) {
    throw new Error("tree-sitter returned null tree");
  }
  return tree;
}
