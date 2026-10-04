import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";

/**
 * R-307 O2, source scan part 1. Every `FileRefusedError` is built at one of twelve named sites, and
 * each construction says which one in a literal `site:` property, so a refusal can be traced to
 * the code that raised it and the PLAN/EMIT split can show no site moved or vanished. Parsed with
 * the TypeScript compiler, so a comment or a string cannot hit.
 */

const REPO = resolve(import.meta.dir, "../../..");

/** The twelve sites, in the order the scan meets them (file path, then source order). */
const PINNED_SITES = [
  "rewrite.overlap",
  "compile.latch-owner",
  "compile.latch-preamble-anchor",
  "compile.latch-split-var-anchor",
  "compile.latch-var-anchor",
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

  test("the site ids are exactly the twelve pinned ones, each once", () => {
    expect(result.constructions.map((c) => c.site)).toEqual(PINNED_SITES);
  });

  test("no construction without new, and no subclass", () => {
    expect(result.problems).toEqual([]);
  });
});
