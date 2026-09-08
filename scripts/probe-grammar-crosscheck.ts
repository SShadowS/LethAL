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
import { initParser, parseAL } from "../packages/engine/src/ast/parser";
import { type ALSyntaxNode, wrapRoot } from "../packages/engine/src/ast/syntax-node";
import { AUDITED_TREE_SITTER_KINDS, COMPILER_TO_TREE_SITTER } from "./lib/al-kind-mapping";

const DEFAULT_ALC_BIN = "C:/Users/SShadowS/.vscode/extensions/ms-dynamics-smb.al-18.0.2668733/bin";

const [target, alcBin = DEFAULT_ALC_BIN] = process.argv.slice(2);
if (target === undefined) {
  console.error("usage: bun scripts/probe-grammar-crosscheck.ts <file-or-dir> [alc-bin-dir]");
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

/** Audited sites as tree-sitter-al sees them. */
async function treeSitterSites(files: readonly string[]): Promise<Site[]> {
  await initParser();
  const out: Site[] = [];
  for (const file of files) {
    const root = wrapRoot(parseAL(await readFile(file, "utf8")));
    const walk = (n: ALSyntaxNode): void => {
      if (AUDITED_TREE_SITTER_KINDS.has(n.rawKind)) {
        out.push({ file, kind: n.rawKind, start: n.startIndex, end: n.endIndex });
      }
      for (const c of n.namedChildren) walk(c);
    };
    walk(root);
  }
  return out;
}

/** Audited sites as the AL compiler's own parser sees them, mapped into tree-sitter's vocabulary. */
function compilerSites(path: string): {
  sites: Site[];
  parserVersion: string;
  parseErrors: number;
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
    nodes: Array<{ file: string; kind: string; start: number; end: number }>;
  };
  const sites: Site[] = [];
  for (const n of parsed.nodes) {
    const mapped = COMPILER_TO_TREE_SITTER.get(n.kind);
    if (mapped === undefined) continue;
    sites.push({ file: resolve(n.file), kind: mapped, start: n.start, end: n.end });
  }
  return { sites, parserVersion: parsed.parserVersion, parseErrors: parsed.parseErrors };
}

const key = (s: Site): string => `${s.file}|${s.kind}|${s.start}`;

const files = await alFiles(target);
if (files.length === 0) {
  throw new Error(`probe-grammar-crosscheck: no .al files under ${target}. Nothing to compare.`);
}

const ts = await treeSitterSites(files);
const { sites: cc, parserVersion, parseErrors } = compilerSites(target);

const tsKeys = new Set(ts.map(key));
const ccKeys = new Set(cc.map(key));
const onlyCompiler = cc.filter((s) => !tsKeys.has(key(s)));
const onlyTreeSitter = ts.filter((s) => !ccKeys.has(key(s)));

const byKind = (sites: readonly Site[]): Map<string, number> => {
  const m = new Map<string, number>();
  for (const s of sites) m.set(s.kind, (m.get(s.kind) ?? 0) + 1);
  return m;
};
const tsCounts = byKind(ts);
const ccCounts = byKind(cc);

console.log(
  `files: ${files.length}   compiler parser: v${parserVersion}   parse errors: ${parseErrors}`,
);
console.log(`\n${"kind".padEnd(28)} ${"tree-sitter".padStart(12)} ${"compiler".padStart(10)}`);
for (const kind of [...AUDITED_TREE_SITTER_KINDS].sort()) {
  const a = tsCounts.get(kind) ?? 0;
  const b = ccCounts.get(kind) ?? 0;
  console.log(
    `${kind.padEnd(28)} ${String(a).padStart(12)} ${String(b).padStart(10)}${a === b ? "" : "   <-- differs"}`,
  );
}

console.log(`\nsites only the COMPILER sees (grammar blind spots): ${onlyCompiler.length}`);
for (const s of onlyCompiler.slice(0, 10)) console.log(`   ${s.kind} at ${s.file}:${s.start}`);
console.log(`sites only TREE-SITTER sees (possible over-claiming): ${onlyTreeSitter.length}`);
for (const s of onlyTreeSitter.slice(0, 10)) console.log(`   ${s.kind} at ${s.file}:${s.start}`);

const agreed = onlyCompiler.length === 0 && onlyTreeSitter.length === 0;
console.log(
  `\n${agreed ? "AGREE: every audited site matched by position." : "DISAGREE, see above."}`,
);
