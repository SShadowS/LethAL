#!/usr/bin/env bun
/**
 * R216: which census rows did the `asserterror_statement.body` slot ADD, are they really at that
 * body, would the runner deploy them, and is each one product or test code?
 *
 *   bun scripts/r216-classify-gained.ts <before.json> <after.json> <corpus-dir>
 *
 * Run with the predicate change applied, so regenerated specs match the AFTER census.
 *
 * 1. Gained/lost is a MULTISET diff keyed like `probe-census-diff.ts`.
 * 2. Ancestry: a gained row counts only when its node (start position plus squashed text) IS the
 *    `body` field of an `asserterror_statement`. Otherwise BAD, exit 1.
 * 3. Deployable: the row survives the runner's own checks, in the runner's order: the file passes
 *    `isEnumeratedAl`; the spec passes `validateSpec` and `isMutableSite`; it survives
 *    `dedupeSpecs` over every operator's specs for that file; and the file passes
 *    `canCarryMutationSelectorVar` (query and XMLport objects fail it). Mirrors
 *    `census-fixture-mutants.ts`, which mirrors `generateMutationSet`.
 * 4. Role, by APP (ruling 1), exactly three outcomes:
 *    test     the nearest app.json (searched up to, and not above, <corpus-dir>) declares a
 *             dependency whose `publisher` is exactly `Microsoft` AND whose name or id is in
 *             TEST_APP_NAMES / TEST_APP_IDS, exact match; OR
 *             that app holds any codeunit with `Subtype = Test` or `TestRunner`; OR there is no
 *             app.json and the enclosing object is itself such a codeunit.
 *    product  an app.json was found, parsed, and the app is not a test app.
 *    unknown  anything else (no app.json and not a test codeunit, or an app.json that fails to
 *             parse). Never counted as product; any unknown row stops the lane.
 * Prints counts, operator names, object names, files and lines only, never source text.
 * The role decision is exported for `r216-classify-gained.test.ts`; the CLI runs only as main.
 */
import { existsSync, readFileSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { tier1Operators } from "../packages/builtin-tier1/src/index";
import { tier2Operators } from "../packages/builtin-tier2/src/index";
import { initParser, parseAL } from "../packages/engine/src/ast/parser";
import { type ALSyntaxNode, visit, wrapRoot } from "../packages/engine/src/ast/syntax-node";
import { declarationMembers } from "../packages/engine/src/ast/tree-walks";
import type { MutationSpec } from "../packages/engine/src/operator/interface";
import { buildSpanIndex, validateSpec } from "../packages/engine/src/operator/spec-validation";
import { buildSemanticContext } from "../packages/engine/src/semantic/context";
import { isEnumeratedAl } from "../packages/runner/src/line-filter";
import { canCarryMutationSelectorVar } from "../packages/schemata/src/compile";
import { dedupeSpecs } from "../packages/schemata/src/dedup";
import { isMutableSite } from "../packages/schemata/src/enclosing";

interface Row {
  readonly operator: string;
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly before: string;
  readonly after: string;
}

/** Microsoft test-library apps (plan fact 9). Exact, case-sensitive; no regex. */
export const TEST_APP_NAMES: ReadonlySet<string> = new Set([
  "Library Assert",
  "Test Runner",
  "Any",
  "Library Variable Storage",
  "Permissions Mock",
]);
/** Only ids read off a real app.json by name. Add others the same way, never by guess. */
export const TEST_APP_IDS: ReadonlySet<string> = new Set(["5095f467-0a01-4b99-99d1-9ff1237d286f"]);

export interface AppDependency {
  readonly name?: string;
  readonly id?: string;
  readonly appId?: string;
  readonly publisher?: string;
}

/** A test library counts only when Microsoft publishes it: a Contoso "Library Assert" is not one. */
export function declaresTestLibrary(deps: readonly AppDependency[]): boolean {
  return deps.some(
    (d) =>
      d.publisher === "Microsoft" &&
      ((d.name !== undefined && TEST_APP_NAMES.has(d.name)) ||
        (d.id !== undefined && TEST_APP_IDS.has(d.id.toLowerCase())) ||
        (d.appId !== undefined && TEST_APP_IDS.has(d.appId.toLowerCase()))),
  );
}

function subtypeOf(obj: ALSyntaxNode): string | null {
  for (const m of declarationMembers(obj)) {
    if (m.rawKind !== "property") continue;
    if (m.childForFieldName("name")?.text.toLowerCase() !== "subtype") continue;
    return m.childForFieldName("value")?.text.trim() ?? null;
  }
  return null;
}
export const isTestCodeunit = (obj: ALSyntaxNode): boolean =>
  obj.rawKind === "codeunit_declaration" && /^(Test|TestRunner)$/i.test(subtypeOf(obj) ?? "");

/** The nearest directory holding an app.json, searched up to and not above `corpusDir`. */
export function appRootOf(corpusDir: string, rel: string): string | null {
  const top = resolve(corpusDir);
  let d = dirname(join(top, rel));
  for (;;) {
    if (existsSync(join(d, "app.json"))) return d;
    if (resolve(d) === top) return null;
    const up = dirname(d);
    if (up === d || relative(top, up).startsWith("..")) return null;
    d = up;
  }
}

/** Every app root that holds a `Subtype = Test` or `TestRunner` codeunit. */
export function testCodeunitApps(
  corpusDir: string,
  roots: ReadonlyMap<string, ALSyntaxNode>,
): Set<string> {
  const out = new Set<string>();
  for (const [rel, root] of roots) {
    let has = false;
    visit(root, (n) => {
      if (isTestCodeunit(n)) has = true;
    });
    const app = appRootOf(corpusDir, rel);
    if (has && app !== null) out.add(app);
  }
  return out;
}

/** true = test app, false = product app, null = app.json unreadable. */
export function appIsTest(app: string, appsWithTestCodeunit: ReadonlySet<string>): boolean | null {
  try {
    const j = JSON.parse(readFileSync(join(app, "app.json"), "utf8").replace(/^\uFEFF/, "")) as {
      dependencies?: AppDependency[];
    };
    return declaresTestLibrary(j.dependencies ?? []) || appsWithTestCodeunit.has(app);
  } catch {
    return null;
  }
}

export type Role = "product" | "test" | "unknown";

/** The role of object `obj` (null when none encloses the site) in corpus file `rel`. */
export function roleOf(
  corpusDir: string,
  rel: string,
  obj: ALSyntaxNode | null,
  appsWithTestCodeunit: ReadonlySet<string>,
): Role {
  const app = appRootOf(corpusDir, rel);
  if (app === null) return obj !== null && isTestCodeunit(obj) ? "test" : "unknown";
  const t = appIsTest(app, appsWithTestCodeunit);
  return t === null ? "unknown" : t ? "test" : "product";
}

const squash = (s: string): string => s.replace(/\s+/g, " ").trim();
const key = (r: Row): string =>
  JSON.stringify([r.operator, r.file, r.line, r.column, r.before, r.after]);
const load = async (p: string): Promise<Row[]> => JSON.parse(await readFile(p, "utf8")) as Row[];

async function main(): Promise<void> {
  const [beforePath, afterPath, corpusArg] = process.argv.slice(2);
  if (beforePath === undefined || afterPath === undefined || corpusArg === undefined) {
    console.error(
      "usage: bun scripts/r216-classify-gained.ts <before.json> <after.json> <corpus-dir>",
    );
    process.exit(2);
  }
  const corpusDir = resolve(corpusArg);

  // 1. Multiset diff.
  const remaining = new Map<string, number>();
  for (const r of await load(beforePath)) remaining.set(key(r), (remaining.get(key(r)) ?? 0) + 1);
  const gained: Row[] = [];
  for (const r of await load(afterPath)) {
    const n = remaining.get(key(r)) ?? 0;
    if (n > 0) remaining.set(key(r), n - 1);
    else gained.push(r);
  }
  let lost = 0;
  for (const n of remaining.values()) lost += n;

  // Parse the corpus exactly as the census does (sorted, recursive), for one semantic context.
  await initParser();
  const rels = (await readdir(corpusDir, { recursive: true }))
    .filter((f) => f.toLowerCase().endsWith(".al"))
    .sort();
  const roots = new Map<string, ALSyntaxNode>();
  for (const rel of rels) {
    roots.set(rel, wrapRoot(parseAL(await readFile(join(corpusDir, rel), "utf8"))));
  }
  const ctx = buildSemanticContext([...roots].map(([path, root]) => ({ path, root })));
  const operators = [...tier1Operators, ...tier2Operators];
  const tiers = new Map(operators.map((op) => [op.name, op.tier]));

  // 4. App roles.
  const appsWithTestCodeunit = testCodeunitApps(corpusDir, roots);

  // 3. Deployed specs per file, the runner's pipeline, computed only for files with gained rows.
  const deployedKeys = new Map<string, Set<string>>();
  function deployedIn(rel: string, root: ALSyntaxNode): Set<string> {
    const hit = deployedKeys.get(rel);
    if (hit !== undefined) return hit;
    const out = new Set<string>();
    if (isEnumeratedAl(rel) && canCarryMutationSelectorVar(root)) {
      const spanIndex = buildSpanIndex(root);
      const raw: MutationSpec[] = [];
      visit(root, (node) => {
        for (const op of operators) {
          if (!op.targets(node, ctx)) continue;
          for (const spec of op.generate(node, ctx)) {
            if (!validateSpec(spec, root, spanIndex).ok) continue;
            if (!isMutableSite(spec.before)) continue;
            raw.push(spec);
          }
        }
      });
      for (const s of dedupeSpecs(raw, (name) => tiers.get(name))) {
        out.add(
          key({
            operator: s.operatorName,
            file: rel,
            line: s.before.startPosition.row + 1,
            column: s.before.startPosition.column,
            before: squash(s.before.text),
            after: squash(s.after.text),
          }),
        );
      }
    }
    deployedKeys.set(rel, out);
    return out;
  }

  const counts = new Map<string, number>();
  const bump = (k: string): void => {
    counts.set(k, (counts.get(k) ?? 0) + 1);
  };
  let bad = 0;
  let unknown = 0;
  for (const r of gained) {
    const root = roots.get(r.file);
    if (root === undefined)
      throw new Error(`r216-classify-gained: ${r.file} is not in ${corpusDir}`);
    let node: ALSyntaxNode | undefined;
    visit(root, (n) => {
      if (node !== undefined) return;
      if (
        n.startPosition.row + 1 === r.line &&
        n.startPosition.column === r.column &&
        squash(n.text) === r.before &&
        n.fieldName === "body" &&
        n.parent?.rawKind === "asserterror_statement"
      )
        node = n;
    });
    if (node === undefined) {
      bad += 1;
      console.log(
        `BAD\t${r.operator}\t${r.file}:${r.line}\tnot the body of an asserterror_statement`,
      );
      continue;
    }
    let obj: ALSyntaxNode | null = node.parent;
    while (obj !== null && !obj.rawKind.endsWith("_declaration")) obj = obj.parent;
    while (obj !== null && obj.parent !== null && obj.parent.rawKind !== "source_file")
      obj = obj.parent;
    // The object's name is its `object_name` field (read off a real parse), not `name`.
    const objName = obj?.childForFieldName("object_name")?.text ?? "(no object)";
    const role = roleOf(corpusDir, r.file, obj, appsWithTestCodeunit);
    const deployable = deployedIn(r.file, root).has(key(r));
    bump(`${role}\t${deployable ? "deployable" : "not-deployed"}\t${r.operator}`);
    if (role === "unknown") unknown += 1;
    if (role !== "test")
      console.log(
        `${role}\t${deployable ? "deployable" : "not-deployed"}\t${r.operator}\t${objName}\t${r.file}:${r.line}`,
      );
  }
  console.log(`\ngained ${gained.length}, lost ${lost}, bad ${bad}, unknown ${unknown}`);
  for (const [k, n] of [...counts].sort()) console.log(`${k}\t${n}`);
  process.exit(lost > 0 || bad > 0 ? 1 : unknown > 0 ? 3 : 0);
}

if (import.meta.main) await main();
