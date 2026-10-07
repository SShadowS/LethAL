import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";

/**
 * R-307 O2, source scan part 1. Every `FileRefusedError` is built at one of thirteen named sites
 * (R470 added `compile.selector-name`), and
 * each construction says which one in a literal `site:` property, so a refusal can be traced to
 * the code that raised it and the PLAN/EMIT split can show no site moved or vanished. Parsed with
 * the TypeScript compiler, so a comment or a string cannot hit.
 */

const REPO = resolve(import.meta.dir, "../../..");

/** The thirteen sites, in the order the scan meets them (file path, then source order). */
const PINNED_SITES = [
  "rewrite.overlap",
  "compile.latch-owner",
  "compile.latch-preamble-anchor",
  "compile.latch-split-var-anchor",
  "compile.latch-var-anchor",
  "compile.selector-name",
  "compile.selector-var-keyword",
  "compile.selector-no-members",
  "compile.selector-no-last-member",
  "compile.unsupported-kind",
  "project.no-header",
  "project.object-mix",
  "project.site-before-header",
];

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name.endsWith(".ts") && !name.endsWith(".d.ts")) out.push(path);
    }
  };
  for (const pkg of readdirSync(join(REPO, "packages")).sort()) {
    const src = join(REPO, "packages", pkg, "src");
    try {
      if (statSync(src).isDirectory()) walk(src);
    } catch {
      // a package with no src directory has nothing to scan
    }
  }
  return out;
}

interface Scan {
  /** `<repo-relative file>:<line> <site id or a problem>`, in scan order. */
  readonly constructions: { readonly where: string; readonly site: string | undefined }[];
  readonly problems: string[];
}

function scan(): Scan {
  const constructions: Scan["constructions"] = [];
  const problems: string[] = [];
  for (const file of sourceFiles()) {
    const text = readFileSync(file, "utf8");
    if (!text.includes("FileRefusedError")) continue;
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const where = (n: ts.Node): string =>
      `${relative(REPO, file).split("\\").join("/")}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`;
    const isRefused = (n: ts.Node): boolean => ts.isIdentifier(n) && n.text === "FileRefusedError";
    const visit = (n: ts.Node): void => {
      if (ts.isNewExpression(n) && isRefused(n.expression)) {
        const fields = n.arguments?.[1];
        let site: string | undefined;
        if (fields !== undefined && ts.isObjectLiteralExpression(fields)) {
          for (const p of fields.properties) {
            if (
              ts.isPropertyAssignment(p) &&
              ts.isIdentifier(p.name) &&
              p.name.text === "site" &&
              ts.isStringLiteral(p.initializer)
            )
              site = p.initializer.text;
          }
        }
        constructions.push({ where: where(n), site });
      } else if (ts.isCallExpression(n) && isRefused(n.expression)) {
        problems.push(`${where(n)}: FileRefusedError called without new`);
      } else if (ts.isCallExpression(n) && n.arguments.some(isRefused)) {
        problems.push(`${where(n)}: FileRefusedError passed as a value (an indirect construction)`);
      } else if (ts.isHeritageClause(n) && n.types.some((t) => isRefused(t.expression))) {
        problems.push(`${where(n)}: extends FileRefusedError`);
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return { constructions, problems };
}

describe("R-307 O2: every FileRefusedError names its site", () => {
  const result = scan();

  test("each construction carries a literal site id", () => {
    const missing = result.constructions.filter((c) => c.site === undefined).map((c) => c.where);
    expect(missing).toEqual([]);
  });

  test("the site ids are exactly the thirteen pinned ones, each once", () => {
    expect(result.constructions.map((c) => c.site)).toEqual(PINNED_SITES);
  });

  test("no construction without new, and no subclass", () => {
    expect(result.problems).toEqual([]);
  });
});

/**
 * R-307 O7, source scan part 2: the PLAN/EMIT boundary (plan amendment section 3). PLAN decides and
 * throws; EMIT turns a frozen plan into text and cannot refuse; a composition calls one then the
 * other. Every `.ts` under the two scanned directories is on exactly one list below, so a new file
 * cannot dodge the scan. Parsed with the TypeScript compiler, so comments and strings cannot hit.
 *
 * Imports are followed through named re-exports (`export { x } from "./y"`) to the module that
 * declares the name, so a value that reaches EMIT through `@lethal/engine`'s index is judged by the
 * module it comes from. `dispatch.ts` is a re-export barrel and is banned outright besides.
 */

const SCANNED_DIRS = ["packages/schemata/src", "packages/engine/src/ast"];

const PLAN_MODULES = [
  "packages/engine/src/ast/rewrite-plan.ts",
  "packages/schemata/src/compile-plan.ts",
  "packages/schemata/src/components.ts",
  "packages/schemata/src/dispatch-plan.ts",
  "packages/schemata/src/enclosing.ts",
  "packages/schemata/src/project-plan.ts",
];

const EMIT_MODULES = [
  "packages/engine/src/ast/join-edits.ts",
  "packages/schemata/src/compile-emit.ts",
  "packages/schemata/src/dispatch-emit.ts",
  "packages/schemata/src/project-emit.ts",
];

/**
 * Each composition and the top-level functions it may hold. `printer.ts` and `compile.ts` hold
 * their one composing function. `project.ts` holds `instrumentOneFile` and the writer
 * (`writeInstrumentedProject`: dedup, ids, manifest rows, file writes), whose helpers are pinned
 * here by name, so a new function there is a decision someone makes on purpose.
 */
const COMPOSITION_MODULES: Readonly<Record<string, readonly string[]>> = {
  "packages/engine/src/ast/printer.ts": ["printWithRewrites"],
  "packages/schemata/src/compile.ts": ["compileSchemataForFile"],
  "packages/schemata/src/project.ts": [
    "gapIdOf",
    "identityTupleOf",
    "coarseIdentityTupleOf",
    "assignIdentityOrdinals",
    "identityOrdinalsOf",
    "identitySiteKey",
    "identityFieldsOf",
    "identityEntriesOf",
    "numberIdentityOrdinals",
    "runIdentityOrdinals",
    "runIdentityEntries",
    "clipMutationText",
    "lineStartsOf",
    "lineOfIndex",
    "stripQuotes",
    "enclosingProcedureLike",
    "coverageArmNamesOf",
    "procedureNameOf",
    "procedureScopeOf",
    "splitIsLocal",
    "triggerNameOf",
    "enclosingMemberOf",
    "withRunIdentityOrdinals",
    "instrumentOneFile",
    "writeInstrumentedProject",
    "writeManifestJson",
  ],
};

/** Neither PLAN nor EMIT: parsing, tree walks, ids, selectors, barrels and shared constants. */
const NEITHER_MODULES = [
  /** Argument-list readers shared by the operators (R-452). */
  "packages/engine/src/ast/arguments.ts",
  /** A member's attribute run (R474: the member hash; runner's testpage-scan and test digest). */
  "packages/engine/src/ast/attribute-run.ts",
  "packages/engine/src/ast/canonicalization.ts",
  "packages/engine/src/ast/hash.ts",
  "packages/engine/src/ast/mask.ts",
  "packages/engine/src/ast/native-parser.ts",
  "packages/engine/src/ast/node-kinds.ts",
  "packages/engine/src/ast/parser-wasm.ts",
  "packages/engine/src/ast/parser.ts",
  "packages/engine/src/ast/preproc-arms.ts",
  "packages/engine/src/ast/syntax-node.ts",
  "packages/engine/src/ast/tree-walks.ts",
  "packages/schemata/src/dedup.ts",
  /** The re-export barrel. No PLAN, EMIT or composition module may import it. */
  "packages/schemata/src/dispatch.ts",
  "packages/schemata/src/duplicate.ts",
  /** R219: a batch file's flat name and the way back; refuses nothing per file. */
  "packages/schemata/src/flat-names.ts",
  "packages/schemata/src/id-ranges.ts",
  "packages/schemata/src/ids.ts",
  "packages/schemata/src/index.ts",
  "packages/schemata/src/lift.ts",
  /** REACH_LATCH: both halves read it, and EMIT may not import a value from PLAN. */
  "packages/schemata/src/reach-latch.ts",
  "packages/schemata/src/selector.ts",
  "packages/schemata/src/wrap.ts",
];

const DISPATCH_BARREL = "packages/schemata/src/dispatch.ts";
const ENGINE_INDEX = "packages/engine/src/index.ts";

const rel = (abs: string): string => relative(REPO, abs).split("\\").join("/");

function listScanned(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name.endsWith(".ts") && !name.endsWith(".d.ts")) out.push(rel(path));
    }
  };
  for (const d of SCANNED_DIRS) walk(join(REPO, d));
  return out;
}

const parsed = new Map<string, ts.SourceFile>();
function parse(file: string): ts.SourceFile {
  const hit = parsed.get(file);
  if (hit !== undefined) return hit;
  const sf = ts.createSourceFile(
    file,
    readFileSync(join(REPO, file), "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  parsed.set(file, sf);
  return sf;
}

/** The repo-relative module a specifier names, or `undefined` for a package outside the scan. */
function resolveSpecifier(from: string, spec: string): string | undefined {
  if (spec === "@lethal/engine") return ENGINE_INDEX;
  if (spec.startsWith("@lethal/")) throw new Error(`${from}: unscanned workspace import ${spec}`);
  if (!spec.startsWith(".")) return undefined;
  const base = rel(resolve(REPO, from, "..", spec));
  for (const candidate of [`${base}.ts`, `${base}/index.ts`]) {
    try {
      if (statSync(join(REPO, candidate)).isFile()) return candidate;
    } catch {
      // try the next candidate
    }
  }
  throw new Error(`${from}: cannot resolve ${spec}`);
}

/** The module that declares `name`, following named `export { name } from` chains from `module`. */
function originOf(module: string, name: string, seen: Set<string> = new Set()): string {
  const key = `${module}#${name}`;
  if (seen.has(key)) throw new Error(`re-export cycle at ${key}`);
  seen.add(key);
  for (const st of parse(module).statements) {
    if (!ts.isExportDeclaration(st) || st.moduleSpecifier === undefined) continue;
    if (!ts.isStringLiteral(st.moduleSpecifier)) continue;
    const clause = st.exportClause;
    if (clause === undefined || !ts.isNamedExports(clause)) continue;
    for (const el of clause.elements) {
      if (el.name.text !== name) continue;
      const target = resolveSpecifier(module, st.moduleSpecifier.text);
      if (target === undefined) return module;
      return originOf(target, el.propertyName?.text ?? el.name.text, seen);
    }
  }
  return module;
}

interface ImportEdge {
  readonly where: string;
  /** The module named in the import statement. */
  readonly direct: string;
  /** The module that declares the imported name (equals `direct` for a whole-module import). */
  readonly origin: string;
  readonly typeOnly: boolean;
}

/**
 * Every import and re-export of `file`, one edge per name. A package outside the scan (`node:fs`)
 * gives an edge whose `origin` is `external:<specifier>` (R442), so the EMIT allow-list judges it
 * like any other module. A dynamic `import(...)` whose target is not a string literal or a
 * no-substitution template gives an edge with origin `unclassified-dynamic-import`.
 */
function importsOf(file: string, sf: ts.SourceFile = parse(file)): ImportEdge[] {
  const edges: ImportEdge[] = [];
  const at = (n: ts.Node): string =>
    `${file}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`;
  const visit = (n: ts.Node): void => {
    if (
      (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) &&
      n.moduleSpecifier !== undefined &&
      ts.isStringLiteral(n.moduleSpecifier)
    ) {
      const spec = n.moduleSpecifier.text;
      const resolved = resolveSpecifier(file, spec);
      const direct = resolved ?? `external:${spec}`;
      const wholeType = ts.isImportDeclaration(n)
        ? n.importClause?.isTypeOnly === true
        : n.isTypeOnly;
      const named = ts.isImportDeclaration(n) ? n.importClause?.namedBindings : n.exportClause;
      const names: { name: string; typeOnly: boolean }[] = [];
      let whole = false;
      if (ts.isImportDeclaration(n)) {
        if (n.importClause === undefined)
          whole = true; // a side-effect import runs the module
        else if (n.importClause.name !== undefined) whole = true; // a default import
      }
      if (named !== undefined && (ts.isNamedImports(named) || ts.isNamedExports(named))) {
        // `import {} from "x"` / `export {} from "x"` still load the module: a whole-module edge.
        if (named.elements.length === 0) whole = true;
        // `import {} from "x"` / `export {} from "x"` still load the module: a whole-module edge.
        for (const el of named.elements)
          names.push({
            name: el.propertyName?.text ?? el.name.text,
            typeOnly: wholeType || el.isTypeOnly,
          });
      } else if (named !== undefined || ts.isExportDeclaration(n)) {
        whole = true; // `* as ns` or `export *`
      }
      if (whole) edges.push({ where: at(n), direct, origin: direct, typeOnly: wholeType });
      for (const x of names)
        edges.push({
          where: at(n),
          direct,
          origin: resolved === undefined ? direct : originOf(resolved, x.name),
          typeOnly: x.typeOnly,
        });
    } else if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const arg = n.arguments[0];
      const direct =
        arg !== undefined && ts.isStringLiteralLike(arg)
          ? (resolveSpecifier(file, arg.text) ?? `external:${arg.text}`)
          : "unclassified-dynamic-import";
      edges.push({ where: at(n), direct, origin: direct, typeOnly: false });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return edges;
}

/** `<file>:<line> <what>` for each node of `file` that `pick` names. */
function findIn(file: string, pick: (n: ts.Node) => string | undefined): string[] {
  const sf = parse(file);
  const out: string[] = [];
  const visit = (n: ts.Node): void => {
    const what = pick(n);
    if (what !== undefined)
      out.push(`${file}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1} ${what}`);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** The names of `file`'s top-level functions: declarations, and consts bound to a function. */
function topLevelFunctions(file: string): string[] {
  const names: string[] = [];
  for (const st of parse(file).statements) {
    if (ts.isFunctionDeclaration(st) && st.name !== undefined) names.push(st.name.text);
    else if (ts.isClassDeclaration(st)) names.push(`class ${st.name?.text ?? "<anonymous>"}`);
    else if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        const init = d.initializer;
        if (
          init !== undefined &&
          (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) &&
          ts.isIdentifier(d.name)
        )
          names.push(d.name.text);
      }
    }
  }
  return names;
}

describe("R-307 O7: the PLAN/EMIT boundary", () => {
  const composition = Object.keys(COMPOSITION_MODULES);
  const plan = new Set(PLAN_MODULES);
  const emit = new Set(EMIT_MODULES);
  const planEmitOrComposition = [...PLAN_MODULES, ...EMIT_MODULES, ...composition];

  test("every scanned .ts is on exactly one list, and every listed file exists", () => {
    const listed = [...planEmitOrComposition, ...NEITHER_MODULES];
    const counts = new Map<string, number>();
    for (const f of listed) counts.set(f, (counts.get(f) ?? 0) + 1);
    const twice = [...counts].filter(([, c]) => c > 1).map(([f]) => f);
    expect(twice).toEqual([]);
    expect(listScanned().sort()).toEqual([...listed].sort());
  });

  test("every new FileRefusedError( is in a PLAN module", () => {
    const outside = scan()
      .constructions.map((c) => c.where)
      .filter((w) => !plan.has(w.slice(0, w.lastIndexOf(":"))));
    expect(outside).toEqual([]);
  });

  test("EMIT modules contain no throw statement", () => {
    const hits = EMIT_MODULES.flatMap((f) =>
      findIn(f, (n) => (ts.isThrowStatement(n) ? "throw" : undefined)),
    );
    expect(hits).toEqual([]);
  });

  test("EMIT imports from PLAN only through import type; PLAN imports nothing from EMIT", () => {
    const bad: string[] = [];
    for (const f of EMIT_MODULES)
      for (const e of importsOf(f))
        if (!e.typeOnly && (plan.has(e.origin) || plan.has(e.direct)))
          bad.push(`${e.where} EMIT value import of PLAN ${e.origin}`);
    for (const f of PLAN_MODULES)
      for (const e of importsOf(f))
        if (emit.has(e.origin) || emit.has(e.direct))
          bad.push(`${e.where} PLAN import of EMIT ${e.origin}`);
    expect(bad).toEqual([]);
  });

  // Allowed: other EMIT modules (they cannot refuse, by the rules above) and reach-latch.ts
  // (one pure constant, REACH_LATCH, read by both halves). Nothing else is needed: a composition
  // such as printWithRewrites runs planEdits and can refuse, and a "neither" module may throw.
  const allowed = new Set([...EMIT_MODULES, "packages/schemata/src/reach-latch.ts"]);
  const allowListViolations = (file: string, sf?: ts.SourceFile): string[] =>
    importsOf(file, sf)
      .filter((e) => !e.typeOnly && !allowed.has(e.origin))
      .map((e) => `${e.where} EMIT value import of ${e.origin} is not on the allow-list`);

  test("EMIT value imports come only from the allow-list; everything else is import type", () => {
    expect(EMIT_MODULES.flatMap((f) => allowListViolations(f))).toEqual([]);
  });

  describe("the allow-list check rejects synthetic EMIT sources (R-442 regression plants)", () => {
    const host = EMIT_MODULES[0] ?? "";
    const run = (text: string): string[] =>
      allowListViolations(host, ts.createSourceFile(host, text, ts.ScriptTarget.Latest, true));
    test.each([
      ["static value import", 'import { readFileSync } from "node:fs";'],
      ["empty named import", 'import {} from "node:fs";'],
      ["empty named re-export", 'export {} from "node:fs";'],
      ["template-literal dynamic import", "const m = import(`node:fs`);"],
      ["concatenated dynamic import", 'const m = import("node:" + "fs");'],
    ])("rejects %s", (_name, text) => {
      expect(run(text)).toHaveLength(1);
    });
    test("accepts import type", () => {
      expect(run('import type { X } from "node:fs";')).toEqual([]);
      expect(run('import type {} from "node:fs";')).toEqual([]);
    });
  });

  test("EMIT modules use no ??, no ||, no .get( and no .find( (total lookups, no fallback)", () => {
    const fallback = new Set([
      ts.SyntaxKind.QuestionQuestionToken,
      ts.SyntaxKind.BarBarToken,
      ts.SyntaxKind.QuestionQuestionEqualsToken,
      ts.SyntaxKind.BarBarEqualsToken,
    ]);
    const hits = EMIT_MODULES.flatMap((f) =>
      findIn(f, (n) => {
        if (ts.isBinaryExpression(n) && fallback.has(n.operatorToken.kind))
          return n.operatorToken.getText();
        if (
          ts.isCallExpression(n) &&
          ts.isPropertyAccessExpression(n.expression) &&
          (n.expression.name.text === "get" || n.expression.name.text === "find")
        )
          return `.${n.expression.name.text}(`;
        return undefined;
      }),
    );
    expect(hits).toEqual([]);
  });

  test("composition modules hold only their named functions and build no FileRefusedError", () => {
    const held: Record<string, readonly string[]> = Object.fromEntries(
      composition.map((f) => [f, topLevelFunctions(f)]),
    );
    expect(held).toEqual({ ...COMPOSITION_MODULES });
    const refusals = composition.flatMap((f) =>
      findIn(f, (n) =>
        ts.isNewExpression(n) &&
        ts.isIdentifier(n.expression) &&
        n.expression.text === "FileRefusedError"
          ? "new FileRefusedError"
          : undefined,
      ),
    );
    expect(refusals).toEqual([]);
  });

  test("no PLAN, EMIT or composition module imports the dispatch.ts barrel", () => {
    const bad = planEmitOrComposition.flatMap((f) =>
      importsOf(f)
        .filter((e) => e.direct === DISPATCH_BARREL)
        .map((e) => e.where),
    );
    expect(bad).toEqual([]);
  });

  test("I4: EMIT_CRASHES is exactly the one crash, and the header comment names it", () => {
    const file = "packages/schemata/src/compile-emit.ts";
    const sf = parse(file);
    let entries: string[] | undefined;
    for (const st of sf.statements) {
      if (!ts.isVariableStatement(st)) continue;
      for (const d of st.declarationList.declarations) {
        if (!ts.isIdentifier(d.name) || d.name.text !== "EMIT_CRASHES") continue;
        let init = d.initializer;
        while (init !== undefined && (ts.isAsExpression(init) || ts.isSatisfiesExpression(init)))
          init = init.expression;
        if (init === undefined || !ts.isArrayLiteralExpression(init))
          throw new Error("EMIT_CRASHES is not an array literal");
        entries = init.elements.map((e) =>
          ts.isStringLiteral(e) ? e.text : `<not a string literal: ${e.getText(sf)}>`,
        );
      }
    }
    expect(entries).toEqual(["RangeError: Invalid string length"]);
    const header = (ts.getLeadingCommentRanges(sf.text, 0) ?? [])
      .map((r) => sf.text.slice(r.pos, r.end))
      .join("\n");
    expect(header).toContain("RangeError: Invalid string length");
    expect(header).toContain("EMIT_CRASHES");
  });
});
