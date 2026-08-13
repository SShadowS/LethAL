import { beforeAll, describe, expect, it } from "bun:test";
/**
 * `SwapFindDirection`: rewrite `<rec>.FindFirst()` <-> `<rec>.FindLast()`.
 *
 * Spec: docs/superpowers/specs/2026-08-12-r136-tier2-trio-design.md §2.2.
 * `claimsRecordMethod` itself is exhaustively tested in `receiver.test.ts`; this file exercises the
 * operator's own guards (the zero-argument guard, and which direction claims) plus the shared
 * `calleeNameNode` splice both new Tier-2 operators use.
 */
import {
  ALNodeKind,
  type ALSyntaxNode,
  type SemanticContext,
  findAll,
  initParser,
} from "@lethal/engine";
import { swapFindDirection } from "../src/swap-find-direction";
import { contextFor, parseClean, projectContextFor } from "./parse-clean";

function specsFor(sourceAL: string) {
  const root = parseClean(sourceAL);
  const ctx: SemanticContext = contextFor(root);
  const calls: ALSyntaxNode[] = findAll(root, ALNodeKind.procedure_call);
  return calls
    .filter((n) => swapFindDirection.targets(n, ctx))
    .flatMap((n) => swapFindDirection.generate(n, ctx));
}

describe("swapFindDirection", () => {
  beforeAll(async () => {
    await initParser();
  });

  it("swaps FindFirst to FindLast and FindLast to FindFirst, preserving receiver and casing context", () => {
    const src = `codeunit 50170 "T" {
      procedure P()
      var Rec: Record Customer;
      begin
        Rec.FindFirst();
        if Rec.FindLast() then;
      end;
    }`;
    const specs = specsFor(src);
    expect(specs.map((s) => s.before.text)).toEqual(["Rec.FindFirst()", "Rec.FindLast()"]);
    expect(specs.map((s) => s.after.text)).toEqual(["Rec.FindLast()", "Rec.FindFirst()"]);
  });

  it("computes parentContext honestly, the guarded form is expression position", () => {
    const src = `codeunit 50171 "T" {
      procedure P(): Boolean
      var Rec: Record Customer;
      begin
        Rec.FindFirst();
        exit(Rec.FindLast());
      end;
    }`;
    const specs = specsFor(src);
    expect(specs.map((s) => s.parentContext)).toEqual([
      "statement-position",
      "expression-position",
    ]);
  });

  it("refuses arguments: Find('-') and FindSet variants are different operations", () => {
    const src = `codeunit 50172 "T" {
      procedure P()
      var Rec: Record Customer;
      begin
        Rec.Find('-');
        Rec.FindSet(true);
        Rec.FindSet();
      end;
    }`;
    expect(specsFor(src)).toEqual([]);
  });

  /**
   * The test above refuses `Find`/`FindSet` by METHOD-NAME mismatch alone: none of those calls is
   * named `FindFirst`/`FindLast`, so it stays refused even with the zero-argument guard removed
   * (verified by red-check, see the task report). This test isolates the guard itself: a call
   * named `FindFirst`/`FindLast` that carries an argument is a shape the real AL methods do not
   * have, but the grammar parses it, and the guard is what refuses it rather than the name check.
   */
  it("refuses FindFirst/FindLast called with an argument: the zero-argument guard, not the name", () => {
    const src = `codeunit 50182 "T" {
      procedure P()
      var Rec: Record Customer;
      begin
        Rec.FindFirst(1);
        Rec.FindLast(1);
      end;
    }`;
    expect(specsFor(src)).toEqual([]);
  });

  it("refuses an unproven receiver", () => {
    const src = `codeunit 50173 "T" {
      procedure P(Mystery: Variant)
      begin
        Mystery.FindFirst();
      end;
    }`;
    expect(specsFor(src)).toEqual([]);
  });

  it("matches case-insensitively and emits canonical replacement text", () => {
    const src = `codeunit 50174 "T" {
      procedure P()
      var Rec: Record Customer;
      begin
        Rec.FINDFIRST();
      end;
    }`;
    const specs = specsFor(src);
    expect(specs).toHaveLength(1);
    expect(specs[0]?.after.text).toBe("Rec.FindLast()");
  });

  /**
   * Spec §2.2's recorded consequence: a quoted method spelling is claimed today because
   * `claimsRecordMethod` strips quotes before comparing names, and splicing the canonical bare
   * name over the QUOTED span still produces valid AL. This pins that consequence rather than
   * leaving it as prose the next reader has to take on faith.
   */
  it("splices the canonical name over a quoted method spelling", () => {
    const src = `codeunit 50175 "T" {
      procedure P()
      var Rec: Record Customer;
      begin
        Rec."FindFirst"();
      end;
    }`;
    const specs = specsFor(src);
    expect(specs).toHaveLength(1);
    expect(specs[0]?.before.text).toBe('Rec."FindFirst"()');
    expect(specs[0]?.after.text).toBe("Rec.FindLast()");
  });

  /**
   * The implicit-receiver form (`Rec` implicit inside a table's own code) had no claim test at all
   * for this operator, unlike `swap-modify-flag`'s pre-existing one for `Modify`. This pins both
   * directions of it directly, inside a table's own trigger body.
   */
  it("claims the implicit-receiver form of FindFirst() inside a table trigger body", () => {
    const src = `table 50190 "T3" { fields { field(1; "No."; Code[20]) { } } trigger OnInsert() begin FindFirst(); end; }`;
    const specs = specsFor(src);
    expect(specs.map((s) => s.before.text)).toEqual(["FindFirst()"]);
    expect(specs[0]?.after.text).toBe("FindLast()");
  });

  it("claims the implicit-receiver form of FindLast() inside a table trigger body", () => {
    const src = `table 50191 "T4" { fields { field(1; "No."; Code[20]) { } } trigger OnInsert() begin FindLast(); end; }`;
    const specs = specsFor(src);
    expect(specs.map((s) => s.before.text)).toEqual(["FindLast()"]);
    expect(specs[0]?.after.text).toBe("FindFirst()");
  });

  /**
   * Section 2.5 of the R136 trio spec: a shadowing refusal test built over a single-file context
   * passes even if the shadowing guard were deleted, because `claimsRecordMethod`'s project-
   * declared-procedure rule can only fire over a context built across the WHOLE project. Each
   * method name this operator claims (`FindFirst`, `FindLast`) therefore gets its own refusal
   * proven over a `projectContextFor` context, paired with a "still CLAIMS" counterweight so the
   * refusal cannot be satisfied by something unrelated going wrong across the file boundary.
   */
  describe("shadowing refusal across files, per method name", () => {
    function specsForProject(sources: readonly string[]) {
      const roots = sources.map((s) => parseClean(s));
      const ctx: SemanticContext = projectContextFor(roots);
      const calls: ALSyntaxNode[] = roots.flatMap((root) =>
        findAll(root, ALNodeKind.procedure_call),
      );
      return calls
        .filter((n) => swapFindDirection.targets(n, ctx))
        .flatMap((n) => swapFindDirection.generate(n, ctx));
    }

    function caller(method: string, table: string): string {
      return `codeunit 50176 "C" { procedure P() var Other: Record "${table}"; begin Other.${method}(); end; }`;
    }

    it("REFUSES FindFirst() when the project declares its own FindFirst on the table", () => {
      const table = `table 50177 "Other Table F1" { fields { field(1; "No."; Code[20]) { } } procedure FindFirst(): Boolean begin end; }`;
      expect(specsForProject([caller("FindFirst", "Other Table F1"), table])).toEqual([]);
    });

    it("still CLAIMS FindFirst() across files when the table declares no such procedure", () => {
      const table = `table 50178 "Plain Table F1" { fields { field(1; "No."; Code[20]) { } } }`;
      const specs = specsForProject([caller("FindFirst", "Plain Table F1"), table]);
      expect(specs.map((s) => s.before.text)).toEqual(["Other.FindFirst()"]);
    });

    it("REFUSES FindLast() when the project declares its own FindLast on the table", () => {
      const table = `table 50179 "Other Table F2" { fields { field(1; "No."; Code[20]) { } } procedure FindLast(): Boolean begin end; }`;
      expect(specsForProject([caller("FindLast", "Other Table F2"), table])).toEqual([]);
    });

    it("still CLAIMS FindLast() across files when the table declares no such procedure", () => {
      const table = `table 50180 "Plain Table F2" { fields { field(1; "No."; Code[20]) { } } }`;
      const specs = specsForProject([caller("FindLast", "Plain Table F2"), table]);
      expect(specs.map((s) => s.before.text)).toEqual(["Other.FindLast()"]);
    });
  });
});
