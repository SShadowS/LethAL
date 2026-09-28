# RUST-01: parse AL natively, through a Rust Node-API addon

Status: design, revision r3 (final), 2026-09-27. Plan: `docs/superpowers/plans/2026-09-27-RUST-01-native-parser.md`.
Owner direction (2026-09-27): move parsing to Rust with tree-sitter-al compiled natively, instead of
the WASM path. Incremental, not a rewrite: operators, the semantic layer, the schemata compiler and
the runner stay TypeScript.

**Revision r2** applies gpt-6-sol review r1 (`H:/lethal-coord/reviews/RUST-01-plan/review-r1.md`),
the orchestrator's rulings C1, I1 to I5 and the minors, and the owner's three decisions of
2026-09-27 (section 2). What changed: the tree proof is a lockstep STRUCTURAL walk on every file,
with field lookups on everywhere, BaseApp included (C1); full identity keys are compared on BaseApp
too (I1); R-236c lands first and its scanner's parse-health decisions are ported explicitly, with
`isMissing` and `hasError` added to `ALSyntaxNode` and no no-op `delete()` (I2); memory is measured
on whole BaseApp and on a scoped REAL run against pre-set ceilings, and Task 0 adds an attribution
step (I3); the spike bar is the design's 2x (I4); binary provenance is recorded and checked in CI
(I5); all five platforms ship, built and parse-tested in CI, with no committed binary; and a
keep-or-revert rule decided now gates the switch-over.

**Revision r3 (final)** applies review r2 (`H:/lethal-coord/reviews/RUST-01-plan/review-r2.md`) and
the orchestrator's rulings on the r2 open questions. What changed: a WASM identity-key listing of
the WHOLE BaseApp corpus (9,620 files) is mandatory, produced by a validated scratch capture, with no
waiver (section 5); release publication moves to a final job that needs all five compiled-binary
smoke jobs (section 7); the R-236c port keeps the merged scanner's error-fact type unchanged, checked
as a precondition after the merge (section 6); the scanner census runs on an explicit corpus list
with asserted counts and no timing fields; the structural check marks visited flat indexes and
compares node text; the variant-B loader expression is probed in the spike and a source-mode loader
works on all five platforms, else STOP; W6 passes its selector ids; the notice check evaluates the
full SPDX expression. Rulings: WASM stays until one native grammar bump, then the owner decides;
Linux builds on `ubuntu-22.04`; one shared `CARGO_TARGET_DIR` for local worktrees; `itest:tables` is
deferred to the combined GH-24 / R-236c check unless its baseline was re-recorded first.

## 1. Why

What is measured today:

- **The WASM heap is capped.** web-tree-sitter runs the parser inside a WebAssembly memory that
  cannot grow past 2 GB here. Every tree lives in that memory until it is deleted. R-236c's TestPage
  scanner aborted at file 9,007 of BaseApp's 9,620 until it deleted its trees.
- **The site census cannot hold all of BaseApp** (R292): it keeps every tree for one shared
  semantic context and aborts near file 9,000 (about 164 M characters). TSAL-441 had to census
  BaseApp in two halves, which leaves a Tier-2 blind spot.
- **The orchestrator has the same shape.** `generateMutationSet` keeps every parsed root for one
  project-wide context, and `line-map.ts` parses again for coverage. A BaseApp-sized `lethal run`
  would meet the same cap.
- **Parsing BaseApp takes about 16 s** in the scanner.
- **Bun processes have been seen above 30 GB. This stays UNATTRIBUTED.** The WASM heap cannot be
  that memory (it is capped at 2 GB), so this design does not claim to fix it. Plan Task 0 records
  the peak memory of `bun test`, the census and a real run as an attribution step; anything it
  finds is filed as its own roadmap item.

What native parsing does and does not remove. It removes the 2 GB cap and the retained WASM trees.
It does NOT remove what Bun itself holds: the flat arrays (about 37 bytes per node), the retained
source strings, the wrapper objects and the semantic layer's nodes, plus temporary copies during
transfer. So a memory win is claimed only where it is measured (section 7).

**The fallback is R292's TypeScript route.** R292 documents it: release each tree once used, or a
two-pass census (a declaration index, then one file at a time). If the spike fails its bar, or the
keep rule (section 2, D3) fails, that route is taken instead, and nothing native is kept.

## 2. Owner decisions (2026-09-27, decided, not open)

- **D1, platforms: all five targets.** Windows x64, Linux x64 and arm64, macOS x64 and arm64, as
  `scripts/build-binary.ts` builds today. Each is built and parse-smoke-tested on its own platform
  in the release CI. This is mandatory before any release that carries the native parser: a
  release cannot ship a target whose parser was not built and parse-tested.
- **D2, shipping: CI-built, attached to releases, nothing committed.** No `.node` file is committed
  to the repo. CI builds the addon; developers build it locally with `bun scripts/build-native-parser.ts`
  (a Rust toolchain is required for development from source). Provenance (grammar source hashes,
  toolchain, license and notice inventory) is checked in CI.
- **D3, keep or revert, decided before any native result and gating the switch-over.** Keep native
  only if BaseApp's census (W2, all 9,620 files) completes in one pass with peak memory at or under
  the ceiling pre-set in the pre-commitment. Otherwise revert to WASM and fix R292 in TypeScript.
  The switch-over is not committed, and R292 is not closed, until this rule has been applied.

## 3. The boundary

**A Node-API addon written with napi-rs, exposing ONE call per file, `parseFlat(source) -> FlatTree`.**
Rust parses the file, walks the tree once, writes every node into flat typed arrays, frees the
tree, and returns the arrays. The TypeScript `ALSyntaxNode` is implemented over those arrays in
plain JavaScript. No per-node call crosses the boundary. (Node-API is Node's stable C interface
for native modules; Bun implements it, so a `.node` file loads in Bun with `require`.)

| Option | Verdict | Reason |
| --- | --- | --- |
| A. Addon exposing live native nodes (a native call per property) | Rejected | Walks read millions of properties, so crossing cost can eat the parse gain, and trees would be freed only by finalizers. |
| **B. Addon returning a flat tree per file** | **Chosen** | One crossing per file; the native tree is freed before the call returns; node access is plain array reads. |
| C. A Rust CLI process streaming facts back | Fallback only | Same flat format plus a child process, pipe framing and a second executable. Only if the spike shows the addon cannot load in dev or inside a `--compile` binary. |
| D. Move hot walks (census, TestPage scan) into Rust | Rejected | Splits site and identity logic across two languages; each moved walk would need its own proof. |
| E. The `tree-sitter` npm package plus tree-sitter-al's `bindings/node` | Rejected | Option A plus a C++ build on install; Bun compatibility unproven. |
| F. `bun:ffi` over a plain DLL | Rejected | Documented as experimental; an embedded DLL would need manual extraction from a `--compile` binary. |

The engine's parse interface stays: `initParser()`, `parseAL(source)`, `wrapRoot(parsed)`. The
return type of `parseAL` changes from web-tree-sitter's `Tree` to an opaque `ParsedAL` (source plus
flat tree). `ALSyntaxNode` gains two read-only members, `isMissing` and `hasError`, because the
R-236c scanner decides whether a test is safe to send from exactly those two facts (section 5).
Every other raw-tree use is either moved to the WASM reference (grammar instruments) or ported.
Which callers exist is established by a repo-wide search AFTER R-236c merges, not by this document.

## 4. Nodes in JavaScript

The flat tree for one file, in preorder (a parent before its children, children left to right):

| Array | Type | Per node |
| --- | --- | --- |
| `kind` | `Uint16Array` | index into `kindNames` (per-file table of `node.kind()` strings) |
| `field` | `Uint16Array` | index into `fieldNames`; 0 means no field |
| `flags` | `Uint8Array` | bit 0 named, bit 1 missing, bit 2 has-error, bit 3 extra |
| `childCount` | `Uint32Array` | number of children; the first child is at `i + 1` |
| `nextSibling` | `Int32Array` | next sibling, or -1 |
| `startIndex`, `endIndex` | `Uint32Array` | UTF-16 code units, as web-tree-sitter reports them |
| `points` | `Uint32Array` | 4 per node: start row, start column, end row, end column |

Names are interned from the strings tree-sitter returns, mapped by symbol and field id (a name is a
function of its id), so aliases, `ERROR` and MISSING nodes read exactly as in web-tree-sitter.

`FlatNode` keeps today's `WrappedNode` semantics: fresh wrappers on every `children` or
`namedChildren` read, no caching, so node identity behaves as before (`schemata/src/compile.ts`
keys a `Map` by the wrapper instance it holds; the symbol table compares positions). `text` is
`source.slice(startIndex, endIndex)`. `childForFieldName(name)` is the first child whose field is
`name`; the proof checks this against web-tree-sitter at every node of every file.

## 5. Identity stays byte-identical

`astSubtreeHash` reads `kind`, `text`, `fieldName` and `namedChildren` and does not change. Matching
versions is necessary but is a HYPOTHESIS, not a guarantee: same grammar sources (section 7), the
`tree-sitter` crate pinned `=0.25.10` (the vendored `web-tree-sitter`'s version), UTF-16 input
(`parse_utf16_le`). It does not by itself establish identical UTF-16 handling, error recovery,
points, aliases or fields. The proof does:

1. **Lockstep structural walk, every file, every corpus, BaseApp included (C1).** Both parsers,
   seen through `ALSyntaxNode` (WASM `WrappedNode` vs native `FlatNode`), walked together: at every
   node, kind, start and end index, start and end point, field name, `isMissing`, `hasError`; the
   number, order and boundaries of `children`; every child's `parent` is the node walked from; the
   `namedChildren` list with each one's field name; and `childForFieldName` for every field name
   the engine queries plus every field present among the children. Field lookups are ON for BaseApp.
   Node text is compared explicitly. Plus a raw link check: a traversal of the flat links from
   the root marks every visited index, rejects an out-of-range link, a duplicate or a cycle, and
   requires every index to be reached exactly once; and the lockstep walk's node count must equal
   the flat tree's length.
2. **Probes kept (I1):** Unicode (Danish letters, a BOM, a character outside the Basic
   Multilingual Plane), CRLF, broken input (ERROR and MISSING), empty source.
3. **Sites, hashes, identity keys.** Census rows, `probe-fixture-hashes.ts` listings, and FULL
   identity-key listings (`selection.ts` `serializeKey(identityKeyOf(m))`, including the
   source-order `identityOrdinal` that `schemata/src/project.ts` assigns) on every fixture, on
   `do-rel2/Cloud` and on the WHOLE BaseApp corpus (9,620 files): byte-identical. There is no
   waiver. The normal WASM pipeline cannot hold whole BaseApp (it keeps every tree for the shared
   context), so the WASM side of that one listing comes from a **scratch capture**: the real
   `generateMutationSet` and `writeInstrumentedProject`, unchanged, run in a scratch worktree whose
   `parseAL` parses with WASM, copies the tree into compact JavaScript arrays through an
   independent scratch materializer (not the product `FlatNode`, so a `FlatNode` defect cannot
   cancel out), and deletes the WASM tree. The context, spec generation and ordinal rules are the
   product's own code. The capture is VALIDATED first: on every corpus small enough for the normal
   WASM pipeline (every fixture, do, dc, sentinel, bcf, sysapp) its listing must be byte-identical
   to the normal pipeline's. If it cannot be validated, or the pipeline refuses the whole-corpus
   root for a project-level reason, that is a STOP for the owner, not a substitute.
4. **R-236c's scanner** (I2): its tests pass unchanged, and its census, run on an explicit list of
   the ten corpora it was measured on, with asserted file, test, refused and loud-error counts,
   non-empty output and timing fields removed, is identical before and after.
5. **The frozen live gates**, no figure moving.

One differing node, row, hash or key is a BLOCK.

## 6. The R-236c merge (I2)

R-236c lands on master first. Its scanner (`packages/runner/src/testpage-scan.ts`) walks the raw
WASM tree for parse health: `root.hasError`, then every node with `type === "ERROR"` or `isMissing`,
through raw `children`, and it frees each tree with `tree.delete()`. Those are SAFETY decisions: a
parse error in a reachable codeunit stops the run rather than sending a test that may open a
TestPage. The port: `errorOffsets` takes the `ALSyntaxNode` root and reads `hasError`, `rawKind ===
"ERROR"`, `isMissing` and `children` (which, like raw `children`, include anonymous nodes); the
`delete()` calls are removed because a native tree is already freed. **Its return type does not
change.** Whatever the merged scanner's error facts are (`number[]` of `startIndex`, as the R-236c
plan describes, or `{ startIndex, text }` objects, as its branch commit `c9750b5` has), the port
pushes exactly that shape, so no consumer (`buildUnit`, `within`, the suspect-offset loop) changes.
Which shape applies is a precondition read after the merge, not assumed here. No no-op `delete()` is added
to hide an unmigrated caller: every caller is found by the repo-wide search and fixed, or
typecheck fails.

## 7. Build, distribution and provenance

- **Crate** at `packages/engine/native/`: `napi` and `napi-derive` 3, `tree-sitter =0.25.10`,
  `tree-sitter-al =4.4.1` (crates.io, checksum pinned by the committed `Cargo.lock`), `sha2`.
  No new npm dependency.
- **No committed binary (D2).** `packages/engine/vendor/native/*.node` is gitignored.
  `scripts/build-native-parser.ts` builds and places it for the current platform. `ci.yml` builds it
  before the unit suite. `release.yml` builds all five in a matrix on native runners (D1). **No release is created and
  nothing is attached until every compiled binary has passed its own smoke test**: build, sign,
  smoke on five platforms, then a final publish job that needs all five smoke jobs.
- **Grammar source check.** `scripts/check-native-grammar.ts` resolves the `tree-sitter-al` crate
  through `cargo metadata`, hashes its `src/parser.c` and `src/scanner.c`, and compares them with
  upstream's `tree-sitter-al.wasm.inputs.sha256` at tag v4.4.1 (the inputs of the vendored WASM):
  `0b687fa1...158e22 src/parser.c`, `346052d7...3b990a src/scanner.c` (full values in the plan).
  The build script refuses to build without passing it, and passes the checked hashes to `build.rs`,
  which embeds them.
- **Embedded provenance.** `nativeInfo()` returns: a hash of the crate's own sources (a stale-build
  guard, `\r` stripped so CRLF checkouts agree), the grammar input hashes, the grammar and
  tree-sitter versions, the language ABI, a digest of the language's kind and field tables, the
  `rustc` version and the target triple. `initParser()` compares grammar version, tree-sitter
  version, ABI, kind-table digest and grammar input hashes with `GRAMMAR_PIN` in
  `packages/engine/src/ast/native-parser.ts`, and throws on any difference.
- **Provenance record per artifact.** Next to each built `.node`, a `.provenance.json`: its
  SHA-256 and size, `nativeInfo()`, the `Cargo.lock` hash, the C compiler's version banner, the
  commit. Release CI attaches it with the binaries.
- **License and notice inventory.** `scripts/native-notices.ts` lists every crate in the build
  graph with its license from `cargo metadata`, refuses any license outside an allowlist (MIT,
  Apache-2.0, BSD-2/3-Clause, ISC, Zlib, Unicode, 0BSD), evaluating the FULL SPDX expression
  (`OR` needs one allowed side, `AND` needs both, `WITH` needs an allowed exception), and writes the committed
  `packages/engine/native/THIRD-PARTY-NOTICES.md`; CI fails if the committed file is out of date.
  The release attaches it.
- **Reproducibility, stated as measured.** Windows builds use deterministic flags (`/Brepro` for
  the linker and the C compiler). The plan builds twice from clean and records whether the bytes
  match. If they do not, the stated limit is: reproducible in BEHAVIOUR (equal `nativeInfo()` and a
  clean equivalence proof), not in bytes, and the per-artifact hash identifies what shipped.
- **The `DIRTY` stamp.** `build-binary.ts` stamps a binary `DIRTY` when `git status --porcelain` is
  non-empty. The downloaded `.node` files are gitignored, so they do not dirty the tree; release CI
  asserts `git status --porcelain` is empty before `build:binaries` and that `--version` does not
  report DIRTY.
- **Standalone binary.** `bun build --compile` embeds a `.node` file required by a literal path;
  the spike proves this on Windows, and the release matrix proves each target by parsing with it.
  If the bundler demands every literal branch's file, the spike probes the exact alternative (a
  build-time `--define` key in the require path, plus a runtime-key require in source mode that
  works on all five platforms). If neither embeds, STOP.
- **Missing binary: fail loudly, no WASM fallback in the product.** `NativeParserMissingError`
  names the platform, the path, and the build command. A silent fallback would bring back the
  2 GB cap exactly where it matters.
- **The WASM stays as a reference instrument only** (`parser-wasm.ts`, not exported from the
  engine index, not reachable from `cli.ts`), for the equivalence proof and the grammar
  cross-check scripts.

## 8. Measurement, bar and keep rule

Pre-committed in `docs/superpowers/specs/2026-09-27-rust-01-precommitment.md`, alone, before any
native number is read. Instrument: `scripts/measure-peak.ts` (wall time and peak resident memory
through `Bun.spawn(...).resourceUsage().maxRSS`; proven on Windows: a 1 GB allocation reports
1,364 MB).

| Id | Workload |
| --- | --- |
| W1 | Parse only: every `.al` file of BaseApp (9,620), parse, wrap, walk every node. |
| W2 | `census-operator-sites.ts` on all of BaseApp in one pass (aborts today). |
| W3 | `census-operator-sites.ts` on `BaseApp/Source` and on `do-rel2/Cloud`. |
| W4 | `lethal run --dry-run` on `BaseApp/Source/Base Application` (8,020 files). |
| W5 | `lethal run --dry-run` on `fixtures/sandbox-data`. |
| W6 | A scoped REAL `lethal run` on bcdev: `fixtures/sandbox-data --only src/DataMain.Table.al` (the chunked gate's slice), selector ids 79399 / 79398 / 79397 passed explicitly. |
| A | Attribution: peak memory of `bun test`, of W3 and of W6 on WASM. |

- **Identity, hard:** section 5, zero differences.
- **Spike STOP (I4):** native parse including flatten and transfer (W1 parse time) must be at most
  50% of WASM's, and the addon must load in dev and inside a `--compile` binary on Windows. Else
  STOP and take R292's TypeScript route.
- **Keep rule (D3), gates the switch-over:** W2 completes in one pass with peak memory at or under
  the pre-committed ceiling. Else revert and take R292's TypeScript route.
- **Ceilings, pre-set in Task 0 from the WASM baseline, never raised after a native result:** W2
  and W4 at a fixed ceiling (recommended 8 GB); W6 at 110% of its WASM peak. W4 or W6 over its
  ceiling does not trigger a revert, but no product memory win is claimed and the excess is filed.
- **Reported, not gating:** W1 walk time, W3 at most 70% of WASM wall time, W3 peak no higher than
  WASM, W5 no more than 10% slower.
- **Gates:** every frozen live gate run passes with no figure moving.

## 9. What does not change

`astSubtreeHash`, every operator, the semantic layer, the schemata compiler, report shapes and
every frozen gate baseline. `ALSyntaxNode` gains `isMissing` and `hasError` only. No baseline is
deleted, regenerated or edited.

## 10. Rulings on the former open questions (orchestrator, 2026-09-27)

1. The WASM reference stays until one grammar bump has been done natively; then the owner decides.
2. Linux addons build on `ubuntu-22.04`.
3. Local worktrees share one `CARGO_TARGET_DIR`, so a fresh worktree's build is quick after the first.
4. `itest:tables` is deferred to the combined GH-24 / R-236c check unless its baseline has been
   re-recorded before the landing gates run.
5. A WASM identity-key listing of whole BaseApp is mandatory (section 5); no waiver.

No open questions remain in this design.
