/**
 * Issue #6, phase 1: does tree-sitter-al see the same sites the AL compiler's own parser sees?
 *
 * R159's census counts node kinds that tree-sitter reports, so it cannot count what the grammar does
 * not parse into the kinds it asks about. A blind spot is invisible to the instrument that measures
 * the grammar. This runs BOTH parsers over the same source and diffs them by position.
 *
 * Two directions, and they are not the same kind of problem:
 *
 *   - the compiler sees a site tree-sitter does not  ->  silent UNDER-coverage, a product gap
 *   - tree-sitter sees a site the compiler does not  ->  a possible WRONG VERDICT, a correctness bug
 *
 * The second is rarer and worse: a mutant at a site the compiler does not agree is a site is a
 * mutant whose verdict means something other than what the report says.
 *
 * **Phase 1 is validation, not measurement.** Run against `mapping-fixture.al`, whose per-kind
 * counts are known by construction, the two parsers must agree exactly. Only once they do is the
 * mapping trustworthy enough to point at a corpus. A disagreement here is a bug in
 * `scripts/lib/al-kind-mapping.ts`, not a finding about the grammar.
 *
 * Usage: bun scripts/probe-grammar-crosscheck.ts <file-or-dir> [alc-bin-dir]
 */
import { spawnSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
// Reached through the engine package, which owns this dependency;  has no direct one.
import { Language, Parser } from "../packages/engine/node_modules/web-tree-sitter/tree-sitter.js";
import { initParser, parseAL } from "../packages/engine/src/ast/parser";
import { type ALSyntaxNode, wrapRoot } from "../packages/engine/src/ast/syntax-node";
import { isStatementSlot } from "../packages/engine/src/ast/tree-walks";
import {
  AUDITED_TREE_SITTER_KINDS,
  COMPILER_TO_TREE_SITTER,
  CONTEXT_PROBES,
  DELIBERATELY_UNMAPPED,
} from "./lib/al-kind-mapping";

const DEFAULT_ALC_BIN = "C:/Users/SShadowS/.vscode/extensions/ms-dynamics-smb.al-18.0.2668733/bin";

const [target, alcBin = DEFAULT_ALC_BIN, grammarWasm] = process.argv.slice(2);
if (target === undefined) {
  console.error(
    "usage: bun scripts/probe-grammar-crosscheck.ts <file-or-dir> [alc-bin-dir] [grammar.wasm]",
  );
  process.exit(2);
}

interface Site {
  readonly file: string;
  readonly kind: string;
  readonly start: number;
  readonly end: number;
}

/** Every `.al` file under a path, or the path itself when it is a file. */
async function alFiles(path: string): Promise<string[]> {
  try {
    const entries = await readdir(path, { recursive: true });
    return entries
      .map((e) => e.toString())
      .filter((e) => e.toLowerCase().endsWith(".al"))
      .map((e) => resolve(join(path, e)))
      .sort();
  } catch {
    return [resolve(path)];
  }
}

/**
 * Audited sites as tree-sitter-al sees them, plus the files it could not parse cleanly.
 *
 * The parse-health channel matters as much as the sites. The compiler side already reports its own
 * parse errors; without the same from tree-sitter the two were asymmetric, and a grammar that
 * REJECTED valid AL would have looked like agreement on whatever sites it still managed to emit.
 * The v4.0.0 grammar did exactly that for a variable named `Filter`.
 *
 * LIMIT, stated rather than discovered later: `ALSyntaxNode` exposes `rawKind`, so an `ERROR` node
 * is visible, but it does not expose tree-sitter's `isMissing`, so a MISSING node is not. This
 * channel is therefore partial, and a clean result here is weaker evidence than a dirty one.
 */
async function treeSitterSites(
  files: readonly string[],
): Promise<{ sites: Site[]; unhealthy: string[]; context: Map<string, number> }> {
  // The engine bakes its grammar in through a Bun file import, so an ALTERNATE grammar is loaded
  // into a parser of this harness's own rather than by touching production code. That is what makes
  // a historical known-bad grammar usable as an end-to-end positive control: run the same corpus and
  // the same compiler side against v3.2.1 and against the vendored build, and the difference is the
  // grammar rather than anything here.
  await initParser();
  let alt: Parser | null = null;
  if (grammarWasm !== undefined) {
    const lang = await Language.load(await readFile(grammarWasm));
    alt = new Parser();
    alt.setLanguage(lang);
  }
  const parse = (src: string): ReturnType<typeof parseAL> => {
    if (alt === null) return parseAL(src);
    const tree = alt.parse(src);
    if (tree === null) throw new Error("alternate grammar returned a null tree");
    return tree;
  };
  const out: Site[] = [];
  const guardedKeys = new Set<string>();
  const unhealthy: string[] = [];
  const tsContext = new Map<string, number>();
  for (const file of files) {
    // BOM stripped so BOTH sides index the same string. .NET's `ReadAllText` strips a UTF-8 BOM
    // and reports offsets into the stripped text; without this the tree-sitter offsets are 3
    // higher for every node in such a file, and the positional diff reports every site in it as a
    // disagreement. MEASURED on `U:/Git/BC.History/BusinessFoundation`: 4 of 104 files carry a BOM,
    // and every "over-claimed" site the first run reported was in one of them, landing on `#region`
    // markers and doc comments rather than on code. That is an artifact of this harness, not a
    // grammar finding, and it was recorded as a known limit before it bit.
    const text = (await readFile(file, "utf8")).replace(/^﻿/, "");
    const tree = parse(text);
    const root = wrapRoot(tree);
    let dirty = false;
    const walk = (n: ALSyntaxNode, guarded: boolean): void => {
      if (n.rawKind === "ERROR") dirty = true;
      // Once inside a preprocessor block every descendant is guarded, so the flag travels down
      // rather than being re-derived by walking back up at each site.
      //
      // The PREFIX is load-bearing: tree-sitter uses `preproc_conditional` when the directive wraps
      // declarations (`#if` around whole procedures, which is how Microsoft writes deprecation) and
      // `preproc_conditional_statement` when it wraps statements inside one body. Matching only the
      // statement form classified R214's OWN fixture as unexplained, since that fixture guards two
      // procedures. Caught by red-checking the classifier against the case it exists to recognise.
      const nowGuarded = guarded || n.rawKind.startsWith("preproc_conditional");
      if (AUDITED_TREE_SITTER_KINDS.has(n.rawKind)) {
        out.push({ file, kind: n.rawKind, start: n.startIndex, end: n.endIndex });
        if (nowGuarded) guardedKeys.add(`${file}|${n.rawKind}|${n.startIndex}|${n.endIndex}`);
      }
      // Context probes, answered with LethAL's OWN predicate rather than a shape comparison. This
      // is the channel that can see a statement_block-class regression.
      for (const probe of CONTEXT_PROBES) {
        if (n.rawKind === probe.treeSitterKind && isStatementSlot(n)) {
          tsContext.set(probe.name, (tsContext.get(probe.name) ?? 0) + 1);
        }
      }
      for (const c of n.children) walk(c, nowGuarded);
    };
    walk(root, false);
    if (dirty) unhealthy.push(file);
    // Free the wasm-side tree. web-tree-sitter allocates each tree in the emscripten heap and does
    // NOT reclaim it on GC, so a corpus walk that keeps parsing without deleting exhausts it: this
    // aborted with `RuntimeError: Aborted()` inside `parse` partway through BaseApp's 9,620 files,
    // while 1,718 had been fine. Everything retained above is a primitive copied out of the tree,
    // so nothing here outlives the delete.
    (tree as { delete?: () => void }).delete?.();
  }
  return { sites: out, unhealthy, context: tsContext, guardedKeys };
}

/** Audited sites as the AL compiler's own parser sees them, mapped into tree-sitter's vocabulary. */
function compilerSites(path: string): {
  sites: Site[];
  parserVersion: string;
  parseErrors: number;
  unmappedKinds: string[];
  context: Map<string, number>;
} {
  const script = join(import.meta.dir, "lib", "dump-compiler-kinds.ps1");
  const run = spawnSync(
    "pwsh",
    ["-NoProfile", "-File", script, "-AlcBin", alcBin, "-Path", resolve(path)],
    { encoding: "utf8", maxBuffer: 512 * 1024 * 1024 },
  );
  if (run.status !== 0) {
    throw new Error(`compiler dump failed (exit ${run.status}): ${run.stderr || run.stdout}`);
  }
  const parsed = JSON.parse(run.stdout) as {
    parserVersion: string;
    parseErrors: number;
    nodes: Array<{ file: string; kind: string; start: number; end: number; parent: string }>;
  };
  const ccContext = new Map<string, number>();
  for (const n of parsed.nodes) {
    for (const probe of CONTEXT_PROBES) {
      if (n.kind === probe.compilerKind && n.parent === probe.compilerParentKind) {
        ccContext.set(probe.name, (ccContext.get(probe.name) ?? 0) + 1);
      }
    }
  }
  const sites: Site[] = [];
  const unmapped = new Set<string>();
  for (const n of parsed.nodes) {
    const mapped = COMPILER_TO_TREE_SITTER.get(n.kind);
    if (mapped === undefined) {
      // Fail CLOSED on an unmapped kind that LOOKS like one of the families audited here. Silently
      // dropping it is how the mapping's incompleteness would stay invisible, and the mapping is
      // the part of this audit that can lie. The `Expression` suffix is a heuristic and is named as
      // one: it over-reports (the compiler has many expression kinds this audit does not want) and
      // is meant to be read, not gated on.
      if (n.kind.endsWith("Expression") && !DELIBERATELY_UNMAPPED.has(n.kind)) {
        unmapped.add(n.kind);
      }
      continue;
    }
    sites.push({ file: resolve(n.file), kind: mapped, start: n.start, end: n.end });
  }
  return {
    sites,
    parserVersion: parsed.parserVersion,
    parseErrors: parsed.parseErrors,
    unmappedKinds: [...unmapped].sort(),
    context: ccContext,
  };
}

/**
 * The diff key. Includes `end`, and the diff below counts occurrences rather than using a Set.
 *
 * An earlier version keyed on `file|kind|start` into a `Set`, which destroyed multiplicity. A
 * left-associative chain nests same-kind nodes that share a start offset: `A + B + C` contains
 * `A + B + C` and `A + B`, both `additive_expression`, both starting at `A`. Measured on a fixture,
 * two sites collapsed to one key. So if one parser emitted two and the other one, both directional
 * diffs came out empty and the harness printed AGREE while the count table showed the difference,
 * because the verdict never consulted the counts. That is a comparator that passes for the wrong
 * reason, inside the one instrument built to catch exactly that, and it was found by an
 * adversarial review rather than by the fixtures.
 */
const key = (s: Site): string => `${s.file}|${s.kind}|${s.start}|${s.end}`;

/** Occurrence counts per key, so multiplicity survives the comparison. */
function tally(sites: readonly Site[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const s of sites) m.set(key(s), (m.get(key(s)) ?? 0) + 1);
  return m;
}

const files = await alFiles(target);
if (files.length === 0) {
  throw new Error(`probe-grammar-crosscheck: no .al files under ${target}. Nothing to compare.`);
}

const { sites: ts, unhealthy, context: tsContext, guardedKeys } = await treeSitterSites(files);
const {
  sites: cc,
  parserVersion,
  parseErrors,
  unmappedKinds,
  context: ccContext,
} = compilerSites(target);

const tsTally = tally(ts);
const ccTally = tally(cc);
const allKeys = new Set([...tsTally.keys(), ...ccTally.keys()]);

interface Delta {
  readonly key: string;
  readonly treeSitter: number;
  readonly compiler: number;
}
const deltas: Delta[] = [];
for (const k of allKeys) {
  const a = tsTally.get(k) ?? 0;
  const b = ccTally.get(k) ?? 0;
  if (a !== b) deltas.push({ key: k, treeSitter: a, compiler: b });
}
const onlyTreeSitter = deltas.filter((d) => d.treeSitter > d.compiler);
const onlyCompiler = deltas.filter((d) => d.compiler > d.treeSitter);

const byKind = (sites: readonly Site[]): Map<string, number> => {
  const m = new Map<string, number>();
  for (const s of sites) m.set(s.kind, (m.get(s.kind) ?? 0) + 1);
  return m;
};
const tsCounts = byKind(ts);
const ccCounts = byKind(cc);

console.log(`grammar: ${grammarWasm ?? "vendored (engine default)"}`);
console.log(
  `files: ${files.length}   compiler parser: v${parserVersion}   compiler parse errors: ${parseErrors}   tree-sitter files with ERROR/MISSING: ${unhealthy.length}`,
);

console.log(`
${"kind".padEnd(28)} ${"tree-sitter".padStart(12)} ${"compiler".padStart(10)}`);
let countsDiffer = false;
for (const kind of [...AUDITED_TREE_SITTER_KINDS].sort()) {
  const a = tsCounts.get(kind) ?? 0;
  const b = ccCounts.get(kind) ?? 0;
  if (a !== b) countsDiffer = true;
  console.log(
    `${kind.padEnd(28)} ${String(a).padStart(12)} ${String(b).padStart(10)}${a === b ? "" : "   <-- differs"}`,
  );
}

console.log(`
sites only the COMPILER sees (grammar blind spots): ${onlyCompiler.length}`);
for (const d of onlyCompiler.slice(0, 10))
  console.log(`   ${d.key}  (ts ${d.treeSitter} vs cc ${d.compiler})`);
// Over-claims split by CAUSE. A node inside a `#if` block is explained by R214: tree-sitter parses
// both arms, the compiler parses only the arm its symbols select, so the inactive arm's nodes are
// tree-sitter-only by construction. That is a known, filed LethAL defect rather than a grammar
// finding, and on a real corpus it is the overwhelming majority: reporting it beside genuinely
// unexplained sites buries the signal under noise a reader has to re-triage by hand every run.
// MEASURED on BaseApp before this split existed: 201 over-claims, of which the handful that were
// NOT R214 had to be found by sampling six of them, and the printout truncates at 10.
const guardedOverClaims = onlyTreeSitter.filter((d) => guardedKeys.has(d.key));
const unexplainedOverClaims = onlyTreeSitter.filter((d) => !guardedKeys.has(d.key));
console.log(`sites only TREE-SITTER sees (possible over-claiming): ${onlyTreeSitter.length}`);
console.log(
  `   of which inside a #if block, i.e. R214 rather than a grammar finding: ${guardedOverClaims.length}`,
);
console.log(`   UNEXPLAINED, the ones worth reading: ${unexplainedOverClaims.length}`);
// Unexplained sites are the signal, so they get a far higher cap than the 10 used elsewhere.
for (const d of unexplainedOverClaims.slice(0, 60)) {
  console.log(`   ${d.key}  (ts ${d.treeSitter} vs cc ${d.compiler})`);
}
if (unexplainedOverClaims.length > 60) {
  console.log(`   ... and ${unexplainedOverClaims.length - 60} more not listed`);
}

console.log(`
${"context probe".padEnd(28)} ${"tree-sitter".padStart(12)} ${"compiler".padStart(10)}`);
let contextDiffers = false;
for (const probe of CONTEXT_PROBES) {
  const a = tsContext.get(probe.name) ?? 0;
  const b = ccContext.get(probe.name) ?? 0;
  if (a !== b) contextDiffers = true;
  console.log(
    `${probe.name.padEnd(28)} ${String(a).padStart(12)} ${String(b).padStart(10)}${a === b ? "" : "   <-- differs"}`,
  );
}

// Fail CLOSED on a compiler kind nobody mapped. A silently dropped kind is an invisible hole in the
// mapping, and the mapping is the part of this audit that can lie.
if (unmappedKinds.length > 0) {
  console.log(`
UNRULED compiler expression kinds (neither mapped nor deliberately unmapped): ${unmappedKinds.length}`);
  for (const k of unmappedKinds.slice(0, 10)) console.log(`   ${k}`);
}

// tree-sitter's own parse health. The compiler side already reports its parse errors; without this
// the two sides were asymmetric, and a grammar that REJECTS valid AL would have looked like
// agreement on the sites it did manage to produce.
if (unhealthy.length > 0) {
  console.log(`
tree-sitter ERROR/MISSING nodes in ${unhealthy.length} file(s):`);
  for (const f of unhealthy.slice(0, 10)) console.log(`   ${f}`);
}

const agreed =
  onlyCompiler.length === 0 &&
  onlyTreeSitter.length === 0 &&
  !countsDiffer &&
  !contextDiffers &&
  unmappedKinds.length === 0 &&
  unhealthy.length === 0 &&
  parseErrors === 0;

console.log(`
${agreed ? "AGREE: every audited site matched by position and multiplicity." : "DISAGREE, see above."}`);
if (!agreed) process.exit(1);
