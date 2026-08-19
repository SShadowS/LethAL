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
  findAll,
  initParser,
} from "@lethal/engine";
import { removeSetRange } from "../src/remove-setrange";
import { contextFor, parseClean } from "./parse-clean";

/**
 * `parseClean` rather than a bare `parseAL`: half the assertions below are REFUSALS, and a snippet
 * that failed to parse would yield no `call_expression` at all — the operator would "refuse" it
 * whatever its guards did. The comment cases in particular carry layouts worth proving parse.
 */
function specsFor(sourceAL: string) {
  const root = parseClean(sourceAL);
  const ctx: SemanticContext = contextFor(root);
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

  /**
   * The three cases below are the same rule as the one above, with a COMMENT inside the
   * parentheses. The grammar emits comments as **named** children of an `argument_list`
   * (measured: `["quoted_identifier", "multiline_comment"]` / `["quoted_identifier", "comment"]`),
   * so an arity guard reading `namedChildren.length >= 2` sees a two-argument call and claims the
   * site.
   *
   * That is worse than a missed site. `SetRange(F)` CLEARS a filter, so deleting it PRESERVES one
   * — the inverse of the intended mutation, quietly corrupting kill/survive results at that site
   * and (Tier 2 outranking Tier 1 in §3.2 dedup) suppressing the correct `void-method-call` mutant
   * there too. The multi-line `// reset the filter` layout is ordinary AL.
   */
  it("REFUSES SetRange(F) with a block comment inside the parentheses", () => {
    const src = `codeunit 50127 "C" { procedure P() var Cust: Record Customer; begin Cust.SetRange("No." /* clear it */); end; }`;
    expect(specsFor(src)).toEqual([]);
  });

  it("REFUSES SetRange(F) with a trailing line comment on a multi-line call", () => {
    const src = `codeunit 50128 "C"
{
    procedure P()
    var
        Cust: Record Customer;
    begin
        Cust.SetRange(
            "No."  // reset the filter
        );
    end;
}`;
    expect(specsFor(src)).toEqual([]);
  });

  it("still CLAIMS SetRange(F, V) when a comment sits inside the parentheses", () => {
    // The counterweight: the comment fix must not turn into "refuse anything with a comment".
    const src = `codeunit 50129 "C" { procedure P() var Cust: Record Customer; begin Cust.SetRange("No." /* the key */, 'A'); end; }`;
    const specs = specsFor(src);
    expect(specs.map((s) => s.before.text)).toEqual(["Cust.SetRange(\"No.\" /* the key */, 'A')"]);
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

  /**
   * R161 FLIPPED this test. It asserted the refusal of an un-braced then-branch, which was
   * `isStatementPosition` standing in for "is this a statement"; a `then_branch` is a statement slot
   * and the site was refused for no reason but the predicate. The emit hazard the old test guarded
   * is now guarded where it can actually be measured: `scripts/r161-emit-proof.ts` compiles the
   * instrumented output with `alc` and carries a negative control that must be REJECTED.
   */
  it("claims a SetRange sitting as an if's then-branch (R161)", () => {
    const src = `codeunit 50126 "C" { procedure P() var Cust: Record Customer; begin if Cust.Find() then Cust.SetRange("No.", 'A'); end; }`;
    const specs = specsFor(src);
    expect(specs).toHaveLength(1);
    expect(specs[0]?.before.text).toBe(`Cust.SetRange("No.", 'A')`);
    expect(specs[0]?.after.text).toBe("");
  });
});
