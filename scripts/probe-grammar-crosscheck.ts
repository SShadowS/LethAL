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
 * **Phase 1 is validation, not measurement.** Run against `al-kind-mapping-fixture.al`, whose
 * per-kind counts are known by construction: the two parsers must agree exactly. Only once they do
 * is the mapping trustworthy enough to point at a corpus. A disagreement here is a bug in
 * `scripts/lib/al-kind-mapping.ts`, not a finding about the grammar.
 *
 * Usage: bun scripts/probe-grammar-crosscheck.ts <file-or-dir> [alc-bin-dir] [grammar.wasm] [--json <out>]
 * Exit codes (EXIT_CODE in ./lib/grammar-crosscheck): 0 agree, 1 disagree, 2 inconclusive,
 * 3 unruled-mapping. A usage error (no target) prints usage and exits 64. A file-count mismatch or
 * a duplicate context key throws.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
// Reached through the engine package, which owns this dependency; scripts/ has no direct one.
import { Language, Parser } from "../packages/engine/node_modules/web-tree-sitter/tree-sitter.js";
import { initParser, parseAL } from "../packages/engine/src/ast/parser";
import { type ALSyntaxNode, wrapRoot } from "../packages/engine/src/ast/syntax-node";
import { isStatementSlot } from "../packages/engine/src/ast/tree-walks";
import { defaultAlToolPaths } from "../packages/runner/src/publisher";
import { corpusEntries, describeFingerprint, fingerprintCorpus } from "./corpus-fingerprint";
import {
  AUDITED_TREE_SITTER_KINDS,
  COMPILER_TO_TREE_SITTER,
  CONTEXT_PROBES,
  DELIBERATELY_UNMAPPED,
} from "./lib/al-kind-mapping";
import {
  EXIT_CODE,
  type Site,
  type SiteDiff,
  type Span,
  type Split,
  assertUniqueKeys,
  contextKey,
  diffSites,
  parseHealth,
  restrictToComparable,
  siteKey,
  splitArgs,
  verdict,
} from "./lib/grammar-crosscheck";

const { positional, jsonOut } = splitArgs(process.argv.slice(2));
const [target, alcBinRaw, grammarWasm] = positional;
if (target === undefined) {
  console.error(
    "usage: bun scripts/probe-grammar-crosscheck.ts <file-or-dir> [alc-bin-dir] [grammar.wasm] [--json <out>]",
  );
  process.exit(64);
}
// An empty string means "not given", so a control can pass a grammar without a bin dir.
const alcBinArg = alcBinRaw !== undefined && alcBinRaw !== "" ? alcBinRaw : undefined;
// R167: newest installed AL extension that actually has the tools, not a hardcoded version (D1).
const found = alcBinArg === undefined ? await defaultAlToolPaths() : undefined;
const alcBin = alcBinArg ?? (found !== undefined ? dirname(found.alcPath) : undefined);
if (alcBin === undefined)
  throw new Error("no AL Language extension with alc found; pass [alc-bin-dir]");

const isDir = (await stat(target)).isDirectory();
const fp = isDir ? await fingerprintCorpus(target) : null;
if (fp !== null) console.log(describeFingerprint(target, fp)); // FIRST output line (R187)
// D3: the file list comes from the SAME filter the fingerprint used (corpusEntries), so both
// parsers read exactly the files the corpus identity names, not an ad hoc unfiltered walk.
const files = isDir
  ? (await corpusEntries(target)).map((rel) => resolve(join(target, rel)))
  : [resolve(target)];
const listFile = join(mkdtempSync(join(tmpdir(), "gh06-")), "files.txt");
writeFileSync(listFile, files.join("\n"));

interface TreeSitterResult {
  readonly sites: Site[];
  readonly context: Site[];
  readonly explainedByProbe: ReadonlyMap<string, Set<string>>;
  readonly guardedSpans: Map<string, Span[]>;
  readonly unhealthy: Array<{ file: string; errorNodes: number; missingNodes: number }>;
  readonly parsedCount: number;
}

/**
 * Audited sites and context-probe sites as tree-sitter-al sees them, plus each file's parse
 * health and the directive spans that guard both diff directions (D5).
 */
async function treeSitterSites(
  files: readonly string[],
  grammarWasm: string | undefined,
): Promise<TreeSitterResult> {
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
  const sites: Site[] = [];
  const context: Site[] = [];
  const explainedByProbe = new Map<string, Set<string>>(
    CONTEXT_PROBES.map((p) => [p.name, new Set<string>()]),
  );
  const guardedSpans = new Map<string, Span[]>();
  const unhealthy: Array<{ file: string; errorNodes: number; missingNodes: number }> = [];
  let parsedCount = 0;
  for (const file of files) {
    // BOM stripped so BOTH sides index the same string. .NET's `ReadAllText` strips a UTF-8 BOM
    // and reports offsets into the stripped text; without this the tree-sitter offsets are 3
    // higher for every node in such a file, and the positional diff reports every site in it as a
    // disagreement.
    const text = (await readFile(file, "utf8")).replace(/^﻿/, "");
    const tree = parse(text);
    // C1/D2: parse health computed BEFORE tree.delete(), on the raw tree-sitter node (parseHealth
    // wants tree-sitter's own ERROR/isMissing, not the ALSyntaxNode wrapper's narrower view).
    const health = parseHealth(tree.rootNode);
    if (health.errorNodes + health.missingNodes > 0) {
      unhealthy.push({ file, errorNodes: health.errorNodes, missingNodes: health.missingNodes });
    }
    const root = wrapRoot(tree);
    const walk = (n: ALSyntaxNode): void => {
      // A directive's span guards BOTH diff directions (D5): the old code only propagated a
      // "guarded" flag down through tree-sitter's own walk, which could never explain a site that
      // exists on the COMPILER side only. The prefix matters: tree-sitter uses `preproc_conditional`
      // when the directive wraps declarations (`#if` around whole procedures) and
      // `preproc_conditional_statement` when it wraps statements inside one body.
      if (n.rawKind.startsWith("preproc_conditional")) {
        const spans = guardedSpans.get(file) ?? [];
        spans.push([n.startIndex, n.endIndex]);
        guardedSpans.set(file, spans);
      }
      if (AUDITED_TREE_SITTER_KINDS.has(n.rawKind)) {
        sites.push({ file, kind: n.rawKind, start: n.startIndex, end: n.endIndex });
      }
      // Context probes, answered with LethAL's OWN predicate rather than a shape comparison. This
      // is the channel that can see a statement_block-class regression.
      for (const probe of CONTEXT_PROBES) {
        if (n.rawKind !== probe.treeSitterKind) continue;
        if (isStatementSlot(n)) {
          context.push({ file, kind: probe.name, start: n.startIndex, end: n.endIndex });
        }
        // R216: a call/assignment directly inside `asserterror <stmt>` (no braces, so no
        // statement_block) is real statement position but `isStatementSlot` does not see it. Rather
        // than widen the predicate for one container, the harness explains the gap it causes: this
        // exact position is known, named, and excluded from "unexplained" without being counted as
        // agreement.
        if (n.parent?.rawKind === "asserterror_statement") {
          const explained = explainedByProbe.get(probe.name);
          explained?.add(
            contextKey({ file, kind: probe.name, start: n.startIndex, end: n.endIndex }),
          );
        }
      }
      for (const c of n.children) walk(c);
    };
    walk(root);
    parsedCount++;
    // Free the wasm-side tree. web-tree-sitter allocates each tree in the emscripten heap and does
    // NOT reclaim it on GC, so a corpus walk that keeps parsing without deleting exhausts it.
    // Everything retained above is a primitive copied out of the tree, so nothing here outlives the
    // delete.
    (tree as { delete?: () => void }).delete?.();
  }
  return { sites, context, explainedByProbe, guardedSpans, unhealthy, parsedCount };
}

interface CompilerResult {
  readonly sites: Site[];
  readonly context: Site[];
  readonly parserVersion: string;
  readonly fileCount: number;
  readonly parseErrorFiles: string[];
  // Per-occurrence, with the FILE it came from, not pre-aggregated: an unmapped kind that exists
  // only inside a file either parser could not read cleanly must not flip the verdict (comparable
  // files decide it), so the file has to survive until the caller knows which files are comparable.
  readonly unmappedKindSites: Array<{ file: string; kind: string }>;
}

/** Audited sites and context-probe sites as the AL compiler's own parser sees them. */
function compilerSites(alcBin: string, listFile: string): CompilerResult {
  const script = join(import.meta.dir, "lib", "dump-compiler-kinds.ps1");
  const run = spawnSync(
    "pwsh",
    ["-NoProfile", "-File", script, "-AlcBin", alcBin, "-ListFile", listFile],
    { encoding: "utf8", maxBuffer: 512 * 1024 * 1024 },
  );
  if (run.status !== 0) {
    throw new Error(`compiler dump failed (exit ${run.status}): ${run.stderr || run.stdout}`);
  }
  const parsed = JSON.parse(run.stdout) as {
    parserVersion: string;
    fileCount: number;
    parseErrorFiles: string[];
    nodes: Array<{ file: string; kind: string; start: number; end: number; parent: string }>;
  };
  const sites: Site[] = [];
  const context: Site[] = [];
  const unmappedKindSites: Array<{ file: string; kind: string }> = [];
  for (const n of parsed.nodes) {
    const mapped = COMPILER_TO_TREE_SITTER.get(n.kind);
    if (mapped === undefined) {
      // Fail CLOSED on an unmapped kind that LOOKS like one of the families audited here. Silently
      // dropping it is how the mapping's incompleteness would stay invisible, and the mapping is
      // the part of this audit that can lie. The `Expression` suffix is a heuristic and is named as
      // one: it over-reports (the compiler has many expression kinds this audit does not want) and
      // is meant to be read, not gated on. Recorded per-occurrence WITH its file: the caller decides
      // whether it counts (comparable file) or is only a warning (unhealthy file), never here.
      if (n.kind.endsWith("Expression") && !DELIBERATELY_UNMAPPED.has(n.kind)) {
        unmappedKindSites.push({ file: resolve(n.file), kind: n.kind });
      }
    } else {
      sites.push({ file: resolve(n.file), kind: mapped, start: n.start, end: n.end });
    }
    for (const probe of CONTEXT_PROBES) {
      // An absent `compilerParentKind` means the kind alone answers the question; see the field's
      // doc comment for why calls need a parent test and assignments do not.
      const parentMatches =
        probe.compilerParentKind === undefined || n.parent === probe.compilerParentKind;
      if (probe.compilerKinds.includes(n.kind) && parentMatches) {
        context.push({ file: resolve(n.file), kind: probe.name, start: n.start, end: n.end });
      }
    }
  }
  return {
    sites,
    context,
    parserVersion: parsed.parserVersion,
    fileCount: parsed.fileCount,
    parseErrorFiles: parsed.parseErrorFiles,
    unmappedKindSites,
  };
}

const tsResult = await treeSitterSites(files, grammarWasm);
const compiled = compilerSites(alcBin, listFile);

console.log(`grammar: ${grammarWasm ?? "vendored (engine default)"}`);
console.log(`alc bin: ${alcBin}   compiler parser: v${compiled.parserVersion}`);

// D4: fail loudly on any count mismatch, a caller-contract violation, never a default. This is
// what turns a silently-truncated file list into a thrown error instead of a quieter, wrong count.
const treeSitterParsed = tsResult.parsedCount;
const expected = fp?.files ?? 1;
if (files.length !== expected || treeSitterParsed !== expected || compiled.fileCount !== expected) {
  throw new Error(
    `file-count mismatch: fingerprint ${expected}, listed ${files.length}, tree-sitter parsed ${treeSitterParsed}, compiler parsed ${compiled.fileCount}`,
  );
}

// C1/D2: drop every site in a file either parser could not read cleanly, on BOTH sides, before
// diffing anything. Every count printed from here on is over `comparable` only.
const ccErrorFiles = new Set(compiled.parseErrorFiles.map((f) => resolve(f)));
const tsUnhealthyByFile = new Map(tsResult.unhealthy.map((u) => [u.file, u]));
const bad = new Set([...tsUnhealthyByFile.keys(), ...ccErrorFiles]);
const comparable = new Set(files.filter((f) => !bad.has(f)));
const tsKinds = restrictToComparable(tsResult.sites, comparable);
const ccKinds = restrictToComparable(compiled.sites, comparable);

// An unhealthy file never changes the verdict: an unmapped kind that occurs ONLY inside a file
// either parser could not read cleanly is not evidence about the mapping, it is noise from a file
// already excluded. Split by whether the kind also occurs in at least one comparable file.
const unmappedInComparable = new Set(
  compiled.unmappedKindSites.filter((u) => comparable.has(u.file)).map((u) => u.kind),
);
const unmappedAnywhere = new Set(compiled.unmappedKindSites.map((u) => u.kind));
const unmappedKinds = [...unmappedInComparable].sort();
const unmappedUnhealthyOnly = [...unmappedAnywhere]
  .filter((k) => !unmappedInComparable.has(k))
  .sort();

const both = [...tsUnhealthyByFile.keys()].filter((f) => ccErrorFiles.has(f)).length;
console.log(
  `files: listed ${files.length}, comparable ${comparable.size} (tree-sitter unhealthy ${tsUnhealthyByFile.size}, compiler parse errors ${ccErrorFiles.size}, both ${both})`,
);

const byKind = (sites: readonly Site[]): Map<string, number> => {
  const m = new Map<string, number>();
  for (const s of sites) m.set(s.kind, (m.get(s.kind) ?? 0) + 1);
  return m;
};
const tsKindCounts = byKind(tsKinds);
const ccKindCounts = byKind(ccKinds);
const kindCounts: Record<string, { treeSitter: number; compiler: number }> = {};
for (const kind of [...AUDITED_TREE_SITTER_KINDS].sort()) {
  kindCounts[kind] = {
    treeSitter: tsKindCounts.get(kind) ?? 0,
    compiler: ccKindCounts.get(kind) ?? 0,
  };
}

console.log(`\n${"kind".padEnd(28)} ${"tree-sitter".padStart(12)} ${"compiler".padStart(10)}`);
for (const kind of [...AUDITED_TREE_SITTER_KINDS].sort()) {
  const c = kindCounts[kind];
  if (c === undefined) continue;
  console.log(
    `${kind.padEnd(28)} ${String(c.treeSitter).padStart(12)} ${String(c.compiler).padStart(10)}${c.treeSitter === c.compiler ? "" : "   <-- differs"}`,
  );
}

/** Prints one direction's three buckets, then up to 60 of its unexplained keys. */
function printSplit(label: string, split: Split, keyFn: (s: Site) => string): void {
  console.log(
    `   ${label}: guarded ${split.guarded.length}, explained-asserterror ${split.explained.length}, UNEXPLAINED ${split.unexplained.length}`,
  );
  for (const d of split.unexplained.slice(0, 60)) console.log(`      ${keyFn(d.site)}`);
  if (split.unexplained.length > 60) {
    console.log(`      ... and ${split.unexplained.length - 60} more not listed`);
  }
}

// Kinds: guardedSpans only (siteKey, the default). D5: guarded applies in EITHER direction.
const kindsDiff = diffSites(tsKinds, ccKinds, { guardedSpans: tsResult.guardedSpans });
console.log("\nkinds (six audited families, comparable files only):");
printSplit("only compiler", kindsDiff.onlyCompiler, siteKey);
printSplit("only tree-sitter", kindsDiff.onlyTreeSitter, siteKey);

// Context probes: compared by POSITION (contextKey), per probe, restricted to comparable files.
const context: Record<
  string,
  { diff: SiteDiff; totals: { treeSitter: number; compiler: number } }
> = {};
console.log("\ncontext probes (comparable files only):");
for (const probe of CONTEXT_PROBES) {
  const tsProbeSites = tsResult.context.filter((s) => s.kind === probe.name);
  const ccProbeSites = compiled.context.filter((s) => s.kind === probe.name);
  // Guards contextKey's assumption that two statement-position sites of one probe never share a
  // start. Checked before restricting to comparable, so a duplicate is caught regardless of which
  // files happen to be excluded.
  assertUniqueKeys(tsProbeSites, contextKey, "tree-sitter");
  assertUniqueKeys(ccProbeSites, contextKey, "compiler");
  const tsComparable = restrictToComparable(tsProbeSites, comparable);
  const ccComparable = restrictToComparable(ccProbeSites, comparable);
  const explained = tsResult.explainedByProbe.get(probe.name) ?? new Set<string>();
  const diff = diffSites(tsComparable, ccComparable, {
    guardedSpans: tsResult.guardedSpans,
    explained,
    key: contextKey,
  });
  context[probe.name] = {
    diff,
    totals: { treeSitter: tsComparable.length, compiler: ccComparable.length },
  };
  console.log(
    `\n${probe.name}: tree-sitter ${tsComparable.length}, compiler ${ccComparable.length}  (summary only, not evidence of agreement)`,
  );
  printSplit("only compiler", diff.onlyCompiler, contextKey);
  printSplit("only tree-sitter", diff.onlyTreeSitter, contextKey);
}

// Fail CLOSED on a compiler kind nobody mapped, in a COMPARABLE file: a silently dropped kind is
// an invisible hole in the mapping, and the mapping is the part of this audit that can lie. A kind
// seen only inside an already-excluded file is reported below as a warning instead, never here,
// so an unhealthy file cannot flip the verdict.
if (unmappedKinds.length > 0) {
  console.log(
    `\nUNRULED compiler expression kinds (neither mapped nor deliberately unmapped): ${unmappedKinds.length}`,
  );
  for (const k of unmappedKinds.slice(0, 10)) console.log(`   ${k}`);
}

// tree-sitter's own parse health plus the compiler's, on the same footing: a grammar that REJECTS
// valid AL would otherwise look like agreement on the sites it still managed to produce.
const warnings: string[] = [];
for (const file of files) {
  const tsBad = tsUnhealthyByFile.get(file);
  const ccBad = ccErrorFiles.has(file);
  if (tsBad === undefined && !ccBad) continue;
  const reasons: string[] = [];
  if (tsBad !== undefined)
    reasons.push(`tree-sitter ERROR ${tsBad.errorNodes} MISSING ${tsBad.missingNodes}`);
  if (ccBad) reasons.push("compiler parse error");
  warnings.push(`WARNING: ${file} excluded (${reasons.join(" | ")})`);
}
for (const kind of unmappedUnhealthyOnly) {
  warnings.push(
    `WARNING: unmapped compiler kind ${kind} seen only in unhealthy file(s), excluded from the verdict`,
  );
}
if (warnings.length > 0) {
  console.log("");
  for (const w of warnings) console.log(w);
}

// The ONE verdict rule. Nothing else decides the outcome.
const v = verdict({
  comparableFiles: comparable.size,
  diffs: [kindsDiff, ...Object.values(context).map((c) => c.diff)],
  unruledKinds: unmappedKinds.length,
});

const report = {
  corpus: target,
  fingerprint: fp !== null ? { files: fp.files, sha256: fp.sha256 } : null,
  grammar: grammarWasm ?? "vendored (engine default)",
  parserVersion: compiled.parserVersion,
  alcBin,
  files: {
    listed: files.length,
    treeSitterParsed,
    compilerParsed: compiled.fileCount,
    comparable: comparable.size,
  },
  verdict: v,
  exitCode: EXIT_CODE[v],
  warnings,
  kindCounts,
  kinds: kindsDiff,
  context,
  treeSitterUnhealthy: tsResult.unhealthy,
  compilerParseErrorFiles: compiled.parseErrorFiles,
  unmappedKinds,
};

if (jsonOut !== undefined) await Bun.write(jsonOut, JSON.stringify(report, null, 2));

console.log("");
switch (v) {
  case "agree":
    console.log(
      `AGREE on the six audited families and two context probes, over ${comparable.size} comparable file(s).`,
    );
    break;
  case "disagree":
    console.log("DISAGREE, see above.");
    break;
  case "unruled-mapping":
    console.log(
      `UNRULED MAPPING: ${unmappedKinds.length} compiler kind(s) neither mapped nor ruled; the audit is not complete.`,
    );
    break;
  case "inconclusive":
    console.log("INCONCLUSIVE: no file both parsers read cleanly.");
    break;
}
process.exit(EXIT_CODE[v]);
