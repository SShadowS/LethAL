import { beforeAll, describe, expect, it } from "bun:test";
import { ALNodeKind } from "../../src/ast/node-kinds";
import { initParser, parseAL } from "../../src/ast/parser";
import { findFirst, visit, wrapRoot } from "../../src/ast/syntax-node";
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

/** The type of the LAST identifier spelled `text` that is not a declaration's own name, or of the
 *  last call whose callee is spelled `text` when `call` is set. A global `var` section goes AFTER
 *  the procedures in these fixtures: before a split member it swallows the member into its body
 *  (a grammar quirk, measured 2026-09-29; none of the corpus split members sits there). */
function typeAt(src: string, text: string, call = false): string | null {
  const root = wrapRoot(parseAL(src));
  const symbols = buildSymbolTable([{ path: "t.al", root }]);
  const types = buildTypeTable([{ path: "t.al", root }], symbols);
  let hit: ALSyntaxNode | null = null;
  visit(root, (n) => {
    if (call) {
      if (n.kind === ALNodeKind.procedure_call && n.childForFieldName("function")?.text === text)
        hit = n;
    } else if (
      n.kind === ALNodeKind.identifier &&
      n.text === text &&
      n.parent?.kind !== ALNodeKind.variable_declaration &&
      n.parent?.kind !== ALNodeKind.parameter
    ) {
      hit = n;
    }
  });
  if (hit === null) throw new Error(`no ${text}`);
  return types.typeOf(hit);
}

// R302: inside a split member, a name types only when every arm declares it with the same type.
// A name the arms disagree on is ambiguous: it types as nothing and HIDES a global of that name,
// because falling through to the global types it by a declaration no build uses there.
describe("buildTypeTable: split members (R302), unique calls (R324), case (R322)", () => {
  beforeAll(async () => {
    await initParser();
  });
  const SPLIT = `codeunit 50100 "Repro T"
{
#if CLEAN27
    procedure Pick(X: Integer; Y: Integer): Integer
#else
    procedure Pick(X: Integer; Y: Text): Integer
#endif
    begin
        Show(X, Y);
        exit(X);
    end;

    local procedure Show(A: Integer; B: Integer)
    begin
    end;

    var
        Y: Integer;
}
`;

  it("an agreeing parameter types; a disagreeing one is null even with a global of its name", () => {
    expect(typeAt(SPLIT, "X")).toBe("Integer");
    expect(typeAt(SPLIT, "Y")).toBeNull();
  });

  it("a call to an agreeing split member types by its return; a disagreeing one is null", () => {
    const src = `codeunit 50100 "Repro T"
{
#if CLEAN27
    procedure Same(X: Integer): Integer
#else
    procedure Same(X: Integer): Integer
#endif
    begin
        exit(X);
    end;

#if CLEAN27
    procedure Differs(X: Integer): Decimal
#else
    procedure Differs(X: Integer): Integer
#endif
    begin
        exit(X);
    end;

    procedure Caller()
    begin
        Glob := Same(1) + 1;
        Glob := Differs(1) + 1;
    end;

    var
        Glob: Decimal;
}
`;
    expect(typeAt(src, "Same", true)).toBe("Integer");
    expect(typeAt(src, "Differs", true)).toBeNull();
  });

  it("R324: a call to an overloaded name is null, plain or split-then-plain; a unique name in other casing types", () => {
    const plain = `codeunit 50100 "Repro T"
{
    procedure Foo(X: Integer): Integer
    begin
        exit(X);
    end;

    procedure Foo(T: Text): Text
    begin
        exit(T);
    end;

    procedure Bar(): Integer
    begin
        exit(1);
    end;

    procedure Caller(): Integer
    begin
        exit(Foo('x') + FOO('y') + BAR());
    end;
}
`;
    expect(typeAt(plain, "Foo", true)).toBeNull();
    expect(typeAt(plain, "BAR", true)).toBe("Integer");
    const split = plain.replace(
      "    procedure Foo(X: Integer): Integer\n",
      "#if CLEAN27\n    procedure Foo(X: Integer): Integer\n#else\n    procedure Foo(X: Integer): Integer\n#endif\n",
    );
    expect(split).not.toBe(plain);
    expect(typeAt(split, "Foo", true)).toBeNull();
  });

  it("R322: a parameter named in other casing than its use types by the parameter, not the global", () => {
    const plain = `codeunit 50100 "Repro T"
{
    procedure Pick(X: Integer; y: Text)
    begin
        Show(X, Y);
    end;

    local procedure Show(A: Integer; B: Text)
    begin
    end;

    var
        Y: Integer;
}
`;
    expect(typeAt(plain, "Y")).toBe("Text");
    const split = plain.replace(
      "    procedure Pick(X: Integer; y: Text)\n",
      "#if CLEAN27\n    procedure Pick(X: Integer; y: Text)\n#else\n    procedure Pick(X: Integer; y: Text)\n#endif\n",
    );
    expect(split).not.toBe(plain);
    expect(typeAt(split, "Y")).toBe("Text");
  });
});

// R327: a split member placed after the object's global `var` section parses INSIDE that section,
// so the symbol table never indexes it. Its names must then type as NOTHING: falling through to
// the object's globals typed `Y` below as the global `Integer`, and `swap-call-arguments` emitted
// a swap that fails `alc` with AL0133 in both builds.
describe("buildTypeTable: a split member swallowed by the global var section (R327)", () => {
  beforeAll(async () => {
    await initParser();
  });
  const SWALLOWED = `codeunit 50100 "Repro R327"
{
    var
        X: Integer;
        Y: Integer;

#if CLEAN27
    procedure Pick(X: Integer; Y: Text): Integer
#else
    procedure Pick(X: Integer; Y: Text): Integer
#endif
    begin
        Show(X, Y);
        exit(X);
    end;

    procedure Show(A: Integer; B: Text)
    begin
    end;
}
`;

  it("a name in the swallowed member types as nothing, not as the global", () => {
    expect(typeAt(SWALLOWED, "X")).toBeNull();
    expect(typeAt(SWALLOWED, "Y")).toBeNull();
  });

  it("R324: a call to a name a swallowed member also declares is untyped", () => {
    const src = `codeunit 50100 "Repro R327O"
{
    var
        Glob: Integer;

#if CLEAN27
    procedure Foo(T: Text): Text
#else
    procedure Foo(T: Text): Text
#endif
    begin
        exit(T);
    end;

    procedure Foo(X: Integer): Integer
    begin
        exit(X);
    end;

    procedure Caller(): Text
    begin
        exit(Foo('x') + Foo('y'));
    end;
}
`;
    expect(typeAt(src, "Foo", true)).toBeNull();
  });
});

// R330: a declaration inside a `#if` region that the symbol table does not index still makes its
// name UNKNOWN. A call to a name an unindexed `#if`-wrapped procedure also declares is untyped, and
// a local declared in a `#if` var block hides a global even when only the casing differs.
describe("buildTypeTable: names declared in an unindexed #if region are unknown (R330)", () => {
  beforeAll(async () => {
    await initParser();
  });
  const WRAPPED = (first: string) => `codeunit 50100 "Repro R330"
{
${first}
    begin
        exit(A);
    end;

#if X
    procedure Foo(A: Text): Text
    begin
        exit(A);
    end;

    procedure Bar(): Text
    begin
        exit(Foo('x') + Foo('y'));
    end;
#endif
}
`;

  it("I1: a split member is not unique beside a #if-wrapped overload", () => {
    const src = WRAPPED(
      "#if Y\n    procedure Foo(A: Integer): Integer\n#else\n    procedure Foo(A: Integer): Integer\n#endif",
    );
    expect(typeAt(src, "Foo", true)).toBeNull();
  });

  it("the older plain form: a direct procedure is not unique beside a #if-wrapped overload", () => {
    expect(typeAt(WRAPPED("    procedure Foo(A: Integer): Integer"), "Foo", true)).toBeNull();
  });

  it("I2: a #if var-block local hides a global whose name differs only in case", () => {
    const src = `codeunit 50100 "Repro R330B"
{
    procedure Bar()
#if not CLEAN27
    var
        Amt: Text;
#endif
    begin
        Message('%1', Amt + Amt);
    end;

    var
        AMT: Integer;
}
`;
    expect(typeAt(src, "Amt")).toBeNull();
  });
});

// R330, run 002 fix round: inside a trigger, a name the trigger declares in its own header (plain
// `var` section or `#if` region) is unknown; it never reaches a global, whatever the global's casing.
describe("buildTypeTable: a trigger's own locals hide the globals (R330)", () => {
  beforeAll(async () => {
    await initParser();
  });
  const src = (local: string, global: string) => `codeunit 50100 "Repro T"
{
    trigger OnRun()
${local}
    begin
        Message('%1', Amt + Amt);
    end;

    var
        ${global}: Integer;
}
`;
  const PLAIN = "    var\n        Amt: Text;";
  const WRAPPED = "#if not CLEAN27\n    var\n        Amt: Text;\n#endif";

  it("a plain trigger local, global in other casing", () => {
    expect(typeAt(src(PLAIN, "AMT"), "Amt")).toBeNull();
  });
  it("a plain trigger local, global in the same casing (master's older form)", () => {
    expect(typeAt(src(PLAIN, "Amt"), "Amt")).toBeNull();
  });
  it("a #if trigger local, global in other casing", () => {
    expect(typeAt(src(WRAPPED, "AMT"), "Amt")).toBeNull();
  });
  it("control: with no trigger local the global still types", () => {
    expect(typeAt(src("", "AMT"), "Amt")).toBe("Integer");
  });
});

// R331 (run 003): a plain procedure wrapped whole in `#if` is not indexed, so its own names are
// unknown. Before, type resolution tried a same-named procedure's declarations and then the
// object's globals (with R322, also one in other casing): `V + V` became an `alc`-failing `V - V`.
describe("buildTypeTable: inside an unindexed plain member nothing types (R331)", () => {
  beforeAll(async () => {
    await initParser();
  });
  const src = (global: string, overload = "") => `codeunit 50100 "Repro C1"
{
${overload}#if X
    procedure Foo(V: Text): Text
    begin
        exit(V + V);
    end;
#endif

    var
        ${global}: Integer;
}
`;
  it("a global in other casing does not type a wrapped member's parameter", () => {
    expect(typeAt(src("v"), "V")).toBeNull();
  });
  it("nor one in the same casing (master's older form)", () => {
    expect(typeAt(src("V"), "V")).toBeNull();
  });
  it("nor a same-named direct procedure's parameter (the removed name fallback)", () => {
    const direct =
      "    procedure Foo(V: Integer): Integer\n    begin\n        exit(V);\n    end;\n\n";
    expect(typeAt(src("G", direct), "V")).toBeNull();
  });
});
