import { readFile } from "node:fs/promises";
// Thin adapter over web-tree-sitter. Returns raw tree-sitter Tree;
// the ALSyntaxNode facade (Task 4) is where AL semantics live.
import { Language, Parser, type Tree } from "web-tree-sitter";
import treeSitterRuntimeWasmPath from "web-tree-sitter/tree-sitter.wasm" with { type: "file" };
import alGrammarWasmPath from "../../vendor/tree-sitter-al.wasm" with { type: "file" };

let parser: Parser | null = null;
let initPromise: Promise<void> | null = null;

/**
 * Both wasm assets are reached through Bun's `file` loader (`with { type: "file" }`), which yields
 * a PATH string rather than the file's contents — deliberately, because that is the one form that
 * works identically in both ways this code is run:
 *
 *   - `bun packages/runner/src/cli.ts ...` (dev): the real absolute path on disk, e.g.
 *     `U:\Git\LethAL\packages\engine\vendor\tree-sitter-al.wasm`.
 *   - a `bun build --compile` standalone binary (what a user downloads, `docs/releasing.md`): the
 *     asset is embedded IN the executable and the path is Bun's virtual root, e.g.
 *     `B:/~BUN/root/tree-sitter-al-pgb865xw.wasm`, which `node:fs` reads out of the embedded blob
 *     store. The hashed basename is Bun's, not ours — never parse or construct these paths.
 *
 * Measured 2026-07-27, and the reason this is not the obvious `resolve(dirname(fileURLToPath(
 * import.meta.url)), "../../vendor/...")` it used to be: under `--compile`, `import.meta.url` is
 * that same virtual root, so the old relative resolve produced `B:\~BUN\root\tree-sitter.wasm`,
 * which does not exist, and EVERY parse died before reading a byte of AL:
 *
 *     failed to asynchronously prepare wasm: Error: ENOENT: no such file or directory,
 *     open 'B:\~BUN\root\tree-sitter.wasm'
 *
 * A static `import ... with { type: "file" }` is what tells `bun build` to carry the asset into the
 * binary at all — a path computed at runtime is invisible to the bundler and cannot be embedded.
 *
 * TWO assets, not one, and the failure above was the SECOND one to be fixed but the FIRST to fire:
 * `tree-sitter.wasm` is web-tree-sitter's own emscripten runtime, which `Parser.init()` fetches
 * relative to its own module directory unless `locateFile` overrides it (below);
 * `tree-sitter-al.wasm` is our vendored AL grammar (packages/engine/vendor, R14). Missing either
 * one breaks parsing completely.
 */
export function initParser(): Promise<void> {
  if (initPromise !== null) return initPromise;
  initPromise = (async () => {
    // `locateFile` is emscripten's hook for "where does this sidecar file live"; it is called with
    // (filename, scriptDirectory). Only `tree-sitter.wasm` is redirected — anything else emscripten
    // may ask for keeps its default resolution rather than being silently pointed at the wrong file.
    await Parser.init({
      locateFile: (file: string, scriptDirectory: string) =>
        file === "tree-sitter.wasm" ? treeSitterRuntimeWasmPath : scriptDirectory + file,
    });
    const wasmBytes = await readFile(alGrammarWasmPath).catch((cause: unknown) => {
      throw new Error(
        `tree-sitter-al.wasm not found at ${alGrammarWasmPath}. Run the vendor step in packages/engine/vendor/README.md.`,
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
