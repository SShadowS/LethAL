import { describe, it, expect, beforeAll } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  ALNodeKind,
  astSubtreeHash,
  buildSemanticContext,
  canonicalize,
  findFirst,
  initParser,
  parseAL,
  print,
  printWithRewrites,
  wrapRoot,
} from "@lethal/engine";
import { build } from "../../src/build";

describe("Layer 1 integration", () => {
  beforeAll(async () => {
    await initParser();
  });

  it("round-trips and rewrites a realistic fixture", async () => {
    const path = resolve(
      __dirname,
      "../../../engine/tests/fixtures/al/comments-and-spacing.al",
    );
    const source = await readFile(path, "utf8");

    const tree = parseAL(source);
    const root = wrapRoot(tree);
    const ctx = buildSemanticContext([{ path, root }]);
    expect(ctx.symbols.objects.length).toBe(1);

    const binaryExpr = findFirst(root, ALNodeKind.comparison_expression);
    if (binaryExpr === null) throw new Error("no comparison_expression found");
    const hashBefore = astSubtreeHash(binaryExpr);
    const canonBefore = canonicalize(binaryExpr);

    // unmodified print is byte-identical
    expect(print(source, root)).toBe(source);

    // rewrite the expression using SDK builders
    // comments-and-spacing.al has "Amount > 0" in the assignment
    const leftText = binaryExpr.text.split(">")[0];
    if (leftText === undefined) throw new Error("no left operand");
    const replacement = build.binaryOp(
      ">=",
      build.identifier(leftText.trim()),
      build.integerLiteral(0),
    );
    const output = printWithRewrites(
      source,
      root,
      new Map([[binaryExpr, replacement.toAL()]]),
    );
    expect(output).toContain(">=");
    expect(output).not.toBe(source);

    // parsing the rewritten source produces a new AST whose binary expression
    // has a different hash (the operator changed).
    const rewrittenRoot = wrapRoot(parseAL(output));
    const rewrittenExpr = findFirst(rewrittenRoot, ALNodeKind.comparison_expression);
    if (rewrittenExpr === null) throw new Error("no comparison in rewrite");
    const hashAfter = astSubtreeHash(rewrittenExpr);
    expect(hashAfter).not.toBe(hashBefore);

    // but canonicalization still classifies the ORIGINAL as itself
    const canonAfter = canonicalize(binaryExpr);
    expect(canonAfter.form).toBe(canonBefore.form);
  });
});
