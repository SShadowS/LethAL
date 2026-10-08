import { beforeAll, describe, expect, it } from "bun:test";
/**
 * R509: the type table read `Record "X" temporary` as no table (the type TEXT ends in the keyword),
 * so a field of a temporary record had no type. R510: `resolveObject` read any name that STARTS
 * with digits as an id, so `Record "50000 Foo"` bound to table 50000. Each is a twin: the temporary
 * record types as the plain one does, and the numeric-looking name binds by name, while a real id
 * still binds by id.
 */
import { initParser, parseAL } from "../../src/ast/parser";
import { type ALSyntaxNode, visit, wrapRoot } from "../../src/ast/syntax-node";
import { buildSemanticContext } from "../../src/semantic/context";
import { resolveReceiverTable } from "../../src/semantic/receiver";
import { buildSymbolTable } from "../../src/semantic/symbol-table";
import { deleteSkipCanRaise } from "../../src/semantic/trigger-skip";
import { buildTypeTable } from "../../src/semantic/types";

const CUSTOMER = `namespace Contoso.Sales;

table 50100 Customer
{
    fields
    {
        field(1; "No."; Code[20]) { }
    }

    procedure Rank(): Integer
    begin
        exit(1);
    end;
}
`;

function parse(files: Record<string, string>) {
  return Object.entries(files).map(([path, src]) => ({ path, root: wrapRoot(parseAL(src)) }));
}
function first(root: ALSyntaxNode, test: (n: ALSyntaxNode) => boolean): ALSyntaxNode {
  let hit: ALSyntaxNode | undefined;
  visit(root, (n) => {
    if (hit === undefined && test(n)) hit = n;
  });
  if (hit === undefined) throw new Error("no such node");
  return hit;
}
function typeIn(type: string, expr: string, files: Record<string, string>): string | null {
  const caller = `codeunit 50200 Caller
{
    procedure Run(): Integer
    var
        C: Record ${type};
    begin
        exit(${expr});
    end;
}
`;
  const parsed = parse({ ...files, "Caller.al": caller });
  const symbols = buildSymbolTable(parsed);
  const types = buildTypeTable(parsed, symbols);
  const root = parsed.find((f) => f.path === "Caller.al")?.root;
  if (root === undefined) throw new Error("no caller");
  return types.typeOf(first(root, (n) => n.text === expr && n.rawKind !== "exit_statement"));
}

describe("R509: a temporary record types as the plain one", () => {
  beforeAll(async () => {
    await initParser();
  });

  // `recordTableName`. Revert: stop stripping `temporary` in `objectNameIn`.
  for (const type of ["Customer", '"Customer"', "Contoso.Sales.Customer"]) {
    it(`a field of Record ${type} temporary`, () => {
      const files = { "Customer.al": CUSTOMER };
      expect(typeIn(type, 'C."No."', files)).toBe("Code[20]");
      expect(typeIn(`${type} temporary`, 'C."No."', files)).toBe("Code[20]");
    });
  }

  // The call-return branch, for a table procedure. Same revert.
  it("a table procedure on Record Customer temporary", () => {
    const files = { "Customer.al": CUSTOMER };
    expect(typeIn("Customer", "C.Rank()", files)).toBe("Integer");
    expect(typeIn("Customer temporary", "C.Rank()", files)).toBe("Integer");
  });

  // Another namespace stays untyped with or without the keyword (R502's rule still applies).
  it("Record Microsoft.Sales.Customer temporary stays untyped", () => {
    const files = { "Customer.al": CUSTOMER };
    expect(typeIn("Microsoft.Sales.Customer temporary", 'C."No."', files)).toBeNull();
  });
});

const REAL = `table 50000 Real
{
    fields
    {
        field(1; K; Code[10]) { }
    }

    trigger OnDelete()
    begin
        Codeunit.Run(50999);
    end;
}
`;
const FOO = `table 50100 "50000 Foo"
{
    fields
    {
        field(1; K; Code[10]) { }
    }
}
`;

describe("R510: a name that starts with digits is a name, a number is an id", () => {
  beforeAll(async () => {
    await initParser();
  });

  // `resolveObject`. Revert: `Number.parseInt(idOrName, 10)` again.
  it("resolveObject: 50000 is table 50000, 50000 Foo is the table named so", () => {
    const symbols = buildSymbolTable(parse({ "Real.al": REAL, "Foo.al": FOO }));
    expect(symbols.resolveObject({ kind: "table", idOrName: "50000" })?.name).toBe("Real");
    expect(symbols.resolveObject({ kind: "table", idOrName: "Real" })?.name).toBe("Real");
    expect(symbols.resolveObject({ kind: "table", idOrName: "50000 Foo" })?.name).toBe("50000 Foo");
    expect(symbols.resolveObject({ kind: "table", idOrName: "50100" })?.name).toBe("50000 Foo");
  });

  // Through a receiver and a tag: `"50000 Foo"` has no OnDelete, so a skip cannot raise; `Real`'s
  // runs a codeunit, so it can. Before R510 `"50000 Foo"` bound to `Real` and took its answer.
  function deleteOn(type: string) {
    const caller = `codeunit 50200 Caller
{
    procedure Run()
    var
        R: Record ${type};
    begin
        R.Delete(true);
    end;
}
`;
    const parsed = parse({ "Real.al": REAL, "Foo.al": FOO, "Caller.al": caller });
    const ctx = buildSemanticContext(parsed);
    const root = parsed.find((f) => f.path === "Caller.al")?.root;
    if (root === undefined) throw new Error("no caller");
    const call = first(root, (n) => n.rawKind === "call_expression" && n.text === "R.Delete(true)");
    return { table: resolveReceiverTable(call, ctx), keepsTag: deleteSkipCanRaise(call, ctx) };
  }
  it('Record "50000 Foo" binds by name; Record 50000 and Record Real bind to Real', () => {
    expect(deleteOn('"50000 Foo"')).toEqual({ table: "50000 Foo", keepsTag: false });
    expect(deleteOn("50000")).toEqual({ table: "50000", keepsTag: true });
    expect(deleteOn("Real")).toEqual({ table: "Real", keepsTag: true });
  });
});
