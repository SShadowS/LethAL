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
    // Rec.Counter is a member access, not a read of the global `Counter` below it. The guard must
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

/**
 * [[R210]]. AL lets one object declare several procedures with the same name, distinguished by
 * parameter list, and `alc` 18.0.2668733 compiles that (verified before these tests were written).
 * `SymbolTable.resolveProcedure` matched by NAME alone, so every site inside the second or later
 * declaration was answered with the FIRST one's locals and parameters.
 *
 * Measured as the single largest cause of unresolved sites in R196's corpus sampling, 15 of 30 on
 * `do-rel2/Cloud` and 16 of 30 on `do-lethal-53470/Cloud`.
 *
 * The fixture gives both overloads a local of the SAME NAME and a DIFFERENT TYPE on purpose. A test
 * that only asserted "resolves to something" would pass on the wrong declaration, which is exactly
 * the failure being fixed: the old behaviour did not return null here, it returned a real symbol
 * belonging to a different procedure.
 */
describe("resolveVarRef across overloaded procedure names (R210)", () => {
  const OVERLOADED = `codeunit 50000 "Overload Probe"
{
    procedure Compute(A: Integer): Integer
    var
        Value: Integer;
    begin
        Value := A;
        exit(Value);
    end;

    procedure Compute(A: Integer; B: Integer): Text
    var
        Value: Text;
    begin
        Value := Format(A + B);
        exit(Value);
    end;
}`;

  it("resolves to the SECOND overload's own local, not the first's", () => {
    const { root, ctx } = load(OVERLOADED);
    // `useOf` takes the last match, which is the `exit(Value)` inside the second procedure.
    const resolved = resolveVarRef(useOf(root, "Value"), ctx);
    expect(resolved).not.toBeNull();
    expect(resolved?.typeText).toContain("Text");
  });

  it("still resolves the FIRST overload's local correctly", () => {
    const { root, ctx } = load(OVERLOADED);
    const uses = identifiers(root).filter((n) => normalizeAlName(n.text) === "value");
    // Declaration, use in the assignment, use in the exit, then the same three again. The second
    // is inside the first procedure.
    const firstProcUse = uses[1];
    if (firstProcUse === undefined) throw new Error("fixture changed");
    const resolved = resolveVarRef(firstProcUse, ctx);
    expect(resolved).not.toBeNull();
    expect(resolved?.typeText).toContain("Integer");
  });

  /**
   * A parameter is resolved from the same `ProcedureSymbol`, so it carries the same defect and is
   * fixed by the same change. `B` exists only in the second overload.
   */
  it("resolves a parameter that exists only in the second overload", () => {
    const { root, ctx } = load(OVERLOADED);
    const resolved = resolveVarRef(useOf(root, "B"), ctx);
    expect(resolved).not.toBeNull();
    expect(resolved?.typeText).toContain("Integer");
  });
});
