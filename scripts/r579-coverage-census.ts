// R-579 / R-580 census: which projects lose al-runner-v3 coverage to a refused wrapped file or a
// multi-object file, and how many would keep it if the two harmless wrapper shapes were admitted.
// usage: bun scripts/r579-coverage-census.ts <checkout-root> <corpus-root> <out.json>
// It imports the coverage code of <checkout-root>, so one copy of this script measures master and
// R-602's tree alike (modelled on prod-identity-keys.ts).
//
// PROJECTS: directories under <corpus-root> holding an app.json, sorted (corpus-snapshot's
// `findProjects`). SOURCE APPS ONLY. TEST-APP RULE: a project is a test app when its app.json
// depends on a test framework (a dependency named "Test Runner", "Library Assert", "Any",
// "Library Variable Storage", "Permissions Mock", or with "test" in its name), or when a directory
// segment of its path under <corpus-root> starts with "Test" (case-insensitive).
//
// PER-TREE RULE: master turns coverage off for any multi-object file OR refused wrapped file; R-602
// (whose `alRunnerCoverageSupport` no longer returns `multiObjectFiles`) only for a refused wrapped
// file. The multi-object list is always computed here with the tree's own `refusedAsMultiObject`.
//
// CLASSES of a refused wrapped file, by parse, looking at each `#if` wrapper that holds an object
// (`wrapperHoldsObject`) and flattening its arms:
//   pragma-only-wrapper  R579: the wrapper holds only pragma, comment, namespace or using nodes.
//   code-free-wrapped    R580: every object in it is one of CODE_FREE below (grammar node kinds).
//   code-bearing-wrapped everything else (also a `preproc_split_declaration`, fail-closed).
// A file with wrappers of several classes takes the worst: code-bearing > code-free > pragma-only.
// Output carries paths and counts only, no source text.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { findProjects } from "./corpus-snapshot.ts";

export const CODE_FREE: ReadonlySet<string> = new Set([
  "enum_declaration",
  "enumextension_declaration",
  "interface_declaration",
  "permissionset_declaration",
  "permissionsetextension_declaration",
  "controladdin_declaration",
  "dotnet_declaration",
  "profile_declaration",
  "entitlement_declaration",
]);
const TRIVIA: ReadonlySet<string> = new Set([
  "pragma",
  "comment",
  "multiline_comment",
  "namespace_declaration",
  "using_statement",
]);
const CODE_NODES: ReadonlySet<string> = new Set(["procedure", "trigger_declaration", "code_block"]);

export type FileClass = "pragma-only-wrapper" | "code-free-wrapped" | "code-bearing-wrapped";
const CLASSES: readonly FileClass[] = [
  "pragma-only-wrapper",
  "code-free-wrapped",
  "code-bearing-wrapped",
];
// biome-ignore lint/suspicious/noExplicitAny: the checkout's own node type, loaded by path
type Node = any;

function holdsCode(n: Node): boolean {
  return n.namedChildren.some((c: Node) => CODE_NODES.has(c.rawKind) || holdsCode(c));
}

/** What a wrapper holds, arms flattened; directive lines dropped, a split declaration kept. */
function itemsOf(w: Node): Node[] {
  const out: Node[] = [];
  for (const c of w.namedChildren as Node[]) {
    const k: string = c.rawKind;
    if (k === "preproc_conditional_object" || k === "preproc_else" || k === "preproc_elif") {
      out.push(...itemsOf(c));
    } else if (!k.startsWith("preproc_") || k === "preproc_split_declaration") out.push(c);
  }
  return out;
}

export function classifyWrapped(
  root: Node,
  wrapperHoldsObject: (w: Node) => boolean,
): FileClass | undefined {
  let worst = -1;
  for (const w of root.namedChildren as Node[]) {
    if (w.rawKind !== "preproc_conditional_object" || !wrapperHoldsObject(w)) continue;
    const real = itemsOf(w).filter((n) => !TRIVIA.has(n.rawKind));
    const cls: FileClass =
      real.length === 0
        ? "pragma-only-wrapper"
        : real.every((n) => CODE_FREE.has(n.rawKind) && !holdsCode(n))
          ? "code-free-wrapped"
          : "code-bearing-wrapped";
    worst = Math.max(worst, CLASSES.indexOf(cls));
  }
  return CLASSES[worst];
}

const TEST_DEP = /test|^(any|library assert|library variable storage|permissions mock)$/i;
const TEST_RUNNER_ID = "23de40a6-dfe8-4f80-80db-d70f83ce8caf";

export function isTestApp(corpusRoot: string, projectDir: string): boolean {
  if (
    relative(corpusRoot, projectDir)
      .split(/[\\/]/)
      .some((s) => /^test/i.test(s))
  )
    return true;
  const app = JSON.parse(readFileSync(join(projectDir, "app.json"), "utf8").replace(/^﻿/, ""));
  const deps: { name?: string; id?: string; appId?: string }[] = app.dependencies ?? [];
  return deps.some(
    (d) => TEST_DEP.test(d.name ?? "") || (d.id ?? d.appId ?? "").toLowerCase() === TEST_RUNNER_ID,
  );
}

interface ProjectRow {
  rel: string;
  coverage: "on" | "off";
  multiObjectFiles: number;
  refusedWrapped: Record<FileClass, number>;
  refusedWrappedFiles: Record<string, FileClass>;
  multiObjectFileList: string[];
  onIfFixed: boolean;
}

export async function census(checkout: string, corpus: string) {
  const eng = await import(join(checkout, "packages/engine/src/index.ts"));
  const lm = await import(join(checkout, "packages/runner/src/line-map.ts"));
  const cov = await import(join(checkout, "packages/runner/src/al-runner-coverage.ts"));
  await eng.initParser();
  const projects = findProjects(corpus).filter((p) => !isTestApp(corpus, p));
  const rows: ProjectRow[] = [];
  let multiRule: boolean | null = null;
  for (const dir of projects) {
    const support = await cov.alRunnerCoverageSupport(dir);
    const wrapped: string[] = support.wrappedObjectFiles;
    // shortcut: the multi-object list is recomputed by walking the dir with Bun.Glob; a link is followed.
    const multi: string[] = [];
    for await (const rel of new Bun.Glob("**/*.al").scan({ cwd: dir })) {
      const root = eng.wrapRoot(eng.parseAL(readFileSync(join(dir, rel), "utf8")));
      if (lm.refusedAsMultiObject(root)) multi.push(rel.replaceAll("\\", "/"));
    }
    multi.sort();
    const multiOff = "multiObjectFiles" in support; // master's rule; R-602 dropped the field
    multiRule = multiOff;
    const counts: Record<FileClass, number> = {
      "pragma-only-wrapper": 0,
      "code-free-wrapped": 0,
      "code-bearing-wrapped": 0,
    };
    const files: Record<string, FileClass> = {};
    for (const rel of wrapped) {
      const root = eng.wrapRoot(eng.parseAL(readFileSync(join(dir, rel), "utf8")));
      const cls = classifyWrapped(root, lm.wrapperHoldsObject) ?? "code-bearing-wrapped";
      counts[cls]++;
      files[rel] = cls;
    }
    rows.push({
      rel: relative(corpus, dir) || ".",
      coverage: (multiOff && multi.length > 0) || wrapped.length > 0 ? "off" : "on",
      multiObjectFiles: multi.length,
      refusedWrapped: counts,
      refusedWrappedFiles: files,
      multiObjectFileList: multi,
      onIfFixed: !(multiOff && multi.length > 0) && counts["code-bearing-wrapped"] === 0,
    });
  }
  const off = rows.filter((r) => r.coverage === "off");
  const totals = {
    projects: rows.length,
    coverageOff: off.length,
    offBecauseMultiObject: off.filter((r) => r.multiObjectFiles > 0).length,
    offBecausePragmaOnly: off.filter((r) => r.refusedWrapped["pragma-only-wrapper"] > 0).length,
    offBecauseCodeFree: off.filter((r) => r.refusedWrapped["code-free-wrapped"] > 0).length,
    offBecauseCodeBearing: off.filter((r) => r.refusedWrapped["code-bearing-wrapped"] > 0).length,
    onIfFixed: off.filter((r) => r.onIfFixed).length,
    // true: this tree turns coverage off for a multi-object file (master); false: it does not (R-602).
    multiObjectTurnsCoverageOff: multiRule,
  };
  return { checkout, corpus, totals, projects: rows };
}

if (import.meta.main) {
  const [checkout, corpus, out] = process.argv.slice(2);
  if (checkout === undefined || corpus === undefined || out === undefined) {
    throw new Error("usage: r579-coverage-census.ts <checkout-root> <corpus-root> <out.json>");
  }
  const result = await census(checkout, corpus);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
  const t = result.totals;
  console.log(
    `r579 census ${corpus}: projects=${t.projects} coverageOff=${t.coverageOff} (multi=${t.offBecauseMultiObject} pragmaOnly=${t.offBecausePragmaOnly} codeFree=${t.offBecauseCodeFree} codeBearing=${t.offBecauseCodeBearing}) onIfFixed=${t.onIfFixed}`,
  );
}
