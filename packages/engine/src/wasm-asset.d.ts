/**
 * Bun's `file` loader — `import p from "x.wasm" with { type: "file" }` — resolves to the asset's
 * PATH as a string (see `src/ast/parser.ts` for why that form, and not the bytes, is what makes a
 * `bun build --compile` binary able to parse AL at all).
 *
 * Declared here because `bun-types`' own `extensions.d.ts` ships wildcard modules for `*.txt`,
 * `*.toml`, `*.yaml`, `*.jsonc`, `*.json5` and `*.html`, but not `*.wasm` — without this, `tsc`
 * cannot resolve either wasm import and the build fails on TS2307.
 *
 * Matches a bare specifier ending in `.wasm` too (`web-tree-sitter/tree-sitter.wasm`), not only a
 * relative path.
 */
declare module "*.wasm" {
  const path: string;
  export default path;
}
