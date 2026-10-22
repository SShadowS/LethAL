import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "@typescript/typescript6";
import { formatFailure } from "../src/format-failure";

const ROOT = join(import.meta.dir, "..", "..", "..");
const ITEST = join(ROOT, "packages", "runner", "itest");
const FORMATTER = "../src/format-failure";

describe("R346: formatFailure", () => {
  test("prints name and message, then only the frame lines of the stack", () => {
    const err = new TypeError("line one\nline two");
    err.stack = "TypeError: line one\nline two\n    at f (frame-a)\n    at g (frame-b)";
    expect(formatFailure(err)).toBe(
      "TypeError: line one\nline two\n    at f (frame-a)\n    at g (frame-b)",
    );
  });

  test("keeps the message when the stack has lost it (the oven-sh/bun#34398 shape)", () => {
    const err = new Error("the reason");
    err.stack = "Error\n    at f (frame-a)";
    expect(formatFailure(err)).toBe("Error: the reason\n    at f (frame-a)");
  });

  test("prints the message alone when there is no stack", () => {
    const err = new Error("no frames");
    err.stack = undefined as unknown as string;
    expect(formatFailure(err)).toBe("Error: no frames");
  });

  test("a non-Error throw is kept, even one String() cannot convert", () => {
    expect(formatFailure("plain string")).toBe("plain string");
    expect(formatFailure(42)).toBe("42");
    expect(formatFailure(undefined)).toBe("undefined");
    expect(formatFailure(Object.create(null))).toBe("[object Object]");
  });

  const bare = (message: string, cause?: unknown, name = "Error"): Error => {
    const e = cause === undefined ? new Error(message) : new Error(message, { cause });
    e.name = name;
    e.stack = undefined as unknown as string;
    return e;
  };

  test("the cause chain follows the frames, one line per cause", () => {
    const root = bare("disk full", undefined, "IOError");
    const mid = bare("cannot write receipt", root);
    const top = bare("gate failed", mid);
    top.stack = "Error: gate failed\n    at f (frame-a)";
    expect(formatFailure(top)).toBe(
      "Error: gate failed\n    at f (frame-a)\nCaused by: Error: cannot write receipt\nCaused by: IOError: disk full",
    );
  });

  test("a non-Error cause is printed as a string, even one String() cannot convert", () => {
    expect(formatFailure(bare("top", "a plain reason"))).toBe(
      "Error: top\nCaused by: a plain reason",
    );
    expect(formatFailure(bare("top", Object.create(null)))).toBe(
      "Error: top\nCaused by: [object Object]",
    );
  });

  test("a cause cycle ends with one line saying so, and does not loop", () => {
    const a = bare("a");
    const b = bare("b", a);
    a.cause = b;
    expect(formatFailure(a)).toBe(
      "Error: a\nCaused by: Error: b\nCaused by: (cycle: this cause was already printed above)",
    );
  });

  test("a chain past the bound is cut after 8 causes, with a line saying so", () => {
    let e = bare("c0");
    for (let i = 1; i <= 12; i++) e = bare(`c${i}`, e);
    const lines = formatFailure(e).split("\n");
    expect(lines).toHaveLength(1 + 8 + 1);
    expect(lines[8]).toBe("Caused by: Error: c4");
    expect(lines[9]).toBe("Caused by: (chain cut after 8 causes)");
  });

  test("a cause getter that throws does not throw out of formatFailure", () => {
    const e = bare("top");
    Object.defineProperty(e, "cause", {
      get() {
        throw new Error("boom");
      },
    });
    expect(formatFailure(e)).toBe("Error: top\nCaused by: (unreadable)");
  });
});

describe("R346: a gate failure reaches stderr with its message after a GC", () => {
  // Bun drops an async-thrown Error's message from `.stack` when a GC runs before the first read
  // (oven-sh/bun#34398). A live gate collects plenty; here `Bun.gc(true)` forces it. The child
  // prints through the formatter exactly as every gate's catch does, and is a separate process
  // so stderr is captured the way a gate's is.
  test("the message survives a GC between the async throw and the print", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lethal-r346-"));
    try {
      const child = join(dir, "gate.ts");
      const formatter = join(import.meta.dir, "..", "src", "format-failure.ts");
      await writeFile(
        child,
        `import { formatFailure } from ${JSON.stringify(formatter)};
async function inner() {
  await Promise.resolve();
  throw new Error("R346 gate reason: 3 mutants differ");
}
async function main() {
  await inner();
}
main().catch((err: unknown) => {
  Bun.gc(true);
  console.error(formatFailure(err));
  process.exit(1);
});
`,
      );
      const run = Bun.spawnSync([process.execPath, child], { cwd: dir });
      const stderr = run.stderr.toString();
      expect(run.exitCode).toBe(1);
      expect(stderr).toContain("Error: R346 gate reason: 3 mutants differ");
      expect(stderr).toMatch(/^\s+at /m);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

/**
 * The gates run and exit at module top level, so they cannot be imported: their failure handlers
 * are checked on the AST, as `baseline-wiring.test.ts` does. A handler is a `main().catch(cb)`
 * callback or the `catch` of a top-level `try { await main() }`. Inside one:
 * - every `console.*` call that mentions the caught value must print exactly
 *   `formatFailure(<caught>)`, with `formatFailure` imported from `../src/format-failure`;
 * - there must be at least one such print.
 * Separately, no gate file may read `.stack` anywhere, so a helper that formats an error for a
 * message (the `describe` helpers in the verify gates) cannot print a stack alone either. The same
 * holds for the CLI, which prints the campaign freeze path's failures.
 *
 * Known ways past it: a handler that copies the error to another variable and prints that, and
 * a print through something other than `console.*` (for example `process.stderr.write`).
 */
const parse = (path: string): ts.SourceFile =>
  ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);

function importsFormatter(sf: ts.SourceFile): boolean {
  return sf.statements.some(
    (s) =>
      ts.isImportDeclaration(s) &&
      ts.isStringLiteral(s.moduleSpecifier) &&
      s.moduleSpecifier.text === FORMATTER &&
      s.importClause?.namedBindings !== undefined &&
      ts.isNamedImports(s.importClause.namedBindings) &&
      s.importClause.namedBindings.elements.some(
        (e) => e.name.text === "formatFailure" && e.propertyName === undefined,
      ),
  );
}

function stackReads(sf: ts.SourceFile): string[] {
  const out: string[] = [];
  const visit = (n: ts.Node): void => {
    const name = ts.isPropertyAccessExpression(n)
      ? n.name.text
      : ts.isElementAccessExpression(n) && ts.isStringLiteral(n.argumentExpression)
        ? n.argumentExpression.text
        : undefined;
    if (name === "stack") {
      out.push(`line ${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}: reads .stack`);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

const isMainCall = (e: ts.Expression): boolean =>
  ts.isCallExpression(e) && ts.isIdentifier(e.expression) && e.expression.text === "main";

/** Each handler as [caught-value name, body]. */
function handlers(sf: ts.SourceFile): Array<[string, ts.Node]> {
  const out: Array<[string, ts.Node]> = [];
  for (const s of sf.statements) {
    if (ts.isExpressionStatement(s)) {
      const c = s.expression;
      if (
        ts.isCallExpression(c) &&
        ts.isPropertyAccessExpression(c.expression) &&
        c.expression.name.text === "catch" &&
        isMainCall(c.expression.expression)
      ) {
        const cb = c.arguments[0];
        if (cb !== undefined && (ts.isArrowFunction(cb) || ts.isFunctionExpression(cb))) {
          const p = cb.parameters[0];
          if (p !== undefined && ts.isIdentifier(p.name)) out.push([p.name.text, cb.body]);
        }
      }
    }
    if (ts.isTryStatement(s) && s.catchClause !== undefined) {
      const callsMain = s.tryBlock.statements.some(
        (t) =>
          ts.isExpressionStatement(t) &&
          ts.isAwaitExpression(t.expression) &&
          isMainCall(t.expression.expression),
      );
      const v = s.catchClause.variableDeclaration;
      if (callsMain && v !== undefined && ts.isIdentifier(v.name)) {
        out.push([v.name.text, s.catchClause.block]);
      }
    }
  }
  return out;
}

function handlerViolations(caught: string, body: ts.Node): string[] {
  const out: string[] = [];
  let routed = 0;
  // R346 follow-up (R332's rule): the first formatted print must come before any await and any
  // receipt write, so a kill during the receipt cannot hide the reason.
  let firstPrint: number | undefined;
  let firstAwaitOrReceipt: number | undefined;
  const mentions = (n: ts.Node): boolean =>
    (ts.isIdentifier(n) && n.text === caught) ||
    (ts.forEachChild(n, (c) => mentions(c) || undefined) ?? false);
  const visit = (n: ts.Node): void => {
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      ts.isIdentifier(n.expression.expression) &&
      n.expression.expression.text === "console"
    ) {
      for (const a of n.arguments) {
        if (!mentions(a)) continue;
        const ok =
          ts.isCallExpression(a) &&
          ts.isIdentifier(a.expression) &&
          a.expression.text === "formatFailure" &&
          a.arguments.length === 1 &&
          a.arguments[0] !== undefined &&
          ts.isIdentifier(a.arguments[0]) &&
          a.arguments[0].text === caught;
        if (ok) {
          routed++;
          firstPrint ??= n.getStart();
        } else out.push(`prints ${a.getText()} without formatFailure`);
      }
    }
    if (
      ts.isAwaitExpression(n) ||
      (ts.isCallExpression(n) &&
        ts.isIdentifier(n.expression) &&
        n.expression.text === "emitFailed")
    ) {
      firstAwaitOrReceipt ??= n.getStart();
    }
    ts.forEachChild(n, visit);
  };
  visit(body);
  if (routed === 0) out.push("never prints formatFailure(<caught>)");
  else if (
    firstPrint !== undefined &&
    firstAwaitOrReceipt !== undefined &&
    firstAwaitOrReceipt < firstPrint
  ) {
    out.push("prints formatFailure(<caught>) after an await or the receipt write");
  }
  return out;
}

function wiringViolations(path: string): string[] {
  const sf = parse(path);
  const out = stackReads(sf);
  const hs = handlers(sf);
  const hasMain = sf.statements.some((s) => ts.isFunctionDeclaration(s) && s.name?.text === "main");
  if (hasMain && hs.length === 0) out.push("defines main() but has no main().catch or try/catch");
  if (hs.length > 0 && !importsFormatter(sf))
    out.push(`does not import formatFailure from ${FORMATTER}`);
  for (const [caught, body] of hs) out.push(...handlerViolations(caught, body));
  return out;
}

describe("R346: every gate's failure handler prints through formatFailure", () => {
  const gates = readdirSync(ITEST)
    .filter((f) => f.endsWith(".itest.ts"))
    .sort();

  test("the scan found the gates", () => {
    // A scan that reads nothing passes everything.
    for (const g of ["bcdev", "al-runner", "envtool", "tables", "hang", "harden", "chunked"]) {
      expect(gates).toContain(`${g}.itest.ts`);
    }
  });

  for (const g of gates) {
    test(g, () => {
      expect(wiringViolations(join(ITEST, g))).toEqual([]);
    });
  }

  test("every gate with a main() has a handler the scan recognises", () => {
    const withMain = gates.filter((g) =>
      /\bfunction main\(/.test(readFileSync(join(ITEST, g), "utf8")),
    );
    expect(withMain.length).toBeGreaterThanOrEqual(13);
    for (const g of withMain) expect(handlers(parse(join(ITEST, g))).length).toBeGreaterThan(0);
  });

  test("the CLI, which prints the campaign freeze failures, never reads .stack", () => {
    const cli = parse(join(ROOT, "packages", "runner", "src", "cli.ts"));
    expect(stackReads(cli)).toEqual([]);
    expect(
      cli.statements.some(
        (s) => ts.isImportDeclaration(s) && s.getText().includes("./format-failure"),
      ),
    ).toBe(true);
  });

  test("the checker catches a gate that prints err.stack alone", () => {
    const file = join(tmpdir(), `lethal-r346-wiring-${process.pid}.itest.ts`);
    const src = `import { formatFailure } from "../src/format-failure";
async function main() {}
main().catch(async (err: unknown) => {
  console.error(err instanceof Error ? err.stack : String(err));
  process.exit(1);
});
`;
    writeFileSync(file, src);
    try {
      const v = wiringViolations(file);
      expect(v.some((x) => x.includes("reads .stack"))).toBe(true);
      expect(v.some((x) => x.includes("without formatFailure"))).toBe(true);
      expect(v).toContain("never prints formatFailure(<caught>)");
    } finally {
      rmSync(file, { force: true });
    }
  });

  test("the checker catches a gate that prints after the receipt write", () => {
    const file = join(tmpdir(), `lethal-r346-order-${process.pid}.itest.ts`);
    writeFileSync(
      file,
      `import { formatFailure } from "../src/format-failure";
async function main() {}
main().catch(async (err: unknown) => {
  await emitFailed("x", String(err));
  console.error(formatFailure(err));
  process.exit(1);
});
`,
    );
    try {
      expect(wiringViolations(file)).toEqual([
        "prints formatFailure(<caught>) after an await or the receipt write",
      ]);
    } finally {
      rmSync(file, { force: true });
    }
  });
});
