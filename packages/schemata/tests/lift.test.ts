import { describe, it, expect, beforeAll } from "bun:test";
import { ALNodeKind, findFirst, initParser, parseAL, wrapRoot } from "@lethal/engine";
import { liftExpression } from "../src/lift";

describe("liftExpression", () => {
  beforeAll(async () => { await initParser(); });

  it("emits var declaration, conditional assign, and local reference", () => {
    const src = `codeunit 51011 "L" { procedure P(A: Decimal): Decimal begin exit(F(A * 2) + G(A)); end; }`;
    const root = wrapRoot(parseAL(src));
    const mul = findFirst(root, ALNodeKind.multiplicative_expression);
    if (mul === null) throw new Error("no multiplicative_expression");
    const out = liftExpression({
      mutantId: "M0001",
      original: mul,
      replacementSource: "0",
      inferredType: "Decimal",
    });
    expect(out.varDeclaration).toMatch(/_m0001:\s*Decimal;/);
    expect(out.conditionalAssign).toContain("MutationSelector.Active('M0001')");
    expect(out.conditionalAssign).toContain("_m0001 := 0");
    expect(out.conditionalAssign).toContain(`_m0001 := ${mul.text.trim()}`);
    expect(out.replacementReference).toBe("_m0001");
  });
});
