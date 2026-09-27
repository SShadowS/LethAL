# RUST-01: Native AL Parser Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Revision r2 (2026-09-27).** Revised per gpt-6-sol review r1 (`H:/lethal-coord/reviews/RUST-01-plan/review-r1.md`), the orchestrator's rulings (C1, I1 to I5, minors) and the owner's decisions D1, D2, D3 (design section 2). What changed: R-236c lands first, and its scanner's parse-health decisions are ported with its tests and census (Task 6); the tree proof is a lockstep structural walk through `ALSyntaxNode` on every file, field lookups on BaseApp too (Task 5); full identity keys run on BaseApp (Tasks 0, 6); the spike bar is 2x parse (Task 1); memory is measured on whole BaseApp and a scoped REAL run against pre-set ceilings, with an attribution step (Task 0); the keep-or-revert rule is pre-committed and gates the switch-over commit (Task 7); no binary is committed, all five targets are built and parse-smoke-tested in release CI, and provenance, notices and the DIRTY stamp are handled in CI (Tasks 2, 8).

**Revision r3 (2026-09-27), final.** Revised per review r2 (`H:/lethal-coord/reviews/RUST-01-plan/review-r2.md`) and the orchestrator's rulings. What changed: the BaseApp identity waiver is gone; Task 0 Step 6 builds and VALIDATES a scratch WASM capture that produces the whole-BaseApp (9,620 files) identity listing through the product's own context, spec-generation and ordinal code, and a failure to validate it is a STOP (C1); release publication moves to a final job that needs all five compiled-binary smoke jobs (C2, Task 8); the R-236c port keeps the merged scanner's error-fact type, checked as a precondition (I1, Tasks 0 and 6); the scanner census runs on an explicit ten-corpus list with asserted counts, non-empty output and timing removed (I2); the structural check marks visited flat indexes, rejects duplicates and cycles, requires every index, and compares text (I3, Task 5); the spike probes the exact variant-B loader and a source-mode loader for all five platforms, else STOP (I4, Tasks 1 and 3); W6 passes selector ids 79399 / 79398 / 79397; the notice check evaluates the full SPDX expression. Rulings: WASM stays until one native grammar bump, then the owner decides; `ubuntu-22.04`; a shared `CARGO_TARGET_DIR`; `itest:tables` deferred to the combined check unless re-recorded first.

**Goal:** Parse AL through tree-sitter-al compiled natively into a Rust Node-API addon, behind the engine's `initParser` / `parseAL` / `wrapRoot` interface, with every tree, site, hash and identity key byte-identical to the WASM path, kept only if the pre-committed keep rule holds.

**Architecture:** A napi-rs addon (`packages/engine/native/`) exposes one call per file, `parseFlat(source)`: Rust parses the UTF-16 source, walks the tree once into flat typed arrays, frees the tree, and returns the arrays. A plain-JavaScript `FlatNode` implements `ALSyntaxNode` over them. The WASM parser stays as a reference instrument (`parser-wasm.ts`) outside the product import graph.

**Tech Stack:** Bun 1.3.14 + TypeScript; Rust 1.96 / cargo; crates `napi` 3, `napi-derive` 3, `napi-build`, `tree-sitter =0.25.10`, `tree-sitter-al =4.4.1`, `sha2`; `web-tree-sitter` 0.25.10 (reference only after Task 6); GitHub Actions; Cronus28 for live runs.

**Spec:** `docs/superpowers/specs/2026-09-27-rust-native-parser-design.md`. Task 0 writes the pre-commitment `docs/superpowers/specs/2026-09-27-rust-01-precommitment.md`.

## Global Constraints

- **Precondition: R-236c is merged to master before Task 0 starts** (ruling I2). The TestPage scanner (`packages/runner/src/testpage-scan.ts`) must be in the tree the baseline measures, and Task 0 Step 1 records the exact type its `errorOffsets` returns and every consumer of it.
- **Local builds share one cargo target directory** (ruling): `export CARGO_TARGET_DIR=C:/Users/SShadowS/.cache/lethal-native-target` in every shell that builds the addon, so a fresh worktree reuses the compiled grammar.
- **WASM stays** as the reference until one grammar bump has been done natively; then the owner decides (ruling).
- **D1:** all five targets (`win32-x64`, `linux-x64`, `linux-arm64`, `darwin-x64`, `darwin-arm64`) are built and parse-smoke-tested on their own platform in release CI. Mandatory before any release carrying the native parser.
- **D2:** no `.node` is committed. `packages/engine/vendor/native/*.node` and `*.provenance.json` are gitignored. Provenance is checked in CI.
- **D3:** keep native only if W2 (BaseApp census, 9,620 files, one pass) completes with peak memory at or under the pre-committed ceiling; otherwise revert and fix R292 in TypeScript. Decided before any native result; gates the switch-over commit.
- **Fallback route:** if the spike (Task 1) or D3 (Task 7) fails, take R292's TypeScript route (release each tree once used, or a two-pass census). Nothing native is kept.
- Plain English, no em dashes, in every file and commit message.
- `tree-sitter` crate `=0.25.10` (equals `web-tree-sitter` 0.25.10 in `bun.lock`); `tree-sitter-al` crate `=4.4.1`; `Cargo.lock` committed.
- Grammar sources must hash to upstream v4.4.1's `tree-sitter-al.wasm.inputs.sha256`: `0b687fa1a84c34e46643e4d7a945e5190208e2f15fb346776f13703f15158e22 src/parser.c`, `346052d7b59f1c340ad77ed79d1349b5c2b4449ecda60840a4b8ad63913b990a src/scanner.c`.
- UTF-16 input; `startIndex` / `endIndex` in UTF-16 code units, as web-tree-sitter reports them.
- No WASM fallback in product code; no no-op `delete()`. Typed errors extend `Error` directly.
- No `!` non-null assertions; `exactOptionalPropertyTypes`; `noUncheckedIndexedAccess`.
- Build loop: `bun run typecheck`, then `rm -rf packages/*/dist`, then `bun test`. Biome only on touched files.
- The pre-commitment is committed ALONE before any native measurement is read. Nothing above `## OUTCOME` changes after a run; a failed prediction gets an `## AMENDMENT`, committed alone.
- No baseline is deleted, regenerated or edited. A differing verdict is a BLOCK.
- `S=<session scratchpad>`; nothing under `$S` is committed. Corpus map, re-declared in every fresh shell:

```bash
S=<session scratchpad>; cd /u/Git/LethAL
declare -A C=([do]="U:/Git/do-rel2/Cloud" [dc]="U:/Git/DC/Cloud" [sentinel]="U:/Git/BusinessCentral.Sentinel" [bcf]="U:/Git/BC.History/BusinessFoundation" [sysapp]="U:/Git/BC.History/System Application" [bsrc]="U:/Git/BC.History/BaseApp/Source" [btest]="U:/Git/BC.History/BaseApp/Test")
F="sandbox-app sandbox-data sandbox-hang sandbox-harden sandbox-coverage-probe"
BAPP="U:/Git/BC.History/BaseApp/Source/Base Application"
BASEAPP="U:/Git/BC.History/BaseApp"
export CARGO_TARGET_DIR=C:/Users/SShadowS/.cache/lethal-native-target
```

## Review Focus

1. **Non-ASCII source** (Danish letters, a BOM, a character outside the Basic Multilingual Plane): offsets and columns equal to web-tree-sitter's, or `printWithRewrites` writes corrupt AL. Pinned by Task 2 (`offsets_are_utf16_code_units`) and Task 5 (unicode snippet).
2. **CRLF line endings:** rows and columns match, and the source hash does not call a CRLF checkout stale. Pinned by Task 5 (CRLF snippet) and Task 3 (staleness test mirrors `build.rs`'s `\r` stripping).
3. **Broken AL:** same ERROR and MISSING nodes, and the ported scanner still refuses a test that reaches a damaged codeunit. Pinned by Task 2 (`has_error_flag_on_broken_input`), Task 5 (broken snippet) and Task 6 (R-236c's own tests, unchanged).
4. **Missing binary or pin mismatch** (a fresh worktree, a release target without its `.node`): a typed error naming the platform and the fix. Pinned by Task 3 (`loadBindingFor("linux-riscv64")`) and Task 8 (release parse smoke per target).
5. **Empty and whitespace-only files:** a one-node tree. Pinned by Task 2 (`empty_source_is_one_root_node`) and Task 5 (empty snippet).

---

### Task 0: Baseline, attribution and pre-commitment (WASM only)

**Files:**
- Create: `scripts/measure-peak.ts`, `scripts/bench-parse.ts`
- Create: `docs/superpowers/specs/2026-09-27-rust-01-precommitment.md`

**Interfaces:**
- Produces: `bun scripts/measure-peak.ts <cmd...>` prints `measure-peak: exit <n> wall_s <s> peak_mb <mb>` on stderr. `bun scripts/bench-parse.ts <dir>` prints `{files, chars, nodes, parseMs, walkMs}` through the engine's public parse interface only, so the same script measures native after Task 6.

- [ ] **Step 1: Confirm the precondition.** `git log --oneline master | grep -i "R-236c"` shows the merge, and `packages/runner/src/testpage-scan.ts` exists. If not, stop: R-236c lands first. Then record, for Task 6's port, the merged `errorOffsets` signature and every consumer of its result:

```bash
grep -nE "function errorOffsets|errorOffsets\(|ErrorSite|errors: readonly|within\(" packages/runner/src/testpage-scan.ts
```

Record whether the element type is `number` (a `startIndex`) or an object (for example `{ startIndex, text }`), and list each consumer by line. Task 6 keeps that exact type.

- [ ] **Step 2: Write `scripts/measure-peak.ts`.**

```ts
#!/usr/bin/env bun
/**
 * RUST-01: run a command and report its wall time and peak resident memory (maxRSS in KB, from the
 * OS through Bun.spawn's resourceUsage). Proven on Windows 2026-09-27: a child that allocates and
 * fills 1 GB reports 1,364 MB.
 *
 *   bun scripts/measure-peak.ts <command> [args...]
 */
const argv = process.argv.slice(2);
if (argv.length === 0) throw new Error("usage: measure-peak.ts <command> [args...]");
const t0 = performance.now();
const child = Bun.spawn(argv, { stdout: "inherit", stderr: "inherit" });
await child.exited;
const usage = child.resourceUsage();
if (usage === undefined) throw new Error("measure-peak: the child reported no resource usage");
const wall = ((performance.now() - t0) / 1000).toFixed(2);
const peakMb = Math.round(Number(usage.maxRSS) / 1024);
console.error(`measure-peak: exit ${child.exitCode} wall_s ${wall} peak_mb ${peakMb}`);
process.exit(child.exitCode ?? 1);
```

- [ ] **Step 3: Prove the instrument.** `$S/alloc.ts`:

```ts
const kept: Uint8Array[] = [];
for (let i = 0; i < 8; i++) {
  const b = new Uint8Array(128 * 1024 * 1024);
  b.fill(1);
  kept.push(b);
}
console.log(kept.length);
```

Run: `bun scripts/measure-peak.ts bun "$S/alloc.ts"`. Expected: `peak_mb` at least 1024, else stop.

- [ ] **Step 4: Write `scripts/bench-parse.ts`.**

```ts
#!/usr/bin/env bun
/**
 * RUST-01 workload W1: parse every .al file of a corpus with the engine's current parser, wrap the
 * root, walk every node once, and report parse and walk time. Files are read first, so disk time is
 * not counted. Only the engine's public parse interface is used, so this script measures WASM
 * before the switch-over and native after it.
 *
 *   bun scripts/bench-parse.ts <corpus-dir>
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { initParser, parseAL } from "../packages/engine/src/ast/parser";
import { visit, wrapRoot } from "../packages/engine/src/ast/syntax-node";
import { corpusEntries } from "./corpus-fingerprint";

const [dir] = process.argv.slice(2);
if (dir === undefined) throw new Error("usage: bench-parse.ts <corpus-dir>");
const files = await corpusEntries(dir);
const sources = await Promise.all(files.map((f) => readFile(join(dir, f), "utf8")));
await initParser();
let parseMs = 0;
let walkMs = 0;
let nodes = 0;
let chars = 0;
for (const source of sources) {
  const t0 = performance.now();
  const parsed = parseAL(source);
  const t1 = performance.now();
  visit(wrapRoot(parsed), () => {
    nodes++;
  });
  const t2 = performance.now();
  // A WASM tree lives in a 2 GB heap and must be freed or this aborts near file 9,000 (R292).
  // A native ParsedAL has no delete(): its tree was freed inside the parse call.
  (parsed as unknown as { delete?: () => void }).delete?.();
  parseMs += t1 - t0;
  walkMs += t2 - t1;
  chars += source.length;
}
console.log(
  JSON.stringify({ files: files.length, chars, nodes, parseMs: Math.round(parseMs), walkMs: Math.round(walkMs) }),
);
```

- [ ] **Step 5: Fingerprints and identity captures.** Copy `identity-keys.ts` and `rows-diff.ts` verbatim from `docs/superpowers/plans/2026-09-27-TSAL-441-grammar-bump.md` Task 3 Step 3 into `$S`.

```bash
for k in "${!C[@]}"; do bun scripts/corpus-fingerprint.ts "${C[$k]}" | head -1; done
for f in $F; do
  bun scripts/census-operator-sites.ts "fixtures/$f/src" "$S/census-wasm-$f.json"
  bun scripts/probe-fixture-hashes.ts "fixtures/$f/src" > "$S/hashes-wasm-$f.txt"
  rm -rf "$S/target-wasm-$f"; bun "$S/identity-keys.ts" "fixtures/$f" "$S/target-wasm-$f" > "$S/ids-wasm-$f.txt"
done
for k in "${!C[@]}"; do bun scripts/census-operator-sites.ts "${C[$k]}" "$S/census-wasm-$k.json"; done
rm -rf "$S/target-wasm-do"; bun "$S/identity-keys.ts" "U:/Git/do-rel2/Cloud" "$S/target-wasm-do" > "$S/ids-wasm-do.txt"
for k in dc sentinel bcf sysapp; do rm -rf "$S/target-wasm-$k"; bun "$S/identity-keys.ts" "${C[$k]}" "$S/target-wasm-$k" > "$S/ids-wasm-$k.txt"; done
R236C_CORPORA=(fixtures/sandbox-data-tests fixtures/sandbox-tests fixtures/sandbox-hang-tests fixtures/sandbox-harden-tests "${C[do]}" "${C[dc]}" "${C[sentinel]}" "${C[bcf]}" "${C[sysapp]}" "$BASEAPP")
bun scripts/r236c-testpage-census.ts "${R236C_CORPORA[@]}" | bun -e 'for (const l of (await Bun.stdin.text()).split("\n").filter(Boolean)) { const o = JSON.parse(l); delete o.ms; console.log(JSON.stringify(o)); }' > "$S/r236c-census-wasm.txt"
bun "$S/r236c-check.ts" "$S/r236c-census-wasm.txt"
```

`$S/r236c-check.ts` asserts the census scanned what it was measured on (the third-run figures in `docs/measurements/2026-09-27-r236c-testpage-census.md`), so two empty outputs can never compare equal:

```ts
// Usage: bun r236c-check.ts <census.txt>. Exit 1 unless every corpus matches its measured counts.
import { readFileSync } from "node:fs";
const EXPECTED: Record<string, [number, number, number, number]> = {
  // corpus suffix: [files, tests, refused, loudErrors]
  "sandbox-data-tests": [1, 68, 1, 0],
  "sandbox-tests": [1, 2, 0, 0],
  "sandbox-hang-tests": [1, 5, 0, 0],
  "sandbox-harden-tests": [1, 6, 0, 0],
  "do-rel2/Cloud": [554, 0, 0, 0],
  "DC/Cloud": [1135, 0, 0, 0],
  "BusinessCentral.Sentinel": [67, 54, 0, 0],
  "BusinessFoundation": [104, 89, 19, 0],
  "System Application": [1718, 1889, 209, 0],
  "BC.History/BaseApp": [9620, 40291, 11173, 0],
};
const [path] = process.argv.slice(2);
const lines = readFileSync(path ?? "", "utf8").split("\n").filter(Boolean);
if (lines.length !== Object.keys(EXPECTED).length) throw new Error(`expected ${Object.keys(EXPECTED).length} corpora, got ${lines.length}`);
let bad = 0;
for (const l of lines) {
  const o = JSON.parse(l) as { corpus: string; files?: number; tests?: number; refused?: number; loudErrors?: number; threw?: string };
  const key = Object.keys(EXPECTED).find((k) => o.corpus.replaceAll("\\", "/").endsWith(k));
  const want = key === undefined ? undefined : EXPECTED[key];
  const got = [o.files, o.tests, o.refused, o.loudErrors];
  if (o.threw !== undefined || want === undefined || got.join() !== want.join()) {
    bad++;
    console.log(`MISMATCH ${o.corpus}: got ${o.threw ?? got.join("/")}, want ${want?.join("/")}`);
  }
}
process.exit(bad === 0 ? 0 : 1);
```

If the merged scanner's figures differ from that document (a later R-236c commit re-measured), use the figures of the merged commit's own latest measurement and name it; never an empty or partial list.

Expected: exit 0 everywhere; fingerprints match TSAL-441's table, or the pre-commitment records the change.

- [ ] **Step 6: The WASM identity listing of WHOLE BaseApp, through a validated scratch capture (ruling C1, no waiver).** The normal WASM pipeline keeps every tree for the shared context and cannot hold 9,620 files. The capture runs the product's own `generateMutationSet` and `writeInstrumentedProject`, unchanged, in a scratch worktree whose `parseAL` parses with WASM, copies the tree into compact JavaScript arrays, and deletes the WASM tree before returning. Context building, spec generation and the source-order `identityOrdinal` are therefore the product's own code. The copier is written here, independent of the product `FlatNode` (which does not exist yet), so a `FlatNode` defect cannot cancel out.

Create the worktree:

```bash
git worktree add --detach "$S/capture-wt" HEAD && (cd "$S/capture-wt" && bun install --frozen-lockfile)
```

`$S/capture-wt/packages/engine/src/ast/wasm-materialized.ts`:

```ts
// RUST-01 Task 0 scratch, never committed: a WASM tree copied into compact arrays, then freed.
// Mirrors WrappedNode: children carry fieldNameForChild(i); namedChildren carry
// fieldNameForNamedChild(i); fresh wrappers on every read. childForFieldName is the first child
// with that field (validated below against the normal pipeline, and per node by Task 5).
import type { Node, Tree } from "web-tree-sitter";
import type { ALNodeKind } from "./node-kinds";
import type { ALSyntaxNode } from "./syntax-node";

export interface Materialized {
  readonly source: string;
  readonly kinds: readonly string[];
  readonly fields: readonly string[];
  readonly kind: Int32Array;
  readonly field: Int32Array;
  readonly namedField: Int32Array;
  readonly flags: Uint8Array; // 1 named, 2 missing, 4 hasError
  readonly start: Int32Array;
  readonly end: Int32Array;
  readonly pt: Int32Array;
  readonly first: Int32Array;
  readonly next: Int32Array;
}

export function materialize(tree: Tree, source: string): Materialized {
  const kinds: string[] = [];
  const kindIx = new Map<string, number>();
  const fields: string[] = [""];
  const fieldIx = new Map<string, number>([["", 0]]);
  const intern = (m: Map<string, number>, arr: string[], v: string): number => {
    let i = m.get(v);
    if (i === undefined) {
      i = arr.length;
      arr.push(v);
      m.set(v, i);
    }
    return i;
  };
  const kind: number[] = [], field: number[] = [], namedField: number[] = [], flags: number[] = [];
  const start: number[] = [], end: number[] = [], pt: number[] = [], first: number[] = [], next: number[] = [];
  const add = (n: Node, f: string | null, nf: string | null): number => {
    const i = kind.length;
    kind.push(intern(kindIx, kinds, n.type));
    field.push(intern(fieldIx, fields, f ?? ""));
    namedField.push(intern(fieldIx, fields, nf ?? ""));
    flags.push((n.isNamed ? 1 : 0) | (n.isMissing ? 2 : 0) | (n.hasError ? 4 : 0));
    start.push(n.startIndex);
    end.push(n.endIndex);
    pt.push(n.startPosition.row, n.startPosition.column, n.endPosition.row, n.endPosition.column);
    first.push(-1);
    next.push(-1);
    const kids = n.children;
    let named = 0;
    let prev = -1;
    for (let c = 0; c < kids.length; c++) {
      const k = kids[c];
      if (k === null || k === undefined) continue;
      const nfc = k.isNamed ? (n.fieldNameForNamedChild(named++) ?? null) : null;
      const ci = add(k, n.fieldNameForChild(c) ?? null, nfc);
      if (prev === -1) first[i] = ci;
      else next[prev] = ci;
      prev = ci;
    }
    return i;
  };
  add(tree.rootNode, null, null);
  return {
    source, kinds, fields,
    kind: Int32Array.from(kind), field: Int32Array.from(field), namedField: Int32Array.from(namedField),
    flags: Uint8Array.from(flags), start: Int32Array.from(start), end: Int32Array.from(end),
    pt: Int32Array.from(pt), first: Int32Array.from(first), next: Int32Array.from(next),
  };
}

class MNode implements ALSyntaxNode {
  constructor(
    private readonly m: Materialized,
    private readonly i: number,
    readonly parent: ALSyntaxNode | null,
    readonly fieldName: string | null,
  ) {}
  get rawKind(): string { return this.m.kinds[this.m.kind[this.i] ?? -1] ?? "<bad>"; }
  get kind(): ALNodeKind { return this.rawKind as ALNodeKind; }
  get text(): string { return this.m.source.slice(this.startIndex, this.endIndex); }
  get startIndex(): number { return this.m.start[this.i] ?? -1; }
  get endIndex(): number { return this.m.end[this.i] ?? -1; }
  get startPosition() { return { row: this.m.pt[4 * this.i] ?? -1, column: this.m.pt[4 * this.i + 1] ?? -1 }; }
  get endPosition() { return { row: this.m.pt[4 * this.i + 2] ?? -1, column: this.m.pt[4 * this.i + 3] ?? -1 }; }
  get isMissing(): boolean { return ((this.m.flags[this.i] ?? 0) & 2) !== 0; }
  get hasError(): boolean { return ((this.m.flags[this.i] ?? 0) & 4) !== 0; }
  private name(ix: number): string | null { return ix === 0 ? null : (this.m.fields[ix] ?? null); }
  get children(): readonly ALSyntaxNode[] {
    const out: ALSyntaxNode[] = [];
    for (let c = this.m.first[this.i] ?? -1; c !== -1; c = this.m.next[c] ?? -1)
      out.push(new MNode(this.m, c, this, this.name(this.m.field[c] ?? 0)));
    return out;
  }
  set children(_: readonly ALSyntaxNode[]) {}
  get namedChildren(): readonly ALSyntaxNode[] {
    const out: ALSyntaxNode[] = [];
    for (let c = this.m.first[this.i] ?? -1; c !== -1; c = this.m.next[c] ?? -1)
      if (((this.m.flags[c] ?? 0) & 1) !== 0) out.push(new MNode(this.m, c, this, this.name(this.m.namedField[c] ?? 0)));
    return out;
  }
  set namedChildren(_: readonly ALSyntaxNode[]) {}
  childForFieldName(name: string): ALSyntaxNode | null {
    for (let c = this.m.first[this.i] ?? -1; c !== -1; c = this.m.next[c] ?? -1)
      if (this.name(this.m.field[c] ?? 0) === name) return new MNode(this.m, c, this, name);
    return null;
  }
}

export function wrapMaterialized(m: Materialized): ALSyntaxNode {
  return new MNode(m, 0, null, null);
}
```

In the worktree only, rename the exported `parseAL` to `parseALRaw` in `packages/engine/src/ast/parser.ts` and append:

```ts
import { materialize } from "./wasm-materialized";
// RUST-01 capture: parse with WASM, copy, free the WASM tree. Never committed.
export function parseAL(source: string): Tree {
  const tree = parseALRaw(source);
  const m = materialize(tree, source);
  tree.delete();
  return m as unknown as Tree;
}
```

and replace `wrapRoot`'s body in the worktree's `syntax-node.ts` with `return wrapMaterialized(tree as unknown as Materialized);` (importing both names from `./wasm-materialized`). Copy `$S/identity-keys.ts` to `$S/capture-wt/scripts/capture-keys.ts` with every `U:/Git/LethAL` import path rewritten to the worktree's own path.

**Validate the capture** on every corpus the normal WASM pipeline can hold. Each listing must be byte-identical to Step 5's normal-pipeline listing:

```bash
for f in $F; do rm -rf "$S/cap-$f"; (cd "$S/capture-wt" && bun scripts/capture-keys.ts "U:/Git/LethAL/fixtures/$f" "$S/cap-$f") > "$S/ids-cap-$f.txt"; cmp "$S/ids-wasm-$f.txt" "$S/ids-cap-$f.txt" && echo "capture valid on $f"; done
for k in do dc sentinel bcf sysapp; do rm -rf "$S/cap-$k"; (cd "$S/capture-wt" && bun scripts/capture-keys.ts "${C[$k]}" "$S/cap-$k") > "$S/ids-cap-$k.txt"; cmp "$S/ids-wasm-$k.txt" "$S/ids-cap-$k.txt" && echo "capture valid on $k"; done
```

Expected: ten `capture valid` lines. Then the whole corpus:

```bash
rm -rf "$S/cap-baseapp"; (cd "$S/capture-wt" && bun "U:/Git/LethAL/scripts/measure-peak.ts" bun scripts/capture-keys.ts "$BASEAPP" "$S/cap-baseapp") > "$S/ids-wasm-baseapp.txt"
head -1 "$S/ids-wasm-baseapp.txt"; sha256sum "$S/ids-wasm-baseapp.txt"
```

Expected: completes with a `raw <n> deployed <n>` line and a listing. **STOP for the owner** (no substitute) if any validation corpus differs and the difference cannot be fixed IN THE MATERIALIZER (never in product code), or if the pipeline refuses the corpus root for a project-level reason (for example a missing root `app.json`, or duplicate object ids across the apps under BaseApp). Keep the worktree until Task 6 is done, then `git worktree remove "$S/capture-wt"`.

- [ ] **Step 7: Workloads and attribution on WASM, three runs each, median.** W6 needs the Cronus28 coord lease (owner authorization 2026-09-25) and `fixtures/sandbox-data/lethal.config.local.json`; take the lease for W6 only and release it after.

```bash
for r in 1 2 3; do
  bun scripts/measure-peak.ts bun scripts/bench-parse.ts "U:/Git/BC.History/BaseApp"                                     # W1
  bun scripts/measure-peak.ts bun scripts/census-operator-sites.ts "U:/Git/BC.History/BaseApp" "$S/w2-wasm.json"            # W2
  bun scripts/measure-peak.ts bun scripts/census-operator-sites.ts "${C[bsrc]}" "$S/w3a-wasm.json"                          # W3a
  bun scripts/measure-peak.ts bun scripts/census-operator-sites.ts "${C[do]}" "$S/w3b-wasm.json"                            # W3b
  bun scripts/measure-peak.ts bun packages/runner/src/cli.ts run --project "$BAPP" --dry-run                                # W4
  bun scripts/measure-peak.ts bun packages/runner/src/cli.ts run --project fixtures/sandbox-data --dry-run                  # W5
  bun scripts/measure-peak.ts bun packages/runner/src/cli.ts run --project fixtures/sandbox-data --tests fixtures/sandbox-data-tests \
    --backend bcdev --config fixtures/sandbox-data/lethal.config.local.json --only src/DataMain.Table.al \
    --selector-id 79399 --control-id 79398 --table-id 79397 --out "$S/w6-wasm-$r.json"   # W6
done
bun scripts/measure-peak.ts bun test                                                                                        # A
```

Expected: W2 aborts with `RuntimeError: Aborted()` (R292). W4 is not predicted; record its outcome. W6 verdicts equal the chunked gate's control leg (17 / 7 / 2). Attribution (A): record the peak of `bun test`, W3a and W6. The 30 GB observation stays UNATTRIBUTED unless one of these reproduces it; any peak above 8 GB is recorded as a lead and filed in Task 10, not chased here.

- [ ] **Step 8: Write the pre-commitment**, every `<...>` filled from Steps 1, 5, 6 and 7:

```markdown
# RUST-01 pre-commitment: native parser vs WASM

Written and committed at HEAD <hash> (R-236c merged) before any native parse, census, dump or run
was read. Nothing above OUTCOME changes after a run.
Design: docs/superpowers/specs/2026-09-27-rust-native-parser-design.md (r2).
Plan: docs/superpowers/plans/2026-09-27-RUST-01-native-parser.md (r2).

## Parsers
| label | what |
| --- | --- |
| wasm | web-tree-sitter 0.25.10 + vendored tree-sitter-al.wasm 4.4.1, sha256 cd6e347e...d085ed099 |
| native | napi-rs addon, tree-sitter =0.25.10 + tree-sitter-al =4.4.1, grammar inputs = the wasm's |

## Corpora
<fingerprint table, TSAL-441 layout, plus the Base Application project path>

## Baseline (wasm, median of 3; wall s / peak MB)
| id | workload | result |
| --- | --- | --- |
| W1 | bench-parse BaseApp | parseMs <n>, walkMs <n>, nodes <n>, peak <mb> |
| W2 | census BaseApp whole | aborted after <s> s |
| W3a | census BaseApp/Source | <s> / <mb> |
| W3b | census do-rel2/Cloud | <s> / <mb> |
| W4 | run --dry-run Base Application | <s> / <mb> / <outcome> |
| W5 | run --dry-run sandbox-data | <s> / <mb> |
| W6 | real run sandbox-data --only DataMain.Table.al, selector ids 79399/79398/79397 | <s> / <mb> / 17 / 7 / 2 |
| A | bun test | <s> / <mb> |
The 30 GB Bun observation: <reproduced by X | not reproduced; stays unattributed>.

## Ceilings (set here, never raised after a native result)
W2: <mb> (recommended 8192). W4: <mb> (recommended 8192). W6: <110% of the wasm W6 peak> MB.

## Keep rule (D3, owner 2026-09-27; gates the switch-over commit)
Keep native only if W2 completes in one pass with peak <= the W2 ceiling. Otherwise revert and fix
R292 in TypeScript. W4 or W6 over its ceiling: no revert, no product memory win claimed, filed.

## Spike STOP (I4)
Native W1 parseMs (parse + flatten + transfer) <= 50% of <wasm W1 parseMs>, and the addon loads in
dev and inside a --compile binary on Windows. Else STOP; take R292's TypeScript route.

## Q1. Trees (Task 5)
Lockstep structural walk through ALSyntaxNode, every file of every fixture and corpus, BaseApp
included, field lookups on everywhere: 0 differing nodes, equal kind tables, consistent flat links.

## Q2. Sites, hashes, identities (Task 6, native vs these captures)
Census rows 0 moved on every fixture and on do, dc, sentinel, bcf, sysapp, BaseApp/Source,
BaseApp/Test. Hash listings and full identity-key listings (identityOrdinal included) byte-identical
on every fixture, on do, and on the WHOLE BaseApp corpus (9,620 files) against the validated WASM
capture (sha256 <of ids-wasm-baseapp.txt>, validated byte-identical to the normal WASM pipeline on
every fixture, do, dc, sentinel, bcf and sysapp). No waiver.

## Q3. R-236c scanner (Task 6)
errorOffsets element type at the merge: <number | object shape>, consumers <lines>, kept unchanged.
testpage-scan.test.ts passes unchanged. The census over the ten listed corpora, timing removed,
passes r236c-check.ts and is identical to this HEAD's.

## Q4. Whole BaseApp census (Task 6, first measurement, not a gate)
Completes; differences from the union of the halves are listed as R292's Tier-2 blind spot.

## Q5. Unit suite
Same pass / skip / fail counts as this HEAD, plus the tests this plan adds.

## Q6. Reported targets (not gating)
W1 native walkMs; W3a <= 70% of wasm wall and peak <= wasm peak; W5 <= 110% of wasm wall.

## Q7. Landing gates
- itest:bcdev: PASS, 3 / 12 / 4, groupedCalls 15, warmKills 0, screen `vacuous`, per-mutant equal.
- itest:chunked: PASS, both legs 17 / 7 / 2, control warmKills 9 / groupedCalls 33, chunked 5 / 57.
- itest:alrunner: PASS, 3 / 12 / 4 on all four legs, per-mutant equal to one-shot.
- itest:tables: deferred to the combined GH-24 / R-236c check (ruling), unless its baseline was re-recorded before Task 9, in which case PASS with the figures frozen in tables.itest.ts, per-mutant equal.

## Q8. Release (D1)
All five targets build in release CI, each parses fixtures/sandbox-data --dry-run on its own
platform with the same raw and deployed counts as Windows, provenance and notices checks pass, and
no release binary reports DIRTY.

## OUTCOME
(filled in by Task 10)
```

- [ ] **Step 9: Commit alone.**

```bash
bunx biome check scripts/measure-peak.ts scripts/bench-parse.ts
git add scripts/measure-peak.ts scripts/bench-parse.ts docs/superpowers/specs/2026-09-27-rust-01-precommitment.md
git commit -m "spec(RUST-01): pre-commit the WASM baseline, the ceilings and the keep rule"
```

---

### Task 1: Spike (loads on Windows? 2x faster?)

**Files:**
- Create (uncommitted until Task 2): `packages/engine/native/Cargo.toml`, `build.rs`, `src/lib.rs`, `.cargo/config.toml`
- Scratch: `$S/spike-*.ts`

**Interfaces:**
- Produces: `lethal_parser.dll` exporting `parseFlat(source: string)` and `nativeInfo()`; the measured column convention; whether an untaken `require` branch with a missing file breaks `bun build --compile`; GO or STOP.

- [ ] **Step 1: `packages/engine/native/Cargo.toml`.**

```toml
[package]
name = "lethal-parser"
version = "0.1.0"
edition = "2021"
publish = false
license = "MIT"

[lib]
crate-type = ["cdylib", "rlib"]

[dependencies]
napi = { version = "3", default-features = false, features = ["napi4"] }
napi-derive = "3"
tree-sitter = "=0.25.10"
tree-sitter-al = "=4.4.1"
sha2 = "0.10"

[build-dependencies]
napi-build = "2"
sha2 = "0.10"

[profile.release]
lto = true
codegen-units = 1
```

- [ ] **Step 2: `packages/engine/native/.cargo/config.toml`** (deterministic Windows builds, design section 7):

```toml
[target.x86_64-pc-windows-msvc]
rustflags = ["-C", "link-arg=/Brepro"]

[env]
CFLAGS_x86_64_pc_windows_msvc = "/Brepro"
```

- [ ] **Step 3: `packages/engine/native/build.rs`.** It embeds a hash of the crate's own sources, the grammar input hashes that `build-native-parser.ts` checked, the `rustc` version and the target. `\r` is stripped so a CRLF checkout hashes like an LF one.

```rust
use sha2::{Digest, Sha256};
use std::env;
use std::process::Command;

const SOURCES: [&str; 4] = ["Cargo.toml", "Cargo.lock", "build.rs", "src/lib.rs"];

fn main() {
    napi_build::setup();
    let mut h = Sha256::new();
    for f in SOURCES {
        println!("cargo:rerun-if-changed={f}");
        let text = std::fs::read_to_string(f).unwrap_or_else(|e| panic!("cannot read {f}: {e}"));
        h.update(f.as_bytes());
        h.update(b"\n");
        h.update(text.replace('\r', "").as_bytes());
        h.update(b"\n");
    }
    println!("cargo:rustc-env=LETHAL_BINDING_SOURCE_SHA256={:x}", h.finalize());

    println!("cargo:rerun-if-env-changed=LETHAL_GRAMMAR_INPUTS");
    let grammar = env::var("LETHAL_GRAMMAR_INPUTS").unwrap_or_else(|_| {
        panic!("LETHAL_GRAMMAR_INPUTS is not set: build with `bun scripts/build-native-parser.ts`, which checks the grammar sources first")
    });
    println!("cargo:rustc-env=LETHAL_GRAMMAR_INPUTS={grammar}");

    let rustc = env::var("RUSTC").unwrap_or_else(|_| "rustc".to_string());
    let out = Command::new(rustc).arg("-V").output().expect("cannot run rustc -V");
    println!("cargo:rustc-env=LETHAL_RUSTC_VERSION={}", String::from_utf8_lossy(&out.stdout).trim());
    println!("cargo:rustc-env=LETHAL_TARGET={}", env::var("TARGET").expect("cargo sets TARGET"));
}
```

- [ ] **Step 4: `packages/engine/native/src/lib.rs`.**

```rust
//! RUST-01: tree-sitter-al parsed natively, returned to JavaScript as flat arrays.
//! One call per file; the tree is freed before the call returns. Design section 4.
use napi::bindgen_prelude::{Int32Array, Uint16Array, Uint32Array, Uint8Array, Utf16String};
use napi_derive::napi;
use sha2::{Digest, Sha256};
use std::cell::RefCell;
use tree_sitter::{Language, Parser, Tree};

pub const GRAMMAR_VERSION: &str = "4.4.1";
pub const TREE_SITTER_VERSION: &str = "0.25.10";

pub const FLAG_NAMED: u8 = 1;
pub const FLAG_MISSING: u8 = 2;
pub const FLAG_HAS_ERROR: u8 = 4;
pub const FLAG_EXTRA: u8 = 8;

#[derive(Default)]
pub struct Flat {
    pub kind_names: Vec<String>,
    pub kind: Vec<u16>,
    pub field_names: Vec<String>,
    pub field: Vec<u16>,
    pub flags: Vec<u8>,
    pub child_count: Vec<u32>,
    pub next_sibling: Vec<i32>,
    pub start_index: Vec<u32>,
    pub end_index: Vec<u32>,
    pub points: Vec<u32>,
}

/// Maps a tree-sitter id (symbol or field) to an index in a per-file name table. A name is a
/// function of its id (ts_node_type is ts_language_symbol_name of ts_node_symbol), so mapping by
/// id is exact, including aliases, ERROR (id 65535) and MISSING nodes.
struct Interner {
    map: Vec<u16>,
    names: Vec<String>,
}

impl Interner {
    fn new(reserved: Option<&str>) -> Self {
        let names = reserved.map(|r| vec![r.to_string()]).unwrap_or_default();
        Self { map: vec![u16::MAX; 65536], names }
    }
    fn get(&mut self, id: u16, name: &str) -> u16 {
        let slot = &mut self.map[id as usize];
        if *slot == u16::MAX {
            *slot = self.names.len() as u16;
            self.names.push(name.to_string());
        }
        *slot
    }
}

fn language() -> Language {
    tree_sitter_al::LANGUAGE.into()
}

thread_local! {
    static PARSER: RefCell<Parser> = RefCell::new({
        let mut p = Parser::new();
        p.set_language(&language()).expect("tree-sitter-al's ABI is not supported by this tree-sitter runtime");
        p
    });
}

/// Preorder walk with a cursor. A node's first child is at index + 1; siblings link forward.
/// Offsets and columns are halved: the input is UTF-16, so tree-sitter counts 2 bytes per code unit.
pub fn flatten(tree: &Tree) -> Flat {
    let mut f = Flat::default();
    let mut kinds = Interner::new(None);
    let mut fields = Interner::new(Some(""));
    let mut cursor = tree.walk();
    let mut parents: Vec<usize> = Vec::new();
    let mut prev: Vec<Option<usize>> = vec![None];
    loop {
        let node = cursor.node();
        let i = f.kind.len();
        f.kind.push(kinds.get(node.kind_id(), node.kind()));
        f.field.push(match (cursor.field_id(), cursor.field_name()) {
            (Some(id), Some(name)) => fields.get(id.get(), name),
            _ => 0,
        });
        f.flags.push(
            (node.is_named() as u8) * FLAG_NAMED
                | (node.is_missing() as u8) * FLAG_MISSING
                | (node.has_error() as u8) * FLAG_HAS_ERROR
                | (node.is_extra() as u8) * FLAG_EXTRA,
        );
        f.child_count.push(0);
        f.next_sibling.push(-1);
        f.start_index.push((node.start_byte() / 2) as u32);
        f.end_index.push((node.end_byte() / 2) as u32);
        let (s, e) = (node.start_position(), node.end_position());
        f.points.extend_from_slice(&[s.row as u32, (s.column / 2) as u32, e.row as u32, (e.column / 2) as u32]);
        if let Some(&p) = parents.last() {
            f.child_count[p] += 1;
        }
        if let Some(Some(s)) = prev.last().copied() {
            f.next_sibling[s] = i as i32;
        }
        if let Some(last) = prev.last_mut() {
            *last = Some(i);
        }
        if cursor.goto_first_child() {
            parents.push(i);
            prev.push(None);
            continue;
        }
        loop {
            if cursor.goto_next_sibling() {
                break;
            }
            if !cursor.goto_parent() {
                f.kind_names = kinds.names;
                f.field_names = fields.names;
                return f;
            }
            parents.pop();
            prev.pop();
        }
    }
}

pub fn parse_units(units: &[u16]) -> Flat {
    PARSER.with(|p| {
        let tree = p.borrow_mut().parse_utf16_le(units, None).expect("tree-sitter returned no tree");
        flatten(&tree)
    })
}

/// SHA-256 over every symbol name in id order, a marker, then every field name. The WASM side
/// computes the same digest from its Language (scripts/lib/parser-equivalence.ts).
pub fn kind_table_sha256() -> String {
    let lang = language();
    let mut h = Sha256::new();
    for id in 0..lang.node_kind_count() as u16 {
        h.update(lang.node_kind_for_id(id).unwrap_or(""));
        h.update(b"\n");
    }
    h.update(b"--fields--\n");
    for id in 1..=lang.field_count() as u16 {
        h.update(lang.field_name_for_id(id).unwrap_or(""));
        h.update(b"\n");
    }
    format!("{:x}", h.finalize())
}

#[napi(object)]
pub struct FlatTree {
    pub kind_names: Vec<String>,
    pub kind: Uint16Array,
    pub field_names: Vec<String>,
    pub field: Uint16Array,
    pub flags: Uint8Array,
    pub child_count: Uint32Array,
    pub next_sibling: Int32Array,
    pub start_index: Uint32Array,
    pub end_index: Uint32Array,
    pub points: Uint32Array,
}

#[napi(object)]
pub struct NativeInfo {
    pub binding_source_sha256: String,
    pub grammar_inputs: String,
    pub grammar_version: String,
    pub tree_sitter_version: String,
    pub language_abi: u32,
    pub kind_table_sha256: String,
    pub rustc_version: String,
    pub target: String,
}

#[napi]
pub fn parse_flat(source: Utf16String) -> FlatTree {
    let f = parse_units(&source);
    FlatTree {
        kind_names: f.kind_names,
        kind: Uint16Array::new(f.kind),
        field_names: f.field_names,
        field: Uint16Array::new(f.field),
        flags: Uint8Array::new(f.flags),
        child_count: Uint32Array::new(f.child_count),
        next_sibling: Int32Array::new(f.next_sibling),
        start_index: Uint32Array::new(f.start_index),
        end_index: Uint32Array::new(f.end_index),
        points: Uint32Array::new(f.points),
    }
}

#[napi]
pub fn native_info() -> NativeInfo {
    NativeInfo {
        binding_source_sha256: env!("LETHAL_BINDING_SOURCE_SHA256").to_string(),
        grammar_inputs: env!("LETHAL_GRAMMAR_INPUTS").to_string(),
        grammar_version: GRAMMAR_VERSION.to_string(),
        tree_sitter_version: TREE_SITTER_VERSION.to_string(),
        language_abi: language().abi_version() as u32,
        kind_table_sha256: kind_table_sha256(),
        rustc_version: env!("LETHAL_RUSTC_VERSION").to_string(),
        target: env!("LETHAL_TARGET").to_string(),
    }
}
```

- [ ] **Step 5: Build (spike form; Task 2 wraps this in the checked build script).**

```bash
cd /u/Git/LethAL/packages/engine/native && cargo generate-lockfile && \
LETHAL_GRAMMAR_INPUTS="spike-unchecked" cargo build --release
```

Expected: `target/release/lethal_parser.dll`. If an API name differs (`Utf16String`, `parse_utf16_le`, `abi_version`, `field_id`), fix it to the crate's actual name and record each fix. Behaviour must not change.

- [ ] **Step 6: Probe A, dev load.** Copy the DLL to `$S/lethal.node`:

```bash
bun -e 'const b = require(process.argv[1]); console.log(b.nativeInfo()); const t = b.parseFlat("codeunit 50100 X { }"); console.log(t.kindNames[t.kind[0]], t.kind.length, t.startIndex instanceof Uint32Array)' "$S/lethal.node"
```

Expected: an info object, then `source_file <n> true`.

- [ ] **Step 7: Probe B, the column convention.** `$S/spike-units.ts`:

```ts
import { writeFileSync } from "node:fs";
import { initParser, parseAL } from "U:/Git/LethAL/packages/engine/src/ast/parser";
const src = "\uFEFF// Ærø 😀\r\ncodeunit 50100 \"Blåbær\"\r\n{\r\n    procedure Kør()\r\n    var\r\n        T: Text;\r\n    begin\r\n        T := 'æøå 😀';\r\n    end;\r\n}\r\n";
writeFileSync(`${process.argv[2]}/unicode.al`, src);
await initParser();
const native = require(`${process.argv[2]}/lethal.node`);
const flat = native.parseFlat(src);
type N = ReturnType<typeof parseAL>["rootNode"];
const rows: string[] = [];
const walk = (n: N): void => {
  rows.push(`${n.type}\t${n.startIndex}\t${n.endIndex}\t${n.startPosition.row}:${n.startPosition.column}\t${n.endPosition.row}:${n.endPosition.column}`);
  for (const c of n.children) if (c !== null) walk(c);
};
walk(parseAL(src).rootNode);
let bad = 0;
for (let i = 0; i < rows.length; i++) {
  const p = flat.points;
  const mine = `${flat.kindNames[flat.kind[i]]}\t${flat.startIndex[i]}\t${flat.endIndex[i]}\t${p[4 * i]}:${p[4 * i + 1]}\t${p[4 * i + 2]}:${p[4 * i + 3]}`;
  if (mine !== rows[i]) { bad++; console.log(`wasm   ${rows[i]}\nnative ${mine}`); }
}
console.log(`nodes wasm ${rows.length} native ${flat.kind.length} differing ${bad}`);
```

Run: `bun "$S/spike-units.ts" "$S"`. Expected: `differing 0`. If only columns differ by a factor of 2, web-tree-sitter does not halve columns: remove `/ 2` from the two column terms, rebuild, re-run, record the convention. Any other difference is reported before Task 2.

- [ ] **Step 8: Probe C, embedding, both loader shapes exactly as Task 3 writes them.** Copy the DLL to `$S/embed/lethal-parser.win32-x64.node`.

Variant A, `$S/embed/a.ts` (one literal `require` per target; only Windows's file exists):

```ts
const key = `${process.platform}-${process.arch}`;
let b: { parseFlat(s: string): { kindNames: string[]; kind: Uint16Array } } | undefined;
if (key === "win32-x64") b = require("./lethal-parser.win32-x64.node");
else if (key === "linux-x64") b = require("./lethal-parser.linux-x64.node");
else if (key === "linux-arm64") b = require("./lethal-parser.linux-arm64.node");
else if (key === "darwin-x64") b = require("./lethal-parser.darwin-x64.node");
else if (key === "darwin-arm64") b = require("./lethal-parser.darwin-arm64.node");
if (b === undefined) throw new Error("no binding");
const t = b.parseFlat("codeunit 50100 X { }");
console.log("parse ok", t.kindNames[t.kind[0] ?? 0]);
```

Variant B, `$S/embed/b.ts` (the exact Task 3 expression: a build-time key when defined, a runtime key in source mode):

```ts
declare const __LETHAL_NATIVE_KEY__: string;
const key = `${process.platform}-${process.arch}`;
const b: { parseFlat(s: string): { kindNames: string[]; kind: Uint16Array } } =
  typeof __LETHAL_NATIVE_KEY__ !== "undefined"
    ? require(`./lethal-parser.${__LETHAL_NATIVE_KEY__}.node`)
    : require(`./lethal-parser.${key}.node`);
const t = b.parseFlat("codeunit 50100 X { }");
console.log("parse ok", t.kindNames[t.kind[0] ?? 0]);
```

```bash
cd "$S/embed"
bun a.ts; bun b.ts                                                     # source mode: both print "parse ok source_file"
bun build --compile a.ts --outfile "$S/a.exe"; echo "A build exit $?"
bun build --compile b.ts --define '__LETHAL_NATIVE_KEY__="win32-x64"' --outfile "$S/b.exe"; echo "B build exit $?"
mv lethal-parser.win32-x64.node "$S/hidden.node"
(cd "$S" && ./a.exe; ./b.exe)                                          # the file is gone: only an embedded copy can load
mv "$S/hidden.node" lethal-parser.win32-x64.node
```

Record per variant: builds (yes or no) and parses with the file hidden (yes or no). Variant A passing both is the default. Variant B is used only if A fails and B passes both. If neither passes both, STOP (the CLI-process fallback of design section 3 is a new design, not an implementation choice). Source mode must print `parse ok` for the chosen variant; the release matrix proves it on the other four platforms.

- [ ] **Step 9: Probe D, the STOP measurement.** `$S/spike-bench.ts`:

```ts
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { corpusEntries } from "U:/Git/LethAL/scripts/corpus-fingerprint";
const [dir, nodePath] = process.argv.slice(2);
if (dir === undefined || nodePath === undefined) throw new Error("usage: spike-bench.ts <dir> <node>");
const b = require(nodePath);
const files = await corpusEntries(dir);
const sources = await Promise.all(files.map((f) => readFile(join(dir, f), "utf8")));
let ms = 0;
let nodes = 0;
for (const s of sources) {
  const t0 = performance.now();
  const t = b.parseFlat(s);
  ms += performance.now() - t0;
  nodes += t.kind.length;
}
console.log(JSON.stringify({ files: files.length, nodes, parseMs: Math.round(ms) }));
```

Three runs: `bun scripts/measure-peak.ts bun "$S/spike-bench.ts" "U:/Git/BC.History/BaseApp" "$S/lethal.node"`.
Expected: `nodes` equals W1's baseline; median `parseMs` at most 50% of the WASM W1 `parseMs` (pre-committed).

- [ ] **Step 10: Decide.** GO only if A and B passed, C passed for at least one variant (record which), and D met the bar. Otherwise STOP: write `## AMENDMENT 1` to the pre-commitment recording the numbers and the failed probe, commit it alone, delete `packages/engine/native/`, and hand over to R292's TypeScript route (release each tree once used, or the two-pass census).

---

### Task 2: The crate, tested, with a checked build, provenance and notices

**Files:**
- Modify: `packages/engine/native/src/lib.rs` (tests)
- Create: `scripts/check-native-grammar.ts`, `scripts/build-native-parser.ts`, `scripts/native-notices.ts`, `packages/engine/native/THIRD-PARTY-NOTICES.md` (generated, committed)
- Modify: `.gitignore`

**Interfaces:**
- Consumes: Task 1's crate and conventions.
- Produces: `grammarInputs(): string` (exported by `check-native-grammar.ts`, format `parser.c:<sha>;scanner.c:<sha>`); `bun scripts/build-native-parser.ts [--test]` writes `packages/engine/vendor/native/lethal-parser.<key>.node` and `.provenance.json`; `bun scripts/native-notices.ts [--check]`.

- [ ] **Step 1: Write the tests** at the end of `lib.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn units(s: &str) -> Vec<u16> {
        s.encode_utf16().collect()
    }

    #[test]
    fn root_is_source_file_and_links_are_consistent() {
        let f = parse_units(&units("codeunit 50100 X { procedure P() begin end; }"));
        assert_eq!(f.kind_names[f.kind[0] as usize], "source_file");
        let n = f.kind.len();
        assert_eq!(f.child_count.iter().map(|&c| c as usize).sum::<usize>(), n - 1);
        assert_eq!(f.next_sibling[0], -1);
        assert_eq!(f.points.len(), 4 * n);
        assert_eq!(f.field.len(), n);
    }

    #[test]
    fn offsets_are_utf16_code_units() {
        let src = "codeunit 50100 \"Blåbær😀\" { }";
        let f = parse_units(&units(src));
        assert_eq!(f.end_index[0] as usize, src.encode_utf16().count());
    }

    #[test]
    fn field_zero_means_no_field() {
        let f = parse_units(&units("codeunit 50100 X { }"));
        assert_eq!(f.field_names[0], "");
        assert_eq!(f.field[0], 0);
        assert!(f.field.iter().any(|&x| x != 0), "an object declaration has named fields");
    }

    #[test]
    fn has_error_flag_on_broken_input() {
        let f = parse_units(&units("codeunit 50100 X { procedure P() begin if then end; }"));
        assert_ne!(f.flags[0] & FLAG_HAS_ERROR, 0);
    }

    #[test]
    fn empty_source_is_one_root_node() {
        let f = parse_units(&units(""));
        assert_eq!(f.kind.len(), 1);
        assert_eq!(f.child_count[0], 0);
    }

    #[test]
    fn kind_table_digest_is_hex_sha256() {
        let d = kind_table_sha256();
        assert_eq!(d.len(), 64);
        assert!(d.chars().all(|c| c.is_ascii_hexdigit()));
    }
}
```

- [ ] **Step 2: Write `scripts/check-native-grammar.ts`.**

```ts
#!/usr/bin/env bun
/**
 * RUST-01: prove the native parser's grammar sources are the ones the vendored WASM was built from
 * (upstream's tree-sitter-al.wasm.inputs.sha256 at tag v4.4.1). `grammarInputs()` is what
 * build-native-parser.ts passes to build.rs, which embeds it. Run directly, exit 1 on a difference.
 *
 *   bun scripts/check-native-grammar.ts
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const EXPECTED_VERSION = "4.4.1";
const EXPECTED: Readonly<Record<string, string>> = {
  "src/parser.c": "0b687fa1a84c34e46643e4d7a945e5190208e2f15fb346776f13703f15158e22",
  "src/scanner.c": "346052d7b59f1c340ad77ed79d1349b5c2b4449ecda60840a4b8ad63913b990a",
};
export const CRATE = join(import.meta.dir, "..", "packages", "engine", "native");

interface CargoPackage {
  readonly name: string;
  readonly version: string;
  readonly manifest_path: string;
  readonly license: string | null;
}

export function cargoPackages(): readonly CargoPackage[] {
  const meta = Bun.spawnSync(["cargo", "metadata", "--format-version", "1", "--locked"], { cwd: CRATE });
  if (meta.exitCode !== 0) throw new Error(`cargo metadata failed: ${meta.stderr.toString()}`);
  const parsed = JSON.parse(meta.stdout.toString()) as { packages?: CargoPackage[] };
  if (parsed.packages === undefined) throw new Error("cargo metadata returned no packages");
  return parsed.packages;
}

/** Throws unless the resolved grammar sources match upstream's recorded inputs. */
export function grammarInputs(): string {
  const pkg = cargoPackages().find((p) => p.name === "tree-sitter-al");
  if (pkg === undefined) throw new Error("cargo metadata lists no tree-sitter-al package");
  if (pkg.version !== EXPECTED_VERSION) throw new Error(`tree-sitter-al is ${pkg.version}, expected ${EXPECTED_VERSION}`);
  const parts: string[] = [];
  for (const [rel, want] of Object.entries(EXPECTED)) {
    const got = new Bun.CryptoHasher("sha256").update(readFileSync(join(dirname(pkg.manifest_path), rel))).digest("hex");
    if (got !== want) throw new Error(`grammar source ${rel} hashes to ${got}, upstream's wasm inputs say ${want}`);
    parts.push(`${rel.replace("src/", "")}:${got}`);
  }
  return parts.join(";");
}

if (import.meta.main) {
  console.log(grammarInputs());
}
```

- [ ] **Step 3: Run it.** `bun scripts/check-native-grammar.ts`. Expected: `parser.c:0b687f...;scanner.c:346052...`, exit 0. A throw stops the plan: the crates.io package is not the tagged grammar. Record it and ask for a ruling (switch to `git = "https://github.com/SShadowS/tree-sitter-al", rev = "7819df5"`, then re-check).

- [ ] **Step 4: Write `scripts/build-native-parser.ts`.**

```ts
#!/usr/bin/env bun
/**
 * RUST-01: check the grammar sources, build the native parser addon for THIS platform, and write
 * packages/engine/vendor/native/lethal-parser.<key>.node plus its .provenance.json (both
 * gitignored, D2). `--test` runs `cargo test` with the same checked environment instead.
 * Honours CARGO_TARGET_DIR, so worktrees can share one build cache.
 *
 *   bun scripts/build-native-parser.ts [--test]
 */
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CRATE, grammarInputs } from "./check-native-grammar";

const LIB: Readonly<Record<string, string>> = {
  "win32-x64": "lethal_parser.dll",
  "linux-x64": "liblethal_parser.so",
  "linux-arm64": "liblethal_parser.so",
  "darwin-x64": "liblethal_parser.dylib",
  "darwin-arm64": "liblethal_parser.dylib",
};
const key = `${process.platform}-${process.arch}`;
const lib = LIB[key];
if (lib === undefined) throw new Error(`build-native-parser: no LethAL target for ${key}`);
const env = { ...process.env, LETHAL_GRAMMAR_INPUTS: grammarInputs() };
const test = process.argv.includes("--test");
const run = Bun.spawnSync(["cargo", test ? "test" : "build", "--release", "--locked"], {
  cwd: CRATE,
  env,
  stdout: "inherit",
  stderr: "inherit",
});
if (run.exitCode !== 0) throw new Error(`build-native-parser: cargo failed with exit ${run.exitCode}`);
if (test) process.exit(0);

const targetDir = process.env.CARGO_TARGET_DIR ?? join(CRATE, "target");
const outDir = join(import.meta.dir, "..", "packages", "engine", "vendor", "native");
const out = join(outDir, `lethal-parser.${key}.node`);
await mkdir(outDir, { recursive: true });
await copyFile(join(targetDir, "release", lib), out);

const bytes = await readFile(out);
const binding = require(out) as { nativeInfo(): unknown };
const cc = Bun.spawnSync(process.platform === "win32" ? ["cl"] : ["cc", "--version"]);
const commit = Bun.spawnSync(["git", "rev-parse", "HEAD"]).stdout.toString().trim();
const provenance = {
  file: `lethal-parser.${key}.node`,
  sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
  bytes: bytes.length,
  nativeInfo: binding.nativeInfo(),
  cargoLockSha256: new Bun.CryptoHasher("sha256").update(await readFile(join(CRATE, "Cargo.lock"))).digest("hex"),
  cCompiler: `${cc.stderr.toString()}${cc.stdout.toString()}`.split("\n")[0]?.trim() ?? "unknown",
  commit,
};
await writeFile(`${out.slice(0, -".node".length)}.provenance.json`, `${JSON.stringify(provenance, null, 2)}\n`);
console.log(`build-native-parser: wrote ${out} (${provenance.sha256})`);
```

- [ ] **Step 5: Run the Rust tests.** `bun scripts/build-native-parser.ts --test`. Expected: 6 pass. Prove they bite: change `/ 2` to `/ 1` on `end_byte`, confirm `offsets_are_utf16_code_units` fails, restore. If `cargo test` cannot link napi symbols on Windows, move `flatten`, `parse_units`, `kind_table_sha256` and the tests into `src/flat.rs` (`mod flat; pub use flat::*;`), add `src/flat.rs` to `SOURCES` in `build.rs`, and record it.

- [ ] **Step 6: Build, then check reproducibility.** Add to `.gitignore`:

```
packages/engine/native/target/
packages/engine/vendor/native/*.node
packages/engine/vendor/native/*.provenance.json
```

```bash
bun scripts/build-native-parser.ts && cp packages/engine/vendor/native/lethal-parser.win32-x64.provenance.json "$S/prov-1.json"
rm -rf packages/engine/native/target && bun scripts/build-native-parser.ts && cp packages/engine/vendor/native/lethal-parser.win32-x64.provenance.json "$S/prov-2.json"
diff <(grep sha256 "$S/prov-1.json") <(grep sha256 "$S/prov-2.json") && echo "byte-reproducible on this machine"
git status --porcelain
```

Expected: `git status --porcelain` lists no `.node` or provenance file. Record whether the two builds are byte-identical. If not, the stated limit (design section 7) applies: reproducible in behaviour, not bytes; confirm the two `nativeInfo` blocks are equal.

- [ ] **Step 7: Write `scripts/native-notices.test.ts`** (the evaluator must refuse `AND` with an unapproved license and an unapproved `WITH` exception):

```ts
import { describe, expect, it } from "bun:test";
import { spdxAllowed } from "./native-notices";

describe("spdxAllowed", () => {
  const cases: [string, boolean][] = [
    ["MIT", true],
    ["MIT OR Apache-2.0", true],
    ["MIT/Apache-2.0", true],
    ["MIT OR GPL-3.0-only", true],
    ["MIT AND GPL-3.0-only", false],
    ["(MIT OR Apache-2.0) AND Unicode-3.0", true],
    ["(MIT OR GPL-3.0-only) AND GPL-2.0-only", false],
    ["Apache-2.0 WITH LLVM-exception", true],
    ["GPL-2.0-only WITH Classpath-exception-2.0", false],
    ["", false],
  ];
  for (const [expr, want] of cases) it(`${expr || "(empty)"} -> ${want}`, () => expect(spdxAllowed(expr)).toBe(want));
  it("throws on an unbalanced expression", () => expect(() => spdxAllowed("(MIT OR Apache-2.0")).toThrow());
});
```

Run: `bun test scripts/native-notices.test.ts`. Expected: FAIL, module not found.

- [ ] **Step 8: Write `scripts/native-notices.ts`.**

```ts
#!/usr/bin/env bun
/**
 * RUST-01: the license and notice inventory for the native parser addon. Lists every crate cargo
 * resolves, evaluates each FULL SPDX expression (OR needs one allowed side, AND needs both, WITH
 * needs an allowed exception), and writes packages/engine/native/THIRD-PARTY-NOTICES.md.
 * `--check` exits 1 if the committed file differs.
 *
 *   bun scripts/native-notices.ts [--check]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CRATE, cargoPackages } from "./check-native-grammar";

const ALLOWED = ["MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC", "Zlib", "Unicode-3.0", "Unicode-DFS-2016", "0BSD"];
const ALLOWED_EXCEPTIONS = ["LLVM-exception"];
const OUT = join(CRATE, "THIRD-PARTY-NOTICES.md");

export function spdxAllowed(expr: string): boolean {
  const tokens = expr.replaceAll("/", " OR ").replaceAll("(", " ( ").replaceAll(")", " ) ").split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return false;
  let pos = 0;
  const atom = (): boolean => {
    const t = tokens[pos++];
    if (t === undefined) throw new Error(`truncated SPDX expression: ${expr}`);
    if (t === "(") {
      const v = orExpr();
      if (tokens[pos++] !== ")") throw new Error(`unbalanced SPDX expression: ${expr}`);
      return v;
    }
    return ALLOWED.includes(t);
  };
  const withExpr = (): boolean => {
    const v = atom();
    if (tokens[pos] !== "WITH") return v;
    pos++;
    const exception = tokens[pos++];
    return v && exception !== undefined && ALLOWED_EXCEPTIONS.includes(exception);
  };
  const andExpr = (): boolean => {
    let v = withExpr();
    while (tokens[pos] === "AND") {
      pos++;
      const r = withExpr();
      v = v && r;
    }
    return v;
  };
  const orExpr = (): boolean => {
    let v = andExpr();
    while (tokens[pos] === "OR") {
      pos++;
      const r = andExpr();
      v = v || r;
    }
    return v;
  };
  const v = orExpr();
  if (pos !== tokens.length) throw new Error(`unparsed tail in SPDX expression: ${expr}`);
  return v;
}

if (import.meta.main) {
  const rows = cargoPackages()
    .filter((p) => p.name !== "lethal-parser")
    .map((p) => ({ name: p.name, version: p.version, license: p.license ?? "" }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
  const bad = rows.filter((r) => !spdxAllowed(r.license));
  if (bad.length > 0) throw new Error(`licenses outside the allowlist: ${bad.map((r) => `${r.name} ${r.version} (${r.license || "none"})`).join(", ")}`);
  const text = [
    "# Third-party notices: LethAL native parser addon",
    "",
    "Generated by `bun scripts/native-notices.ts` from `cargo metadata`. Do not edit by hand.",
    "The grammar (tree-sitter-al, MIT) and the tree-sitter runtime (MIT) are compiled into the addon.",
    "",
    "| crate | version | license |",
    "| --- | --- | --- |",
    ...rows.map((r) => `| ${r.name} | ${r.version} | ${r.license} |`),
    "",
  ].join("\n");
  if (process.argv.includes("--check")) {
    if (readFileSync(OUT, "utf8").replaceAll("\r", "") !== text) {
      console.error("THIRD-PARTY-NOTICES.md is out of date: run bun scripts/native-notices.ts");
      process.exit(1);
    }
  } else {
    writeFileSync(OUT, text);
  }
}
```

Run `bun test scripts/native-notices.test.ts` (11 pass; red-check: make `andExpr` combine with `||`, confirm the `AND` cases fail, restore), then `bun scripts/native-notices.ts` and `bun scripts/native-notices.ts --check` (exit 0). A refusal lists the crate: stop and ask; never widen the allowlist silently.

- [ ] **Step 9: Commit.**

```bash
bunx biome check scripts/check-native-grammar.ts scripts/build-native-parser.ts scripts/native-notices.ts scripts/native-notices.test.ts
git add .gitignore packages/engine/native/Cargo.toml packages/engine/native/Cargo.lock packages/engine/native/build.rs packages/engine/native/.cargo packages/engine/native/src packages/engine/native/THIRD-PARTY-NOTICES.md scripts/check-native-grammar.ts scripts/build-native-parser.ts scripts/native-notices.ts scripts/native-notices.test.ts
git commit -m "feat(RUST-01): native tree-sitter-al addon with a checked grammar, embedded provenance and a notice inventory"
```

---

### Task 3: WASM to a reference module, `isMissing` / `hasError` on the interface, and the native loader

**Files:**
- Create: `packages/engine/src/ast/parser-wasm.ts`, `packages/engine/src/ast/native-parser.ts`
- Modify: `packages/engine/src/ast/parser.ts`, `packages/engine/src/ast/syntax-node.ts`
- Modify (imports only): the raw-tree grammar instruments the search in Step 1 finds (at least `scripts/lib/grammar-crosscheck.ts`, `scripts/lib/grammar-crosscheck.test.ts`, `scripts/probe-grammar-corpus.ts`, `scripts/probe-grammar-crosscheck.ts`)
- Test: `packages/engine/tests/ast/native-binding.test.ts`

**Interfaces:**
- Produces: `ALSyntaxNode.isMissing: boolean`, `ALSyntaxNode.hasError: boolean`. `parser-wasm.ts`: `initWasmParser()`, `parseALWasm(source): Tree`, `wrapWasmRoot(tree): ALSyntaxNode`, `wasmLanguage(): Language`. `native-parser.ts`: `NativeInfo`, `NativeBinding`, `NativeParserMissingError`, `NativeParserPinError`, `GRAMMAR_PIN`, `loadBindingFor(key)`, `initNativeParser()`, `parseALNative(source): ParsedAL`, `nativeInfo()`. `syntax-node.ts`: `FlatTree`, `ParsedAL`, `FLAG_NAMED`, `FLAG_MISSING`, `FLAG_HAS_ERROR`, `FLAG_EXTRA`. `parser.ts` / `wrapRoot` still WASM.

- [ ] **Step 1: Repo-wide caller search (after the R-236c merge).**

```bash
grep -rnE "parseAL|initParser|wrapRoot|rootNode|hasError|isMissing|\.delete\(\)|web-tree-sitter|ReturnType<typeof parseAL>" --include=*.ts packages scripts | grep -v node_modules | grep -v /dist/ > "$S/callers.txt"; wc -l "$S/callers.txt"
```

Classify every line in the Task 3 report as: ordinary (`wrapRoot(parseAL(...))`, unchanged), grammar instrument (moves to `parser-wasm`), or product raw-tree use (ported in Task 6; `testpage-scan.ts` is expected here). An unclassified line blocks the task.

- [ ] **Step 2: Create `parser-wasm.ts`** by moving today's `parser.ts` body (imports, the long doc comment, `initParser`, `parseAL`) and today's `WrappedNode` from `syntax-node.ts`, renamed `initWasmParser`, `parseALWasm`, `wrapWasmRoot`. Header: "Reference only since RUST-01: the equivalence proof and the grammar cross-check scripts use it; product code must not import it." Add:

```ts
let language: Language | null = null;
// in initWasmParser, after Language.load:  language = alLanguage;
export function wasmLanguage(): Language {
  if (language === null) throw new Error("wasm parser not initialized, call initWasmParser() first");
  return language;
}
```

and to `WrappedNode`:

```ts
  get isMissing(): boolean {
    return this.ts.isMissing;
  }
  get hasError(): boolean {
    return this.ts.hasError;
  }
```

- [ ] **Step 3: Extend the interface and delegate.** In `syntax-node.ts`, add to `ALSyntaxNode`:

```ts
  /** A node the parser inserted for a missing token (web-tree-sitter `isMissing`). RUST-01. */
  readonly isMissing: boolean;
  /** This node or a descendant is ERROR or MISSING (web-tree-sitter `hasError`). RUST-01. */
  readonly hasError: boolean;
```

Delete `WrappedNode`, `wrapRoot` and the `web-tree-sitter` import there; add `export { wrapWasmRoot as wrapRoot } from "./parser-wasm";`. `parser.ts` becomes:

```ts
// The engine's parse entry point. Backed by the WASM reference until the RUST-01 switch-over.
export { initWasmParser as initParser, parseALWasm as parseAL } from "./parser-wasm";
```

- [ ] **Step 4: Point the grammar instruments at the reference.** In each file Step 1 classified as a grammar instrument, import only the names it uses:

```ts
import {
  initWasmParser as initParser,
  parseALWasm as parseAL,
  wrapWasmRoot as wrapRoot,
} from "../packages/engine/src/ast/parser-wasm";
```

(`../../packages/...` from `scripts/lib/`; `grammar-crosscheck.ts` keeps a type-only import.)

- [ ] **Step 5: Nothing moved.** `bun run typecheck && rm -rf packages/*/dist && bun test`. Expected: counts equal Task 0's HEAD. Test fakes cast `as ALSyntaxNode` compile unchanged; if one is a typed object literal, add `isMissing: false, hasError: false` to it.

- [ ] **Step 6: Write the failing test** `packages/engine/tests/ast/native-binding.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  GRAMMAR_PIN,
  NativeParserMissingError,
  initNativeParser,
  loadBindingFor,
  nativeInfo,
  parseALNative,
} from "../../src/ast/native-parser";

const CRATE = join(import.meta.dir, "..", "..", "native");

/** Mirrors build.rs: name, newline, the file with \r removed, newline, for each source. */
function bindingSourceSha256(): string {
  const h = new Bun.CryptoHasher("sha256");
  for (const f of ["Cargo.toml", "Cargo.lock", "build.rs", "src/lib.rs"]) {
    h.update(`${f}\n`);
    h.update(readFileSync(join(CRATE, f), "utf8").replaceAll("\r", ""));
    h.update("\n");
  }
  return h.digest("hex");
}

describe("native parser binding", () => {
  it("was built from the crate sources in this working tree (rebuild: bun scripts/build-native-parser.ts)", () => {
    expect(nativeInfo().bindingSourceSha256).toBe(bindingSourceSha256());
  });

  it("matches the grammar pin, grammar input hashes included", () => {
    const info = nativeInfo();
    expect({
      grammarVersion: info.grammarVersion,
      treeSitterVersion: info.treeSitterVersion,
      languageAbi: info.languageAbi,
      kindTableSha256: info.kindTableSha256,
      grammarInputs: info.grammarInputs,
    }).toEqual(GRAMMAR_PIN);
  });

  it("names the platform and the fix when there is no binary", () => {
    expect(() => loadBindingFor("linux-riscv64")).toThrow(NativeParserMissingError);
    expect(() => loadBindingFor("linux-riscv64")).toThrow(/linux-riscv64.*build-native-parser/s);
  });

  it("parses after init", async () => {
    await initNativeParser();
    const parsed = parseALNative("codeunit 50100 X { }");
    expect(parsed.flat.kindNames[parsed.flat.kind[0] ?? -1]).toBe("source_file");
  });
});
```

If `src/flat.rs` was added in Task 2 Step 5, add it to the list here too.

- [ ] **Step 7: Run it.** Expected: FAIL, `native-parser` does not exist.

- [ ] **Step 8: Add the flat types to `syntax-node.ts`** (after `ALSyntaxNode`):

```ts
/** RUST-01: one file's tree as the native addon returns it. Preorder; first child at index + 1. */
export interface FlatTree {
  readonly kindNames: readonly string[];
  readonly kind: Uint16Array;
  readonly fieldNames: readonly string[];
  readonly field: Uint16Array;
  readonly flags: Uint8Array;
  readonly childCount: Uint32Array;
  readonly nextSibling: Int32Array;
  readonly startIndex: Uint32Array;
  readonly endIndex: Uint32Array;
  readonly points: Uint32Array;
}

export interface ParsedAL {
  readonly source: string;
  readonly flat: FlatTree;
}

export const FLAG_NAMED = 1;
export const FLAG_MISSING = 2;
export const FLAG_HAS_ERROR = 4;
export const FLAG_EXTRA = 8;
```

- [ ] **Step 9: Write `native-parser.ts`.** Fill `kindTableSha256` and `languageAbi` from the Task 2 binary's `nativeInfo()`; Task 5 cross-checks the digest against the WASM language. Variant A (Task 1 Probe C showed an untaken branch with a missing file does not break `--compile`):

```ts
/**
 * RUST-01: loads the native tree-sitter-al addon and checks it against the pinned grammar.
 * No WASM fallback: a missing or mismatched binary throws (design section 7).
 */
import type { FlatTree, ParsedAL } from "./syntax-node";

export interface NativeInfo {
  readonly bindingSourceSha256: string;
  readonly grammarInputs: string;
  readonly grammarVersion: string;
  readonly treeSitterVersion: string;
  readonly languageAbi: number;
  readonly kindTableSha256: string;
  readonly rustcVersion: string;
  readonly target: string;
}

export interface NativeBinding {
  parseFlat(source: string): FlatTree;
  nativeInfo(): NativeInfo;
}

export const GRAMMAR_PIN = {
  grammarVersion: "4.4.1",
  treeSitterVersion: "0.25.10",
  languageAbi: 15, // from Task 2's nativeInfo(); correct it here if the binary reports otherwise
  kindTableSha256: "<64 hex from Task 2's nativeInfo()>",
  grammarInputs:
    "parser.c:0b687fa1a84c34e46643e4d7a945e5190208e2f15fb346776f13703f15158e22;scanner.c:346052d7b59f1c340ad77ed79d1349b5c2b4449ecda60840a4b8ad63913b990a",
} as const;

export class NativeParserMissingError extends Error {
  constructor(
    readonly platformKey: string,
    cause: unknown,
  ) {
    super(
      `LethAL's native AL parser has no binary for ${platformKey}. Expected packages/engine/vendor/native/lethal-parser.${platformKey}.node; build it with \`bun scripts/build-native-parser.ts\` (needs a Rust toolchain), or use a release binary.`,
      cause === undefined ? undefined : { cause },
    );
    this.name = "NativeParserMissingError";
  }
}

export class NativeParserPinError extends Error {
  constructor(field: string, expected: string, actual: string) {
    super(
      `LethAL's native AL parser reports ${field} ${actual}, but the engine is pinned to ${expected}. Rebuild it with \`bun scripts/build-native-parser.ts\`.`,
    );
    this.name = "NativeParserPinError";
  }
}

/** One LITERAL require per target: `bun build --compile` embeds only a path it can read statically. */
export function loadBindingFor(key: string): NativeBinding {
  let loaded: unknown;
  try {
    if (key === "win32-x64") loaded = require("../../vendor/native/lethal-parser.win32-x64.node");
    else if (key === "linux-x64") loaded = require("../../vendor/native/lethal-parser.linux-x64.node");
    else if (key === "linux-arm64") loaded = require("../../vendor/native/lethal-parser.linux-arm64.node");
    else if (key === "darwin-x64") loaded = require("../../vendor/native/lethal-parser.darwin-x64.node");
    else if (key === "darwin-arm64") loaded = require("../../vendor/native/lethal-parser.darwin-arm64.node");
  } catch (cause) {
    throw new NativeParserMissingError(key, cause);
  }
  if (loaded === undefined) throw new NativeParserMissingError(key, undefined);
  return loaded as NativeBinding;
}

let binding: NativeBinding | null = null;

function checkedBinding(): NativeBinding {
  if (binding !== null) return binding;
  const b = loadBindingFor(`${process.platform}-${process.arch}`);
  const info = b.nativeInfo();
  for (const k of ["grammarVersion", "treeSitterVersion", "languageAbi", "kindTableSha256", "grammarInputs"] as const) {
    if (info[k] !== GRAMMAR_PIN[k]) throw new NativeParserPinError(k, String(GRAMMAR_PIN[k]), String(info[k]));
  }
  binding = b;
  return b;
}

export function initNativeParser(): Promise<void> {
  checkedBinding();
  return Promise.resolve();
}

export function nativeInfo(): NativeInfo {
  return checkedBinding().nativeInfo();
}

export function parseALNative(source: string): ParsedAL {
  if (binding === null) throw new Error("native parser not initialized, call initParser() first");
  return { source, flat: binding.parseFlat(source) };
}
```

Variant B (only if Task 1 Probe C recorded that A failed and B passed both checks): replace the `if` chain inside the `try` with the exact expression Probe C proved, which also serves source mode on all five platforms:

```ts
declare const __LETHAL_NATIVE_KEY__: string;
// inside loadBindingFor's try:
loaded =
  typeof __LETHAL_NATIVE_KEY__ !== "undefined"
    ? require(`../../vendor/native/lethal-parser.${__LETHAL_NATIVE_KEY__}.node`)
    : require(`../../vendor/native/lethal-parser.${key}.node`);
```

and `scripts/build-binary.ts` passes `--define=__LETHAL_NATIVE_KEY__=${JSON.stringify(key)}` per target next to its `__LETHAL_BUILD_*__` defines, with `key` mapped from each `BuildTarget` (`bun-windows-x64` to `win32-x64`, `bun-linux-x64` to `linux-x64`, `bun-linux-arm64` to `linux-arm64`, `bun-darwin-x64` to `darwin-x64`, `bun-darwin-arm64` to `darwin-arm64`). The `linux-riscv64` test still throws `NativeParserMissingError` because the runtime-key `require` fails and is caught. No third variant is allowed: Probe C's STOP applies.

- [ ] **Step 10: Run it.** Expected: 4 pass. Red-check the staleness test: add a comment line to `src/lib.rs`, confirm the first test fails, remove it, confirm green.

- [ ] **Step 11: Commit.**

```bash
bun run typecheck && rm -rf packages/*/dist && bun test
bunx biome check packages/engine/src/ast packages/engine/tests/ast/native-binding.test.ts <the instrument files from Step 1>
git add packages/engine/src/ast packages/engine/tests/ast/native-binding.test.ts <the instrument files from Step 1>
git commit -m "refactor(RUST-01): WASM parser becomes a reference module; isMissing and hasError on ALSyntaxNode; native loader with a staleness and grammar pin"
```

---

### Task 4: `FlatNode`

**Files:**
- Modify: `packages/engine/src/ast/syntax-node.ts`
- Test: `packages/engine/tests/ast/flat-node.test.ts`

**Interfaces:**
- Consumes: `FlatTree`, `ParsedAL`, `FLAG_*` (Task 3).
- Produces: `wrapFlatRoot(parsed: ParsedAL): ALSyntaxNode`.

- [ ] **Step 1: Write the failing test.** A hand-built tree for `"ab"`: root `r` (0..2, has-error) with a named child `x` in field `left` (0..1) and a missing anonymous child `+` (1..2).

```ts
import { describe, expect, it } from "bun:test";
import { type FlatTree, wrapFlatRoot } from "../../src/ast/syntax-node";

const flat: FlatTree = {
  kindNames: ["r", "x", "+"],
  kind: Uint16Array.of(0, 1, 2),
  fieldNames: ["", "left"],
  field: Uint16Array.of(0, 1, 0),
  flags: Uint8Array.of(1 | 4, 1, 2),
  childCount: Uint32Array.of(2, 0, 0),
  nextSibling: Int32Array.of(-1, 2, -1),
  startIndex: Uint32Array.of(0, 0, 1),
  endIndex: Uint32Array.of(2, 1, 2),
  points: Uint32Array.of(0, 0, 0, 2, 0, 0, 0, 1, 0, 1, 0, 2),
};
const root = wrapFlatRoot({ source: "ab", flat });

describe("FlatNode", () => {
  it("exposes kind, text, offsets, points and parse health", () => {
    expect(root.rawKind).toBe("r");
    expect(root.text).toBe("ab");
    expect([root.startIndex, root.endIndex]).toEqual([0, 2]);
    expect(root.endPosition).toEqual({ row: 0, column: 2 });
    expect(root.parent).toBeNull();
    expect(root.fieldName).toBeNull();
    expect(root.hasError).toBe(true);
    expect(root.isMissing).toBe(false);
    expect(root.children[1]?.isMissing).toBe(true);
  });

  it("lists all children and only named children, with field names and parent", () => {
    expect(root.children.map((c) => c.rawKind)).toEqual(["x", "+"]);
    expect(root.namedChildren.map((c) => c.rawKind)).toEqual(["x"]);
    const [x] = root.children;
    expect(x?.fieldName).toBe("left");
    expect(x?.parent).toBe(root);
    expect(x?.text).toBe("a");
    expect(x?.children).toEqual([]);
  });

  it("finds a child by field name, or null", () => {
    expect(root.childForFieldName("left")?.text).toBe("a");
    expect(root.childForFieldName("left")?.fieldName).toBe("left");
    expect(root.childForFieldName("right")).toBeNull();
  });

  it("returns fresh wrappers per read, as WrappedNode did", () => {
    expect(root.children[0]).not.toBe(root.children[0]);
  });

  it("throws on a corrupt tree instead of returning undefined", () => {
    const bad = wrapFlatRoot({ source: "ab", flat: { ...flat, kind: Uint16Array.of(9, 1, 2) } });
    expect(() => bad.rawKind).toThrow(/kindNames\[9\]/);
  });
});
```

- [ ] **Step 2: Run it.** Expected: FAIL, `wrapFlatRoot` is not exported.

- [ ] **Step 3: Implement** in `syntax-node.ts`:

```ts
function at<T>(arr: ArrayLike<T>, i: number, what: string): T {
  const v = arr[i];
  if (v === undefined) throw new Error(`flat tree: ${what}[${i}] is out of range`);
  return v;
}

/**
 * RUST-01: an ALSyntaxNode over a native flat tree. Same semantics as the WASM WrappedNode: fresh
 * wrappers on every children read, no caching, so node identity behaves as before.
 */
class FlatNode implements ALSyntaxNode {
  constructor(
    private readonly p: ParsedAL,
    private readonly i: number,
    readonly parent: ALSyntaxNode | null,
    readonly fieldName: string | null,
  ) {}

  get rawKind(): string {
    return at(this.p.flat.kindNames, at(this.p.flat.kind, this.i, "kind"), "kindNames");
  }
  // Unknown raw kinds (anonymous tokens) are surfaced as-is, exactly as WrappedNode did.
  get kind(): ALNodeKind {
    return this.rawKind as ALNodeKind;
  }
  get text(): string {
    return this.p.source.slice(this.startIndex, this.endIndex);
  }
  get startIndex(): number {
    return at(this.p.flat.startIndex, this.i, "startIndex");
  }
  get endIndex(): number {
    return at(this.p.flat.endIndex, this.i, "endIndex");
  }
  get startPosition(): { readonly row: number; readonly column: number } {
    const pt = this.p.flat.points;
    return { row: at(pt, 4 * this.i, "points"), column: at(pt, 4 * this.i + 1, "points") };
  }
  get endPosition(): { readonly row: number; readonly column: number } {
    const pt = this.p.flat.points;
    return { row: at(pt, 4 * this.i + 2, "points"), column: at(pt, 4 * this.i + 3, "points") };
  }
  get isMissing(): boolean {
    return (at(this.p.flat.flags, this.i, "flags") & FLAG_MISSING) !== 0;
  }
  get hasError(): boolean {
    return (at(this.p.flat.flags, this.i, "flags") & FLAG_HAS_ERROR) !== 0;
  }
  get children(): readonly ALSyntaxNode[] {
    return this.childNodes(false);
  }
  // No-op setters, as on WrappedNode: a runtime assignment is ignored rather than throwing.
  set children(_: readonly ALSyntaxNode[]) {
    /* readonly, ignored */
  }
  get namedChildren(): readonly ALSyntaxNode[] {
    return this.childNodes(true);
  }
  set namedChildren(_: readonly ALSyntaxNode[]) {
    /* readonly, ignored */
  }
  childForFieldName(name: string): ALSyntaxNode | null {
    const f = this.p.flat;
    for (let c = this.firstChild(); c !== -1; c = at(f.nextSibling, c, "nextSibling")) {
      if (this.fieldOf(c) === name) return new FlatNode(this.p, c, this, name);
    }
    return null;
  }
  private firstChild(): number {
    return at(this.p.flat.childCount, this.i, "childCount") > 0 ? this.i + 1 : -1;
  }
  private fieldOf(c: number): string | null {
    const id = at(this.p.flat.field, c, "field");
    return id === 0 ? null : at(this.p.flat.fieldNames, id, "fieldNames");
  }
  private childNodes(namedOnly: boolean): ALSyntaxNode[] {
    const f = this.p.flat;
    const out: ALSyntaxNode[] = [];
    for (let c = this.firstChild(); c !== -1; c = at(f.nextSibling, c, "nextSibling")) {
      if (namedOnly && (at(f.flags, c, "flags") & FLAG_NAMED) === 0) continue;
      out.push(new FlatNode(this.p, c, this, this.fieldOf(c)));
    }
    return out;
  }
}

export function wrapFlatRoot(parsed: ParsedAL): ALSyntaxNode {
  return new FlatNode(parsed, 0, null, null);
}
```

- [ ] **Step 4: Run it.** Expected: 5 pass. Red-check: make `childNodes` ignore `namedOnly`, confirm the named-children test fails, restore.

- [ ] **Step 5: Commit.**

```bash
bunx biome check packages/engine/src/ast/syntax-node.ts packages/engine/tests/ast/flat-node.test.ts
git add packages/engine/src/ast/syntax-node.ts packages/engine/tests/ast/flat-node.test.ts
git commit -m "feat(RUST-01): FlatNode, the ALSyntaxNode over a native flat tree"
```

---

### Task 5: Lockstep structural proof on every file (Q1, ruling C1)

**Files:**
- Create: `scripts/lib/parser-equivalence.ts`, `scripts/lib/parser-equivalence.test.ts`, `scripts/probe-parser-equivalence.ts`

**Interfaces:**
- Consumes: `initWasmParser`, `parseALWasm`, `wrapWasmRoot`, `wasmLanguage`, `initNativeParser`, `parseALNative`, `GRAMMAR_PIN` (Task 3); `wrapFlatRoot` (Task 4).
- Produces: `compareStructure(wasm: ALSyntaxNode, native: ALSyntaxNode, limit: number): { nodes: number; diffs: NodeDiff[] }`; `flatLinksConsistent(flat: FlatTree): boolean`; `wasmKindTableSha256(lang: Language): string`; CLI `bun scripts/probe-parser-equivalence.ts <dir>`, exit 1 on any difference.

- [ ] **Step 1: Write the failing test** `scripts/lib/parser-equivalence.test.ts`:

```ts
import { beforeAll, describe, expect, it } from "bun:test";
import { GRAMMAR_PIN, initNativeParser, parseALNative } from "../../packages/engine/src/ast/native-parser";
import { initWasmParser, parseALWasm, wasmLanguage, wrapWasmRoot } from "../../packages/engine/src/ast/parser-wasm";
import { wrapFlatRoot } from "../../packages/engine/src/ast/syntax-node";
import { compareStructure, flatLinksConsistent, wasmKindTableSha256 } from "./parser-equivalence";

const SNIPPETS: Record<string, string> = {
  simple: 'codeunit 50100 "X"\n{\n    procedure P(A: Integer): Integer\n    begin\n        if A > 1 then exit(A + 1);\n        exit(0);\n    end;\n}\n',
  unicode: "\uFEFF// Ærø 😀\r\ncodeunit 50100 \"Blåbær\"\r\n{\r\n    procedure Kør()\r\n    var\r\n        T: Text;\r\n    begin\r\n        T := 'æøå 😀';\r\n    end;\r\n}\r\n",
  crlf: "codeunit 50100 X\r\n{\r\n    trigger OnRun()\r\n    begin\r\n        Message('a');\r\n    end;\r\n}\r\n",
  broken: "codeunit 50100 X { procedure P() begin if then end; }",
  empty: "",
};

describe("native vs wasm, lockstep through ALSyntaxNode", () => {
  beforeAll(async () => {
    await initWasmParser();
    await initNativeParser();
  });

  for (const [name, src] of Object.entries(SNIPPETS)) {
    it(`is identical on the ${name} snippet`, () => {
      const tree = parseALWasm(src);
      const parsed = parseALNative(src);
      const r = compareStructure(wrapWasmRoot(tree), wrapFlatRoot(parsed), 20);
      tree.delete();
      expect(r.diffs).toEqual([]);
      expect(r.nodes).toBeGreaterThan(0);
      expect(flatLinksConsistent(parsed.flat)).toBe(true);
    });
  }

  it("the WASM language's kind and field tables hash to the native pin", () => {
    expect(wasmKindTableSha256(wasmLanguage())).toBe(GRAMMAR_PIN.kindTableSha256);
  });

  it("reports a structural difference when one exists", () => {
    const tree = parseALWasm(SNIPPETS.simple ?? "");
    const r = compareStructure(wrapWasmRoot(tree), wrapFlatRoot(parseALNative(SNIPPETS.crlf ?? "")), 5);
    tree.delete();
    expect(r.diffs.length).toBeGreaterThan(0);
  });

  it("detects a sibling-link cycle and a child count that disagrees with the links", () => {
    const parsed = parseALNative(SNIPPETS.simple ?? "");
    const cyc = Int32Array.from(parsed.flat.nextSibling);
    cyc[1] = 1;
    expect(flatLinksConsistent({ ...parsed.flat, nextSibling: cyc })).toBe(false);
    const dup = Uint32Array.from(parsed.flat.childCount);
    dup[1] = (dup[1] ?? 0) + 1;
    expect(flatLinksConsistent({ ...parsed.flat, childCount: dup })).toBe(false);
  });

  it("compares text, not only offsets", () => {
    const src = SNIPPETS.simple ?? "";
    const tree = parseALWasm(src);
    const parsed = parseALNative(src);
    const r = compareStructure(wrapWasmRoot(tree), wrapFlatRoot({ ...parsed, source: src.replace("exit(0)", "exit(9)") }), 5);
    tree.delete();
    expect(r.diffs.some((d) => d.what === "text")).toBe(true);
  });

  it("detects a broken sibling link even when every row matches", () => {
    const parsed = parseALNative(SNIPPETS.simple ?? "");
    const bent = { ...parsed, flat: { ...parsed.flat, nextSibling: parsed.flat.nextSibling.map(() => -1) } };
    const tree = parseALWasm(SNIPPETS.simple ?? "");
    const r = compareStructure(wrapWasmRoot(tree), wrapFlatRoot(bent), 5);
    tree.delete();
    expect(r.diffs.length).toBeGreaterThan(0);
    expect(flatLinksConsistent(bent.flat)).toBe(false);
  });
});
```

- [ ] **Step 2: Run it.** Expected: FAIL, `./parser-equivalence` does not exist.

- [ ] **Step 3: Write `scripts/lib/parser-equivalence.ts`.**

```ts
/**
 * RUST-01 Q1 (ruling C1): walk the WASM and native trees together through ALSyntaxNode, the view
 * every operator and astSubtreeHash read. At every node: kind, offsets, points, field name,
 * isMissing, hasError; the count, order and boundaries of children; each child's parent is the
 * node walked from; namedChildren with their field names; childForFieldName for every engine
 * query and every field present. Field lookups are always on.
 */
import type { Language } from "web-tree-sitter";
import type { ALSyntaxNode, FlatTree } from "../../packages/engine/src/ast/syntax-node";

/** Every field name product code passes to childForFieldName (grep, 2026-09-27). */
export const ENGINE_FIELD_QUERIES: readonly string[] = [
  "arguments", "base_object", "condition", "else_branch", "enum_type", "function", "left", "member",
  "name", "object", "object_id", "object_name", "operand", "operator", "reference", "return_type",
  "return_value", "right", "then_branch", "type", "value", "value_name",
];

export interface NodeDiff {
  readonly path: string;
  readonly what: string;
  readonly wasm: string;
  readonly native: string;
}

function row(n: ALSyntaxNode): Record<string, string> {
  return {
    kind: n.rawKind,
    start: String(n.startIndex),
    end: String(n.endIndex),
    startPoint: `${n.startPosition.row}:${n.startPosition.column}`,
    endPoint: `${n.endPosition.row}:${n.endPosition.column}`,
    field: n.fieldName ?? "",
    missing: String(n.isMissing),
    hasError: String(n.hasError),
    text: n.text,
  };
}

const span = (n: ALSyntaxNode | null | undefined): string =>
  n === null || n === undefined ? "null" : `${n.rawKind}@${n.startIndex}-${n.endIndex}:${n.fieldName ?? ""}`;

export function compareStructure(
  wasmRoot: ALSyntaxNode,
  nativeRoot: ALSyntaxNode,
  limit: number,
): { nodes: number; diffs: NodeDiff[] } {
  const diffs: NodeDiff[] = [];
  const add = (path: string, what: string, wasm: string, native: string): void => {
    if (diffs.length < limit) diffs.push({ path, what, wasm, native });
  };
  let nodes = 0;
  const walk = (w: ALSyntaxNode, n: ALSyntaxNode, path: string): void => {
    nodes++;
    const rw = row(w);
    const rn = row(n);
    for (const k of Object.keys(rw)) if (rw[k] !== rn[k]) add(path, k, rw[k] ?? "", rn[k] ?? "");

    const wn = w.namedChildren;
    const nn = n.namedChildren;
    const wNamed = wn.map(span).join(",");
    const nNamed = nn.map(span).join(",");
    if (wNamed !== nNamed) add(path, "namedChildren", wNamed, nNamed);

    const wk = w.children;
    const nk = n.children;
    if (wk.length !== nk.length) add(path, "childCount", String(wk.length), String(nk.length));

    const names = new Set(ENGINE_FIELD_QUERIES);
    for (const c of wk) if (c.fieldName !== null) names.add(c.fieldName);
    for (const c of nk) if (c.fieldName !== null) names.add(c.fieldName);
    for (const name of names) {
      const a = span(w.childForFieldName(name));
      const b = span(n.childForFieldName(name));
      if (a !== b) add(path, `childForFieldName(${name})`, a, b);
    }

    const count = Math.min(wk.length, nk.length);
    for (let c = 0; c < count; c++) {
      const wc = wk[c];
      const nc = nk[c];
      if (wc === undefined || nc === undefined) continue;
      if (wc.parent !== w) add(`${path}/${c}`, "wasm parent", "self", span(wc.parent));
      if (nc.parent !== n) add(`${path}/${c}`, "native parent", "self", span(nc.parent));
      walk(wc, nc, `${path}/${c}`);
    }
  };
  walk(wasmRoot, nativeRoot, "");
  return { nodes, diffs };
}

/**
 * Raw link check (r2 ruling I3): traverse the flat links from the root, marking every index. An
 * out-of-range link, a duplicate visit (two parents, or a cycle) or a child count that disagrees
 * with the links fails; every index must be reached exactly once.
 */
export function flatLinksConsistent(f: FlatTree): boolean {
  const n = f.kind.length;
  if (n === 0) return false;
  const seen = new Uint8Array(n);
  seen[0] = 1;
  let reached = 1;
  const stack: number[] = [0];
  for (let i = stack.pop(); i !== undefined; i = stack.pop()) {
    const count = f.childCount[i] ?? 0;
    let k = 0;
    let c = count > 0 ? i + 1 : -1;
    while (c !== -1) {
      if (c < 0 || c >= n || seen[c] === 1) return false;
      seen[c] = 1;
      reached++;
      k++;
      stack.push(c);
      c = f.nextSibling[c] ?? -2;
    }
    if (k !== count) return false;
  }
  return reached === n;
}

/** Same bytes as lib.rs kind_table_sha256: symbol names in id order, a marker, field names 1..n. */
export function wasmKindTableSha256(lang: Language): string {
  const h = new Bun.CryptoHasher("sha256");
  for (let id = 0; id < lang.nodeTypeCount; id++) h.update(`${lang.nodeTypeForId(id) ?? ""}\n`);
  h.update("--fields--\n");
  for (let id = 1; id <= lang.fieldCount; id++) h.update(`${lang.fieldNameForId(id) ?? ""}\n`);
  return h.digest("hex");
}
```

- [ ] **Step 4: Run it.** Expected: 10 pass. A snippet diff is a real finding: fix the Rust side (column units, or `node.field_name_for_child(i)` instead of the cursor's field name), rebuild, re-run. Never loosen the comparison.

- [ ] **Step 5: Write `scripts/probe-parser-equivalence.ts`.**

```ts
#!/usr/bin/env bun
/**
 * RUST-01 Q1: every .al file under <dir>, both parsers, lockstep structural comparison with field
 * lookups on, plus flat-link sanity. Exit 1 on any difference.
 *
 *   bun scripts/probe-parser-equivalence.ts <dir>
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { GRAMMAR_PIN, initNativeParser, parseALNative } from "../packages/engine/src/ast/native-parser";
import { initWasmParser, parseALWasm, wasmLanguage, wrapWasmRoot } from "../packages/engine/src/ast/parser-wasm";
import { wrapFlatRoot } from "../packages/engine/src/ast/syntax-node";
import { corpusEntries } from "./corpus-fingerprint";
import { compareStructure, flatLinksConsistent, wasmKindTableSha256 } from "./lib/parser-equivalence";

const [dir] = process.argv.slice(2);
if (dir === undefined) throw new Error("usage: probe-parser-equivalence.ts <dir>");
await initWasmParser();
await initNativeParser();
const tablesEqual = wasmKindTableSha256(wasmLanguage()) === GRAMMAR_PIN.kindTableSha256;
const files = await corpusEntries(dir);
let nodes = 0;
let differingFiles = 0;
const sample: string[] = [];
const t0 = performance.now();
for (const rel of files) {
  const source = await readFile(join(dir, rel), "utf8");
  const tree = parseALWasm(source);
  const parsed = parseALNative(source);
  const r = compareStructure(wrapWasmRoot(tree), wrapFlatRoot(parsed), 5);
  tree.delete();
  nodes += r.nodes;
  const links = flatLinksConsistent(parsed.flat);
  const allVisited = r.nodes === parsed.flat.kind.length;
  if (r.diffs.length > 0 || !links || !allVisited) {
    differingFiles++;
    if (!links && sample.length < 20) sample.push(`${rel}\tflat links inconsistent`);
    if (!allVisited && sample.length < 20) sample.push(`${rel}\twalk visited ${r.nodes} of ${parsed.flat.kind.length} flat nodes`);
    for (const d of r.diffs) if (sample.length < 20) sample.push(`${rel}\t${JSON.stringify(d)}`);
  }
}
const seconds = Math.round((performance.now() - t0) / 1000);
console.log(JSON.stringify({ dir, files: files.length, nodes, differingFiles, tablesEqual, seconds }));
for (const s of sample) console.log(s);
process.exit(differingFiles === 0 && tablesEqual ? 0 : 1);
```

- [ ] **Step 6: Run Q1 on everything, field lookups on everywhere.** BaseApp is expected to take long (about 22 field lookups per node on each side); run it in the foreground and record the time.

```bash
for f in $F grammar-probe; do bun scripts/probe-parser-equivalence.ts "fixtures/$f"; done
mkdir -p "$S/controls" && cp scripts/lib/al-kind-mapping-*.al "$S/controls/" && bun scripts/probe-parser-equivalence.ts "$S/controls"
for k in do dc sentinel bcf sysapp; do bun scripts/probe-parser-equivalence.ts "${C[$k]}"; done
bun scripts/probe-parser-equivalence.ts "U:/Git/BC.History/BaseApp"
```

Expected: every line `differingFiles 0`, `tablesEqual true`, exit 0. Any difference fails Q1: STOP before the switch-over, write an `## AMENDMENT` with every differing row explained, commit it alone, fix, and re-run the whole step.

- [ ] **Step 7: Commit.**

```bash
bunx biome check scripts/lib/parser-equivalence.ts scripts/lib/parser-equivalence.test.ts scripts/probe-parser-equivalence.ts
git add scripts/lib/parser-equivalence.ts scripts/lib/parser-equivalence.test.ts scripts/probe-parser-equivalence.ts
git commit -m "test(RUST-01): lockstep structural equivalence of native and WASM trees; Q1 holds on every file"
```

---

### Task 6: Switch-over in the working tree, the R-236c port, Q2 to Q5 (NOT committed until Task 7)

**Files:**
- Modify: `packages/engine/src/ast/parser.ts`, `packages/engine/src/ast/syntax-node.ts`, `packages/engine/tests/ast/parser.test.ts`
- Modify: `packages/runner/src/testpage-scan.ts` (parse-health port, `delete()` removal)
- Modify: `packages/engine/src/index.ts` only if typecheck needs `ParsedAL` exported

**Interfaces:**
- Produces: native `initParser`, `parseAL(source): ParsedAL`, `wrapRoot(parsed): ALSyntaxNode`.

- [ ] **Step 1: Rewrite `parser.test.ts`** (it read the raw WASM tree):

```ts
import { beforeAll, describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ALNodeKind } from "../../src/ast/node-kinds";
import { initParser, parseAL } from "../../src/ast/parser";
import { findAll, wrapRoot } from "../../src/ast/syntax-node";

const fixture = resolve(__dirname, "../fixtures/al/simple-codeunit.al");

describe("parser", () => {
  beforeAll(async () => {
    await initParser();
  });

  it("parses a simple codeunit without errors", async () => {
    const root = wrapRoot(parseAL(await readFile(fixture, "utf8")));
    expect(root.hasError).toBe(false);
    expect(root.rawKind).toBe("source_file");
  });

  it("surfaces a procedure named DoubleIt in the AST", async () => {
    const root = wrapRoot(parseAL(await readFile(fixture, "utf8")));
    const [proc] = findAll(root, ALNodeKind.procedure);
    expect(proc?.text).toContain("DoubleIt");
  });

  it("is safe to initParser twice (concurrent and sequential)", async () => {
    await Promise.all([initParser(), initParser()]);
    await initParser();
    expect(wrapRoot(parseAL('codeunit 50999 "X" { }')).rawKind).toBe("source_file");
  });
});
```

- [ ] **Step 2: Switch.** `parser.ts`:

```ts
// The engine's parse entry point: native since RUST-01. parser-wasm.ts is a reference instrument only.
export { initNativeParser as initParser, parseALNative as parseAL } from "./native-parser";
```

In `syntax-node.ts`, replace `export { wrapWasmRoot as wrapRoot } from "./parser-wasm";` with (below `wrapFlatRoot`):

```ts
export const wrapRoot = wrapFlatRoot;
```

- [ ] **Step 3: Port the R-236c scanner's parse-health decisions (r1 ruling I2, r2 ruling I1).** Precondition, from Task 0 Step 1's record: the element type of `errorOffsets`' result and its consumers. The port keeps that type EXACTLY, so no consumer changes. Delete `type TsNode = ReturnType<typeof parseAL>["rootNode"];` and replace `errorOffsets` with the same decisions read through `ALSyntaxNode`. If the recorded type is `number` (the R-236c plan's `readonly number[]`, consumed by `buildUnit`, `within` and the suspect-offset loop):

```ts
/** ERROR and MISSING offsets, same rule as before RUST-01: nothing when the root has no error,
 *  otherwise the startIndex of every ERROR node and every MISSING node, walking ALL children. */
function errorOffsets(root: ALSyntaxNode): number[] {
  if (!root.hasError) return [];
  const out: number[] = [];
  const walk = (n: ALSyntaxNode): void => {
    if (n.rawKind === "ERROR" || n.isMissing) out.push(n.startIndex);
    for (const c of n.children) walk(c);
  };
  walk(root);
  return out;
}
```

If the recorded type is an object (branch commit `c9750b5` has `ErrorSite` = `{ startIndex, text }`), keep the merged `ErrorSite` declaration where it is and push `{ startIndex: n.startIndex, text: n.text }` instead, returning `ErrorSite[]`. Any other shape: port every consumer together with a test per consumer, and list them.

At the call site, take `const root = wrapRoot(parsed)` first and pass `errorOffsets(root)`; change the `tree: ReturnType<typeof parseAL>` parameter to `parsed: ParsedAL`; remove every `tree.delete()`. Nothing else in the scanner changes.

- [ ] **Step 4: Typecheck and the full suite.** `bun run typecheck && rm -rf packages/*/dist && bun test`
Expected: clean; counts equal Task 0's HEAD plus the tests Tasks 2 to 5 added (Q5); `testpage-scan.test.ts` passes UNCHANGED (Q3). Any caller typecheck names that Task 3 Step 1 did not classify blocks the task: classify it, fix it, record it.

- [ ] **Step 5: Q3, the R-236c census re-run, same explicit corpus list, timing removed.**

```bash
R236C_CORPORA=(fixtures/sandbox-data-tests fixtures/sandbox-tests fixtures/sandbox-hang-tests fixtures/sandbox-harden-tests "${C[do]}" "${C[dc]}" "${C[sentinel]}" "${C[bcf]}" "${C[sysapp]}" "$BASEAPP")
bun scripts/r236c-testpage-census.ts "${R236C_CORPORA[@]}" | bun -e 'for (const l of (await Bun.stdin.text()).split("\n").filter(Boolean)) { const o = JSON.parse(l); delete o.ms; console.log(JSON.stringify(o)); }' > "$S/r236c-census-native.txt"
bun "$S/r236c-check.ts" "$S/r236c-census-native.txt" && diff "$S/r236c-census-wasm.txt" "$S/r236c-census-native.txt" && echo "r236c census identical"
```

Expected: the check passes (ten corpora, measured counts, non-empty) and `r236c census identical`.

- [ ] **Step 6: Q2, sites, hashes, identity keys.**

```bash
for f in $F; do
  bun scripts/census-operator-sites.ts "fixtures/$f/src" "$S/census-native-$f.json"
  bun scripts/probe-fixture-hashes.ts "fixtures/$f/src" > "$S/hashes-native-$f.txt"
  rm -rf "$S/target-native-$f"; bun "$S/identity-keys.ts" "fixtures/$f" "$S/target-native-$f" > "$S/ids-native-$f.txt"
  bun scripts/probe-census-diff.ts "$S/census-wasm-$f.json" "$S/census-native-$f.json"
  cmp "$S/hashes-wasm-$f.txt" "$S/hashes-native-$f.txt" && cmp "$S/ids-wasm-$f.txt" "$S/ids-native-$f.txt" && echo "$f identical"
done
for k in do dc sentinel bcf sysapp bsrc btest; do bun scripts/census-operator-sites.ts "${C[$k]}" "$S/census-native-$k.json"; bun scripts/probe-census-diff.ts "$S/census-wasm-$k.json" "$S/census-native-$k.json"; done
rm -rf "$S/target-native-do"; bun "$S/identity-keys.ts" "${C[do]}" "$S/target-native-do" > "$S/ids-native-do.txt"; cmp "$S/ids-wasm-do.txt" "$S/ids-native-do.txt" && echo "do identical"
rm -rf "$S/target-native-baseapp"; bun "$S/identity-keys.ts" "$BASEAPP" "$S/target-native-baseapp" > "$S/ids-native-baseapp.txt"; cmp "$S/ids-wasm-baseapp.txt" "$S/ids-native-baseapp.txt" && echo "whole BaseApp identical"
```

Expected: 0 / 0 on every census diff; every `identical` line printed, `whole BaseApp identical` included (against Task 0 Step 6's validated capture). Anything else fails Q2: STOP, amend, and revert the working tree to the last commit with `git stash` (keep the stash for the report).

- [ ] **Step 7: Q4, whole BaseApp census, first measurement.** `bun scripts/census-operator-sites.ts "U:/Git/BC.History/BaseApp" "$S/census-native-baseapp.json"`. Compare with the union of `census-native-bsrc.json` and `census-native-btest.json` (paths re-prefixed `Source/` and `Test/`) using `$S/rows-diff.ts`; list every difference with operator and file. Recorded, not gated.

- [ ] **Step 8: Do NOT commit.** The switch-over is committed in Task 7 only if the keep rule holds.

---

### Task 7: Apply the keep rule (D3), then commit or revert

**Files:**
- Modify: `docs/superpowers/specs/2026-09-27-rust-01-precommitment.md` (an `## AMENDMENT` only if the rule fails)

- [ ] **Step 1: Run the workloads natively on Task 6's working tree**, three times each, median, with Task 0 Step 7's exact commands (W6 under a Cronus28 lease).

- [ ] **Step 2: Apply D3 exactly as pre-committed.** W2 completed in one pass AND its median peak is at or under the W2 ceiling: KEEP. Anything else: REVERT. No other number changes this decision; W4 and W6 over their ceilings are recorded for Task 10 and filed, not reasons to revert or to keep.

- [ ] **Step 3a: KEEP.** Commit the switch-over:

```bash
bunx biome check packages/engine/src/ast/parser.ts packages/engine/src/ast/syntax-node.ts packages/engine/tests/ast/parser.test.ts packages/runner/src/testpage-scan.ts
git add packages/engine/src/ast/parser.ts packages/engine/src/ast/syntax-node.ts packages/engine/tests/ast/parser.test.ts packages/runner/src/testpage-scan.ts
git commit -m "feat(RUST-01): the engine parses AL natively; keep rule met; sites, hashes and identity keys byte-identical"
```

- [ ] **Step 3b: REVERT.** `git stash push -m "RUST-01 switch-over, reverted by D3"` (non-destructive; the stash is evidence). Write `## AMENDMENT` recording W2's result against the ceiling and the revert, commit it alone, and hand over to R292's TypeScript route. The committed native crate and loader stay unused until the owner rules on removing them; the plan ends here.

---

### Task 8: CI, release matrix (D1, D2) and the Windows binary

**Files:**
- Modify: `.github/workflows/ci.yml`, `.github/workflows/release.yml`, `docs/releasing.md`
- Modify: `scripts/build-binary.ts` only for Task 3 variant B (`__LETHAL_NATIVE_KEY__`)

- [ ] **Step 1: `ci.yml`, before `Typecheck`:**

```yaml
      - uses: actions/cache@v4
        with:
          path: |
            ~/.cargo/registry
            packages/engine/native/target
          key: native-${{ runner.os }}-${{ hashFiles('packages/engine/native/Cargo.lock', 'packages/engine/native/src/**', 'packages/engine/native/build.rs') }}

      - name: Build the native parser (checks grammar sources, writes provenance)
        run: bun scripts/build-native-parser.ts

      - name: Native notice inventory is current
        run: bun scripts/native-notices.ts --check
```

- [ ] **Step 2: Restructure `release.yml` (r2 ruling C2): no release is created and nothing is attached until every compiled binary has passed its own smoke.** Four jobs, in order: `native-parser` (5-target matrix, source mode) then `build` (Windows: typecheck, tests, `build:binaries`, sign, verify; uploads the binaries, publishes NOTHING) then `smoke` (5-target matrix on the compiled binaries) then `publish` (the only job that creates the draft release and attaches files). Read a local `--dry-run` first and set `COUNTS` to the exact regex of its raw and deployed count lines.

```yaml
jobs:
  native-parser:
    strategy:
      fail-fast: true
      matrix:
        include:
          - { os: windows-latest, key: win32-x64 }
          - { os: ubuntu-22.04, key: linux-x64 }
          - { os: ubuntu-22.04-arm, key: linux-arm64 }
          - { os: macos-13, key: darwin-x64 }
          - { os: macos-14, key: darwin-arm64 }
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with: { bun-version: 1.3.14 }
      - run: bun install --frozen-lockfile
      - run: bun scripts/build-native-parser.ts
      - run: bun scripts/native-notices.ts --check
      - name: Source-mode parse smoke on this platform
        shell: bash
        run: bun packages/runner/src/cli.ts run --project fixtures/sandbox-data --dry-run | tee dry-run-src-${{ matrix.key }}.txt
      - uses: actions/upload-artifact@v4
        with:
          name: native-${{ matrix.key }}
          path: |
            packages/engine/vendor/native/lethal-parser.${{ matrix.key }}.node
            packages/engine/vendor/native/lethal-parser.${{ matrix.key }}.provenance.json
            dry-run-src-${{ matrix.key }}.txt

  build:
    needs: native-parser
    # (existing header comments, runs-on: windows-latest, permissions, environment: release: kept)
    steps:
      # (existing checkout, setup-bun, install and tag check: kept)
      # The unit tests now need the native parser, so the download runs BEFORE typecheck and tests.
      - uses: actions/download-artifact@v4
        with: { pattern: native-*, path: native-artifacts, merge-multiple: true }
      - shell: bash
        run: |
          mkdir -p packages/engine/vendor/native
          cp native-artifacts/*.node native-artifacts/*.provenance.json packages/engine/vendor/native/
          for k in win32-x64 linux-x64 linux-arm64 darwin-x64 darwin-arm64; do
            test -f "packages/engine/vendor/native/lethal-parser.$k.node" || { echo "missing $k"; exit 1; }
          done
          rm -rf native-artifacts
          test -z "$(git status --porcelain)" || { git status --porcelain; echo "dirty tree: binaries would be stamped DIRTY"; exit 1; }
      # (existing typecheck, dist clean, unit tests, build:binaries, Azure login, sign, verify, host --version smoke: kept)
      - uses: actions/upload-artifact@v4
        with:
          name: binaries
          path: |
            build/lethal-*
            packages/engine/vendor/native/*.provenance.json
            packages/engine/native/THIRD-PARTY-NOTICES.md
      # The "Release notes from the changelog" and "Publish the release" steps are REMOVED here.

  smoke:
    needs: build
    strategy:
      fail-fast: true
      matrix:
        include:
          - { os: windows-latest, key: win32-x64, suffix: windows-x64.exe }
          - { os: ubuntu-22.04, key: linux-x64, suffix: linux-x64 }
          - { os: ubuntu-22.04-arm, key: linux-arm64, suffix: linux-arm64 }
          - { os: macos-13, key: darwin-x64, suffix: darwin-x64 }
          - { os: macos-14, key: darwin-arm64, suffix: darwin-arm64 }
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/download-artifact@v4
        with: { name: binaries, path: dl }
      - uses: actions/download-artifact@v4
        with: { name: native-win32-x64, path: ref }
      - name: The downloadable binary parses AL on its own platform
        shell: bash
        run: |
          COUNTS='<exact count-line regex from a local --dry-run>'
          exe="$(ls dl/build/lethal-*-${{ matrix.suffix }})"
          chmod +x "$exe"
          "$exe" --version | tee version.txt
          if grep -q DIRTY version.txt; then echo "binary is stamped DIRTY"; exit 1; fi
          "$exe" run --project fixtures/sandbox-data --dry-run > dry-run-bin.txt
          test -n "$(grep -E "$COUNTS" dry-run-bin.txt)" || { echo "no count lines: nothing was parsed"; exit 1; }
          diff <(grep -E "$COUNTS" ref/dry-run-src-win32-x64.txt) <(grep -E "$COUNTS" dry-run-bin.txt)

  publish:
    needs: smoke
    runs-on: ubuntu-22.04
    permissions:
      contents: write
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with: { bun-version: 1.3.14 }
      - uses: actions/download-artifact@v4
        with: { name: binaries, path: dl }
      # (the existing "Release notes from the changelog" step, moved here unchanged)
      - name: Publish the release
        uses: softprops/action-gh-release@v2
        with:
          draft: true
          generate_release_notes: true
          files: |
            dl/build/lethal-*
            dl/packages/engine/vendor/native/*.provenance.json
            dl/packages/engine/native/THIRD-PARTY-NOTICES.md
          body_path: release-notes.md
```

`publish` is the ONLY place `action-gh-release` appears: `grep -n "action-gh-release" .github/workflows/release.yml` gives one hit, inside `publish`. The release-notes step reads `vars.AZURE_SIGNING_ACCOUNT` exactly as before.

- [ ] **Step 3: Prove the Windows binary locally.**

```bash
bun run build:binary
mkdir -p "$S/bin" && cp build/lethal-*-windows-x64.exe "$S/bin/lethal.exe"
mv packages/engine/vendor/native/lethal-parser.win32-x64.node "$S/hidden.node"
(cd "$S/bin" && ./lethal.exe run --project "U:/Git/LethAL/fixtures/sandbox-data" --dry-run > "$S/dry-exe.txt"); echo "exe exit $?"
mv "$S/hidden.node" packages/engine/vendor/native/lethal-parser.win32-x64.node
bun packages/runner/src/cli.ts run --project fixtures/sandbox-data --dry-run > "$S/dry-src.txt"
diff "$S/dry-exe.txt" "$S/dry-src.txt" && echo "dry-run identical"
```

Expected: the exe parses with the vendor `.node` hidden, and `dry-run identical` (or equal count lines if timings print). Restore the `.node` even if the run fails. Record the new size. Under variant A, this local build needs all five `.node` files only if Probe C showed the bundler requires them; if so, `build:binary` locally is Windows-only through variant B, and this is recorded.

- [ ] **Step 4: `docs/releasing.md`:** the native parser is built per target in CI and embedded by a literal `require`; no release may ship without the `native-parser` matrix passing (D1); the new Windows size; `.provenance.json` and `THIRD-PARTY-NOTICES.md` are attached; the reproducibility result from Task 2 Step 6; building from source now needs Rust (`bun scripts/build-native-parser.ts`).

- [ ] **Step 5: Commit, then run CI on a branch push, and exercise `release.yml` on a pre-release tag in a fork or with `publish` temporarily disabled** (never a real release from this step). Record each target's `native-parser` and `smoke` result. Any failing target blocks every release carrying the native parser (D1).

```bash
git add .github/workflows/ci.yml .github/workflows/release.yml docs/releasing.md
git commit -m "ci(RUST-01): build the native parser in CI; five-target release matrix with parse smoke, provenance and notices"
```

---

### Task 9: Frozen live gates (Q7), no figure moving

- [ ] **Step 1: Offline.** `bun run typecheck && rm -rf packages/*/dist && bun test` green. No `.al` changed.

- [ ] **Step 2: al-runner, local.** `LETHAL_ITEST_ALRUNNER=1 LETHAL_ALRUNNER_PATH="C:/Users/SShadowS/.dotnet/tools/al-runner.exe" bun run itest:alrunner`. Record the build line first. Expected: PASS, 3 / 12 / 4 on all four legs.

- [ ] **Step 3: Cronus28 coord lease.** Record the control app version; this plan does not republish it.

- [ ] **Step 4: Container gates, foreground, one at a time.**

```bash
LETHAL_ITEST_BCDEV=1 bun run itest:bcdev
LETHAL_ITEST_CHUNKED=1 bun run itest:chunked
```

Expected: bcdev PASS 3 / 12 / 4, `groupedCalls` 15, `warmKills` 0, screen `vacuous`; chunked PASS both legs 17 / 7 / 2, control 9 / 33, chunked 5 / 57.

- [ ] **Step 5: `itest:tables` (ruling):** deferred to the combined GH-24 / R-236c check and recorded as owed there, UNLESS its baseline was re-recorded before this task, in which case `LETHAL_ITEST_TABLES=1 bun run itest:tables` must PASS with the figures frozen in `tables.itest.ts`, per-mutant equal.

- [ ] **Step 6: Release the lease.** Any failure is a BLOCK: explain before any re-run; never edit a baseline.

---

### Task 10: OUTCOME, vendoring notes, roadmap

**Files:**
- Modify: `docs/superpowers/specs/2026-09-27-rust-01-precommitment.md` (`## OUTCOME`)
- Modify: `packages/engine/vendor/README.md` (new "Native parser" section)
- Modify: `docs/roadmap/R292.md`; new roadmap items as needed; `ROADMAP.md` regenerated

- [ ] **Step 1: OUTCOME.** One line per Q1 to Q8 (MATCHED or MISSED, with numbers), the spike result, the D3 decision with W2's peak against its ceiling, W4 and W6 against theirs, and the Q6 reported targets with WASM and native side by side.

- [ ] **Step 2: Vendor README section** `## Native parser (RUST-01, <date>)`: crate path and pins; that no binary is committed (D2) and how to build one; the grammar source check; the provenance record and notice inventory; the reproducibility result; the bump procedure (bump the crate pin, `bun scripts/check-native-grammar.ts` with the new tag's inputs, `bun scripts/build-native-parser.ts`, update `GRAMMAR_PIN`, `probe-parser-equivalence.ts` on every fixture and corpus, then the TSAL-441 method); that the WASM is now the reference, not the product.

- [ ] **Step 3: Roadmap.** R292: `done (<switch-over commit>)`, with the whole-BaseApp census completing in one pass under its ceiling and Q4's differences listed. Re-check `ls docs/roadmap/` for the next free id immediately before filing: W4 or W6 over ceiling, any peak above 8 GB from Task 0's attribution, and the 30 GB observation if still unattributed. Then `bun scripts/roadmap-index.ts && bun test scripts/roadmap-index.test.ts`.

- [ ] **Step 4: Commit the OUTCOME alone first, then the rest.**

```bash
git add docs/superpowers/specs/2026-09-27-rust-01-precommitment.md && git commit -m "spec(RUST-01): OUTCOME"
git add packages/engine/vendor/README.md docs/roadmap ROADMAP.md && git commit -m "docs(RUST-01): native parser vendoring, provenance and bump procedure; R292 closed"
```

---

## Rulings on the former open questions (orchestrator, 2026-09-27)

1. The WASM reference stays until one grammar bump has been done natively; then the owner decides.
2. Linux addons build on `ubuntu-22.04` (Task 8 matrix).
3. Local worktrees share `CARGO_TARGET_DIR=C:/Users/SShadowS/.cache/lethal-native-target` (Global Constraints).
4. `itest:tables` is deferred to the combined GH-24 / R-236c check unless its baseline was re-recorded first (Task 9 Step 5).
5. A WASM identity-key listing of whole BaseApp is mandatory, through the validated capture of Task 0 Step 6; failing to produce or validate it is a STOP for the owner.

No open questions remain.
