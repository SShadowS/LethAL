import { Parser, Language, type Tree } from "web-tree-sitter";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

let alLanguage: Language | null = null;
let parser: Parser | null = null;

const PARSER_WASM_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../vendor/tree-sitter-al.wasm",
);

export async function initParser(): Promise<void> {
  if (parser !== null) return;
  await Parser.init();
  const wasmBytes = await readFile(PARSER_WASM_PATH);
  alLanguage = await Language.load(wasmBytes);
  parser = new Parser();
  parser.setLanguage(alLanguage);
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
