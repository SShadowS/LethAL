import { beforeAll, describe, expect, it } from "bun:test";
/**
 * R502: a namespace-qualified table or codeunit reference is several segments, and every reader
 * used to take the first (`System` of `System.Utilities.Integer`) or the whole dotted text. Each
 * reader is checked here as a TWIN: the qualified spelling must resolve exactly as the unqualified
 * one does when the project declares that object in that namespace, and must stay UNRESOLVED when
 * the namespace does not match or the name is ambiguous (opus, R-502 plan review, C1: binding the
 * wrong same-named table drops a tag, the unsafe direction).
 */
import { initParser, parseAL } from "../../src/ast/parser";
import { type ALSyntaxNode, visit, wrapRoot } from "../../src/ast/syntax-node";
import { buildSemanticContext } from "../../src/semantic/context";
import { resolveReceiverTable } from "../../src/semantic/receiver";
import { buildSymbolTable } from "../../src/semantic/symbol-table";
import { deleteSkipCanRaise } from "../../src/semantic/trigger-skip";
import { buildTypeTable } from "../../src/semantic/types";

/** A project table in `Contoso.Sales` with no `OnDelete`: a `Delete(true)` on it cannot raise. */
const CUSTOMER = `namespace Contoso.Sales;

table 50100 Customer
{
    fields
    {
        field(1; "No."; Code[20]) { }
    }
}
`;
/** The same name in another namespace: a qualified reference must not pick either. */
const OTHER_CUSTOMER = `namespace Fabrikam.Sales;

table 50101 Customer
{
    fields
    {
        field(1; "No."; Integer) { }
    }
}
`;
const UTIL = `namespace Contoso.Util;

codeunit 50110 Util
{
    procedure Count(): Integer
    begin
        exit(1);
    end;
}
`;

type Files = Record<string, string>;
function contextOf(files: Files) {
  const parsed = Object.entries(files).map(([path, src]) => ({
    path,
    root: wrapRoot(parseAL(src)),
  }));
  return { parsed, ctx: buildSemanticContext(parsed) };
}
function first(root: ALSyntaxNode, test: (n: ALSyntaxNode) => boolean, what: string): ALSyntaxNode {
  let hit: ALSyntaxNode | undefined;
  visit(root, (n) => {
    if (hit === undefined && test(n)) hit = n;
  });
  if (hit === undefined) throw new Error(`no ${what}`);
  return hit;
}
const deleteCall = (root: ALSyntaxNode) =>
  first(
    root,
    (n) => n.rawKind === "call_expression" && /Delete\(true\)$/.test(n.text),
    "Delete call",
  );

/** The table the `Delete(true)` in `caller` binds to, and whether its skip tag is kept. */
function deleteSite(caller: string, extra: Files = {}) {
  const { parsed, ctx } = contextOf({ "Customer.al": CUSTOMER, ...extra, "Caller.al": caller });
  const root = parsed.find((f) => f.path === "Caller.al")?.root;
  if (root === undefined) throw new Error("no caller");
  const call = deleteCall(root);
  return { table: resolveReceiverTable(call, ctx), keepsTag: deleteSkipCanRaise(call, ctx) };
}

const varCaller = (type: string) => `codeunit 50200 Caller
{
    procedure Run()
    var
        C: Record ${type};
    begin
        C.Delete(true);
    end;
}
`;
const dataitemCaller = (table: string) => `report 50201 R
{
    dataset
    {
        dataitem(C; ${table})
        {
            trigger OnAfterGetRecord()
            begin
                C.Delete(true);
            end;
        }
    }
}
`;
const sourceTableCaller = (table: string) => `page 50202 P
{
    SourceTable = ${table};

    trigger OnOpenPage()
    begin
        Rec.Delete(true);
    end;
}
`;

describe("R502: a qualified reference resolves like its unqualified twin, or not at all", () => {
  beforeAll(async () => {
    await initParser();
  });

  // Site B (`classifyDeclaredType`). Revert: read `childForFieldName("reference")` again.
  it("Record: Contoso.Sales.Customer is Customer, in that namespace", () => {
    const plain = deleteSite(varCaller("Customer"));
    const qualified = deleteSite(varCaller("Contoso.Sales.Customer"));
    expect(plain).toEqual({ table: "Customer", keepsTag: false });
    expect(qualified).toEqual(plain);
  });

  // Site A (the report data item scope). Revert: read `childForFieldName("table_name")` again.
  it("data item: dataitem(C; Contoso.Sales.Customer) is Customer", () => {
    const plain = deleteSite(dataitemCaller("Customer"));
    const qualified = deleteSite(dataitemCaller("Contoso.Sales.Customer"));
    expect(plain).toEqual({ table: "Customer", keepsTag: false });
    expect(qualified).toEqual(plain);
  });

  // Site E (`propertyValueOf`). Revert: `stripQuotes(value.text)` again.
  it("SourceTable = Contoso.Sales.Customer is Customer", () => {
    const plain = deleteSite(sourceTableCaller("Customer"));
    const qualified = deleteSite(sourceTableCaller("Contoso.Sales.Customer"));
    expect(plain).toEqual({ table: "Customer", keepsTag: false });
    expect(qualified).toEqual(plain);
  });

  // The other direction, for all three: a namespace the table is not in, or a name two
  // namespaces declare, resolves to NO project table and the tag is kept. Revert: return the last
  // segment from `qualifiedObjectName` without the namespace and uniqueness checks.
  for (const [what, caller] of [
    ["Record", varCaller],
    ["data item", dataitemCaller],
    ["SourceTable", sourceTableCaller],
  ] as const) {
    it(`${what}: another namespace's Customer stays unresolved and keeps the tag`, () => {
      expect(deleteSite(caller("Microsoft.Sales.Customer"))).toEqual({
        table: "Microsoft.Sales.Customer",
        keepsTag: true,
      });
    });
    it(`${what}: a name two namespaces declare stays unresolved, even qualified`, () => {
      const site = deleteSite(caller("Contoso.Sales.Customer"), {
        "Other.al": OTHER_CUSTOMER,
      });
      expect(site).toEqual({ table: "Contoso.Sales.Customer", keepsTag: true });
    });
  }

  // Opus plan review I2: `extends Microsoft.Sales.Customer` does not parse, so the extension is
  // indexed as `Microsoft` and could be the one that observes this table. Revert: drop
  // `hasQualifiedBase` from `projectObserves`.
  // Error recovery puts the ERROR on either side of `base_object` (measured): `Contoso.Sales.` then
  // `base_object` Customer, or `base_object` Microsoft then `.Sales.Customer`.
  for (const [shape, base] of [
    ["ERROR before base_object", "Contoso.Sales.Customer"],
    ["ERROR after base_object", "Microsoft.Sales.Customer"],
  ] as const) {
    it(`a tableextension with a qualified extends keeps the tag (${shape})`, () => {
      const ext = `tableextension 50300 X extends ${base}\n{\n}\n`;
      expect(deleteSite(varCaller("Customer"))).toEqual({ table: "Customer", keepsTag: false });
      expect(deleteSite(varCaller("Customer"), { "Ext.al": ext })).toEqual({
        table: "Customer",
        keepsTag: true,
      });
    });
  }
});

describe("R502: types through a qualified Record or Codeunit", () => {
  beforeAll(async () => {
    await initParser();
  });

  function typeAt(files: Files, caller: string, test: (n: ALSyntaxNode) => boolean) {
    const parsed = Object.entries({ ...files, "Caller.al": caller }).map(([path, src]) => ({
      path,
      root: wrapRoot(parseAL(src)),
    }));
    const symbols = buildSymbolTable(parsed);
    const types = buildTypeTable(parsed, symbols);
    const root = parsed.find((f) => f.path === "Caller.al")?.root;
    if (root === undefined) throw new Error("no caller");
    return types.typeOf(first(root, test, "expression"));
  }

  // Site C (`recordTableName`). Revert: unquote the whole text again.
  it("a field of a qualified Record has its declared type", () => {
    const caller = (type: string) => `codeunit 50200 Caller
{
    procedure Run(): Code[20]
    var
        C: Record ${type};
    begin
        exit(C."No.");
    end;
}
`;
    const member = (n: ALSyntaxNode) => n.rawKind === "member_expression" && n.text === 'C."No."';
    const files = { "Customer.al": CUSTOMER };
    expect(typeAt(files, caller("Customer"), member)).toBe("Code[20]");
    expect(typeAt(files, caller("Contoso.Sales.Customer"), member)).toBe("Code[20]");
    expect(typeAt(files, caller("Microsoft.Sales.Customer"), member)).toBeNull();
  });

  // Site D (the call-return branch). Revert: `stripQuotes(raw)` again.
  it("a procedure of a qualified Codeunit has its return type", () => {
    const caller = (type: string) => `codeunit 50200 Caller
{
    procedure Run(): Integer
    var
        U: Codeunit ${type};
    begin
        exit(U.Count());
    end;
}
`;
    const call = (n: ALSyntaxNode) => n.rawKind === "call_expression" && n.text === "U.Count()";
    const files = { "Util.al": UTIL };
    expect(typeAt(files, caller("Util"), call)).toBe("Integer");
    expect(typeAt(files, caller("Contoso.Util.Util"), call)).toBe("Integer");
    expect(typeAt(files, caller("Microsoft.Util.Util"), call)).toBeNull();
  });
});
