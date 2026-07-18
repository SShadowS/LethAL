import { describe, it, expect, beforeAll } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  ALNodeKind,
  buildSemanticContext,
  findAll,
  initParser,
  parseAL,
  wrapRoot,
} from "@lethal/engine";
import { conditionalBoundary } from "../src/conditional-boundary";

describe("conditionalBoundary", () => {
  beforeAll(async () => { await initParser(); });

  it("has correct manifest", () => {
    expect(conditionalBoundary.name).toBe("lethal.conditional-boundary");
    expect(conditionalBoundary.tier).toBe(1);
    expect(conditionalBoundary.targetNodeKinds).toEqual([ALNodeKind.comparison_expression]);
    expect(conditionalBoundary.producesNodeKinds).toEqual([ALNodeKind.comparison_expression]);
  });

  it("generates one spec per >, <, >=, <= site", async () => {
    const src = await readFile(
      resolve(__dirname, "./fixtures/al/conditional-boundary.al"),
      "utf8",
    );
    const root = wrapRoot(parseAL(src));
    const ctx = buildSemanticContext([{ path: "fixture.al", root }]);

    const specs = findAll(root, ALNodeKind.comparison_expression)
      .filter((n) => conditionalBoundary.targets(n, ctx))
      .flatMap((n) => conditionalBoundary.generate(n, ctx));

    // fixture has three comparison sites: > 0, < 0, >= 100
    expect(specs).toHaveLength(3);
    const beforeTexts = specs.map((s) => s.before.text).sort();
    expect(beforeTexts).toEqual(["n < 0", "n > 0", "n >= 100"]);

    const mapping = new Map(specs.map((s) => [s.before.text, s.after.text]));
    expect(mapping.get("n > 0")).toBe("n >= 0");
    expect(mapping.get("n < 0")).toBe("n <= 0");
    expect(mapping.get("n >= 100")).toBe("n > 100");

    for (const s of specs) {
      expect(s.parentContext).toBe("statement-position");
      expect(s.operatorName).toBe("lethal.conditional-boundary");
    }
  });

  it("skips = and <> (NegateConditional's domain)", () => {
    const src = `codeunit 51301 "X" { procedure P(A: Integer) begin if A = 0 then exit(1); end; }`;
    const root = wrapRoot(parseAL(src));
    const ctx = buildSemanticContext([{ path: "x.al", root }]);
    const specs = findAll(root, ALNodeKind.comparison_expression)
      .filter((n) => conditionalBoundary.targets(n, ctx))
      .flatMap((n) => conditionalBoundary.generate(n, ctx));
    expect(specs).toHaveLength(0);
  });

  // Same descendant-operator grammar quirk as negate-conditional: with both
  // operands parenthesized, childForFieldName("operator") returns a nested
  // operator instead of this node's own, so no mutant was produced.
  it("flips > to >= when both operands are parenthesized", () => {
    const src = `codeunit 79002 "T" { procedure P(A: Integer; B: Integer): Boolean begin exit((A) > (B)); end; }`;
    const root = wrapRoot(parseAL(src));
    const ctx = buildSemanticContext([{ path: "fixture.al", root }]);

    const specs = findAll(root, ALNodeKind.comparison_expression)
      .filter((n) => conditionalBoundary.targets(n, ctx))
      .flatMap((n) => conditionalBoundary.generate(n, ctx));

    expect(specs).toHaveLength(1);
    expect(specs[0]?.after.text).toBe("(A) >= (B)");
  });
});
