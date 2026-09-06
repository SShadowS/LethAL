import { beforeAll, describe, expect, it } from "bun:test";
import { ALNodeKind } from "../../src/ast/node-kinds";
import { initParser, parseAL } from "../../src/ast/parser";
import { type ALSyntaxNode, wrapRoot } from "../../src/ast/syntax-node";
import { buildSemanticContext } from "../../src/semantic/context";
import { enclosingScope, normalizeAlName, resolveVarRef } from "../../src/semantic/resolve-var-ref";

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

  it("returns null for a MEMBER name after a dot, not a variable read", () => {
    const { root, ctx } = load(`codeunit 50205 "R" { var Rec: Record Customer;
      procedure P() begin Rec.Name := 'x'; end; }`);
    expect(resolveVarRef(useOf(root, "Name"), ctx)).toBeNull();
  });

  it("returns null for an undeclared name rather than inventing one", () => {
    const { root, ctx } = load(`codeunit 50206 "R" {
      procedure P() begin Missing := 1; end; }`);
    expect(resolveVarRef(useOf(root, "Missing"), ctx)).toBeNull();
  });
});

describe("normalizeAlName", () => {
  it("strips one layer of quoting", () => {
    expect(normalizeAlName('"No."')).toBe("No.");
  });

  it("leaves case alone, since lookupVar already compares case-insensitively", () => {
    expect(normalizeAlName("COUNTER")).toBe("COUNTER");
  });

  it("leaves an unquoted name untouched", () => {
    expect(normalizeAlName("Counter")).toBe("Counter");
  });
});

describe("enclosingScope", () => {
  beforeAll(async () => {
    await initParser();
  });

  it("reports the owning object and the enclosing procedure's name", () => {
    const { root } = load(`codeunit 50210 "R" { var Counter: Integer;
      procedure P() begin Counter := 1; end; }`);
    const scope = enclosingScope(useOf(root, "Counter"));
    expect(scope?.ownerName).toBe("R");
    expect(scope?.procName).toBe("P");
  });

  it("reports a null procName inside a TRIGGER, not the trigger's own name", () => {
    const { root } = load(`table 50211 "R" { fields { field(1; "No."; Code[20]) { } }
      trigger OnInsert() var Seen: Integer; begin Seen := 1; end; }`);
    const scope = enclosingScope(useOf(root, "Seen"));
    expect(scope?.ownerName).toBe("R");
    expect(scope?.procName).toBeNull();
  });

  it("returns null for a node with no enclosing object", () => {
    const { root } = load(`codeunit 50212 "R" { procedure P() begin end; }`);
    expect(enclosingScope(root)).toBeNull();
  });
});
