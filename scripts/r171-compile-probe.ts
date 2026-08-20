#!/usr/bin/env bun
/**
 * R171 spike, compile half: does every mutant `negate-guard` emits actually COMPILE?
 *
 * The operator's doc comment claims it compiles "by construction", because AL requires the condition
 * of an `if` to be Boolean and `not` of a Boolean is Boolean. That is the same SHAPE of argument
 * `swap-multiplicative` made and lost with: its proof was true about the operands and silent about
 * the RESULT type, and only a live run refuted it. So the claim is checked here against real
 * `alc.exe` rather than asserted, one mutant at a time so a failure names its own shape.
 *
 * Mutants come from the operator's own `generate()`, never from a hand-written string: a probe that
 * re-implements the mutation proves something about the probe.
 *
 *   bun scripts/r171-compile-probe.ts <project-dir> <alc-path>
 */
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { negateGuard } from "../packages/builtin-tier1/src/negate-guard";
import { initParser, parseAL } from "../packages/engine/src/ast/parser";
import { type ALSyntaxNode, wrapRoot } from "../packages/engine/src/ast/syntax-node";
import { buildSemanticContext } from "../packages/engine/src/semantic/context";
import type { SourceFile } from "../packages/engine/src/semantic/symbol-table";

const [projectDir, alcPath] = process.argv.slice(2);
if (projectDir === undefined || alcPath === undefined) {
  console.error("usage: bun scripts/r171-compile-probe.ts <project-dir> <alc-path>");
  process.exit(2);
}

function walk(n: ALSyntaxNode, v: (x: ALSyntaxNode) => void): void {
  v(n);
  for (const c of n.namedChildren) walk(c, v);
}

async function compiles(dir: string): Promise<string[]> {
  const proc = Bun.spawn(
    [
      alcPath as string,
      `/project:${dir}`,
      `/packagecachepath:${join(dir, ".alpackages")}`,
      `/out:${join(dir, "probe.app")}`,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out.split("\n").filter((l) => l.includes(": error "));
}

await initParser();

const rels = (await readdir(projectDir, { recursive: true })).filter((f) =>
  f.toLowerCase().endsWith(".al"),
);
const originals = new Map<string, string>();
const files: SourceFile[] = [];
for (const rel of rels) {
  const text = await readFile(join(projectDir, rel), "utf8");
  originals.set(rel, text);
  files.push({ path: rel, root: wrapRoot(parseAL(text)) });
}
const ctx = buildSemanticContext(files);

interface Site {
  rel: string;
  start: number;
  end: number;
  before: string;
  after: string;
  procedure: string;
}
const sites: Site[] = [];
for (const file of files) {
  walk(file.root, (n) => {
    if (!negateGuard.targets(n, ctx)) return;
    for (const spec of negateGuard.generate(n, ctx)) {
      let proc = "(top level)";
      for (let p: ALSyntaxNode | null = n; p !== null; p = p.parent) {
        if (p.rawKind === "procedure" || p.rawKind === "trigger_declaration") {
          proc = p.namedChildren.find((c) => c.rawKind === "identifier")?.text ?? proc;
          break;
        }
      }
      sites.push({
        rel: file.path,
        start: spec.before.startIndex,
        end: spec.before.endIndex,
        before: spec.before.text,
        after: spec.after.text,
        procedure: proc,
      });
    }
  });
}

console.log(`sites claimed: ${sites.length}\n`);
const baseErrors = await compiles(projectDir);
console.log(`baseline: ${baseErrors.length} error(s)${baseErrors.length === 0 ? "  OK" : ""}`);
if (baseErrors.length > 0) {
  for (const e of baseErrors.slice(0, 5)) console.log(`   ${e.trim()}`);
  throw new Error(
    "r171-compile-probe: baseline does not compile — nothing below would mean anything",
  );
}

let failed = 0;
for (const [i, s] of sites.entries()) {
  const original = originals.get(s.rel);
  if (original === undefined) continue;
  const mutated = original.slice(0, s.start) + s.after + original.slice(s.end);
  await writeFile(join(projectDir, s.rel), mutated, "utf8");
  const errs = await compiles(projectDir);
  await writeFile(join(projectDir, s.rel), original, "utf8");
  const tag = errs.length === 0 ? "OK  " : "FAIL";
  if (errs.length > 0) failed++;
  console.log(
    `  ${tag} [${String(i + 1).padStart(2)}/${sites.length}] ${s.procedure.padEnd(22)} ${s.before} -> ${s.after}`,
  );
  for (const e of errs.slice(0, 2)) console.log(`         ${e.trim()}`);
}

console.log(`\n${sites.length - failed} of ${sites.length} mutants compile; ${failed} failed`);
if (sites.length === 0) throw new Error("r171-compile-probe: no sites — refusing to report a pass");
