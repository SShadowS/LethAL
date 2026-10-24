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
  const callers = files.filter((f) => scan(readFileSync(join(ITEST, f), "utf8")).callsRunSession);

  test("the scan finds the itests that call runSession", () => {
    expect(callers.length).toBeGreaterThanOrEqual(14);
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
  });
});
