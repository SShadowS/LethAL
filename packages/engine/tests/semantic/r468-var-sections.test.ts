import { beforeAll, describe, expect, it } from "bun:test";
import { ALNodeKind } from "../../src/ast/node-kinds";
import { initParser, parseAL } from "../../src/ast/parser";
/**
 * R468: every DIRECT object-level `var` section is the object's globals, not only the first one.
 * `protected var` then `var` is the usual shape (621 of 704 extra sections in the BaseApp history
 * corpus). Plan: `docs/superpowers/plans/2026-10-05-R-468-every-object-var-section.md`.
 *
 * Two directions, each with its own red test:
 * - missing fix (first section only): a later section's names are not globals and do not resolve;
 * - over-applied fix: a procedure's locals, a swallowed split member's locals, or a section in an
 *   inactive `#if` arm become globals.
 */
import { evaluateArms } from "../../src/ast/preproc-arms";
import { type ALSyntaxNode, findAll, wrapRoot } from "../../src/ast/syntax-node";
import { buildSemanticContext } from "../../src/semantic/context";
import { resolveVarRef } from "../../src/semantic/resolve-var-ref";
import { objectScopeKey } from "../../src/semantic/symbol-table";

beforeAll(async () => {
  await initParser();
});

const KEY = objectScopeKey("codeunit", "R");

/** `symbols` null: a context with no arm map. */
function load(src: string, symbols: readonly string[] | null = null) {
  const root = wrapRoot(parseAL(src));
  const arms = symbols === null ? undefined : new Map([[root, evaluateArms(root, src, symbols)]]);
  const ctx = buildSemanticContext([{ path: "r.al", root }], arms);
  const globals = () => ctx.symbols.globalsOf(KEY).map((g) => g.name);
  /** The target identifier of the assignment whose text is `text`. */
  const target = (text: string): ALSyntaxNode => {
    const node = findAll(root, ALNodeKind.assignment_statement).find((n) => n.text === text);
    const left = node?.namedChildren[0];
    if (left === undefined) throw new Error(`no assignment ${text}`);
    return left;
  };
  return { ctx, globals, target };
}

describe("R468: every direct object-level var section is globals", () => {
  // Revert (first section only): B and C are missing and B does not resolve.
  it("indexes protected var then var, and a third section", () => {
    const { ctx, globals, target } = load(`codeunit 50480 R
{
    procedure P()
    begin
        B := false;
    end;

    protected var
        A: Boolean;

    var
        B: Boolean;

    var
        C: Integer;
}
`);
    expect(globals()).toEqual(["A", "B", "C"]);
    expect(resolveVarRef(target("B := false"), ctx)?.name).toBe("B");
  });

  // Over-applied (every var_section in the object, recursively): L leaks into the globals and
  // resolves from Q.
  it("keeps a procedure's local out of the globals and unresolved from another procedure", () => {
    const { ctx, globals, target } = load(`codeunit 50480 R
{
    protected var
        A: Boolean;

    procedure P()
    var
        L: Integer;
    begin
        L := 1;
    end;

    procedure Q()
    begin
        L := 2;
    end;

    var
        B: Boolean;
}
`);
    expect(globals()).toEqual(["A", "B"]);
    expect(resolveVarRef(target("L := 1"), ctx)?.name).toBe("L");
    expect(resolveVarRef(target("L := 2"), ctx)).toBeNull();
  });

  // Over-applied (a swallowed or split member's own var section read as globals): Sw or Shared
  // leaks in. R327: a split member after the global section parses inside that section's body.
  it("keeps a swallowed split member's locals out of the globals", () => {
    const { globals } = load(`codeunit 50480 R
{
    protected var
        G: Integer;

#if CLEAN27
    procedure Foo(T: Text): Text
#else
    procedure FooOld(T: Text): Text
#endif
    var
        Sw: Integer;
    begin
        exit(T);
    end;

    var
        B: Boolean;
}
`);
    expect(globals()).toEqual(["G", "B"]);
  });

  it("keeps a split procedure's shared local out of the globals", () => {
    const { globals } = load(`codeunit 50480 R
{
    protected var
        A: Boolean;

#if CLEAN27
    procedure Pick(X: Integer; Y: Integer): Integer
#else
    internal procedure Pick(X: Integer; Y: Text): Integer
#endif
    var
        Shared: Decimal;
    begin
        exit(X);
    end;

    var
        B: Boolean;
}
`);
    expect(globals()).toEqual(["A", "B"]);
  });

  // Over-applied (inactive-arm filtering ignored): Z appears under [] although its arm is out.
  // The active case is the control: with CLEANX defined, Z is a global. The `#if` follows a
  // procedure on purpose: directly after a var section the grammar swallows it into that section's
  // body (`preproc_conditional_var`), which is not a member-level `#if` (R364/R369's ruling).
  it("reads a member-level #if section by arm: inactive out, active in", () => {
    const src = `codeunit 50480 R
{
    protected var
        A: Boolean;

    procedure P()
    begin
    end;

#if CLEANX
    var
        Z: Integer;
#endif

    var
        B: Boolean;
}
`;
    expect(load(src, []).globals()).toEqual(["A", "B"]);
    expect(load(src, ["CLEANX"]).globals()).toEqual(["A", "Z", "B"]);
  });
});
