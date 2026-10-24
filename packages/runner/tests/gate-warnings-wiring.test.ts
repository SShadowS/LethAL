import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import ts from "@typescript/typescript6";

/**
 * R736: every live itest that calls `runSession(` must collect and check warning codes, end through
 * `finishGate`, exit through `nonPassExit` and validate observe mode first. The itests run at
 * import, so this reads their syntax. `emitPassed(` may appear only inside a `finishGate(...)`
 * call, so an observe run can never write a pass receipt.
 */
const ITEST = join(import.meta.dir, "..", "itest");
const REQUIRED = [
  "collectWarnings",
  "checkGateWarnings",
  "finishGate",
  "nonPassExit",
  "preflightObserve",
] as const;

const parse = (text: string): ts.SourceFile =>
  ts.createSourceFile("x.ts", text, ts.ScriptTarget.Latest, true);

function callsOf(sf: ts.SourceFile): { name: string; node: ts.CallExpression }[] {
  const out: { name: string; node: ts.CallExpression }[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) {
      out.push({ name: n.expression.text, node: n });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** Names of the itests that call runSession, with the calls each makes. */
function scan(text: string): { callsRunSession: boolean; missing: string[]; bare: number } {
  const calls = callsOf(parse(text));
  const names = new Set(calls.map((c) => c.name));
  const inFinish = (n: ts.Node): boolean => {
    for (let p: ts.Node | undefined = n.parent; p !== undefined; p = p.parent) {
      if (
        ts.isCallExpression(p) &&
        ts.isIdentifier(p.expression) &&
        p.expression.text === "finishGate"
      )
        return true;
    }
    return false;
  };
  return {
    callsRunSession: names.has("runSession"),
    missing: REQUIRED.filter((r) => !names.has(r)),
    bare: calls.filter((c) => c.name === "emitPassed" && !inFinish(c.node)).length,
  };
}

describe("gate-warnings wiring", () => {
  const files = readdirSync(ITEST).filter((f) => f.endsWith(".itest.ts"));
  /** Exempt by name: verify-scale is a measurement script (R270), not a gate; selectLegs never picks it. */
  const EXEMPT = new Set(["verify-scale.itest.ts"]);
  const callers = files
    .filter((f) => !EXEMPT.has(f))
    .filter((f) => scan(readFileSync(join(ITEST, f), "utf8")).callsRunSession);

  test("the scan finds the itests that call runSession", () => {
    expect(callers.length).toBeGreaterThanOrEqual(13);
  });

  test("the exemption is real: verify-scale calls runSession and is the only one exempt", () => {
    expect(scan(readFileSync(join(ITEST, "verify-scale.itest.ts"), "utf8")).callsRunSession).toBe(
      true,
    );
    expect([...EXEMPT]).toEqual(["verify-scale.itest.ts"]);
  });

  for (const f of callers) {
    test(`${f} collects, checks, finishes and preflights`, () => {
      const r = scan(readFileSync(join(ITEST, f), "utf8"));
      expect(r.missing).toEqual([]);
      expect(r.bare).toBe(0);
    });
  }

  test("the scan itself flags a missing helper and a bare emitPassed", () => {
    const bad = scan("runSession({}); emitPassed('g', {});");
    expect(bad.callsRunSession).toBe(true);
    expect(bad.missing).toContain("finishGate");
    expect(bad.bare).toBe(1);
    const ok = scan(
      "runSession({}); collectWarnings(); checkGateWarnings(); nonPassExit(); preflightObserve(); finishGate(() => emitPassed('g', {}));",
    );
    expect(ok.missing).toEqual([]);
    expect(ok.bare).toBe(0);
    // A name in a comment or a string is not a call.
    const fake = scan("runSession({}); // finishGate()\nconst s = 'collectWarnings()';");
    expect(fake.missing).toContain("finishGate");
    expect(fake.missing).toContain("collectWarnings");
  });
});

/**
 * R739: the other runs that emit warning events. EVERY `runNamedMutants(` call, and every
 * `runVerify(` call (the seam wrapper `verifyFromCli` is given), must hand the run an object with
 * an `emit` property, so a gate cannot call one and leave its warnings uncollected. Per call, not
 * per file: one wired call must not hide a bare one. The object must hold an `emit` property of its
 * own; a spread of someone else's deps does not count.
 */
const EMITTING_RUNS = new Set(["runNamedMutants", "runVerify"]);

/** The calls to `runNamedMutants` / `runVerify` in `text` that pass no object literal with `emit`. */
function runsWithoutEmit(text: string): string[] {
  const bare: string[] = [];
  for (const { name, node } of callsOf(parse(text))) {
    if (!EMITTING_RUNS.has(name)) continue;
    const hasEmit = node.arguments.some(
      (a) =>
        ts.isObjectLiteralExpression(a) &&
        a.properties.some(
          (p) =>
            (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) &&
            ts.isIdentifier(p.name) &&
            p.name.text === "emit",
        ),
    );
    if (!hasEmit) {
      const { line } = node.getSourceFile().getLineAndCharacterOfPosition(node.getStart());
      bare.push(`${name} at line ${line + 1}`);
    }
  }
  return bare;
}

describe("gate-warnings wiring: runNamedMutants and runVerify calls", () => {
  const EXEMPT = new Set(["verify-scale.itest.ts"]);
  const files = readdirSync(ITEST).filter((f) => f.endsWith(".itest.ts") && !EXEMPT.has(f));

  test("the itests that call them are found", () => {
    const callers = files.filter((f) => {
      const text = readFileSync(join(ITEST, f), "utf8");
      return callsOf(parse(text)).some((c) => EMITTING_RUNS.has(c.name));
    });
    expect(callers.sort()).toEqual([
      "test-app-publish.itest.ts",
      "verify-agreement.itest.ts",
      "verify.itest.ts",
    ]);
  });

  for (const f of files) {
    test(`${f}: every runNamedMutants and runVerify call passes an object with emit`, () => {
      expect(runsWithoutEmit(readFileSync(join(ITEST, f), "utf8"))).toEqual([]);
    });
  }

  test("red, both ways: a bare call is flagged per call, and an emit property clears it", () => {
    // Direction 1: no emit anywhere, or only a spread, or a name in a comment or string.
    expect(runsWithoutEmit("runNamedMutants({ backend });")).toEqual(["runNamedMutants at line 1"]);
    expect(runsWithoutEmit("runVerify(args, { ...deps, log });")).toEqual(["runVerify at line 1"]);
    expect(runsWithoutEmit("runVerify(args, deps);")).toEqual(["runVerify at line 1"]);
    // One wired call does not hide a bare one (per call, not per file).
    expect(
      runsWithoutEmit("runNamedMutants({ emit: [c.subscriber] });\nrunNamedMutants({ backend });"),
    ).toEqual(["runNamedMutants at line 2"]);
    // A comment or a string is not a call.
    expect(runsWithoutEmit("// runNamedMutants({})\nconst s = 'runVerify(a, {})';")).toEqual([]);
    // Direction 2: an emit property, written out or as a shorthand, clears the call.
    expect(runsWithoutEmit("runNamedMutants({ emit: [c.subscriber], backend });")).toEqual([]);
    expect(runsWithoutEmit("runVerify(args, { ...deps, emit: [...(deps.emit ?? [])] });")).toEqual(
      [],
    );
    expect(runsWithoutEmit("runNamedMutants({ emit, backend });")).toEqual([]);
  });
});
