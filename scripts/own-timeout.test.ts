import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import ts from "@typescript/typescript6";
import { WINDOWS_CI_OWN_TIMEOUT_MS, ownTimeout } from "../packages/engine/src/own-timeout";
import { WINDOWS_CI_TIMEOUT_MS } from "./verify.ts";

describe("R726 ownTimeout: a short own timeout is raised on Windows CI only", () => {
  test("Windows CI raises a short timeout to 60000 and keeps a longer one", () => {
    expect(WINDOWS_CI_OWN_TIMEOUT_MS).toBe(WINDOWS_CI_TIMEOUT_MS); // one number, two files
    expect(ownTimeout(2_000, "win32", true)).toBe(WINDOWS_CI_TIMEOUT_MS);
    expect(ownTimeout(30_000, "win32", true)).toBe(60_000);
    expect(ownTimeout(120_000, "win32", true)).toBe(120_000);
  });
  test("Linux CI, and Windows outside CI, keep the timeout as written", () => {
    expect(ownTimeout(30_000, "linux", true)).toBe(30_000);
    expect(ownTimeout(30_000, "win32", false)).toBe(30_000);
    expect(ownTimeout(30_000, "linux", false)).toBe(30_000);
    expect(ownTimeout(2_000, "darwin", true)).toBe(2_000);
  });
});

const TEST_FNS = new Set([
  "test",
  "it",
  "bunTest",
  "beforeAll",
  "afterAll",
  "beforeEach",
  "afterEach",
  "setDefaultTimeout",
]);

function root(e: ts.Expression): string {
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e) || ts.isCallExpression(e)) return root(e.expression);
  return "";
}

/** Literal own timeouts under 60 s, as `line: value`. A wrapped value (`ownTimeout(...)`) is not a literal. */
function shortLiteralTimeouts(file: string, text: string): string[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && TEST_FNS.has(root(n.expression))) {
      const name = root(n.expression);
      const last = n.arguments[n.arguments.length - 1];
      let v: string | undefined;
      if (last !== undefined) {
        if (ts.isNumericLiteral(last) && (n.arguments.length > 1 || name === "setDefaultTimeout"))
          v = last.text;
        else if (ts.isObjectLiteralExpression(last)) {
          for (const p of last.properties)
            if (ts.isPropertyAssignment(p) && p.name.getText() === "timeout")
              v = p.initializer.getText();
        }
      }
      if (v !== undefined && Number(v.replace(/_/g, "")) < WINDOWS_CI_TIMEOUT_MS)
        found.push(`${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}: ${name} ${v}`);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}

describe("R726 guard: no unit test passes a literal own timeout under 60 s", () => {
  test("the scanner flags literals and passes wrapped values", () => {
    expect(shortLiteralTimeouts("a.ts", 'test("x", () => {}, 30_000);')).toEqual(["1: test 30000"]);
    expect(
      shortLiteralTimeouts("a.ts", "setDefaultTimeout(5000); afterAll(f, 1_000);").length,
    ).toBe(2);
    expect(shortLiteralTimeouts("a.ts", 'test("x", f, { timeout: 2000 });').length).toBe(1);
    expect(shortLiteralTimeouts("a.ts", 'test.skipIf(c)("x", f, 40_000);').length).toBe(1);
    expect(shortLiteralTimeouts("a.ts", 'test("x", f, ownTimeout(30_000));')).toEqual([]);
    expect(shortLiteralTimeouts("a.ts", 'test("x", f, 60_000); test("y", f, 120_000);')).toEqual(
      [],
    );
  });
  test("every unit test file wraps its short own timeouts in ownTimeout", async () => {
    const repo = join(import.meta.dir, "..");
    const bad: string[] = [];
    let files = 0;
    for (const pat of [
      "packages/*/tests/**/*.test.ts",
      "packages/*/itest/**/*.test.ts",
      "scripts/**/*.test.ts",
    ]) {
      for await (const f of new Bun.Glob(pat).scan({ cwd: repo })) {
        files++;
        for (const hit of shortLiteralTimeouts(f, await Bun.file(join(repo, f)).text()))
          bad.push(`${f}:${hit}`);
      }
    }
    expect(files).toBeGreaterThan(100); // the scan really read the tree
    expect(bad, `wrap in ownTimeout() from @lethal/engine/own-timeout:\n${bad.join("\n")}`).toEqual(
      [],
    );
  });
});
