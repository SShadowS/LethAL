import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { GATE_BASELINES, SYMBOL_BASELINES } from "../itest/baseline-guard";
import { SYMBOL_SETS } from "../itest/symbol-fixture";

/**
 * R332: the live gates run and exit at module top level, so they cannot be imported. Their wiring
 * is checked on the AST: comments and unused imports do not count, and a checked call must name a
 * function imported from `./baseline-guard`, so a local stub with the same name does not count.
 *
 * The writer scan reads every `*.ts` under `packages/<pkg>/src`, `packages/<pkg>/itest` and
 * `scripts`, and proves it reached each root. It skips `tests` folders and `*.test.ts` on purpose:
 * unit tests write temporary `*.baseline.json` files to exercise the guard. It also skips
 * `packages/runner/itest/baseline-guard.ts` (the one writer) and allows exactly one plain import of
 * the self-recording helper in `packages/runner/src/campaign-freeze.ts`.
 *
 * Known ways past these checks (it is a pattern check, not a data-flow analysis):
 * - A destination with no "baseline" in its text and no variable traced to one. Variables are
 *   traced by symbol, so same-named variables in other scopes stay apart, through any number of
 *   `const`/`let` hops and through `for...of` loops over something named like a baseline (so a
 *   loop over `GATE_BASELINES` IS caught), but not through anything else, for example a
 *   reassignment, a map lookup or a string built from unrelated parts.
 * - A baseline path passed as a function parameter: `save(BASELINE_PATH)` then `writeFile(p)`
 *   inside `save`. The parameter is not traced back to its callers.
 * - Writers the scan does not know: file handles (`open` then `.write`), `openSync`/`writeSync`,
 *   shell commands (`Bun.$`, spawn), other libraries' writers under other names, and element
 *   access such as `Bun["write"]`.
 * - A re-export of a writer under another name (a re-export of the self-recording helper itself
 *   IS caught).
 * - Files outside the scanned roots (tests folders, fixtures, docs, repro, `.claude`).
 * - For the preflight: a call inside an `if` or a closure before the first await is accepted even
 *   though it might not run, and async work started without `await` before it is not seen.
 * The offline runs in the R332 plan (Task 9) are the behavioural backstop for the gates.
 */
const ROOT = join(import.meta.dir, "..", "..", "..");
const ITEST = join(ROOT, "packages", "runner", "itest");
const GUARD = "./baseline-guard";
const parse = (path: string): ts.SourceFile =>
  ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
const repoPath = (p: string): string => relative(ROOT, p).replace(/\\/g, "/");

const WRITERS = new Set([
  "writeFile",
  "writeFileSync",
  "appendFile",
  "appendFileSync",
  "copyFile",
  "copyFileSync",
  "rename",
  "renameSync",
  "cp",
  "cpSync",
  "createWriteStream",
]);
const FS_MODULES = new Set(["node:fs", "node:fs/promises", "fs", "fs/promises"]);
const LOOKS_LIKE_BASELINE = /baseline/i;
const DEST_IS_SECOND = new Set([
  "copyFile",
  "copyFileSync",
  "rename",
  "renameSync",
  "cp",
  "cpSync",
]);
const SELF_RECORDING = "assertMatchesBaseline";

/** Every identifier a binding (plain, array or object pattern) introduces. */
function boundNames(b: ts.BindingName): ts.Identifier[] {
  if (ts.isIdentifier(b)) return [b];
  return b.elements.flatMap((e) => (ts.isBindingElement(e) ? boundNames(e.name) : []));
}

/** True when any identifier inside `n` (or `n` itself) satisfies `hit`. */
function mentions(n: ts.Node, hit: (id: ts.Identifier) => boolean): boolean {
  if (ts.isIdentifier(n)) return hit(n);
  return ts.forEachChild(n, (c) => mentions(c, hit) || undefined) ?? false;
}

/**
 * Parse sources as one program so the checker can tell two variables with the same name in
 * different scopes apart. No lib and no module resolution: only local symbols are needed.
 */
function analyse(sources: Record<string, string>): {
  checker: ts.TypeChecker;
  file: (path: string) => ts.SourceFile;
} {
  const options: ts.CompilerOptions = { noLib: true, noResolve: true, types: [] };
  const host = ts.createCompilerHost(options, true);
  host.getSourceFile = (f, lang) => {
    const text = sources[f];
    return text === undefined ? undefined : ts.createSourceFile(f, text, lang, true);
  };
  host.fileExists = (f) => sources[f] !== undefined;
  host.readFile = (f) => sources[f];
  const program = ts.createProgram(Object.keys(sources), options, host);
  const checker = program.getTypeChecker();
  return {
    checker,
    file: (path) => {
      const sf = program.getSourceFile(path);
      if (sf === undefined) throw new Error(`${path}: not in the program`);
      return sf;
    },
  };
}
const slash = (p: string): string => p.replace(/\\/g, "/");

/**
 * Every way this source could write a baseline outside baseline-guard.ts. Empty is clean.
 * `exemptOneImport` allows exactly one plain (unaliased) import of the self-recording helper.
 */
function writeViolations(
  sf: ts.SourceFile,
  checker: ts.TypeChecker,
  exemptOneImport = false,
): string[] {
  const out: string[] = [];
  const at = (n: ts.Node) =>
    `${sf.fileName}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`;
  const writerNames = new Set(WRITERS);
  // Keyed by symbol, so a `dir` traced to a baseline in one function does not taint another
  // function's `dir`. An identifier with no symbol (undeclared) falls back to its name.
  const baselineVars = new Set<ts.Symbol | string>();
  const key = (id: ts.Identifier): ts.Symbol | string => checker.getSymbolAtLocation(id) ?? id.text;
  const tracesToBaseline = (e: ts.Node): boolean =>
    LOOKS_LIKE_BASELINE.test(e.getText(sf)) || mentions(e, (id) => baselineVars.has(key(id)));
  const collect = (n: ts.Node): void => {
    if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) {
      const bindings = n.importClause?.namedBindings;
      if (FS_MODULES.has(n.moduleSpecifier.text) && bindings && ts.isNamedImports(bindings)) {
        for (const s of bindings.elements) {
          if (WRITERS.has((s.propertyName ?? s.name).text)) writerNames.add(s.name.text);
        }
      }
    }
    if (ts.isVariableDeclaration(n) && n.initializer) {
      const init = n.initializer;
      // `const { writeFile: w } = await import("node:fs/promises")` or `= require("fs")`.
      if (ts.isObjectBindingPattern(n.name)) {
        const fromFs = [...FS_MODULES].some((m) => init.getText(sf).includes(`"${m}"`));
        for (const e of n.name.elements) {
          const key = e.propertyName ?? e.name;
          if (fromFs && ts.isIdentifier(key) && WRITERS.has(key.text) && ts.isIdentifier(e.name)) {
            writerNames.add(e.name.text);
          }
        }
      }
      if (tracesToBaseline(init)) for (const v of boundNames(n.name)) baselineVars.add(key(v));
    }
    // `for (const n of Object.keys(GATE_BASELINES))`: the loop variable is a baseline name.
    if (
      (ts.isForOfStatement(n) || ts.isForInStatement(n)) &&
      ts.isVariableDeclarationList(n.initializer) &&
      tracesToBaseline(n.expression)
    ) {
      for (const d of n.initializer.declarations) {
        for (const v of boundNames(d.name)) baselineVars.add(key(v));
      }
    }
    ts.forEachChild(n, collect);
  };
  collect(sf);
  let allowedImports = exemptOneImport ? 1 : 0;
  const visit = (n: ts.Node): void => {
    if (ts.isImportSpecifier(n) && (n.propertyName ?? n.name).text === SELF_RECORDING) {
      if (n.propertyName === undefined && allowedImports > 0) allowedImports--;
      else out.push(`${at(n)}: imports the self-recording ${SELF_RECORDING} (as ${n.name.text})`);
    }
    if (ts.isExportSpecifier(n) && (n.propertyName ?? n.name).text === SELF_RECORDING) {
      out.push(`${at(n)}: re-exports the self-recording ${SELF_RECORDING}`);
    }
    if (ts.isPropertyAccessExpression(n) && n.name.text === SELF_RECORDING) {
      out.push(`${at(n)}: calls <namespace>.${SELF_RECORDING}`);
    }
    if (ts.isCallExpression(n)) {
      const c = n.expression;
      const name = ts.isIdentifier(c)
        ? c.text
        : ts.isPropertyAccessExpression(c)
          ? c.name.text
          : "";
      const bunWrite =
        ts.isPropertyAccessExpression(c) && c.expression.getText(sf) === "Bun" && name === "write";
      // `Bun.file(p).write(...)`: the destination is `Bun.file`'s argument.
      const bunFile =
        ts.isPropertyAccessExpression(c) &&
        name === "write" &&
        ts.isCallExpression(c.expression) &&
        c.expression.expression.getText(sf) === "Bun.file"
          ? c.expression
          : undefined;
      const fsWrite = ts.isIdentifier(c) ? writerNames.has(name) : WRITERS.has(name);
      // The DESTINATION only: arg 1 for copy/rename/cp, arg 0 otherwise. Checking every argument
      // would flag `writeFile(out, JSON.stringify(baselineSnapshot))`, a false positive.
      const dest =
        bunFile !== undefined
          ? bunFile.arguments[0]
          : n.arguments[DEST_IS_SECOND.has(name) ? 1 : 0];
      const kind = bunFile !== undefined ? "Bun.file().write" : bunWrite ? "Bun.write" : name;
      if (
        (bunWrite || bunFile !== undefined || fsWrite) &&
        dest !== undefined &&
        tracesToBaseline(dest)
      ) {
        out.push(`${at(n)}: ${kind}(...) targets a baseline`);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

function mainOf(sf: ts.SourceFile): ts.FunctionDeclaration {
  const m = sf.statements.find(
    (s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === "main",
  );
  if (m?.body === undefined) throw new Error(`${sf.fileName}: no function main()`);
  return m;
}

/** True when `sf` imports `fn`, unaliased, by name from `from`. */
function importsFrom(sf: ts.SourceFile, fn: string, from: string): boolean {
  return sf.statements.some((s) => {
    if (!ts.isImportDeclaration(s) || !ts.isStringLiteral(s.moduleSpecifier)) return false;
    const b = s.importClause?.namedBindings;
    return (
      s.moduleSpecifier.text === from &&
      b !== undefined &&
      ts.isNamedImports(b) &&
      b.elements.some((e) => e.name.text === fn && (e.propertyName ?? e.name).text === fn)
    );
  });
}

/** Calls of `fn` under `root`, counted only when `fn` is imported from `from`. */
function calls(root: ts.Node, sf: ts.SourceFile, fn: string, from = GUARD): ts.CallExpression[] {
  if (!importsFrom(sf, fn, from)) return [];
  const found: ts.CallExpression[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === fn)
      found.push(n);
    ts.forEachChild(n, visit);
  };
  visit(root);
  return found;
}

const hasAwait = (n: ts.Node): boolean =>
  ts.isAwaitExpression(n) || (ts.forEachChild(n, hasAwait) ?? false);

/** The statements of main() before the first one that awaits. */
function preAwait(sf: ts.SourceFile): ts.Statement[] {
  const stmts = mainOf(sf).body?.statements ?? [];
  const i = stmts.findIndex(hasAwait);
  return i < 0 ? [...stmts] : stmts.slice(0, i);
}

/** `const BASELINE_PATH = join(HERE, "<literal>")`, returning the literal. */
function baselineName(sf: ts.SourceFile): string {
  for (const s of sf.statements) {
    if (!ts.isVariableStatement(s)) continue;
    for (const d of s.declarationList.declarations) {
      if (!ts.isIdentifier(d.name) || d.name.text !== "BASELINE_PATH") continue;
      const i = d.initializer;
      if (
        i &&
        ts.isCallExpression(i) &&
        i.expression.getText(sf) === "join" &&
        i.arguments.length === 2
      ) {
        const [dir, lit] = i.arguments;
        if (dir && lit && dir.getText(sf) === "HERE" && ts.isStringLiteral(lit)) return lit.text;
      }
    }
  }
  throw new Error(`${sf.fileName}: BASELINE_PATH is not join(HERE, "<name>")`);
}

/** `process.exit(err instanceof BaselineRecordedError ? 3 : 1)` somewhere in the file. */
function exitsThreeOnRecord(sf: ts.SourceFile): boolean {
  let ok = false;
  const visit = (n: ts.Node): void => {
    const arg = ts.isCallExpression(n) ? n.arguments[0] : undefined;
    if (
      ts.isCallExpression(n) &&
      n.expression.getText(sf) === "process.exit" &&
      arg !== undefined &&
      ts.isConditionalExpression(arg) &&
      ts.isBinaryExpression(arg.condition) &&
      arg.condition.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword &&
      arg.condition.right.getText(sf) === "BaselineRecordedError" &&
      arg.whenTrue.getText(sf) === "3"
    ) {
      ok = true;
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return ok;
}

const WRITING_GATES: Record<string, string> = {
  "al-runner.itest.ts": "al-runner.baseline.json",
  "bcdev.itest.ts": "bcdev.baseline.json",
  "envtool.itest.ts": "envtool.baseline.json",
  "harden.itest.ts": "harden.baseline.json",
  "tables.itest.ts": "tables.baseline.json",
};
const READERS: Record<string, string> = {
  "verify.itest.ts": "bcdev.baseline.json",
  "test-app-publish.itest.ts": "bcdev.baseline.json",
  "verify-agreement.itest.ts": "harden.baseline.json",
  "verify-scale.itest.ts": "tables.baseline.json",
};

/** The writer scan's roots: every package's src and itest, and scripts. */
function scanRoots(): string[] {
  const pkgs = join(ROOT, "packages");
  const roots = readdirSync(pkgs, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .flatMap((e) => ["src", "itest"].map((sub) => join(pkgs, e.name, sub)))
    .filter((d) => existsSync(d));
  return [...roots, join(ROOT, "scripts")];
}
/** One file each of these roots must yield, so a root that moved is noticed by name. */
const KNOWN: Record<string, string> = {
  "packages/runner/itest": "bcdev.itest.ts",
  "packages/runner/src": "campaign-subcommands.ts",
  "packages/engine/src": "index.ts",
  scripts: "roadmap-index.ts",
};

/** Non-test `*.ts` under `root`, minus the guard itself. */
function scannedFiles(root: string): string[] {
  const files: string[] = [];
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) {
        if (e.name !== "node_modules" && e.name !== "dist" && e.name !== "tests") walk(p);
      } else if (
        e.name.endsWith(".ts") &&
        !e.name.endsWith(".test.ts") &&
        repoPath(p) !== "packages/runner/itest/baseline-guard.ts"
      ) {
        files.push(p);
      }
    }
  };
  walk(root);
  return files;
}

describe("R332 wiring: real call sites, not text", () => {
  test("the registry equals the committed baselines, one directory, so basenames are unique", () => {
    const committed = readdirSync(ITEST)
      .filter((f) => f.endsWith(".baseline.json"))
      .sort();
    expect([...Object.keys(GATE_BASELINES), ...SYMBOL_BASELINES].sort()).toEqual(committed);
  });

  test("every registered gate baseline has a writing gate checked below; every reader names one", () => {
    expect(Object.values(WRITING_GATES).sort()).toEqual(Object.keys(GATE_BASELINES).sort());
    expect(Object.values(READERS).filter((n) => GATE_BASELINES[n] === undefined)).toEqual([]);
  });

  test("each writing gate: BASELINE_PATH, startup preflight, a real assertGateBaseline call, exit 3", () => {
    for (const [file, name] of Object.entries(WRITING_GATES)) {
      const sf = parse(join(ITEST, file));
      expect({ file, name: baselineName(sf) }).toEqual({ file, name });
      const head = preAwait(sf);
      const pre = head.flatMap((s) => calls(s, sf, "preflightGateBaseline"));
      expect({
        file,
        preflight: pre.some((c) => c.arguments[0]?.getText(sf) === "BASELINE_PATH"),
      }).toEqual({
        file,
        preflight: true,
      });
      const writerFile = file === "harden.itest.ts" ? "harden-expected.ts" : file;
      const wsf = parse(join(ITEST, writerFile));
      const root = file === "harden.itest.ts" ? wsf : mainOf(wsf);
      const asserted = calls(root, wsf, "assertGateBaseline").some((c) =>
        ["BASELINE_PATH", "baselinePath"].includes(c.arguments[1]?.getText(wsf) ?? ""),
      );
      expect({ file, asserted }).toEqual({ file, asserted: true });
      expect({ file, exit3: exitsThreeOnRecord(sf) }).toEqual({ file, exit3: true });
    }
    // harden: main() hands BASELINE_PATH to recordAfterBothLegs, whose body is checked above.
    const h = parse(join(ITEST, "harden.itest.ts"));
    expect(
      calls(mainOf(h), h, "recordAfterBothLegs", "./harden-expected").some(
        (c) => c.arguments[2]?.getText(h) === "BASELINE_PATH",
      ),
    ).toBe(true);
  });

  test("al-runner: SYMBOL_SETS names exactly the registered symbol baselines", () => {
    const sf = parse(join(ITEST, "al-runner.itest.ts"));
    const fn = sf.statements.find(
      (s): s is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(s) && s.name?.text === "symbolBaselinePath",
    );
    const returned = fn?.body?.statements.find(ts.isReturnStatement)?.expression?.getText(sf);
    expect(returned).toBe(
      'join(HERE, `al-runner.symbols-${symbols.join("-").toLowerCase()}.baseline.json`)',
    );
    const names = SYMBOL_SETS.map(
      (s) => `al-runner.symbols-${s.join("-").toLowerCase()}.baseline.json`,
    );
    expect([...names].sort()).toEqual([...SYMBOL_BASELINES].sort());
  });

  test("al-runner preflights BOTH symbol baselines before its first await", () => {
    const sf = parse(join(ITEST, "al-runner.itest.ts"));
    const pre = preAwait(sf).flatMap((s) => calls(s, sf, "preflightFrozenBaseline"));
    expect(pre.map((c) => c.arguments.map((a) => a.getText(sf)))).toEqual([
      ["symbolBaselinePath(symbols)", '"al-runner itest symbols"', "RECORD_SYMBOL_BASELINES"],
    ]);
    const loop = preAwait(sf).find(ts.isForOfStatement);
    expect(loop?.expression.getText(sf)).toBe("SYMBOL_SETS");
  });

  test("al-runner writes the symbol baselines only through assertMatchesFrozenBaseline, per set", () => {
    const sf = parse(join(ITEST, "al-runner.itest.ts"));
    const inSymbolLoop = (n: ts.Node): boolean => {
      for (let p = n.parent; p !== undefined; p = p.parent) {
        if (ts.isForOfStatement(p) && p.expression.getText(sf) === "SYMBOL_SETS") return true;
      }
      return false;
    };
    const writes = calls(sf, sf, "assertMatchesFrozenBaseline").filter(
      (c) =>
        c.arguments[1]?.getText(sf) === "symbolBaselinePath(symbols)" &&
        c.arguments[3]?.getText(sf) === "RECORD_SYMBOL_BASELINES" &&
        inSymbolLoop(c),
    );
    expect(writes.length).toBeGreaterThan(0);
  });

  test("each reader: BASELINE_PATH and a startup preflightReadOnlyBaseline", () => {
    for (const [file, name] of Object.entries(READERS)) {
      const sf = parse(join(ITEST, file));
      expect({ file, name: baselineName(sf) }).toEqual({ file, name });
      const pre = preAwait(sf).flatMap((s) => calls(s, sf, "preflightReadOnlyBaseline"));
      expect({
        file,
        preflight: pre.some((c) => c.arguments[0]?.getText(sf) === "BASELINE_PATH"),
      }).toEqual({
        file,
        preflight: true,
      });
    }
  });

  test("no non-test source under packages/*/src, packages/*/itest or scripts writes a baseline, except the guard and campaign freeze", () => {
    const roots = scanRoots();
    const files: string[] = [];
    for (const root of roots) {
      const seen = scannedFiles(root);
      const known = KNOWN[repoPath(root)];
      expect({
        root: repoPath(root),
        visited: seen.length > 0,
        known: known === undefined || seen.includes(join(root, known)),
      }).toEqual({ root: repoPath(root), visited: true, known: true });
      files.push(...seen);
    }
    expect(Object.keys(KNOWN).filter((k) => !roots.map(repoPath).includes(k))).toEqual([]);
    const { checker, file } = analyse(
      Object.fromEntries(files.map((f) => [slash(f), readFileSync(f, "utf8")])),
    );
    const found = files.flatMap((f) =>
      writeViolations(
        file(slash(f)),
        checker,
        repoPath(f) === "packages/runner/src/campaign-freeze.ts",
      ),
    );
    expect(found).toEqual([]);
  });
});

describe("R332 wiring: the checker catches alternate writers (negative tests)", () => {
  const src = (text: string) => ts.createSourceFile("x.ts", text, ts.ScriptTarget.Latest, true);
  const violations = (text: string, exempt = false): string[] => {
    const { checker, file } = analyse({ "/x.ts": text });
    return writeViolations(file("/x.ts"), checker, exempt);
  };

  test.each([
    [
      "direct writeFile",
      `import { writeFile } from "node:fs/promises";\nawait writeFile(BASELINE_PATH, "x");`,
    ],
    [
      "aliased writeFile through a variable",
      `import { writeFile as w } from "node:fs/promises";\nconst p = join(HERE, "bcdev.baseline.json");\nawait w(p, "x");`,
    ],
    [
      "a path through two variables",
      `import { writeFile } from "node:fs/promises";\nconst a = BASELINE_PATH;\nconst b = a;\nawait writeFile(b, "x");`,
    ],
    [
      "a loop over the registry",
      `import { writeFile } from "node:fs/promises";\nfor (const n of Object.keys(GATE_BASELINES)) await writeFile(join(HERE, n), "x");`,
    ],
    [
      "a destructured writer from a dynamic import",
      `const { writeFile: w } = await import("node:fs/promises");\nawait w(BASELINE_PATH, "x");`,
    ],
    [
      "namespace fs",
      `import * as fsp from "node:fs/promises";\nawait fsp.writeFile(BASELINE_PATH, "x");`,
    ],
    ["Bun.write", `await Bun.write(BASELINE_PATH, "x");`],
    ["Bun.file().write", `await Bun.file(BASELINE_PATH).write("x");`],
    [
      "copyFile onto a baseline",
      `import { copyFile } from "node:fs/promises";\nawait copyFile(tmp, BASELINE_PATH);`,
    ],
    [
      "aliased self-recording helper",
      `import { assertMatchesBaseline as check } from "./baseline-guard";\nawait check(r, BASELINE_PATH, "x");`,
    ],
    [
      "namespace self-recording helper",
      `import * as g from "./baseline-guard";\nawait g.assertMatchesBaseline(r, BASELINE_PATH, "x");`,
    ],
    [
      "re-exported self-recording helper",
      `export { assertMatchesBaseline as amb } from "./baseline-guard";`,
    ],
  ])("%s is a violation", (_name, text) => {
    expect(violations(text).length).toBeGreaterThan(0);
  });

  test.each([
    ["a comment", `// await writeFile(BASELINE_PATH, "x");\nconst a = 1;`],
    [
      "a scratch write",
      `import { writeFile } from "node:fs/promises";\nawait writeFile(join(scratch, "out.json"), "x");`,
    ],
    ["reading a baseline", `const raw = await readFile(BASELINE_PATH, "utf8");`],
    [
      "a baseline in the CONTENT, not the destination",
      `import { writeFile } from "node:fs/promises";\nawait writeFile(outPath, JSON.stringify(baselineSnapshot));`,
    ],
  ])("%s is clean", (_name, text) => {
    expect(violations(text)).toEqual([]);
  });

  test("the campaign-freeze exemption allows exactly one plain import, nothing else", () => {
    const plain = `import { assertMatchesBaseline } from "../itest/baseline-guard";\nawait assertMatchesBaseline(r, p, s);`;
    expect(violations(plain, true)).toEqual([]);
    expect(violations(plain, false).length).toBeGreaterThan(0);
    const aliased = `import { assertMatchesBaseline as a } from "../itest/baseline-guard";`;
    expect(violations(aliased, true).length).toBeGreaterThan(0);
    const twice = `${plain}\nimport { assertMatchesBaseline } from "./other";`;
    expect(violations(twice, true).length).toBeGreaterThan(0);
    const ns = `import * as g from "../itest/baseline-guard";\nawait g.assertMatchesBaseline(r, p, s);`;
    expect(violations(ns, true).length).toBeGreaterThan(0);
  });

  test("a preflight in a comment, after an await, or from a local stub does not count", () => {
    const imp = `import { preflightGateBaseline } from "./baseline-guard";\n`;
    const commented = src(
      `${imp}const BASELINE_PATH = join(HERE, "bcdev.baseline.json");\nasync function main(): Promise<void> {\n  // preflightGateBaseline(BASELINE_PATH, "x");\n  await go();\n}`,
    );
    expect(
      preAwait(commented).flatMap((s) => calls(s, commented, "preflightGateBaseline")),
    ).toEqual([]);
    const late = src(
      `${imp}async function main(): Promise<void> {\n  await go();\n  preflightGateBaseline(BASELINE_PATH, "x");\n}`,
    );
    expect(preAwait(late).flatMap((s) => calls(s, late, "preflightGateBaseline"))).toEqual([]);
    const stub = src(
      `function preflightGateBaseline(p: string, w: string): void {}\nasync function main(): Promise<void> {\n  preflightGateBaseline(BASELINE_PATH, "x");\n  await go();\n}`,
    );
    expect(preAwait(stub).flatMap((s) => calls(s, stub, "preflightGateBaseline"))).toEqual([]);
    const real = src(
      `${imp}async function main(): Promise<void> {\n  preflightGateBaseline(BASELINE_PATH, "x");\n  await go();\n}`,
    );
    expect(preAwait(real).flatMap((s) => calls(s, real, "preflightGateBaseline")).length).toBe(1);
  });
});
