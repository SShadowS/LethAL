import { beforeAll, describe, expect, it } from "bun:test";
/**
 * R-464: `lookupVar`'s PRECISE field-over-variable guard (engine `semantic/receiver.ts`).
 *
 * A record field wins over a variable only where AL binds it: a `with` subject's field over any
 * variable; an implicit record's field (page SourceTable, TableNo OnRun, report dataitem chain)
 * over an object GLOBAL, never in a table or tableextension (R294). And only a field this project
 * DECLARES counts: an unknown table proves nothing, so the variable stands. Each direction below.
 */
import { ALNodeKind } from "../../src/ast/node-kinds";
import { initParser, parseAL } from "../../src/ast/parser";
import { type ALSyntaxNode, wrapRoot } from "../../src/ast/syntax-node";
import { buildSemanticContext } from "../../src/semantic/context";
import { normalizeAlName, resolveVarRef } from "../../src/semantic/resolve-var-ref";

const OWN = `table 50100 Own
{
    fields
    {
        field(1; "No."; Code[20]) { }
        field(2; Flag; Boolean) { }
    }
}`;

/** Resolve the LAST use of `name` in `src` (one project context with table Own). */
function resolvedAt(src: string, name: string): string {
  const own = wrapRoot(parseAL(OWN));
  const root = wrapRoot(parseAL(src));
  const ctx = buildSemanticContext([
    { path: "Own.al", root: own },
    { path: "t.al", root },
  ]);
  const hits: ALSyntaxNode[] = [];
  const walk = (n: ALSyntaxNode): void => {
    if (n.kind === ALNodeKind.identifier && normalizeAlName(n.text) === normalizeAlName(name))
      hits.push(n);
    for (const c of n.namedChildren) walk(c);
  };
  walk(root);
  const last = hits[hits.length - 1];
  if (last === undefined) throw new Error(`no identifier ${name}`);
  const sym = resolveVarRef(last, ctx);
  return sym === null ? "null" : sym.typeText;
}

describe("R-464 lookupVar field-over-variable guard", () => {
  beforeAll(async () => {
    await initParser();
  });

  it("page global named like a SourceTable field -> null (the field binds)", () => {
    const src = `page 50103 P
{
    SourceTable = Own;
    var
        Flag: Integer;
    trigger OnOpenPage()
    begin
        Flag := 1;
    end;
}`;
    expect(resolvedAt(src, "Flag")).toBe("null");
  });

  it("page LOCAL named like a SourceTable field -> the local (an implicit field beats globals only)", () => {
    const src = `page 50103 P
{
    SourceTable = Own;
    trigger OnOpenPage()
    var
        Flag: Integer;
    begin
        Flag := 1;
    end;
}`;
    expect(resolvedAt(src, "Flag")).toBe("Integer");
  });

  it("page global with NO same-named field -> the global", () => {
    const src = `page 50103 P
{
    SourceTable = Own;
    var
        NotAField: Integer;
    trigger OnOpenPage()
    begin
        NotAField := 1;
    end;
}`;
    expect(resolvedAt(src, "NotAField")).toBe("Integer");
  });

  it("table global named like its own field -> the global (R294: the global wins there)", () => {
    const src = `tableextension 50104 OwnExt extends Own
{
    var
        Flag: Integer;
    trigger OnAfterInsert()
    begin
        Flag := 1;
    end;
}`;
    expect(resolvedAt(src, "Flag")).toBe("Integer");
    const table = `table 50109 Own2
{
    fields
    {
        field(1; "No."; Code[20]) { }
        field(2; Flag; Boolean) { }
    }
    var
        Flag2: Integer;
    trigger OnInsert()
    begin
        Flag2 := 1;
    end;
}`;
    // The table's own field `Flag` vs a global `Flag`: the global wins in a table too.
    expect(resolvedAt(table.replaceAll("Flag2", "Flag"), "Flag")).toBe("Integer");
  });

  it("report global named like an OUTER dataitem's field -> null; in a report procedure -> global", () => {
    const inner = `report 50105 R
{
    var
        Flag: Integer;
    dataset
    {
        dataitem(Hdr; Own)
        {
            dataitem(Line; Integer)
            {
                trigger OnAfterGetRecord()
                begin
                    Flag := 1;
                end;
            }
        }
    }
}`;
    const outside = `report 50105 R
{
    var
        Flag: Integer;
    dataset
    {
        dataitem(Hdr; Own) { }
    }
    procedure P()
    begin
        Flag := 1;
    end;
}`;
    expect(resolvedAt(inner, "Flag")).toBe("null");
    expect(resolvedAt(outside, "Flag")).toBe("Integer");
  });

  it("a `with` subject's field beats a LOCAL -> null; outside the with -> the local", () => {
    const inWith = `codeunit 50106 C
{
    procedure P()
    var
        R: Record Own;
        Flag: Integer;
    begin
        with R do begin
            Flag := true;
        end;
    end;
}`;
    const outside = `codeunit 50106 C
{
    procedure P()
    var
        R: Record Own;
        Flag: Integer;
    begin
        with R do begin
        end;
        Flag := 1;
    end;
}`;
    expect(resolvedAt(inWith, "Flag")).toBe("null");
    expect(resolvedAt(outside, "Flag")).toBe("Integer");
  });

  it("implicit table the project does not declare -> the global stands (never a blanket refusal)", () => {
    const src = `page 50107 P
{
    SourceTable = Customer;
    var
        Name: Integer;
    trigger OnOpenPage()
    begin
        Name := 1;
    end;
}`;
    expect(resolvedAt(src, "Name")).toBe("Integer");
  });

  it("TableNo OnRun: a global named like the TableNo table's field -> null; another trigger -> global", () => {
    const onRun = `codeunit 50108 C
{
    TableNo = Own;
    var
        Flag: Integer;
    trigger OnRun()
    begin
        Flag := 1;
    end;
}`;
    const other = `codeunit 50108 C
{
    TableNo = Own;
    var
        Flag: Integer;
    procedure P()
    begin
        Flag := 1;
    end;
}`;
    expect(resolvedAt(onRun, "Flag")).toBe("null");
    expect(resolvedAt(other, "Flag")).toBe("Integer");
  });
});
