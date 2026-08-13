import { beforeAll, describe, expect, it } from "bun:test";
/**
 * `FlipFilterLiteral`: mutate inside the filter-expression string literal of `<rec>.SetFilter(F, '...')`.
 *
 * Spec: docs/superpowers/specs/2026-08-12-r134-filter-literal-design.md §2.1-2.7.
 * The mini-parser and its four-rule ladder (`mutateFilterContent` and friends) are exhaustively
 * tested in `filter-expression.test.ts`; this file exercises the operator's own guards (the
 * shadowing surface `claimsRecordMethod` newly carries for `SetFilter`, the argument-count and
 * text-literal-kind guards, the splice, and the honestly-computed `parentContext`).
 */
import {
  ALNodeKind,
  type ALSyntaxNode,
  type SemanticContext,
  findAll,
  initParser,
} from "@lethal/engine";
import { flipFilterLiteral } from "../src/flip-filter-literal";
import { contextFor, parseClean, projectContextFor } from "./parse-clean";

function specsFor(sourceAL: string) {
  const root = parseClean(sourceAL);
  const ctx: SemanticContext = contextFor(root);
  const calls: ALSyntaxNode[] = findAll(root, ALNodeKind.procedure_call);
  return calls
    .filter((n) => flipFilterLiteral.targets(n, ctx))
    .flatMap((n) => flipFilterLiteral.generate(n, ctx));
}

describe("flipFilterLiteral", () => {
  beforeAll(async () => {
    await initParser();
  });

  it("flips the negation inside the literal and leaves everything else verbatim", () => {
    const src = `codeunit 50100 "T" {
      procedure P(No: Code[20])
      var Rec: Record Customer;
      begin
        Rec.SetFilter("No.", '<>%1', No);
      end;
    }`;
    const specs = specsFor(src);
    expect(specs).toHaveLength(1);
    expect(specs[0]?.before.text).toBe(`Rec.SetFilter("No.", '<>%1', No)`);
    expect(specs[0]?.after.text).toBe(`Rec.SetFilter("No.", '=%1', No)`);
  });

  it("refuses a variable filter string, a wildcard literal, and a closed-range literal", () => {
    const src = `codeunit 50101 "T" {
      procedure P(F: Text)
      var Rec: Record Customer;
      begin
        Rec.SetFilter("No.", F);
        Rec.SetFilter("No.", 'FIL*');
        Rec.SetFilter("No.", '%1..%2', 'A', 'B');
      end;
    }`;
    expect(specsFor(src)).toEqual([]);
  });

  /**
   * The brief's Step 1 sketch expected `'<>O''Brien'` to mutate to `'=O''Brien'`. The RATIFIED spec
   * contradicts that: §2.2 step 2's `'` bullet refuses the WHOLE SITE on any embedded quote, stated
   * explicitly and unconditionally ("no content this parser ever admits past this step contains a
   * `'`"), with the `<>''` "not blank" idiom given as the worked example of exactly this refusal.
   * `unquoteALString` happily decodes `'<>O''Brien'` to the content `<>O'Brien`, but that content
   * contains a literal `'`, so `mutateFilterContent` refuses it via `REFUSED_CHARACTERS` before any
   * rule runs. This is a brief/spec conflict, resolved in the spec's favor per task instructions;
   * flagged in the task report.
   */
  it("REFUSES an embedded quote rather than re-escaping it when splicing back (spec §2.2 step 2)", () => {
    const src = `codeunit 50102 "T" {
      procedure P()
      var Rec: Record Customer;
      begin
        Rec.SetFilter(Name, '<>O''Brien');
      end;
    }`;
    expect(specsFor(src)).toEqual([]);
  });

  it("emits exactly one mutant per site even when several rules could apply", () => {
    const src = `codeunit 50103 "T" {
      procedure P(No: Code[20])
      var Rec: Record Customer;
      begin
        Rec.SetFilter("No.", '<>%1|FIXED', No);
      end;
    }`;
    expect(specsFor(src)).toHaveLength(1);
  });

  it("computes parentContext honestly: statement position vs. an un-braced then-branch", () => {
    const src = `codeunit 50104 "T" {
      procedure P(No: Code[20])
      var Rec: Record Customer;
      begin
        Rec.SetFilter("No.", '<>%1', No);
        if No <> '' then Rec.SetFilter("No.", '<%1', No);
      end;
    }`;
    const specs = specsFor(src);
    expect(specs.map((s) => s.parentContext)).toEqual([
      "statement-position",
      "expression-position",
    ]);
  });

  it("matches case-insensitively", () => {
    const src = `codeunit 50105 "T" {
      procedure P(No: Code[20])
      var Rec: Record Customer;
      begin
        Rec.SETFILTER("No.", '<>%1', No);
      end;
    }`;
    const specs = specsFor(src);
    expect(specs).toHaveLength(1);
    expect(specs[0]?.after.text).toBe(`Rec.SETFILTER("No.", '=%1', No)`);
  });

  it("refuses a call with fewer than two arguments", () => {
    const src = `codeunit 50106 "T" {
      procedure P()
      var Rec: Record Customer;
      begin
        Rec.SetFilter("No.");
      end;
    }`;
    expect(specsFor(src)).toEqual([]);
  });

  it("refuses the pre-existing bare-placeholder shape (ladder exhaustion, not parser refusal)", () => {
    const src = `codeunit 50107 "T" {
      procedure P(MainNo: Code[20])
      var Rec: Record Customer;
      begin
        Rec.SetFilter("Main No.", '%1', MainNo);
      end;
    }`;
    expect(specsFor(src)).toEqual([]);
  });

  it("claims the implicit-receiver form inside a table's own code", () => {
    const src = `table 50108 "T5" { fields { field(1; "No."; Code[20]) { } } trigger OnInsert() begin SetFilter("No.", '<>%1', "No."); end; }`;
    const specs = specsFor(src);
    expect(specs.map((s) => s.before.text)).toEqual([`SetFilter("No.", '<>%1', "No.")`]);
    expect(specs[0]?.after.text).toBe(`SetFilter("No.", '=%1', "No.")`);
  });

  /**
   * This operator is the first to put `SetFilter` on `claimsRecordMethod`'s shadowing-guard
   * surface (spec §0, verified: no existing operator claims that name). Per the trio spec's own
   * rule, a newly-claimed method name needs its own project-wide shadowing refusal test — a
   * single-file context cannot exercise the project-declared-procedure rule at all, since that
   * rule reads the semantic context for the receiver's table, which is normally declared in a
   * different file.
   */
  describe("shadowing refusal across files (SetFilter newly claimable)", () => {
    function specsForProject(sources: readonly string[]) {
      const roots = sources.map((s) => parseClean(s));
      const ctx: SemanticContext = projectContextFor(roots);
      const calls: ALSyntaxNode[] = roots.flatMap((root) =>
        findAll(root, ALNodeKind.procedure_call),
      );
      return calls
        .filter((n) => flipFilterLiteral.targets(n, ctx))
        .flatMap((n) => flipFilterLiteral.generate(n, ctx));
    }

    it("REFUSES SetFilter(...) when the project declares its own SetFilter on the table", () => {
      const caller = `codeunit 50109 "C" { procedure P(No: Code[20]) var Other: Record "Other Table SF1"; begin Other.SetFilter("No.", '<>%1', No); end; }`;
      const table = `table 50110 "Other Table SF1" { fields { field(1; "No."; Code[20]) { } } procedure SetFilter() begin end; }`;
      expect(specsForProject([caller, table])).toEqual([]);
    });

    it("still CLAIMS SetFilter(...) across files when the table declares no such procedure", () => {
      const caller = `codeunit 50111 "C" { procedure P(No: Code[20]) var Other: Record "Plain Table SF1"; begin Other.SetFilter("No.", '<>%1', No); end; }`;
      const table = `table 50112 "Plain Table SF1" { fields { field(1; "No."; Code[20]) { } } }`;
      const specs = specsForProject([caller, table]);
      expect(specs.map((s) => s.before.text)).toEqual([`Other.SetFilter("No.", '<>%1', No)`]);
    });
  });
});
