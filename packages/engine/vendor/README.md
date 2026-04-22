# Vendored `tree-sitter-al.wasm`

This directory contains a prebuilt tree-sitter parser WebAssembly binary for the
AL language (Microsoft Dynamics 365 Business Central). The `@lethal/engine`
package loads this file at runtime via `web-tree-sitter` to parse AL source.

## Upstream grammar

- Repository: <https://github.com/SShadowS/tree-sitter-al>
- License: MIT
- Release tag: `v2.5.0`
- Commit: `3e4ccb672f27d1ad673a8a995b1f5c770bb0f738`
- Asset URL:
  <https://github.com/SShadowS/tree-sitter-al/releases/download/v2.5.0/tree-sitter-al.wasm>

The grammar's root node type is `source_file` and exposes a `procedure` named
node, both of which the `@lethal/engine` parser tests assert against.

## How to reproduce / update

### Option A: re-download the prebuilt asset (preferred)

```bash
curl -L -o packages/engine/vendor/tree-sitter-al.wasm \
  https://github.com/SShadowS/tree-sitter-al/releases/download/<tag>/tree-sitter-al.wasm
```

Replace `<tag>` with the desired release (e.g. `v2.5.0`). Update this README's
release tag / commit fields to match, and re-run
`bun test packages/engine/tests/ast/parser.test.ts` to confirm the grammar
still emits `source_file` / `procedure` nodes.

### Option B: build locally from source

Requires a working tree-sitter CLI plus either Emscripten or Docker:

```bash
git clone https://github.com/SShadowS/tree-sitter-al /tmp/tsa
cd /tmp/tsa
git checkout <tag>
npx tree-sitter generate
npx tree-sitter build --wasm
cp tree-sitter-al.wasm /path/to/LethAL/packages/engine/vendor/
```

`tree-sitter build --wasm` falls back to a Docker image when Emscripten is not
installed locally.

## Bumping the vendored WASM

When upgrading the grammar:

1. Download or build the new `tree-sitter-al.wasm`, replacing the file in this
   directory.
2. Update the **release tag** and **commit** fields above.
3. Re-run the engine test suite. If the grammar's node-type names have shifted,
   the `ALNodeKind` enum and any downstream consumers may also need to be
   regenerated from the new `src/node-types.json`.
