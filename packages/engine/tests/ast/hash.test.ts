import { describe, it, expect, beforeAll } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { initParser, parseAL } from "../../src/ast/parser";
import { wrapRoot, findFirst } from "../../src/ast/syntax-node";
import { astSubtreeHash } from "../../src/ast/hash";
import { ALNodeKind } from "../../src/ast/node-kinds";

describe("astSubtreeHash", () => {
  beforeAll(async () => {
    await initParser();
  });

  async function hashExitExpr(fixture: string): Promise<string> {
    const source = await readFile(
      resolve(__dirname, `../fixtures/al/${fixture}`),
      "utf8",
    );
    const root = wrapRoot(parseAL(source));
    const exit = findFirst(root, ALNodeKind.exit_statement)!;
    const inner = findFirst(exit, ALNodeKind.comparison_expression)!;
    return astSubtreeHash(inner);
  }

  it("is invariant under whitespace differences", async () => {
    const a = await hashExitExpr("hash-equiv-formatting.al");
    const c = await hashExitExpr("hash-equiv-rename.al");
    expect(a).toBe(c);
  });

  it("is invariant under local-identifier rename", async () => {
    const a = await hashExitExpr("hash-equiv-formatting.al");
    const c = await hashExitExpr("hash-equiv-rename.al");
    expect(a).toBe(c);
  });

  it("differs when the operator changes", async () => {
    const a = await hashExitExpr("hash-equiv-formatting.al");
    const b = await hashExitExpr("hash-differs-operator.al");
    expect(a).not.toBe(b);
  });

  it("produces a deterministic fixed-length hex hash", async () => {
    const a = await hashExitExpr("hash-equiv-formatting.al");
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});
