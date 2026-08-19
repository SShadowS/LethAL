#!/usr/bin/env bun
/**
 * R159 SPIKE, part 2, does the emitted AL actually compile, and is the type guard load-bearing?
 *
 *   bun scripts/r159-aor-spike/compile-proof.ts <project-dir>
 *
 * The census counts sites. It cannot tell you whether the mutants would compile, and a mutant that
 * does not compile is not a weak mutant, it is an `AlcCompileError` that aborts a whole run after
 * the expensive instrument-and-publish step. AL overloads `+` across Text, Date + Duration and
 * DateTime + Duration, so an unguarded AOR is a project-level compile failure waiting for the first
 * string concatenation, and this corpus is 1,006 `+` tokens deep.
 *
 * So two passes, and the second is the one that matters:
 *
 *   POSITIVE  every site the guard CLAIMS is applied one at a time and compiled. Every one must
 *             compile, or the guard is too loose.
 *   NEGATIVE  every site the guard REFUSES as non-numeric is applied anyway and compiled. `alc`
 *             must REJECT it, or the guard is refusing sites that were safe all along and the
 *             claimed-site count is an undercount.
 *
 * Without the negative pass a guard that refused everything would score a perfect positive pass.
 * That is this repository's signature bug in its purest form: empty-vs-empty reading as agreement.
 */
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";
import { initParser, parseAL } from "../../packages/engine/src/ast/parser";
import { type ALSyntaxNode, wrapRoot } from "../../packages/engine/src/ast/syntax-node";
import { buildSemanticContext } from "../../packages/engine/src/semantic/context";
import type { SourceFile } from "../../packages/engine/src/semantic/symbol-table";
import { ADDITIVE_FLIP, type AorGroup, MULTIPLICATIVE_FLIP, decide } from "./aor";

const [projectDir] = process.argv.slice(2);
if (projectDir === undefined) {
  console.error("usage: bun scripts/r159-aor-spike/compile-proof.ts <project-dir>");
  process.exit(2);
}

const GROUPS: readonly AorGroup[] = ["additive", "multiplicative"];

function findAlc(): string | null {
  const extRoot = join(homedir(), ".vscode", "extensions");
  if (!existsSync(extRoot)) return null;
  // R167: the AL extension ships BOTH layouts across versions — `bin/win32/alc.exe` on the
  // multi-platform VSIX (18.0.2498801) and `bin/alc.exe` on the per-platform one (18.0.2668733),
  // which has no `win32` directory at all. Probe both, newest first, and take the one that exists.
  const candidates = readdirSync(extRoot)
    .filter((d) => d.startsWith("ms-dynamics-smb.al-"))
    .flatMap((d) => [
      join(extRoot, d, "bin", "win32", "alc.exe"),
      join(extRoot, d, "bin", "alc.exe"),
    ])
    .filter((p) => existsSync(p));
  candidates.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return candidates[0] ?? null;
}

const alc = findAlc();
if (alc === null) {
  console.error(
    "compile-proof: no alc.exe under ~/.vscode/extensions/ms-dynamics-smb.al-*, SKIPPED, not passed.",
  );
  process.exit(0);
}
const packageCache = join(projectDir, ".alpackages");
if (!existsSync(packageCache)) {
  console.error(
    `compile-proof: ${projectDir} has no .alpackages, SKIPPED, not passed (symbols are gitignored).`,
  );
  process.exit(0);
}

interface Candidate {
  readonly file: string;
  readonly line: number;
  readonly startIndex: number;
  readonly endIndex: number;
  readonly before: string;
  readonly after: string;
  readonly claimed: boolean;
  readonly why: string;
}

await initParser();
const rel = (await readdir(projectDir, { recursive: true })).filter((f) =>
  f.toLowerCase().endsWith(".al"),
);
const sources = new Map<string, string>();
const files: SourceFile[] = [];
for (const r of rel) {
  const text = readFileSync(join(projectDir, r), "utf8");
  sources.set(r, text);
  files.push({ path: r, root: wrapRoot(parseAL(text)) });
}
const ctx = buildSemanticContext(files);

const candidates: Candidate[] = [];
function walk(node: ALSyntaxNode, file: string, inExecutable: boolean): void {
  if (
    inExecutable &&
    (node.rawKind === "additive_expression" || node.rawKind === "multiplicative_expression")
  ) {
    const d = decide(node, ctx, GROUPS);
    const token = d.token;
    if (token !== undefined) {
      const flips = node.rawKind === "additive_expression" ? ADDITIVE_FLIP : MULTIPLICATIVE_FLIP;
      const flipped = flips.get(token);
      // The negative pass has to apply the SAME textual edit the operator would have made, or it
      // proves nothing about the guard. Sites the operator could not edit at all (`div`, `mod`) are
      // not evidence either way and are dropped from both passes.
      if (flipped !== undefined) {
        const idx = node.text.indexOf(token);
        const mutated = `${node.text.slice(0, idx)}${flipped}${node.text.slice(idx + token.length)}`;
        candidates.push({
          file,
          line: node.startPosition.row + 1,
          startIndex: node.startIndex,
          endIndex: node.endIndex,
          before: node.text,
          after: mutated,
          claimed: d.claimed,
          why: d.claimed ? "claimed" : (d.refusal ?? "unknown"),
        });
      }
    }
  }
  const next =
    inExecutable || node.rawKind === "procedure" || node.rawKind === "trigger_declaration";
  for (const c of node.namedChildren) walk(c, file, next);
}
for (const f of files) walk(f.root, f.path, false);

const positives = candidates.filter((c) => c.claimed);
const negatives = candidates.filter((c) => !c.claimed && c.why === "operand-type-not-numeric");

const scratch = mkdtempSync(join(tmpdir(), "lethal-aor-proof-"));
function compileWith(mutant: Candidate): readonly string[] {
  const work = join(scratch, "project");
  rmSync(work, { recursive: true, force: true });
  // `.alpackages` is excluded and the ORIGINAL is passed as the package cache: copying symbol
  // packages per mutant would dominate the run time and change nothing about the result.
  cpSync(projectDir, work, {
    recursive: true,
    filter: (src) => !relative(projectDir, src).startsWith(".alpackages"),
  });
  const original = sources.get(mutant.file);
  if (original === undefined) throw new Error(`compile-proof: no source for ${mutant.file}`);
  const patched = `${original.slice(0, mutant.startIndex)}${mutant.after}${original.slice(mutant.endIndex)}`;
  writeFileSync(join(work, mutant.file), patched, "utf8");
  const out = join(scratch, "out.app");
  const r = spawnSync(
    alc,
    [`/project:${work}`, `/packagecachepath:${packageCache}`, `/out:${out}`],
    {
      encoding: "utf8",
    },
  );
  rmSync(out, { force: true });
  return `${r.stdout ?? ""}${r.stderr ?? ""}`
    .split(/\r?\n/)
    .filter((l) => /: error [A-Z]{2}\d+:/.test(l))
    .map((l) => l.trim());
}

console.log(`compile-proof: ${projectDir}`);
console.log(
  `  ${positives.length} claimed site(s), ${negatives.length} refused-as-non-numeric site(s)\n`,
);

let positiveFailures = 0;
for (const c of positives) {
  const errors = compileWith(c);
  const where = `${c.file}:${c.line}`;
  if (errors.length === 0) {
    console.log(`  OK        ${where.padEnd(52)} ${c.before}  ->  ${c.after}`);
  } else {
    positiveFailures += 1;
    console.log(`  COMPILE-FAIL ${where.padEnd(49)} ${c.before}  ->  ${c.after}`);
    console.log(`              ${errors[0]}`);
  }
}

let negativeEscapes = 0;
console.log("");
for (const c of negatives) {
  const errors = compileWith(c);
  const where = `${c.file}:${c.line}`;
  if (errors.length > 0) {
    console.log(`  REJECTED  ${where.padEnd(52)} ${errors[0]}`);
  } else {
    negativeEscapes += 1;
    console.log(
      `  COMPILED  ${where.padEnd(52)} ${c.before}  ->  ${c.after}   <-- guard refused a SAFE site`,
    );
  }
}

rmSync(scratch, { recursive: true, force: true });

console.log("");
console.log(
  `positive pass: ${positives.length - positiveFailures}/${positives.length} claimed mutants compile`,
);
console.log(
  `negative pass: ${negatives.length - negativeEscapes}/${negatives.length} refused mutants are rejected by alc`,
);
if (negatives.length === 0) {
  // 0/0 is not a pass. This project's signature bug is an empty result reading as agreement, and a
  // project with no non-numeric arithmetic proves nothing about a guard whose whole job is to
  // refuse non-numeric arithmetic.
  console.log(
    "  (VACUOUS: this project has no non-numeric arithmetic, so the guard was not tested here)",
  );
}
if (positives.length === 0 && negatives.length === 0) {
  // Refuse to report a green result from an empty measurement.
  throw new Error(
    "compile-proof: no candidates at all, nothing was proven, and this is not a pass",
  );
}
process.exit(positiveFailures > 0 ? 1 : 0);
