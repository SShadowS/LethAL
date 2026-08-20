#!/usr/bin/env bun
/**
 * R171 spike, emit half: does the INSTRUMENTED artifact compile?
 *
 * `r171-compile-probe.ts` splices the mutant text straight into the source, which proves the
 * replacement is well-typed AL but says nothing about the path a real run takes. LethAL never emits
 * that form: it compiles ONE artifact carrying every mutant behind a runtime guard, and the shape of
 * that guard is chosen from `MutationSpec.parentContext`. A wrong hint produces an artifact that
 * does not compile even though the naive splice did, and no unit test would see it because unit
 * tests compare strings rather than running `alc`.
 *
 * So this runs the real `writeInstrumentedProject` with `negate-guard` in the operator set, next to
 * every shipped Tier-1 and Tier-2 operator so the dedup and containment logic sees a realistic mix,
 * then compiles the result.
 *
 *   bun scripts/r171-emit-probe.ts <project-dir> <alc-path>
 *
 * The project is copied first; the source directory is never written to.
 */
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { tier1Operators } from "../packages/builtin-tier1/src/index";
import { negateGuard } from "../packages/builtin-tier1/src/negate-guard";
import { tier2Operators } from "../packages/builtin-tier2/src/index";
import { initParser, parseAL } from "../packages/engine/src/ast/parser";
import { type ALSyntaxNode, wrapRoot } from "../packages/engine/src/ast/syntax-node";
import { buildSemanticContext } from "../packages/engine/src/semantic/context";
import type { SourceFile } from "../packages/engine/src/semantic/symbol-table";
import type { MutationSpec } from "../packages/operator-sdk/src/index";
import { writeInstrumentedProject } from "../packages/schemata/src/index";

const [projectDir, alcPath] = process.argv.slice(2);
const CONTROL_APP = "U:/git/LethAL/extensions/lethal-control/lethal-control.app";
if (projectDir === undefined || alcPath === undefined) {
  console.error("usage: bun scripts/r171-emit-probe.ts <project-dir> <alc-path>");
  process.exit(2);
}

const operators = [...tier1Operators, negateGuard, ...tier2Operators];
const OPERATOR_TIERS = new Map<string, 1 | 2 | 3 | "custom">(
  operators.map((o) => [o.name, o.tier]),
);

function walk(n: ALSyntaxNode, v: (x: ALSyntaxNode) => void): void {
  v(n);
  for (const c of n.namedChildren) walk(c, v);
}
/** Layer 3 rejects overlapping specs at one site; keep the first claim per span. */
function dedupeByFirstSite(specs: readonly MutationSpec[]): MutationSpec[] {
  const seen = new Set<string>();
  const kept: MutationSpec[] = [];
  for (const s of specs) {
    const key = `${s.before.startIndex}-${s.before.endIndex}`;
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(s);
  }
  return kept;
}

await initParser();

const rels = (await readdir(projectDir, { recursive: true })).filter((f) =>
  f.toLowerCase().endsWith(".al"),
);
const sources = new Map<string, string>();
const files: SourceFile[] = [];
for (const rel of rels) {
  const text = await readFile(join(projectDir, rel), "utf8");
  sources.set(rel, text);
  files.push({ path: rel, root: wrapRoot(parseAL(text)) });
}
const ctx = buildSemanticContext(files);

const instrumented: {
  path: string;
  source: string;
  root: ALSyntaxNode;
  specs: MutationSpec[];
}[] = [];
let guardSpecs = 0;
let totalSpecs = 0;
for (const file of files) {
  const specs: MutationSpec[] = [];
  walk(file.root, (node) => {
    for (const op of operators) {
      try {
        if (op.targets(node, ctx)) specs.push(...op.generate(node, ctx));
      } catch {
        /* R120's business, not this spike's */
      }
    }
  });
  const kept = dedupeByFirstSite(specs);
  totalSpecs += kept.length;
  guardSpecs += kept.filter((s) => s.operatorName === "lethal.negate-guard").length;
  const source = sources.get(file.path);
  if (source === undefined) continue;
  instrumented.push({ path: file.path, source, root: file.root, specs: kept });
}

console.log(`mutants emitted: ${totalSpecs} total, ${guardSpecs} from negate-guard`);
if (guardSpecs === 0) {
  throw new Error(
    "r171-emit-probe: negate-guard emitted nothing — a green compile would prove nothing",
  );
}

const outDir = await mkdtemp(join(tmpdir(), "lethal-r171-"));
try {
  await writeInstrumentedProject({
    targetDir: outDir,
    files: instrumented,
    selectorIds: { selectorId: 79199, controlId: 79198, tableId: 79197 },
    artifactId: "0123456789abcdef0123456789abcdef",
    targetAppId: "df1aa9ff-6539-4c86-a9d0-ad702b61ac9a",
    operatorTiers: OPERATOR_TIERS,
  });
  // The instrumented tree carries only .al files; the manifest and the project metadata come along
  // so alc has an app.json and symbols.
  await cp(join(projectDir, ".alpackages"), join(outDir, ".alpackages"), { recursive: true });
  // The instrumented target references `LC Control State`, so it needs the control app's SYMBOLS and
  // a declared dependency on it — the same two steps `BcDevMcpBackend.stageForCompile` does before
  // every real compile. Without them the artifact fails on AL0185 for a reason that has nothing to
  // do with the operator under test.
  await cp(CONTROL_APP, join(outDir, ".alpackages", "lethal-control.app"));
  const app = JSON.parse(await readFile(join(projectDir, "app.json"), "utf8")) as Record<
    string,
    unknown
  >;
  const deps = Array.isArray(app.dependencies) ? [...app.dependencies] : [];
  deps.push({
    id: "5e7a1c00-1111-4c00-8c00-1e7a1c000701",
    name: "LethAL Control",
    publisher: "LethAL",
    version: "1.0.0.0",
  });
  app.dependencies = deps;
  await writeFile(
    join(outDir, "app.json"),
    `${JSON.stringify(app, null, 2)}
`,
    "utf8",
  );

  const proc = Bun.spawn(
    [
      alcPath,
      `/project:${outDir}`,
      `/packagecachepath:${join(outDir, ".alpackages")}`,
      `/out:${join(outDir, "instrumented.app")}`,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  const errors = out.split("\n").filter((l) => l.includes(": error "));
  console.log(
    `instrumented artifact: ${errors.length} error(s)${errors.length === 0 ? "  OK" : ""}`,
  );
  for (const e of errors.slice(0, 12)) console.log(`   ${e.trim()}`);

  if (errors.length === 0) {
    // Show one emitted guard so a reader can see what the dispatch looks like, rather than trusting
    // "it compiled".
    const first = instrumented.find((f) =>
      f.specs.some((s) => s.operatorName === "lethal.negate-guard"),
    );
    if (first !== undefined) {
      const emitted = await readFile(join(outDir, basename(first.path)), "utf8").catch(() => "");
      // Must be a DISPATCH line, not a comment that happens to contain the same text: a green
      // compile plus an unverified emission is the empty-vs-empty shape this repo keeps hitting.
      const lines = emitted.split("\n");
      const idx = lines.findIndex((l) => l.includes("not (") && !l.trimStart().startsWith("//"));
      if (idx === -1) {
        throw new Error(
          "r171-emit-probe: artifact compiled but carries no emitted `not (` dispatch — the compile proved nothing",
        );
      }
      console.log("\nemitted dispatch, verbatim:");
      for (const l of lines.slice(Math.max(0, idx - 2), idx + 3)) console.log(`   ${l}`);
    }
  }
  if (errors.length > 0) process.exitCode = 1;
} finally {
  await rm(outDir, { recursive: true, force: true });
}
