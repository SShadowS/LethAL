import { beforeAll, describe, expect, it } from "bun:test";
/**
 * `RemoveSetRange` — delete `<rec>.SetRange(F, ...)`, but SKIP the no-value
 * form: `SetRange(F)` *clears* a filter, so deleting it *preserves* one — the
 * inverse of every other deletion operator's effect at its site.
 *
 * Spec: docs/superpowers/specs/2026-07-25-tier2-mutation-operators-design.md §4 table.
 * `claimsRecordMethod` itself is exhaustively tested in `receiver.test.ts`;
 * this file exercises the operator's own three guards — statement position,
 * the receiver claim, and the arity guard specific to this operator — end to
 * end through `targets`/`generate`.
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
import { removeSetRange } from "../src/remove-setrange";

function specsFor(sourceAL: string) {
  const root = wrapRoot(parseAL(sourceAL));
  const ctx: SemanticContext = buildSemanticContext([{ path: "fixture.al", root }]);
  const calls: ALSyntaxNode[] = findAll(root, ALNodeKind.procedure_call);
  return calls
    .filter((n) => removeSetRange.targets(n, ctx))
    .flatMap((n) => removeSetRange.generate(n, ctx));
}

describe("removeSetRange", () => {
  beforeAll(async () => {
    await initParser();
  });

  it("claims a two-argument SetRange call and deletes it", () => {
    const src = `codeunit 50120 "C" { procedure P() var Cust: Record Customer; begin Cust.SetRange("No.", 'A'); end; }`;
    const specs = specsFor(src);
    expect(specs.map((s) => s.before.text)).toEqual(["Cust.SetRange(\"No.\", 'A')"]);
    const [spec] = specs;
    expect(spec).toBeDefined();
    if (spec === undefined) return;
    expect(spec.after.text).toBe("");
    expect(spec.operatorName).toBe("lethal.remove-setrange");
    expect(spec.parentContext).toBe("statement-position");
  });

  it("claims a three-argument (from/to range) SetRange call and deletes it", () => {
    const src = `codeunit 50121 "C" { procedure P() var Cust: Record Customer; begin Cust.SetRange("No.", 'A', 'Z'); end; }`;
    const specs = specsFor(src);
    expect(specs.map((s) => s.before.text)).toEqual(["Cust.SetRange(\"No.\", 'A', 'Z')"]);
    expect(specs[0]?.after.text).toBe("");
  });

  it("claims the implicit-receiver form inside a table trigger body", () => {
    const src = `table 50122 "T" { fields { field(1; "No."; Code[20]) { } } trigger OnInsert() begin SetRange("No.", 'A'); end; }`;
    const specs = specsFor(src);
    expect(specs.map((s) => s.before.text)).toEqual(["SetRange(\"No.\", 'A')"]);
  });

  it("REFUSES the no-value SetRange(F) form — it clears a filter, so deleting it preserves one", () => {
    const src = `codeunit 50123 "C" { procedure P() var Cust: Record Customer; begin Cust.SetRange("No."); end; }`;
    expect(specsFor(src)).toEqual([]);
  });

  it("REFUSES a receiver that resolves to a non-record (Builder.SetRange)", () => {
    const src = `codeunit 50124 "C" { procedure P() var Builder: Codeunit "My Builder"; begin Builder.SetRange('A', 'Z'); end; }`;
    expect(specsFor(src)).toEqual([]);
  });

  it("is case-insensitive on the method name", () => {
    const src = `codeunit 50125 "C" { procedure P() var Cust: Record Customer; begin Cust.SETRANGE("No.", 'A'); end; }`;
    const specs = specsFor(src);
    expect(specs.map((s) => s.before.text)).toEqual(["Cust.SETRANGE(\"No.\", 'A')"]);
  });

  it("is statement-position only: does not claim an if's then-branch call", () => {
    const src = `codeunit 50126 "C" { procedure P() var Cust: Record Customer; begin if Cust.Find() then Cust.SetRange("No.", 'A'); end; }`;
    expect(specsFor(src)).toEqual([]);
  });
});
