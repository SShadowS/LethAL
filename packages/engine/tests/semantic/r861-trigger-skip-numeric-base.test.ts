import { beforeAll, describe, expect, it } from "bun:test";
/**
 * R861: `procedureNamesOn` (trigger-skip) must find a tableextension's procedure when the extension
 * names its base by id. A trigger's bare call to that procedure is then not harmless, and the skip
 * tag stays. An unresolved id (a dependency's table) may extend any table: it keeps the tag too.
 */
import { initParser, parseAL } from "../../src/ast/parser";
import { type ALSyntaxNode, visit, wrapRoot } from "../../src/ast/syntax-node";
import { buildSemanticContext } from "../../src/semantic/context";
import { modifySkipCanRaise } from "../../src/semantic/trigger-skip";

const PAR = `table 50300 Par
{
    fields
    {
        field(1; "No."; Code[20]) { }
    }
    trigger OnModify()
    begin
        if Touch then
            Rec."No." := '';
    end;
}
`;
const OTHER = `table 50301 Other
{
    fields
    {
        field(1; "No."; Code[20]) { }
    }
}
`;
const CALLER = `codeunit 50309 Ops
{
    procedure P()
    var
        Par: Record Par;
    begin
        Par.Modify(true);
    end;
}
`;
const ext = (base: string) => `tableextension 50302 ParExt extends ${base}
{
    procedure Touch(): Boolean
    begin
        Codeunit.Run(50999);
        exit(true);
    end;
}
`;

function skipTag(extension: string): boolean {
  const files = [PAR, OTHER, CALLER, extension].map((src, i) => ({
    path: `f${i}.al`,
    root: wrapRoot(parseAL(src)),
  }));
  const ctx = buildSemanticContext(files);
  const ops = files[2]?.root;
  if (ops === undefined) throw new Error("no caller");
  let call: ALSyntaxNode | undefined;
  visit(ops, (n) => {
    if (call === undefined && n.rawKind === "call_expression") call = n;
  });
  if (call === undefined) throw new Error("no call");
  return modifySkipCanRaise(call, ctx);
}

describe("R861: trigger-skip's procedureNamesOn reads a numeric extends base", () => {
  beforeAll(async () => {
    await initParser();
  });
  it("a plain name (control): the extension's Touch keeps the tag", () => {
    expect(skipTag(ext("Par"))).toBe(true);
  });
  it("resolved to this table (`extends 50300`): the tag stays (red: compared by name only)", () => {
    expect(skipTag(ext("50300"))).toBe(true);
  });
  it("resolved to ANOTHER table (`extends 50301`): not this table's procedure, the tag drops", () => {
    expect(skipTag(ext("50301"))).toBe(false);
  });
  it("unresolved (`extends 18`): may extend any table, the tag stays (red: unresolved skipped)", () => {
    expect(skipTag(ext("18"))).toBe(true);
  });
});
