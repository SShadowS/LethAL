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
  /**
   * R160. `computeType` had no case for `member_expression` or `call_expression`, so it answered
   * `null` for `Rec.Amount` and `GetAmount()` alike, which is exactly where Business Central keeps
   * its numbers. Measured on `do-rel2/Cloud` while spiking R159: of 170 arithmetic expressions whose
   * operands could not be typed, 81 were a call and 49 a record field.
   *
   * The change is provably INERT for every shipped operator: the tier-1 site census over the same
   * 554-file corpus is byte-identical before and after, 20,844 sites, 0 added and 0 removed. What it
   * moves is the arithmetic spike's claimable set, 100 to 120 sites.
   */
  describe("R160: record fields and project procedure returns", () => {
    const TABLE = `table 79400 "R160 Tbl" { fields { field(1; "No."; Code[20]) { } field(2; Amount; Decimal) { } field(3; Qty; Integer) { } } }`;
    const EXTENSION = `tableextension 79401 "R160 Ext" extends "R160 Tbl" { fields { field(50; Extra; Integer) { } } }`;
    const HELPER = `codeunit 79402 "R160 Helper" { procedure Compute(): Decimal begin exit(1); end; }`;

    const typeOfIn = async (body: string, extra = ""): Promise<string | null> =>
      typeOfExitExprIn(
        // The object under test comes FIRST: `typeOfExitExpr` types the argument of the first
        // `exit_statement` in the source, so a helper codeunit placed ahead of it would silently
        // type the helper's own `exit(1)` and every case would answer Integer.
        `codeunit 79403 "R160 C" { procedure P() var R: Record "R160 Tbl"; H: Codeunit "R160 Helper"; begin exit(${body}); end; ${extra} }
` +
          `${TABLE}
${EXTENSION}
${HELPER}`,
      );

    it("types a record field through its declared table", async () => {
      expect(await typeOfIn("R.Amount")).toBe("Decimal");
      expect(await typeOfIn("R.Qty")).toBe("Integer");
    });

    it("keeps the field type VERBATIM, matching VarSymbol.typeText", async () => {
      // `Code[20]`, not `Code`. Consumers compare declared types for equality or test membership in
      // a numeric set, and both want the declaration as written rather than a normalisation this
      // layer invented.
      expect(await typeOfIn('R."No."')).toBe("Code[20]");
    });

    it("sees a field a tableextension adds to the table", async () => {
      expect(await typeOfIn("R.Extra")).toBe("Integer");
    });

    it("types an unqualified call to a procedure of the same object", async () => {
      expect(await typeOfIn("Local()", "procedure Local(): Integer begin exit(1); end;")).toBe(
        "Integer",
      );
    });

    it("types a qualified call to another project codeunit's procedure", async () => {
      expect(await typeOfIn("H.Compute()")).toBe("Decimal");
    });

    it("REFUSES a platform method rather than guessing a return type", async () => {
      // `Count()` is the base application's, not this project's. Inventing return types for the
      // platform would be a table of guesses that goes stale silently; answering null costs sites,
      // answering wrongly costs a compile (R87, AL0133 on a whole project).
      expect(await typeOfIn("R.Count()")).toBeNull();
    });

    it("REFUSES a member that is not a field of the resolved table", async () => {
      expect(await typeOfIn("R.NotAField")).toBeNull();
    });

    it("REFUSES a receiver that resolves to no project table", async () => {
      expect(await typeOfIn("Unknown.Amount")).toBeNull();
    });

    it("REFUSES a chained member access rather than resolving half of it", async () => {
      // `A.B.C` would need the middle to resolve to a record type, which this layer does not model.
      expect(await typeOfIn("R.Amount.Something")).toBeNull();
    });
  });
});
