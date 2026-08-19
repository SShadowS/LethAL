import { beforeAll, describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { astSubtreeHash } from "../../src/ast/hash";
import { ALNodeKind } from "../../src/ast/node-kinds";
import { initParser, parseAL } from "../../src/ast/parser";
import { findFirst, wrapRoot } from "../../src/ast/syntax-node";

describe("astSubtreeHash", () => {
  beforeAll(async () => {
    await initParser();
  });

  async function hashExitExpr(fixture: string): Promise<string> {
    const source = await readFile(resolve(__dirname, `../fixtures/al/${fixture}`), "utf8");
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
  /**
   * R166. Every identifier used to canonicalise to a positional id, INCLUDING a call's method name,
   * so `DataMain.Delete(false)`, `.Insert(false)` and `.Modify(false)` all serialised as
   * `id0.id1(false)` and hashed identically — three different mutations under one identity key.
   * `design.md` §5.1 describes the input as "local variable names canonicalized to positional ids"
   * and promises the hash "changes when the expression's structure or operators change". A method
   * name is neither, so erasing it was outside what the rule said.
   *
   * Each case below builds a source with exactly ONE call or member access, so `findFirst` picks the
   * node under test without any text matching.
   */
  describe("R166: names keep their text, variables stay positional", () => {
    const firstCallHash = (src: string): string => {
      const node = findFirst(wrapRoot(parseAL(src)), ALNodeKind.procedure_call);
      if (node === null) throw new Error("no call_expression");
      return astSubtreeHash(node);
    };
    const firstMemberHash = (src: string): string => {
      const node = findFirst(wrapRoot(parseAL(src)), ALNodeKind.field_access);
      if (node === null) throw new Error("no member_expression");
      return astSubtreeHash(node);
    };
    const cu = (id: number, body: string): string =>
      `codeunit ${id} "C" { procedure P(N: Integer) var R: Record "T"; begin ${body} end; }`;

    it("gives three record methods on the same receiver three DIFFERENT hashes", () => {
      const hashes = new Set([
        firstCallHash(cu(51910, "R.Delete(false);")),
        firstCallHash(cu(51911, "R.Insert(false);")),
        firstCallHash(cu(51912, "R.Modify(false);")),
      ]);
      expect(hashes.size).toBe(3);
    });

    it("gives two different FIELD reads different hashes", () => {
      expect(firstMemberHash(cu(51913, "N := R.Amount;"))).not.toBe(
        firstMemberHash(cu(51914, "N := R.Qty;")),
      );
    });

    it("distinguishes two unqualified calls by name", () => {
      expect(firstCallHash(cu(51915, "Foo();"))).not.toBe(firstCallHash(cu(51916, "Bar();")));
    });

    it("still ignores a RECEIVER rename", () => {
      // The property the canonicalisation exists for. Renaming the record variable must leave the
      // hash alone, or history resets on a refactor that changed no behaviour.
      const alpha = `codeunit 51917 "C" { procedure P() var Alpha: Record "T"; begin Alpha.Delete(false); end; }`;
      const beta = `codeunit 51918 "C" { procedure P() var Beta: Record "T"; begin Beta.Delete(false); end; }`;
      expect(firstCallHash(alpha)).toBe(firstCallHash(beta));
    });

    it("still ignores an ARGUMENT rename", () => {
      // `Error(AErr, N)` and `Error(BErr, N)` remain one hash, deliberately: same call, differently
      // named local. This is the half of the old behaviour that was CORRECT, and the fix keeps it.
      expect(firstCallHash(cu(51919, "Foo(AErr, N);"))).toBe(
        firstCallHash(cu(51920, "Foo(BErr, N);")),
      );
    });
  });
});
