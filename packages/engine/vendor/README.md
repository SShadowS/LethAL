# Vendored `tree-sitter-al.wasm`

This directory contains a prebuilt tree-sitter parser WebAssembly binary for the
AL language (Microsoft Dynamics 365 Business Central). The `@lethal/engine`
package loads this file at runtime via `web-tree-sitter` to parse AL source.

## Upstream grammar

- Repository: <https://github.com/SShadowS/tree-sitter-al>
- License: MIT
- Version: `3.2.1`
- Commit: `335d1ffc04a123a1812a033f768827db710d9239` — "chore: rebuild
  tree-sitter-al.wasm for v3.2.1", tag `v3.2.1`
- Provenance: **built locally from source at that tag**, NOT downloaded from a
  release. `tree-sitter build --wasm`, tree-sitter CLI 0.26.11, from a detached
  worktree at the tag so the grammar checkout's own state could not leak in.
- Artifact: 7,457,411 bytes,
  `sha256:33b861ddd6172d697232fbbe48103f9b91c4205fd768add13a0d0c4260f48b2e`

Previously `3.0.1` at commit `f150581` (7,979,068 bytes,
`sha256:3ea9756824...`), kept here because a bump's evidence is only readable
against what it replaced.

A commit alone does not determine the binary — `tree-sitter build --wasm` uses
local Emscripten when present and falls back to a Docker image otherwise, and the
two toolchains do not produce byte-identical output. Record the artifact hash on
every bump so the vendored file can be *verified*, not merely re-approximated.

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

## The 3.0.1 -> 3.2.1 bump (2026-08-08), and what it cost: nothing

Recorded because the v2 -> v3 bump's damage was silent and the next reader
deserves to know what a CLEAN bump looks like too.

Upstream moved three tags past what was vendored. The vendored binary was built
at `f150581`, which is already past the `v3.0.1` tag, so the substantive changes
taken on were two, both parse-correctness FIXES rather than shape changes:

- **v3.1.0** (`307dc39`) — `TableData` as a first option member; whitespace-
  tolerant `# pragma` / `# region`.
- **v3.2.0** (`14bd55c`) — whitespace-tolerant `# if` / `# elif`, depth-correct.

Plus a parser regeneration on the same tree-sitter CLI (0.26.11) and packaging
changes. Nothing renamed, nothing re-parented — which is what made the outcome
predictable, and is exactly the reading the v2 -> v3 bump also had before it
turned out to insert container nodes. So it was measured anyway.

**Measured on 659 real AL files (6.0 MB): Continia Document Output's `Cloud`
(554) plus its test app (105).**

| | vendored 3.0.1 build | 3.2.1 |
| --- | --- | --- |
| files parsed / clean | 659 / 659 (100%) | 659 / 659 (100%) |
| ERROR nodes | 0 | 0 |
| `statementCalls` | 18,150 | 18,150 |
| `blocks` | 8,458 | 8,458 |
| `triggerBlocks` | 2,146 | 2,146 |
| `procedures` | 4,484 | 4,484 |
| `exits` | 2,536 | 2,536 |

And the PER-SITE half this document demands and had no instrument for until now:
`scripts/census-tier1-sites.ts` emits one row per (operator, file, line, column,
before, after) for every Tier-1 operator over the whole corpus. **31,110 sites,
and the two JSON files are BYTE-IDENTICAL** — 0 sites only in the old, 0 only in
the new, per operator:

```
lethal.conditional-boundary        493
lethal.empty-block                7976
lethal.negate-conditional         2804
lethal.return-value                981
lethal.swap-call-arguments         706
lethal.void-method-call          18150
```

Then `bun test` (2,069 pass / 1 skip / 0 fail) and the live tables gate
(109 killed / 17 survived / 10 no-coverage, `untargetedTriggers=0`, PASS,
per-mutant against the committed baseline).

**What the bump does NOT prove.** The two fixes are for `#if` / `#pragma` /
`#region` with whitespace and for `TableData` as a first option member; this
corpus contains none of those shapes, which is precisely why every number is
identical. So this measures that the bump costs nothing, not that it gains
anything. The gain is on code the old grammar misread, and no corpus here
carries it.

## Bumping the vendored WASM

The unit suite alone CANNOT tell you a bump was safe. A grammar that parses
better while yielding fewer mutation sites passes every test in this repo. Run
all of this:

1. Build or download the new wasm, replacing the file in this directory.
2. Update the **version**, **commit** and **provenance** fields above.
3. `bun run typecheck`, then `rm -rf packages/*/dist`, then `bun test`. Any new
   failure is a shape change — map the clusters before fixing anything.
4. **Run BOTH censuses — aggregate and per-site. The aggregate one alone is
   not the proof this document asks for.**

   ```bash
   bun run scripts/probe-grammar-corpus.ts <flat-corpus-dir> --json /tmp/after.json
   bun scripts/census-tier1-sites.ts <corpus-dir> /tmp/sites-after.json
   ```

   A drop in `statementCalls`, `blocks`, `triggerBlocks`, `procedures` or
   `exits` is a silent capability loss even when the parse is 100% clean. But
   counts cannot see a bump that keeps every total while moving WHICH sites are
   claimed, and R120 established that is reachable at runtime with no type error:
   `ALNodeKind` is a CURATED subset and `ALSyntaxNode.kind` CASTS the raw
   tree-sitter type into it. `census-tier1-sites.ts` emits the site LIST for
   every Tier-1 operator, so the two runs diff directly.

   Note `probe-grammar-corpus.ts` reads a FLAT directory (no recursion) while
   `census-tier1-sites.ts` recurses. Stage a flat copy for the first.
5. Run the live gate (`itest:bcdev`, `itest:alrunner`, `itest:lease`,
   `itest:stale-publish`). Expect the per-mutant baselines to flag a difference
   if any operator's target subtree changed shape: `empty-block`'s identity hash
   moved in the v3 bump because its `before` node IS the `code_block`, and
   `astSubtreeHash` serializes named children recursively.

   **Before re-recording a baseline, prove per-site — not per-signature.**
   Comparing the `(object, operator, verdict, killingTest)` signature as a
   multiset is NOT sufficient: it cannot see a swap between two same-operator
   sites in the same object. The sandbox fixture has five `empty-block` sites in
   one codeunit with verdicts {killed ×1, survived ×4}, so a shift in *which*
   block is the killed one leaves that signature byte-identical.

   The decisive check takes about a minute and needs no server. The old parser is
   always one command away:

   ```bash
   git show <base-commit>:packages/engine/vendor/tree-sitter-al.wasm > /tmp/old.wasm
   ```

   Load both wasms through `web-tree-sitter`, replicate the affected operator's
   `targets()` and `astSubtreeHash` over the fixture files, and build an
   old-key → **source line** → new-key map. Diff by line. Every site must appear
   on both sides with its verdict unchanged; a site that appears or disappears is
   a coverage change and a BLOCK. Never re-record simply to make the gate pass.
6. If node-type names shifted, regenerate `ALNodeKind` from the new
   `src/node-types.json` and update every consumer.
