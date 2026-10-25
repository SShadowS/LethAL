import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import ts from "@typescript/typescript6";
import { ownTimeout } from "../packages/engine/src/own-timeout";
import {
  OWN_TIMEOUT_FLOOR_ENV,
  WINDOWS_CI_TIMEOUT_MS,
  testChildEnv,
  testTimeout,
} from "./verify.ts";

describe("R726c ownTimeout: verify's marker raises a short own timeout, nothing else does", () => {
  test("the floor raises a short timeout and keeps a longer one", () => {
    expect(ownTimeout(2_000, 60_000)).toBe(60_000);
    expect(ownTimeout(30_000, 60_000)).toBe(60_000);
    expect(ownTimeout(120_000, 60_000)).toBe(120_000);
    expect(ownTimeout(30_000, 0)).toBe(30_000);
  });
  test("the DEFAULT floor reads the marker in this process's env", () => {
    const saved = process.env[OWN_TIMEOUT_FLOOR_ENV];
    try {
      process.env[OWN_TIMEOUT_FLOOR_ENV] = "60000";
      expect(ownTimeout(1)).toBe(60_000);
      delete process.env[OWN_TIMEOUT_FLOOR_ENV];
      expect(ownTimeout(1)).toBe(1);
    } finally {
      if (saved === undefined) delete process.env[OWN_TIMEOUT_FLOOR_ENV];
      else process.env[OWN_TIMEOUT_FLOOR_ENV] = saved;
    }
  });
  test("the env name is the one the helper reads", () => {
    expect(OWN_TIMEOUT_FLOOR_ENV).toBe("LETHAL_VERIFY_OWN_TIMEOUT_FLOOR");
  });
  test("verify sets the marker on Windows CI only", () => {
    const floorFor = (platform: string, ci: boolean): string | undefined =>
      testChildEnv({}, testTimeout(undefined, platform, ci).ownFloorMs)[OWN_TIMEOUT_FLOOR_ENV];
    expect(floorFor("win32", true)).toBe(String(WINDOWS_CI_TIMEOUT_MS));
    expect(floorFor("win32", false)).toBeUndefined(); // the owner's local Windows run
    expect(floorFor("linux", true)).toBeUndefined();
    expect(floorFor("linux", false)).toBeUndefined();
  });
  test("an inherited marker is dropped, so only verify can set it", () => {
    expect(
      testChildEnv({ [OWN_TIMEOUT_FLOOR_ENV]: "60000" })[OWN_TIMEOUT_FLOOR_ENV],
    ).toBeUndefined();
    expect(
      testChildEnv({ [OWN_TIMEOUT_FLOOR_ENV]: "1", LETHAL_TEST_ALLOW_SNAPSHOT_CREATE: "1" })[
        OWN_TIMEOUT_FLOOR_ENV
      ],
    ).toBeUndefined();
    expect(testChildEnv({}, 60_000).CI).toBe("true");
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

/** Computed values that are deliberate, by file and exact expression text. Say why. */
const ALLOWED: Record<string, string> = {
  "packages/runner/tests/r214-history.test.ts|ownTimeout(15_000) + 15_000":
    "afterAll must outlast the per-test guard, which is itself wrapped",
};

function root(e: ts.Expression): string {
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e) || ts.isCallExpression(e)) return root(e.expression);
  return "";
}

const num = (e: ts.Expression): number | undefined =>
  ts.isNumericLiteral(e) ? Number(e.text.replace(/_/g, "")) : undefined;

/**
 * Own timeouts that would stay under 60 s on Windows CI, as `file:line: why`. OK: a literal of 60 s
 * or more, `ownTimeout(...)`, an identifier naming a same-file `const` with such a value, and an
 * ALLOWED expression. Flagged: a short literal or const, and any other computed value
 * (`15_000 * 2`, `ownTimeout(x) + 1`, a conditional). A callback or an unresolved identifier is not
 * a timeout we can judge and is skipped.
 */
function unwrappedTimeouts(file: string, text: string): string[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const consts = new Map<string, number>();
  for (const st of sf.statements)
    if (ts.isVariableStatement(st) && st.declarationList.flags & ts.NodeFlags.Const)
      for (const d of st.declarationList.declarations) {
        const v = d.initializer !== undefined ? num(d.initializer) : undefined;
        if (ts.isIdentifier(d.name) && v !== undefined) consts.set(d.name.text, v);
      }
  const found: string[] = [];
  const judge = (e: ts.Expression, at: ts.Node, name: string): void => {
    const where = `${sf.getLineAndCharacterOfPosition(at.getStart()).line + 1}: ${name}`;
    const lit = num(e);
    if (lit !== undefined) {
      if (lit < WINDOWS_CI_TIMEOUT_MS) found.push(`${where} ${e.getText()}`);
      return;
    }
    if (ts.isIdentifier(e)) {
      const c = consts.get(e.text);
      if (c !== undefined && c < WINDOWS_CI_TIMEOUT_MS) found.push(`${where} ${e.text} = ${c}`);
      return;
    }
    if (
      ts.isCallExpression(e) &&
      ts.isIdentifier(e.expression) &&
      e.expression.text === "ownTimeout"
    )
      return;
    if (
      ts.isBinaryExpression(e) ||
      ts.isConditionalExpression(e) ||
      ts.isParenthesizedExpression(e)
    ) {
      // Bun.Glob gives `\` paths on Windows; ALLOWED keys use `/`.
      if (ALLOWED[`${file.replaceAll("\\", "/")}|${e.getText()}`] === undefined)
        found.push(`${where} computed: ${e.getText()}`);
    }
  };
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && TEST_FNS.has(root(n.expression))) {
      const name = root(n.expression);
      const last = n.arguments[n.arguments.length - 1];
      if (last !== undefined) {
        if (ts.isObjectLiteralExpression(last)) {
          for (const p of last.properties)
            if (ts.isPropertyAssignment(p) && p.name.getText() === "timeout")
              judge(p.initializer, n, name);
        } else if (n.arguments.length > 1 || name === "setDefaultTimeout") judge(last, n, name);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}

describe("R726 guard: no unit test leaves a short own timeout unwrapped", () => {
  test("the scanner flags literals, consts and computed values, and passes wrapped ones", () => {
    const hits = (src: string): number => unwrappedTimeouts("a.ts", src).length;
    expect(unwrappedTimeouts("a.ts", 'test("x", () => {}, 30_000);')).toEqual(["1: test 30_000"]);
    expect(hits("setDefaultTimeout(5000); afterAll(f, 1_000);")).toBe(2);
    expect(hits('test("x", f, { timeout: 2000 });')).toBe(1);
    expect(hits('test.skipIf(c)("x", f, 40_000);')).toBe(1);
    expect(hits('test("x", f, ownTimeout(30_000));')).toBe(0);
    expect(hits('test("x", f, 60_000); test("y", f, 120_000);')).toBe(0);
    // A same-file const is judged by its value.
    expect(hits('const D = 30_000; afterAll(f, D); test("x", f, D);')).toBe(2);
    expect(hits('const D = ownTimeout(30_000); test("x", f, D);')).toBe(0);
    expect(hits('const D = 90_000; test("x", f, D);')).toBe(0);
    // Computed values are flagged unless allowed.
    expect(hits('test("x", f, 15_000 * 2);')).toBe(1);
    expect(hits('test("x", f, ownTimeout(x) + 1);')).toBe(1);
    expect(hits('test("x", f, c ? 1 : 2);')).toBe(1);
    // A callback or a handler is not a timeout.
    expect(hits('test("x", handler); test("y", async () => {});')).toBe(0);
    expect(
      unwrappedTimeouts(
        "packages/runner/tests/r214-history.test.ts",
        "afterAll(f, ownTimeout(15_000) + 15_000);",
      ),
    ).toEqual([]);
    // The same allowed site under a Windows glob path (CI run 40235606454 flagged it).
    expect(
      unwrappedTimeouts(
        "packages\\runner\\tests\\r214-history.test.ts",
        "afterAll(f, ownTimeout(15_000) + 15_000);",
      ),
    ).toEqual([]);
  });
  test("every unit test file wraps its short own timeouts in ownTimeout", async () => {
    const repo = join(import.meta.dir, "..");
    const bad: string[] = [];
    // Each pattern must find files, so one pattern going empty cannot hide behind the others.
    for (const pat of [
      "packages/*/tests/**/*.test.ts",
      "packages/*/itest/**/*.test.ts",
      "packages/*/src/**/*.test.ts",
      "scripts/**/*.test.ts",
    ]) {
      let files = 0;
      for await (const f of new Bun.Glob(pat).scan({ cwd: repo })) {
        if (f.includes("node_modules")) continue;
        files++;
        for (const hit of unwrappedTimeouts(f, await Bun.file(join(repo, f)).text()))
          bad.push(`${f}:${hit}`);
      }
      expect(files, pat).toBeGreaterThan(5);
    }
    expect(
      bad,
      `wrap in ownTimeout(): import it from "@lethal/engine/own-timeout" in a package, or from "../packages/engine/src/own-timeout" in scripts/:\n${bad.join("\n")}`,
    ).toEqual([]);
  });
});
