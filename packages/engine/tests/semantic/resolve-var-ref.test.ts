import { beforeAll, describe, expect, it } from "bun:test";
import { ALNodeKind } from "../../src/ast/node-kinds";
import { initParser, parseAL } from "../../src/ast/parser";
import { type ALSyntaxNode, wrapRoot } from "../../src/ast/syntax-node";
import { buildSemanticContext } from "../../src/semantic/context";
import { normalizeAlName, resolveVarRef } from "../../src/semantic/resolve-var-ref";

/** Every `identifier` node in the tree, in source order. */
function identifiers(root: ALSyntaxNode): ALSyntaxNode[] {
  const out: ALSyntaxNode[] = [];
  const walk = (n: ALSyntaxNode): void => {
    if (n.kind === ALNodeKind.identifier) out.push(n);
    for (const c of n.namedChildren) walk(c);
  };
  walk(root);
  return out;
}

function load(src: string) {
  const root = wrapRoot(parseAL(src));
  const ctx = buildSemanticContext([{ path: "t.al", root }]);
  return { root, ctx };
}

/** The LAST identifier whose text matches, which is the use site rather than the declaration. */
function useOf(root: ALSyntaxNode, name: string): ALSyntaxNode {
  const hits = identifiers(root).filter((n) => normalizeAlName(n.text) === normalizeAlName(name));
  const last = hits[hits.length - 1];
  if (last === undefined) throw new Error(`no identifier ${name}`);
  return last;
}

describe("resolveVarRef", () => {
  beforeAll(async () => {
    await initParser();
  });

  it("resolves a codeunit global from inside a procedure", () => {
    const { root, ctx } = load(`codeunit 50200 "R" { var Counter: Integer;
      procedure P() begin Counter := 1; end; }`);
    const sym = resolveVarRef(useOf(root, "Counter"), ctx);
    expect(sym?.name).toBe("Counter");
    expect(sym?.typeText).toContain("Integer");
  });

  it("resolves a local, and prefers it over a same-named global (shadowing)", () => {
    const { root, ctx } = load(`codeunit 50201 "R" { var Total: Integer;
      procedure P() var Total: Decimal; begin Total := 1; end; }`);
    const sym = resolveVarRef(useOf(root, "Total"), ctx);
    expect(sym?.typeText).toContain("Decimal");
  });

  it("resolves a PARAMETER, which localsOf does not carry", () => {
    const { root, ctx } = load(`codeunit 50202 "R" {
      procedure P(Limit: Integer) begin Limit := 2; end; }`);
    expect(resolveVarRef(useOf(root, "Limit"), ctx)?.name).toBe("Limit");
  });

  it("is case-insensitive, as AL is", () => {
    const { root, ctx } = load(`codeunit 50203 "R" { var Counter: Integer;
      procedure P() begin COUNTER := 1; end; }`);
    expect(resolveVarRef(useOf(root, "COUNTER"), ctx)?.name).toBe("Counter");
  });

  it("resolves inside a TRIGGER, not only a procedure", () => {
    const { root, ctx } = load(`table 50204 "R" { fields { field(1; "No."; Code[20]) { } }
      trigger OnInsert() var Seen: Integer; begin Seen := 1; end; }`);
    expect(resolveVarRef(useOf(root, "Seen"), ctx)?.name).toBe("Seen");
  });

  it("returns null for a MEMBER name after a dot, even when that name is ALSO a declared variable", () => {
    // Rec.Counter is a member access, not a read of the global `Counter` below it — the guard must
    // refuse it on AST SHAPE, not merely because no such name happens to be in scope. Without the
    // guard this resolves to the unrelated global instead of refusing.
    const { root, ctx } = load(`codeunit 50205 "R" { var Rec: Record Customer; Counter: Integer;
      procedure P() begin Rec.Counter := 1; end; }`);
    expect(resolveVarRef(useOf(root, "Counter"), ctx)).toBeNull();
  });

  it("returns null for an undeclared name rather than inventing one", () => {
    const { root, ctx } = load(`codeunit 50206 "R" {
      procedure P() begin Missing := 1; end; }`);
    expect(resolveVarRef(useOf(root, "Missing"), ctx)).toBeNull();
  });
});

describe("normalizeAlName", () => {
  it("strips one layer of quoting and lowercases", () => {
    expect(normalizeAlName('"No."')).toBe("no.");
  });

  it("lowercases, since this is public and a consumer may compare two normalized names directly", () => {
    expect(normalizeAlName("COUNTER")).toBe("counter");
  });

  it("lowercases an unquoted name too", () => {
    expect(normalizeAlName("Counter")).toBe("counter");
  });
});
