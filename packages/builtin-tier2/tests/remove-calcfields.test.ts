import { beforeAll, describe, expect, it } from "bun:test";
/**
 * `RemoveCalcFields` — delete `<rec>.CalcFields(...)` where the Boolean return is unused.
 *
 * Spec: docs/superpowers/specs/2026-07-25-tier2-mutation-operators-design.md §4 table.
 * `claimsRecordMethod` itself is exhaustively tested in `receiver.test.ts`; this file exercises
 * the operator's own guards — statement position (which doubles as the "return value unused"
 * guard for this operator, per the doc comment in `../src/remove-calcfields.ts`) and the
 * arity-agnostic claim — end to end through `targets`/`generate`.
 */
import {
  ALNodeKind,
  type ALSyntaxNode,
  type SemanticContext,
  buildSemanticContext,
  findAll,
  initParser,
  parseAL,
  wrapRoot,
} from "@lethal/engine";
import { removeCalcFields } from "../src/remove-calcfields";

function specsFor(sourceAL: string) {
  const root = wrapRoot(parseAL(sourceAL));
  const ctx: SemanticContext = buildSemanticContext([{ path: "fixture.al", root }]);
  const calls: ALSyntaxNode[] = findAll(root, ALNodeKind.procedure_call);
  return calls
    .filter((n) => removeCalcFields.targets(n, ctx))
    .flatMap((n) => removeCalcFields.generate(n, ctx));
}

describe("removeCalcFields", () => {
  beforeAll(async () => {
    await initParser();
  });

  it("claims a one-field CalcFields call whose return is unused and deletes it", () => {
    const src = `table 50130 "T" { fields { field(1; "No."; Code[20]) { } } trigger OnAfterGetRecord() begin Rec.CalcFields("No."); end; }`;
    const specs = specsFor(src);
    expect(specs.map((s) => s.before.text)).toEqual(['Rec.CalcFields("No.")']);
    const [spec] = specs;
    expect(spec).toBeDefined();
    if (spec === undefined) return;
    expect(spec.after.text).toBe("");
    expect(spec.operatorName).toBe("lethal.remove-calcfields");
    expect(spec.parentContext).toBe("statement-position");
  });

  it("claims a multi-field CalcFields call and deletes it", () => {
    const src = `table 50131 "T" { fields { field(1; "No."; Code[20]) { } field(2; "Name"; Text[50]) { } } trigger OnAfterGetRecord() begin Rec.CalcFields("No.", "Name"); end; }`;
    const specs = specsFor(src);
    expect(specs.map((s) => s.before.text)).toEqual(['Rec.CalcFields("No.", "Name")']);
    expect(specs[0]?.after.text).toBe("");
  });

  it("claims the implicit-receiver form inside a table trigger body", () => {
    const src = `table 50132 "T" { fields { field(1; "No."; Code[20]) { } } trigger OnAfterGetRecord() begin CalcFields("No."); end; }`;
    const specs = specsFor(src);
    expect(specs.map((s) => s.before.text)).toEqual(['CalcFields("No.")']);
  });

  it("REFUSES a receiver that resolves to a non-record (Validator.CalcFields)", () => {
    const src = `codeunit 50133 "C" { procedure P() var Validator: Codeunit "My Validator"; begin Validator.CalcFields(X); end; }`;
    expect(specsFor(src)).toEqual([]);
  });

  it("REFUSES a project-declared CalcFields procedure", () => {
    const src = `table 50134 "T"
{
    fields { field(1; "No."; Code[20]) { } }

    trigger OnAfterGetRecord()
    begin
        CalcFields(X);
    end;

    procedure CalcFields(V: Integer)
    begin
    end;
}`;
    expect(specsFor(src)).toEqual([]);
  });

  it("is case-insensitive on the method name", () => {
    const src = `table 50135 "T" { fields { field(1; "No."; Code[20]) { } } trigger OnAfterGetRecord() begin Rec.CALCFIELDS("No."); end; }`;
    const specs = specsFor(src);
    expect(specs.map((s) => s.before.text)).toEqual(['Rec.CALCFIELDS("No.")']);
  });

  it("REFUSES the form whose return value is consumed by an if condition", () => {
    // Deleting this would leave `if  then Message('missing');`, which changes
    // control flow rather than deleting a statement whose value nobody reads.
    const src = `table 50136 "T"
{
    fields { field(1; "No."; Code[20]) { } }

    trigger OnAfterGetRecord()
    begin
        if Rec.CalcFields("No.") then Message('ok');
    end;
}`;
    expect(specsFor(src)).toEqual([]);
  });

  it("REFUSES the form whose return value is consumed by an assignment", () => {
    const src = `codeunit 50137 "C" { procedure P() var Cust: Record Customer; Success: Boolean; begin Success := Cust.CalcFields("No."); end; }`;
    expect(specsFor(src)).toEqual([]);
  });
});
