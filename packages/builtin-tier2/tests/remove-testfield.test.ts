import { beforeAll, describe, expect, it } from "bun:test";
/**
 * `RemoveTestField` — delete `<rec>.TestField(...)`, both call-arity forms.
 *
 * Spec: docs/superpowers/specs/2026-07-25-tier2-mutation-operators-design.md §4 table.
 * The predicate itself (`claimsRecordMethod`) is exhaustively tested in
 * `receiver.test.ts`; this file exercises the operator's own two guards —
 * statement position, and the arity-agnostic claim — end to end through
 * `targets`/`generate`, following `packages/builtin-tier1/tests/*`'s shape.
 */
import {
  ALNodeKind,
  type ALSyntaxNode,
  type SemanticContext,
  findAll,
  initParser,
} from "@lethal/engine";
import { removeTestField } from "../src/remove-testfield";
import { contextFor, parseClean } from "./parse-clean";

/**
 * `parseClean` rather than a bare `parseAL`: the refusal assertions below would pass for the wrong
 * reason on a snippet that failed to parse — no `call_expression`, hence no spec, hence "refused"
 * whatever the operator's guards did.
 */
function specsFor(sourceAL: string) {
  const root = parseClean(sourceAL);
  const ctx: SemanticContext = contextFor(root);
  const calls: ALSyntaxNode[] = findAll(root, ALNodeKind.procedure_call);
  return calls
    .filter((n) => removeTestField.targets(n, ctx))
    .flatMap((n) => removeTestField.generate(n, ctx));
}

describe("removeTestField", () => {
  beforeAll(async () => {
    await initParser();
  });

  it("claims a one-argument TestField call and deletes it", () => {
    const src = `table 50100 "T" { fields { field(1; "No."; Code[20]) { } } trigger OnInsert() begin Rec.TestField("No."); end; }`;
    const specs = specsFor(src);
    expect(specs.map((s) => s.before.text)).toEqual(['Rec.TestField("No.")']);
    const [spec] = specs;
    expect(spec).toBeDefined();
    if (spec === undefined) return;
    expect(spec.after.text).toBe("");
    expect(spec.operatorName).toBe("lethal.remove-testfield");
    expect(spec.parentContext).toBe("statement-position");
  });

  it("claims a two-argument TestField call and deletes it", () => {
    const src = `table 50101 "T" { fields { field(1; "No."; Code[20]) { } } trigger OnInsert() begin Rec.TestField("No.", 'must have a value'); end; }`;
    const specs = specsFor(src);
    expect(specs.map((s) => s.before.text)).toEqual([
      "Rec.TestField(\"No.\", 'must have a value')",
    ]);
    expect(specs[0]?.after.text).toBe("");
  });

  it("claims the implicit-receiver form inside a table trigger body", () => {
    const src = `table 50102 "T" { fields { field(1; "No."; Code[20]) { } } trigger OnInsert() begin TestField("No."); end; }`;
    const specs = specsFor(src);
    expect(specs.map((s) => s.before.text)).toEqual(['TestField("No.")']);
  });

  it("REFUSES a receiver that resolves to a non-record (Validator.TestField)", () => {
    const src = `codeunit 50103 "C" { procedure P() var Validator: Codeunit "My Validator"; begin Validator.TestField(X); end; }`;
    expect(specsFor(src)).toEqual([]);
  });

  it("REFUSES a project-declared TestField procedure", () => {
    const src = `table 50104 "T"
{
    fields { field(1; "No."; Code[20]) { } }

    trigger OnInsert()
    begin
        TestField(X);
    end;

    procedure TestField(V: Integer)
    begin
    end;
}`;
    expect(specsFor(src)).toEqual([]);
  });

  it("is statement-position only: does not claim an if's then-branch call", () => {
    // Deleting this would leave `if Rec.Find() then ;`, which changes control
    // flow rather than deleting a statement — the reasoning `void-method-call`
    // already applies, reused here rather than re-derived.
    const src = `table 50105 "T"
{
    fields { field(1; "No."; Code[20]) { } }

    trigger OnInsert()
    begin
        if Rec.Find() then Rec.TestField("No.");
    end;
}`;
    expect(specsFor(src)).toEqual([]);
  });
});
