import { beforeAll, describe, expect, it } from "bun:test";
/**
 * R567: the engine's two attribute/argument readers that read by position, `onInsertAssignsPrimaryKey`
 * (the Validate scan) and trigger-skip's `subscribesToTable`, read through `argumentList`. Each test
 * was red-checked by reverting that one reader (`/coord/handoff/R-567/redcheck.md`).
 */
import { initParser, parseAL } from "../../src/ast/parser";
import { type ALSyntaxNode, visit, wrapRoot } from "../../src/ast/syntax-node";
import { buildSemanticContext } from "../../src/semantic/context";
import { onInsertAssignsPrimaryKey } from "../../src/semantic/insert-key-assignment";
import { forceCanRaise } from "../../src/semantic/trigger-skip";

beforeAll(async () => {
  await initParser();
});

const PRAGMA = "#pragma warning disable AA0001";

const table = (onInsert: string): ALSyntaxNode => {
  const src = `table 50190 "Key T"
{
    fields { field(1; "No."; Code[20]) { } field(2; Flag; Boolean) { } }
    keys { key(PK; "No.") { Clustered = true; } }
    trigger OnInsert()
    begin
        ${onInsert}
    end;
}`;
  let hit: ALSyntaxNode | undefined;
  visit(wrapRoot(parseAL(src)), (n: ALSyntaxNode) => {
    if (hit === undefined && n.rawKind === "table_declaration") hit = n;
  });
  if (hit === undefined) throw new Error("no table");
  return hit;
};

describe("R567: insert-key-assignment's Validate scan", () => {
  it("control: `Validate(Flag, true)` assigns no key field", () => {
    expect(onInsertAssignsPrimaryKey(table("Validate(Flag, true);"))).toBe(false);
  });
  it('a comment before the field: `Validate(/*c*/ "No.", ...)` assigns the key', () => {
    expect(onInsertAssignsPrimaryKey(table(`Validate(/*c*/ "No.", 'K');`))).toBe(true);
  });
  it("unreadable (a pragma among the arguments): counts as assigning the key (keeps the tag)", () => {
    expect(onInsertAssignsPrimaryKey(table(`Validate(\n${PRAGMA}\n Flag, true);`))).toBe(true);
  });
});

const PAR = `table 50300 Par
{
    fields { field(1; "No."; Code[20]) { } }
}`;
const CALLER = `codeunit 50301 Ops
{
    procedure P()
    var
        Par: Record Par;
    begin
        Par.Modify();
    end;
}`;
/** A codeunit the symbol table does not index (an `#if` wrapper, no arm map): read structurally by
 *  `subscribesToTable`. */
const wrappedSub = (args: string): string =>
  `#if X\ncodeunit 50303 Subs\n{\n    [EventSubscriber(${args})]\n    local procedure Handle()\n    begin\n    end;\n}\n#endif\n`;

/** The forced tag on `Par.Modify()` with `observer` in the project. */
function forced(observer: string): boolean {
  const files = [
    { path: "Par.al", root: wrapRoot(parseAL(PAR)) },
    { path: "Ops.al", root: wrapRoot(parseAL(CALLER)) },
    { path: "Obs.al", root: wrapRoot(parseAL(observer)) },
  ];
  const ctx = buildSemanticContext(files);
  const ops = files[1]?.root;
  if (ops === undefined) throw new Error("no caller");
  let call: ALSyntaxNode | undefined;
  visit(ops, (n: ALSyntaxNode) => {
    if (call === undefined && n.rawKind === "call_expression") call = n;
  });
  if (call === undefined) throw new Error("no call");
  return forceCanRaise(call, ctx, "modify");
}

describe("R567: trigger-skip's subscribesToTable", () => {
  it("controls: a subscriber of Par keeps the tag, one of another table drops it", () => {
    expect(
      forced(wrappedSub("ObjectType::Table, Database::Par, 'OnCustom', '', false, false")),
    ).toBe(true);
    expect(
      forced(wrappedSub("ObjectType::Table, Database::Oth, 'OnCustom', '', false, false")),
    ).toBe(false);
  });
  it("a comment before the target: `/*c*/ Database::Oth` is read as another table", () => {
    expect(
      forced(wrappedSub("ObjectType::Table, /*c*/ Database::Oth, 'OnCustom', '', false, false")),
    ).toBe(false);
  });
});
