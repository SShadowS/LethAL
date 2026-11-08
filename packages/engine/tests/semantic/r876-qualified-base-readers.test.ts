import { beforeAll, describe, expect, it } from "bun:test";
/**
 * R-876 (R861, tree-sitter-al 4.6.0): a dotted `extends` name is ONE `qualified_name` node whose
 * `.text` is the whole dotted name, and `extends 18` is an `integer` node. The four `base_object`
 * readers in receiver.ts must compare the LAST segment (a table id when the base is an integer).
 * Each reader is run on a dotted name (plain and quoted-with-a-dot), a plain name, and a number.
 * The tables hold both ways: "named" cases must see the extension, "other" cases must not.
 * Real AL goes through the native parser; no hand-built nodes.
 */
import { ALNodeKind } from "../../src/ast/node-kinds";
import { initParser, parseAL } from "../../src/ast/parser";
import { type ALSyntaxNode, visit, wrapRoot } from "../../src/ast/syntax-node";
import { buildSemanticContext } from "../../src/semantic/context";
import {
  bareReceiverText,
  claimsRecordMethod,
  claimsSystemCall,
  resolveReceiverTable,
} from "../../src/semantic/receiver";

beforeAll(async () => {
  await initParser();
});

const wrapped = (src: string) => `#if NEVER_DEFINED\n${src}#endif\n`;

function ctxOf(srcs: string[]) {
  const files = srcs.map((src, i) => ({ path: `f${i}.al`, root: wrapRoot(parseAL(src)) }));
  return { files, ctx: buildSemanticContext(files) };
}

function firstNode(root: ALSyntaxNode, pred: (n: ALSyntaxNode) => boolean): ALSyntaxNode {
  let found: ALSyntaxNode | undefined;
  visit(root, (n) => {
    if (found === undefined && pred(n)) found = n;
  });
  if (found === undefined) throw new Error("node not found");
  return found;
}

const CUSTOMER = `table 50100 "Customer"
{
    fields { field(1; "No."; Code[20]) { } }
}
`;

/** The bases an extension of table 50100 `Customer` can be written with, and whether each names it. */
const TABLE_BASES: [string, string, boolean][] = [
  ["dotted", "Microsoft.Sales.Customer", true],
  ["dotted, quoted with a dot", '"My.Ns"."Customer"', true],
  ["plain", "Customer", true],
  ["number: the table id", "50100", true],
  ["dotted, other table", "Microsoft.Sales.Vendor", false],
  ["plain, other table", "Vendor", false],
  ["number: another id", "77", false],
];

describe("R-876: extendedTableOf, via resolveReceiverTable on a bare call", () => {
  // Red: read `childForFieldName("base_object")` (the whole dotted text) in extendedTableOf.
  const tableOf = (base: string) => {
    const { files, ctx } = ctxOf([
      `tableextension 50101 "Cust Ext" extends ${base}\n{\n    trigger OnInsert()\n    begin\n        SetRange("No.", 'x');\n    end;\n}\n`,
    ]);
    const root = files[0]?.root;
    if (root === undefined) throw new Error("no root");
    return resolveReceiverTable(
      firstNode(root, (n) => n.kind === ALNodeKind.procedure_call),
      ctx,
    );
  };
  it("a dotted base resolves to its last segment", () => {
    expect(tableOf("Microsoft.Sales.Customer")).toBe("Customer");
    expect(tableOf('"My.Ns"."Customer"')).toBe("Customer");
  });
  it("a plain base resolves to its name", () => {
    expect(tableOf("Customer")).toBe("Customer");
    expect(tableOf('"Sales Header"')).toBe("Sales Header");
  });
  it("a number base resolves to the id text, which tableObjectOfRef matches by id", () => {
    expect(tableOf("18")).toBe("18");
  });
});

describe("R-876: projectDeclaresProcedureOnTable, indexed and unindexed (#if) tableextension", () => {
  // The extension declares SetRange, so a call on a Customer variable is that procedure: no claim.
  const ext = (base: string) =>
    `tableextension 50101 "Cust Ext" extends ${base}\n{\n    procedure SetRange(A: Integer; B: Integer)\n    begin\n    end;\n}\n`;
  const CALLER = `codeunit 50102 Caller
{
    procedure P()
    var
        C: Record Customer;
    begin
        C.SetRange("No.", 'x');
    end;
}
`;
  const claims = (extSrc: string) => {
    const { files, ctx } = ctxOf([CUSTOMER, CALLER, extSrc]);
    const root = files[1]?.root;
    if (root === undefined) throw new Error("no root");
    return claimsRecordMethod(
      firstNode(root, (n) => n.kind === ALNodeKind.procedure_call),
      ctx,
      "SetRange",
    );
  };
  for (const [label, base, named] of TABLE_BASES) {
    // Red (unindexed): read `childForFieldName("base_object")?.text` for the `#if`-wrapped one.
    it(`unindexed, ${label}: ${named ? "refuses" : "keeps the claim"}`, () => {
      expect(claims(wrapped(ext(base)))).toBe(!named);
    });
    // Red (indexed): compare `ext.baseObject` whole.
    it(`indexed, ${label}: ${named ? "refuses" : "keeps the claim"}`, () => {
      expect(claims(ext(base))).toBe(!named);
    });
  }
});

describe("R-876: mayHaveMember, via bareReceiverText", () => {
  // A procedure named Rec on an extension of the page's table stops `Rec.` being written.
  const PAGE = `page 50120 P
{
    SourceTable = Customer;

    trigger OnOpenPage()
    begin
        Validate("No.", 'x');
    end;
}
`;
  const ext = (base: string) =>
    `tableextension 50101 "Cust Ext" extends ${base}\n{\n    procedure Rec()\n    begin\n    end;\n}\n`;
  const receiver = (extSrc: string) => {
    const { files, ctx } = ctxOf([CUSTOMER, PAGE, extSrc]);
    const root = files[1]?.root;
    if (root === undefined) throw new Error("no root");
    return bareReceiverText(
      firstNode(root, (n) => n.rawKind === "call_expression" && n.text.startsWith("Validate")),
      ctx,
    );
  };
  for (const [label, base, named] of TABLE_BASES) {
    it(`indexed, ${label}: ${named ? "blocks Rec" : "leaves Rec"}`, () => {
      expect(receiver(ext(base))).toBe(named ? null : "Rec");
    });
    it(`unindexed, ${label}: ${named ? "blocks Rec" : "leaves Rec"}`, () => {
      expect(receiver(wrapped(ext(base)))).toBe(named ? null : "Rec");
    });
  }
});

describe("R-876: basePageDeclaresVisible, via claimsSystemCall in a pageextension", () => {
  const PAGE = `page 50600 "Base Page"
{
    procedure Commit(): Integer
    begin
    end;
}
`;
  const ext = (base: string) => `pageextension 50601 "Base Ext" extends ${base}
{
    trigger OnOpenPage()
    begin
        Commit();
    end;
}
`;
  const claims = (base: string) => {
    const { files, ctx } = ctxOf([PAGE, ext(base)]);
    const root = files[1]?.root;
    if (root === undefined) throw new Error("no root");
    return claimsSystemCall(
      firstNode(root, (n) => n.kind === ALNodeKind.procedure_call),
      ctx,
      "Commit",
    );
  };
  // Red: read `childForFieldName("base_object")?.text` (whole dotted text; no id match).
  it("dotted base naming the page: refused", () => {
    expect(claims('Microsoft.Sales."Base Page"')).toBe(false);
    expect(claims('"My.Ns"."Base Page"')).toBe(false);
  });
  it("plain base naming the page: refused", () => {
    expect(claims('"Base Page"')).toBe(false);
  });
  it("number base equal to the page id: refused", () => {
    expect(claims("50600")).toBe(false);
  });
  it("other pages, dotted, plain or number: the claim stands", () => {
    expect(claims("Microsoft.Sales.Other")).toBe(true);
    expect(claims("Other")).toBe(true);
    expect(claims("77")).toBe(true);
  });
});
