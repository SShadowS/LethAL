# Vendored `tree-sitter-al.wasm`

This directory contains a prebuilt tree-sitter parser WebAssembly binary for the
AL language (Microsoft Dynamics 365 Business Central). The `@lethal/engine`
package loads this file at runtime via `web-tree-sitter` to parse AL source.

## Upstream grammar

- Repository: <https://github.com/SShadowS/tree-sitter-al>
- License: MIT
- Version: `4.0.1`
- Commit: `58c236f` — "chore: regenerate parser.c and rebuild tree-sitter-al.wasm
  for v4.0.1", tag `v4.0.1`
- Provenance: **built locally from source at that tag**, NOT downloaded from a
  release. `tree-sitter build --wasm`, tree-sitter CLI 0.26.12, from a detached
  worktree at the tag so the grammar checkout's own state could not leak in.
- Artifact: 10,323,560 bytes,
  `sha256:d2584663e92a84197530f4627dc5444830c588499f1bd3d93d7b9c2b37075af6`
- 4.0.1 is the tagged form of what was vendored hours earlier from untagged
  `05e6288` (artifact `sha256:4dcd0fda87f1...`): `914e779` fixes an object-level
  variable named after a section keyword (`var Filter: Codeunit …`, also `keys`,
  `fields`, `layout` + 11 more) parsing as ERROR — reported by a downstream
  consumer verifying 4.0.0, present since 2.5.1 — and `3bac021` fixes MSVC
  scanner builds. Between `05e6288` and the tag: version stamp and upstream
  docs only (`parser.c` diff is one line). Proven against the 4.0.0-tag build
  on the same corpus snapshot: per-site Tier-1 census BYTE-IDENTICAL (30,751
  sites), both fixtures' per-spec identity hashes BYTE-IDENTICAL (16 + 141
  rows — every committed itest baseline stays valid), unit suite 2,172 pass /
  0 fail, `itest:bcdev` 3/10/3 PASS per-mutant; and the v4.0.1 build re-proved
  census + fixture hashes BYTE-IDENTICAL to the `05e6288` build. What it adds
  over 4.0.0: `probe-kw-vars2.ts` (session scratch) showed the 4.0.0-tag build
  ERRORs on `var Filter: Codeunit "Some Thing";` at object level and this build
  parses it clean — real BC code uses such names, our corpus just does not.

Previously `3.2.1` at commit `335d1ff` (7,457,411 bytes, `sha256:33b861ddd6...`),
kept here because a bump's evidence is only readable against what it replaced.

A commit alone does not determine the binary — `tree-sitter build --wasm` uses
local Emscripten when present and falls back to a Docker image otherwise, and the
two toolchains do not produce byte-identical output. Record the artifact hash on
every bump so the vendored file can be *verified*, not merely re-approximated.
The build is not even reproducible on ONE machine: two consecutive
`tree-sitter build --wasm` runs at the 4.0.0 tag with the same CLI differed in
848 bytes (and 7 bytes of length) — emscripten-class path/metadata noise — so
the recorded hash identifies the SHIPPED artifact, never the (commit, toolchain)
pair. The wasm checked into the grammar repo's root at the tag is close but not
this artifact either (10,129,974 bytes, `sha256:c1232fd290...`); build from
source rather than copying it.

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

## The 3.2.1 -> 4.0.0 bump (2026-08-12): trees move, and the identity hashes move with them

Upstream 4.0.0 is a deliberately breaking release (its changelog enumerates every
tree-moving change by node-instance set difference over 15,358 BC.History files).
Three releases came in one bump: 3.3.0 (additive `#define`/`#undef`), 3.3.1
(scanner fixes, tree-neutral) and 4.0.0. What it cost HERE, measured:

**Grammar-caused code changes needed: one.** `emitDispatch` (`packages/schemata/src/dispatch.ts`)
appended `;` unconditionally after a guard chain's final `end`. Under 3.x every
statement span consumed its own terminator so that was correct; 4.0.0 moves the
`;` OUT of every statement/block node, the source's own `;` now survives outside
the replaced span, and the unconditional append emitted `end;;`. The fix applies
the same consumed-terminator rule the other two splice sites already used: emit
`;` if and only if the replaced text ended with one. Two test updates rode along
(`empty-block`'s conformance `beforeText` lost its trailing `;`; a compile.test
expectation likewise).

**Aggregate census** — same corpus as the 3.2.1 bump (Continia Document Output
Cloud + Test), re-snapshotted 2026-08-12 at 658 files, so numbers are not
directly comparable to the 659-file column above; the A/B below is same-day,
same-snapshot:

| | 3.2.1 | 4.0.0 |
| --- | --- | --- |
| files parsed / clean | 658 / 658 | 658 / 658 |
| ERROR nodes | 0 | 0 |
| `statementCalls` | 17,910 | 17,929 |
| `blocks` | 8,416 | 8,416 |
| `triggerBlocks` | 2,146 | 2,146 |
| `procedures` | 4,443 | 4,443 |
| `exits` | 2,533 | 2,533 |

**Per-site census** (`census-tier1-sites.ts`, position-keyed): 30,823 -> 30,751
sites. Every moved site maps to a named upstream change:

- **94 removed**, all `lethal.negate-conditional`, every one a single-entry
  `DataItemLink`/`RunPageLink`/`SubPageLink` property (`"No." = field("No.")`)
  that 3.x misparsed as a `comparison_expression` and 4.0.0 parses as
  `link_value`. These were never live mutants — the orchestrator's
  `isMutableSite` guard already dropped declarative sites — so the census shrank
  and no run changes.
- **19 added** `lethal.void-method-call`: statement calls in bare `case … else`
  bodies. 4.0.0 wraps those bodies in a `statement_block`, which is exactly what
  `isStatementPosition` keys on — a genuine coverage GAIN (`else Error('');` was
  unclaimable under 3.x).
- **3 added** `lethal.empty-block`: the dangling-`else` repair. In
  `X: if C then begin … end else begin … end;` inside a case branch, 3.x bound
  the `else` to the CASE (block parent `case_else_branch`, unclaimed); 4.0.0
  binds it to the inner `if` (parent `if_statement`, claimed). Upstream calls
  this its only change to what a program MEANS; here it surfaces as three new
  blocks.
- **0 other text or position drift**: 22,945 surviving positions byte-identical,
  7,669 differ only by the trailing `;` leaving the span, 0 anything else.
  Position-key collisions (115, nested same-operator sites) proven identical as
  semicolon-normalized multisets on both sides.

**Identity hashes move — `assignment_operator` is why.** 4.0.0 makes the
assignment operator a named node (upstream: +243,044 instances; the bytes were
previously in NO node). `astSubtreeHash` serializes named children, so every
`empty-block` mutant whose block contains a `:=`/`+=` gained a child and a new
hash: 2 of sandbox-app's 16 mutants, 30 of sandbox-data's 141. Both fixtures
proven per-site BEFORE any baseline was touched: spec planning replicated
(targets -> generate -> validateSpec -> isMutableSite -> dedup) under both wasms,
joined 1:1 on (operator, file, line, col) — no site appeared or disappeared, no
text changed beyond the trailing `;`, and the hash mapping is functional (no
old hash maps to two new ones). Every moved hash belongs to `empty-block`; every
other operator's hashes are byte-stable.

**Baselines re-recorded the sanctioned way** (delete, gate records, gate re-run
self-compares — never hand-edited), with the offline proof that
`old-baseline re-keyed through the mapping == recorded baseline` as EXACT JSON
multisets (verdicts, killingTests and all) for each of the four:

| gate | frozen figures | re-keyed | self-compare |
| --- | --- | --- | --- |
| `itest:bcdev` | 3 / 10 / 3, baselineGreen=true | 2 hashes | PASS |
| `itest:alrunner` (v2.1.1.0, BC 28.1) | 3 / 13 / 0 | 2 hashes | PASS |
| `itest:tables` | 113 / 18 / 10, untargetedTriggers=0, screen `vacuous`, the one named TestPage refusal | 30 hashes | PASS |
| `itest:envtool` | 3 / 10 / 3 | 2 hashes | PASS |

`itest:lease` (P1-P10, P9B) and `itest:stale-publish` (Probes A+B): PASS,
unchanged — they pin no per-mutant baseline.

The envtool gate's environment had been deleted, and recreating one exposed two
latent runner gaps — neither grammar-caused, both fixed alongside this bump: the
envtool ITEST never spread `afterLeaseAcquiredFor` into `runSession`, so a
config's `publishApps` was silently never published (the R31/R56 staleness class
cli.ts warns about — invisible until a FRESH environment made "no test app"
observable as every baseline test failing with "RunMutant returned 0 test
lines"); and `EnvToolPublisher.publishFile` died republishing identical bytes
because BC rejects a duplicate packageId — now treated as already-published,
`publishFile` only, since compiled mutant artifacts carry fresh versions and a
duplicate THERE stays loud. The gate now runs against environment
`1a15baa8-914a-4806-ad7b-354dfeefc593` (DK 28.1, expires 2026-08-26; the
gitignored config names it).

Also verified: all 41 curated `ALNodeKind` values still exist in 4.0.0's
`node-types.json` (nothing renamed or removed that LethAL names), so no kind
regeneration was needed; the new named types (`assignment_operator`, the
`where()` marker keywords, `preproc_define`/`preproc_undef`,
`begin_keyword`/`end_keyword` inside `#if`) are simply not yet in the curated
set. Unit suite after the one dispatch fix: 2,169 pass / 1 skip / 0 fail.

**What this bump does NOT prove**, same caveat as last time: the corpus here
contains none of the shapes the 4.0.0 semantic fixes repair at scale (the
fixture dangling-else sites are the exception that DID move). The gain is on
code the old grammar misread — `#if`-split blocks, mixed-case keywords, spaced
`exit (…)` — and only the three dangling-else/case-else clusters above witness
it in this corpus.

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
