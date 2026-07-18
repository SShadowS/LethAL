import { describe, it, expect, beforeAll } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  ALNodeKind,
  buildSemanticContext,
  findAll,
  initParser,
  parseAL,
  visit,
  wrapRoot,
} from "@lethal/engine";
import { negateConditional } from "../src/negate-conditional";

describe("negateConditional", () => {
  beforeAll(async () => { await initParser(); });

  it("generates specs for =/<> as statement-position, and/or as short-circuit-operand", async () => {
    const src = await readFile(
      resolve(__dirname, "./fixtures/al/negate-conditional.al"),
      "utf8",
    );
    const root = wrapRoot(parseAL(src));
    const ctx = buildSemanticContext([{ path: "fixture.al", root }]);

    const candidates = [
      ...findAll(root, ALNodeKind.comparison_expression),
      ...findAll(root, ALNodeKind.logical_expression),
    ];
    const specs = candidates
      .filter((n) => negateConditional.targets(n, ctx))
      .flatMap((n) => negateConditional.generate(n, ctx));

    expect(specs).toHaveLength(4);

    const byBefore = new Map(specs.map((s) => [s.before.text, s]));
    expect(byBefore.get("A = 0")?.after.text).toBe("A <> 0");
    expect(byBefore.get("A = 0")?.parentContext).toBe("statement-position");
    expect(byBefore.get("A <> 5")?.after.text).toBe("A = 5");
    expect(byBefore.get("A <> 5")?.parentContext).toBe("statement-position");
    expect(byBefore.get("B and C")?.after.text).toBe("B or C");
    expect(byBefore.get("B and C")?.parentContext).toBe("short-circuit-operand");
    expect(byBefore.get("B or C")?.after.text).toBe("B and C");
    expect(byBefore.get("B or C")?.parentContext).toBe("short-circuit-operand");
  });

  it("skips non-target operators in comparison_expression", () => {
    const src = `codeunit 51401 "X" { procedure P(A: Integer) begin if A > 0 then exit(1); end; }`;
    const root = wrapRoot(parseAL(src));
    const ctx = buildSemanticContext([{ path: "x.al", root }]);
    const specs: unknown[] = [];
    visit(root, (n) => {
      if (negateConditional.targets(n, ctx)) specs.push(...negateConditional.generate(n, ctx));
    });
    expect(specs).toHaveLength(0);
  });

  // Regression: tree-sitter-al surfaces childForFieldName("operator") from a
  // DESCENDANT when both operands are parenthesized — for `(V < 0) or (V > 100)`
  // it returns the nested `<`, not the top-level `or`, and `or` is an anonymous
  // token so the `_operator` namedChildren fallback misses it too. The operator
  // was therefore read as `<`, LOGICAL_FLIP had no entry, and no mutant was
  // generated. Found by running the sandbox fixture end to end: 15 sites, not 16.
  it("flips or/and when both operands are parenthesized", () => {
    const src = `codeunit 79000 "T" { procedure P(V: Integer): Boolean begin if (V < 0) or (V > 100) then exit(true); exit(false); end; }`;
    const root = wrapRoot(parseAL(src));
    const ctx = buildSemanticContext([{ path: "fixture.al", root }]);

    const specs = findAll(root, ALNodeKind.logical_expression)
      .filter((n) => negateConditional.targets(n, ctx))
      .flatMap((n) => negateConditional.generate(n, ctx));

    expect(specs).toHaveLength(1);
    expect(specs[0]?.before.text).toBe("(V < 0) or (V > 100)");
    expect(specs[0]?.after.text).toBe("(V < 0) and (V > 100)");
    expect(specs[0]?.parentContext).toBe("short-circuit-operand");
  });

  it("flips a comparison whose operands are parenthesized", () => {
    const src = `codeunit 79001 "T" { procedure P(A: Integer; B: Integer): Boolean begin exit((A) = (B)); end; }`;
    const root = wrapRoot(parseAL(src));
    const ctx = buildSemanticContext([{ path: "fixture.al", root }]);

    const specs = findAll(root, ALNodeKind.comparison_expression)
      .filter((n) => negateConditional.targets(n, ctx))
      .flatMap((n) => negateConditional.generate(n, ctx));

    expect(specs).toHaveLength(1);
    expect(specs[0]?.after.text).toBe("(A) <> (B)");
  });
});
