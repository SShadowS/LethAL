import { beforeAll, describe, expect, it } from "bun:test";
import { ALNodeKind } from "../../src/ast/node-kinds";
import { initParser, parseAL } from "../../src/ast/parser";
import { findFirst, wrapRoot } from "../../src/ast/syntax-node";
import type { ALSyntaxNode } from "../../src/ast/syntax-node";
import { buildSymbolTable } from "../../src/semantic/symbol-table";
import { buildTypeTable } from "../../src/semantic/types";

async function typeOfExitExpr(codeunitSrc: string): Promise<string | null> {
  const root = wrapRoot(parseAL(codeunitSrc));
  const symbols = buildSymbolTable([{ path: "t.al", root }]);
  const types = buildTypeTable([{ path: "t.al", root }], symbols);
  const exit = findFirst(root, ALNodeKind.exit_statement);
  if (exit === null) throw new Error("no exit_statement");
  // The exit's argument may be wrapped or be the first non-keyword namedChild.
  // Find the first non-keyword expression-shaped namedChild.
  let inner: ALSyntaxNode | null = null;
  for (const c of exit.namedChildren) {
    if (!c.kind.endsWith("_keyword") && !c.kind.endsWith("_operator") && c.rawKind !== ";") {
      inner = c;
      break;
    }
  }
  if (inner === null) throw new Error("no expression inside exit");
  // If the expression is parenthesized, unwrap
  if (inner.kind === ALNodeKind.parenthesized_expression && inner.namedChildren.length > 0) {
    inner = inner.namedChildren[0] ?? inner;
  }
  return types.typeOf(inner);
}

/**
 * Types the argument of the FIRST `exit_statement` in the source, which the fixtures below place in
 * the object whose scoping is under test. Multi-object on purpose: R87 is only reachable when more
 * than one object declares a procedure of the same name.
 */
async function typeOfExitExprIn(src: string): Promise<string | null> {
  return typeOfExitExpr(src);
}

describe("buildTypeTable", () => {
  beforeAll(async () => {
    await initParser();
  });

  /**
   * R87, and this is the row's own measured counterexample.
   *
   * `resolveIdentifierType` iterated `symbols.objects` in PARSE ORDER and asked each one "do you
   * declare a procedure of this name?" via `findEnclosingProcedure(node, obj.node)`. That walk
   * climbs from the identifier until it meets either a `procedure` or `obj.node` — and the
   * identifier's OWN enclosing procedure always comes first, so the `current !== objectNode` guard
   * gated nothing and the answer came from whichever object happened to be parsed first.
   *
   * The decoy is named `Aaa` and the victim `Zzz` so parse order puts the wrong one first, which is
   * exactly how the row reproduced it. Measured consequence when this feeds `swap-call-arguments`:
   * the operator CLAIMS a site it should refuse and emits AL that `alc` 18.0 rejects with
   * `error AL0133: Argument 1: cannot convert from 'Record "Data Related"' to 'Record "Data Main"'`
   * — a whole-project compile failure, after the expensive part of a run.
   *
   * Calibrated on `do-rel2/Cloud` (244 objects): 1,793 distinct procedure names, 184 of them
   * (10.3%) declared by more than one object. So the precondition is ordinary, not exotic.
   */
  it("R87: types a local from its OWN object, not from whichever object parsed first", async () => {
    const src = `codeunit 50320 "Aaa Scope Decoy"
{
    procedure RunLink()
    var
        Row: Record "Data Main";
    begin
        Row.Init();
    end;
}

codeunit 50321 "Zzz Scope Victim"
{
    procedure RunLink()
    var
        Row: Record "Data Related";
    begin
        exit(Row);
    end;
}`;
    // The victim's own declaration. Under the defect this answered `Record "Data Main"` — the
    // decoy's — which is the wrong TYPE, not merely a missing one.
    expect(await typeOfExitExprIn(src)).toBe('Record "Data Related"');
  });

  /**
   * The OTHER half of the same defect, and the one that costs sites rather than corrupting them:
   * the loop `return null`ed as soon as a matching procedure name was found in an object that did
   * not declare the identifier, instead of trying the remaining objects. Measured on the same
   * project: 73 of 463 candidate sites (15.8%) LOST this way.
   *
   * Here the decoy declares `RunLink` but no `Row`, so a first-match-then-give-up walk answers
   * `null` and the victim's perfectly resolvable local is never reached.
   */
  /**
   * The third R87 site, and a red-check found it untested: an identifier that is an object-level
   * GLOBAL, referenced from inside a procedure that declares neither a local nor a parameter of
   * that name.
   *
   * The old code reached globals only on the object it had already (mis)chosen by name, so a global
   * resolved against the wrong object's declarations or not at all. Here the scope is the
   * identifier's own by construction — but the fall-through past the procedure lookup has to
   * actually happen, and a `return null` after the parameter check would leave every global
   * untyped while both tests above stayed green.
   */
  it("R87: an object-level global resolves from inside a procedure that does not declare it", async () => {
    const src = `codeunit 50324 "Aaa Scope Decoy"
{
    procedure RunLink()
    begin
    end;
}

codeunit 50325 "Zzz Scope Victim"
{
    var
        Row: Record "Data Related";

    procedure RunLink()
    begin
        exit(Row);
    end;
}`;
    expect(await typeOfExitExprIn(src)).toBe('Record "Data Related"');
  });

  /**
   * AL's own shadowing rule, pinned so the fall-through above cannot be widened into "globals win".
   * A procedure local of the same name HIDES the object global, and the two declare different types
   * here so the assertion can tell which one answered.
   */
  it("R87: a procedure local SHADOWS an object global of the same name", async () => {
    const src = `codeunit 50326 "Zzz Scope Victim"
{
    var
        Row: Record "Data Main";

    procedure RunLink()
    var
        Row: Record "Data Related";
    begin
        exit(Row);
    end;
}`;
    expect(await typeOfExitExprIn(src)).toBe('Record "Data Related"');
  });

  it("R87: a same-named procedure in another object does not shadow-and-terminate the lookup", async () => {
    const src = `codeunit 50322 "Aaa Scope Decoy"
{
    procedure RunLink()
    begin
    end;
}

codeunit 50323 "Zzz Scope Victim"
{
    procedure RunLink()
    var
        Row: Record "Data Related";
    begin
        exit(Row);
    end;
}`;
    expect(await typeOfExitExprIn(src)).toBe('Record "Data Related"');
  });

  it("types a literal integer expression as Integer", async () => {
    expect(
      await typeOfExitExpr(`codeunit 50300 "T" { procedure P(): Integer begin exit(42); end; }`),
    ).toBe("Integer");
  });

  it("types a decimal literal as Decimal", async () => {
    expect(
      await typeOfExitExpr(`codeunit 50301 "T" { procedure P(): Decimal begin exit(1.5); end; }`),
    ).toBe("Decimal");
  });

  it("types a comparison as Boolean", async () => {
    expect(
      await typeOfExitExpr(`codeunit 50302 "T" { procedure P(): Boolean begin exit(1 > 0); end; }`),
    ).toBe("Boolean");
  });

  // R84. These four pin the WHOLE declared type as the type identity. Reverting `extractType` to
  // its first-token form turns the first three red and leaves the fourth green — the fourth is
  // here to prove the collapse is about SUBTYPES and not about text equality.
  it("keeps a Record's subtype, so two different records are two different types", async () => {
    expect(
      await typeOfExitExpr(
        `codeunit 50304 "T" { procedure P() var SalesHeader: Record "Sales Header"; begin exit(SalesHeader); end; }`,
      ),
    ).toBe('Record "Sales Header"');
  });

  it("keeps a Codeunit's subtype", async () => {
    expect(
      await typeOfExitExpr(
        `codeunit 50305 "T" { procedure P() var Mgt: Codeunit "Sales-Post"; begin exit(Mgt); end; }`,
      ),
    ).toBe('Codeunit "Sales-Post"');
  });

  it("keeps a generic type's parameter, so List of [Text] is not List of [Integer]", async () => {
    expect(
      await typeOfExitExpr(
        `codeunit 50306 "T" { procedure P() var Names: List of [Text]; begin exit(Names); end; }`,
      ),
    ).toBe("List of [Text]");
  });

  it("answers `Label` for a label, whatever its constant text", async () => {
    // Not a special case in `extractType`: the grammar's `type` field for a label declaration is
    // the bare word, and the constant is a sibling. Two labels with different text are the same
    // type, and this pins that they compare equal.
    expect(
      await typeOfExitExpr(
        `codeunit 50307 "T" { procedure P() var Msg: Label 'Posting...'; begin exit(Msg); end; }`,
      ),
    ).toBe("Label");
  });

  it("returns null for unresolvable identifiers", async () => {
    expect(
      await typeOfExitExpr(
        `codeunit 50303 "T" { procedure P(): Integer begin exit(UnknownVar); end; }`,
      ),
    ).toBeNull();
  });
});
