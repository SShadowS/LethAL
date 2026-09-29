import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { GATE_BASELINES, SYMBOL_BASELINES } from "../itest/baseline-guard";

/**
 * R332: the live gates run and exit at module top level, so they cannot be imported. Their wiring
 * is checked on the AST: comments and unused imports do not count. Limits: a baseline path that
 * flows through more than one variable, or a call in unreachable code, is not seen here; the
 * offline runs in the R332 plan (Task 9) are the behavioural proof for the gates.
 */
const ROOT = join(import.meta.dir, "..", "..", "..");
const ITEST = join(ROOT, "packages", "runner", "itest");
const parse = (path: string): ts.SourceFile =>
  ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);

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

/** Every way this source could write a baseline outside baseline-guard.ts. Empty is clean. */
function writeViolations(sf: ts.SourceFile, allowSelfRecordingImport = false): string[] {
  const out: string[] = [];
  const at = (n: ts.Node) =>
    `${sf.fileName}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`;
  const writerNames = new Set(WRITERS);
  const baselineVars = new Set<string>();
  const collect = (n: ts.Node): void => {
    if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) {
      const bindings = n.importClause?.namedBindings;
      if (FS_MODULES.has(n.moduleSpecifier.text) && bindings && ts.isNamedImports(bindings)) {
        for (const s of bindings.elements) {
          if (WRITERS.has((s.propertyName ?? s.name).text)) writerNames.add(s.name.text);
        }
      }
    }
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
      if (LOOKS_LIKE_BASELINE.test(n.initializer.getText(sf))) baselineVars.add(n.name.text);
    }
    ts.forEachChild(n, collect);
  };
  collect(sf);
  const targetsBaseline = (a: ts.Expression): boolean =>
    LOOKS_LIKE_BASELINE.test(a.getText(sf)) || (ts.isIdentifier(a) && baselineVars.has(a.text));
  const visit = (n: ts.Node): void => {
    if (
      ts.isImportSpecifier(n) &&
      (n.propertyName ?? n.name).text === "assertMatchesBaseline" &&
      !allowSelfRecordingImport
    ) {
      out.push(`${at(n)}: imports the self-recording assertMatchesBaseline (as ${n.name.text})`);
    }
    if (
      ts.isPropertyAccessExpression(n) &&
      n.name.text === "assertMatchesBaseline" &&
      !allowSelfRecordingImport
    ) {
      out.push(`${at(n)}: calls <namespace>.assertMatchesBaseline`);
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
      const fsWrite = ts.isIdentifier(c) ? writerNames.has(name) : WRITERS.has(name);
      // The DESTINATION only: arg 1 for copy/rename/cp, arg 0 otherwise. Checking every argument
      // would flag `writeFile(out, JSON.stringify(baselineSnapshot))`, a false positive.
      const dest = n.arguments[DEST_IS_SECOND.has(name) ? 1 : 0];
      if ((bunWrite || fsWrite) && dest !== undefined && targetsBaseline(dest)) {
        out.push(`${at(n)}: ${bunWrite ? "Bun.write" : name}(...) targets a baseline`);
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

function calls(root: ts.Node, sf: ts.SourceFile, fn: string): ts.CallExpression[] {
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

describe("R332 wiring: real call sites, not text", () => {
  test("the registry equals the committed baselines, one directory, so basenames are unique", () => {
    const committed = readdirSync(ITEST)
      .filter((f) => f.endsWith(".baseline.json"))
      .sort();
    expect([...Object.keys(GATE_BASELINES), ...SYMBOL_BASELINES].sort()).toEqual(committed);
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
      calls(mainOf(h), h, "recordAfterBothLegs").some(
        (c) => c.arguments[2]?.getText(h) === "BASELINE_PATH",
      ),
    ).toBe(true);
  });

  test("al-runner preflights BOTH symbol baselines before its first await", () => {
    const sf = parse(join(ITEST, "al-runner.itest.ts"));
    const pre = preAwait(sf).flatMap((s) => calls(s, sf, "preflightFrozenBaseline"));
    expect(pre.map((c) => c.arguments[0]?.getText(sf))).toEqual(["symbolBaselinePath(symbols)"]);
    const loop = preAwait(sf).find(ts.isForOfStatement);
    expect(loop?.expression.getText(sf)).toBe("SYMBOL_SETS");
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

  test("no source anywhere writes a baseline except baseline-guard.ts", () => {
    // Each root with one file the walk must reach, so the scan can never pass by visiting nothing.
    const roots: Record<string, string> = {
      [ITEST]: "bcdev.itest.ts",
      [join(ROOT, "packages", "runner", "src")]: "campaign-subcommands.ts",
      [join(ROOT, "scripts")]: "roadmap-index.ts",
    };
    const files: string[] = [];
    const walk = (d: string): void => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) {
          if (e.name !== "node_modules" && e.name !== "dist") walk(p);
        } else if (
          e.name.endsWith(".ts") &&
          !e.name.endsWith(".test.ts") &&
          e.name !== "baseline-guard.ts"
        ) {
          files.push(p);
        }
      }
    };
    for (const [root, known] of Object.entries(roots)) {
      const before = files.length;
      walk(root);
      const seen = files.slice(before);
      expect({ root, visited: seen.length > 0, known: seen.includes(join(root, known)) }).toEqual({
        root,
        visited: true,
        known: true,
      });
    }
    const found = files.flatMap((f) =>
      writeViolations(
        parse(f),
        relative(ROOT, f).replace(/\\/g, "/") === "packages/runner/src/campaign-freeze.ts",
      ),
    );
    expect(found).toEqual([]);
  });
});

describe("R332 wiring: the checker catches alternate writers (negative tests)", () => {
  const src = (text: string) => ts.createSourceFile("x.ts", text, ts.ScriptTarget.Latest, true);

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
      "namespace fs",
      `import * as fsp from "node:fs/promises";\nawait fsp.writeFile(BASELINE_PATH, "x");`,
    ],
    ["Bun.write", `await Bun.write(BASELINE_PATH, "x");`],
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
  ])("%s is a violation", (_name, text) => {
    expect(writeViolations(src(text)).length).toBeGreaterThan(0);
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
    expect(writeViolations(src(text))).toEqual([]);
  });

  test("a preflight in a comment, or after an await, does not count", () => {
    const commented = src(
      `const BASELINE_PATH = join(HERE, "bcdev.baseline.json");\nasync function main(): Promise<void> {\n  // preflightGateBaseline(BASELINE_PATH, "x");\n  await go();\n}`,
    );
    expect(
      preAwait(commented).flatMap((s) => calls(s, commented, "preflightGateBaseline")),
    ).toEqual([]);
    const late = src(
      `async function main(): Promise<void> {\n  await go();\n  preflightGateBaseline(BASELINE_PATH, "x");\n}`,
    );
    expect(preAwait(late).flatMap((s) => calls(s, late, "preflightGateBaseline"))).toEqual([]);
  });
});
