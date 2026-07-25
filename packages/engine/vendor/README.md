# Vendored `tree-sitter-al.wasm`

This directory contains a prebuilt tree-sitter parser WebAssembly binary for the
AL language (Microsoft Dynamics 365 Business Central). The `@lethal/engine`
package loads this file at runtime via `web-tree-sitter` to parse AL source.

## Upstream grammar

- Repository: <https://github.com/SShadowS/tree-sitter-al>
- License: MIT
- Version: `3.0.1` (`package.json`)
- Commit: `f150581` — "queries: capture scoped member-trigger names (Object::Member)", 2026-06-28
- Provenance: **built locally from source at that commit**, NOT downloaded from a
  release. `tree-sitter build --wasm`, tree-sitter CLI 0.26.11, 7,979,068 bytes.

> The `tree-sitter-al.wasm` checked into the grammar repo's own root is NOT the
> same artifact — it is dated before the commit above and is 8,941,485 bytes.
> Build from source rather than copying that file.

The grammar's root node type is `source_file` and exposes a `procedure` named
node, both of which the `@lethal/engine` parser tests assert against.

## What changed in v3 (and what it cost)

v3 renames nothing. It **inserts container nodes**: `statement_block` between a
`code_block` and its statements, `var_body` inside a `var_section`, and
`declaration_body` inside an object declaration. Code that walked straight from
a parent to its statements or declarations must now skip the container — see
`blockStatements`, `varDeclarations`, `declarationMembers` and
`isStatementPosition` in `src/ast/tree-walks.ts`.

This is worth stating plainly because the upgrade's failure mode was silent.
Measured against 2,876 real Business Central test-app files (114 MB), v3 parses
**100% clean** where v2.5.0 parsed 99.9% — a strictly better parser — while
statement-position call sites went from 703,239 to **zero**, because
`void-method-call` keyed on `code_block` as a statement's parent. Nothing threw.
Every parse looked perfect. The tool would simply have reported that there was
little to mutate.

After the upgrade the same corpus yields 710,950 statement calls (the three
files v2.5.0 could not parse cleanly now parse), with `blocks`,
`triggerBlocks`, `procedures` and `exits` byte-identical to the old counts.

## How to reproduce / update

### Build locally from source (what the current binary was made with)

```bash
cd /path/to/tree-sitter-al
git log -1 --format="%h %ad %s" --date=short   # record this in the README
tree-sitter build --wasm -o /tmp/tree-sitter-al.wasm
cp /tmp/tree-sitter-al.wasm /path/to/LethAL/packages/engine/vendor/tree-sitter-al.wasm
```

`tree-sitter build --wasm` falls back to a Docker image when Emscripten is not
installed locally. Downloading a release asset also works when the release
matches the commit you want, but prefer building: a release artifact can lag the
grammar's HEAD, and the repo's checked-in root wasm demonstrably does.

## Bumping the vendored WASM

The unit suite alone CANNOT tell you a bump was safe. A grammar that parses
better while yielding fewer mutation sites passes every test in this repo. Run
all of this:

1. Build or download the new wasm, replacing the file in this directory.
2. Update the **version**, **commit** and **provenance** fields above.
3. `bun run typecheck`, then `rm -rf packages/*/dist`, then `bun test`. Any new
   failure is a shape change — map the clusters before fixing anything.
4. **Run the corpus probe and compare site counts, not just parse errors:**

   ```bash
   bun run scripts/probe-grammar-corpus.ts <corpus-dir> --json /tmp/after.json
   ```

   A drop in `statementCalls`, `blocks`, `triggerBlocks`, `procedures` or
   `exits` is a silent capability loss even when the parse is 100% clean.
5. Run the live gate (`itest:bcdev`, `itest:alrunner`, `itest:lease`,
   `itest:stale-publish`). Expect the per-mutant baselines to flag a difference
   if any operator's target subtree changed shape: `empty-block`'s identity hash
   moved in the v3 bump because its `before` node IS the `code_block`. Before
   re-recording a baseline, PROVE the verdicts held — compare the
   `(object, operator, verdict, killingTest)` signature across old and new, and
   confirm which operators' keys moved and why. Never re-record simply to make
   the gate pass.
6. If node-type names shifted, regenerate `ALNodeKind` from the new
   `src/node-types.json` and update every consumer.
