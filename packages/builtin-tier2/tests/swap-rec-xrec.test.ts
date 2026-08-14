import { beforeAll, describe, expect, it } from "bun:test";
/**
 * `SwapRecXRec`: rewrite `Rec` <-> `xRec` inside a field `OnValidate` or a table `OnRename`.
 *
 * Spec: docs/superpowers/specs/2026-07-31-r33-tier2-phase2-design.md §1; roadmap R71.
 *
 * This file exists because of R137. The operator shipped with four refusals declared only as
 * conformance cases with an EMPTY `expectedSpecs`, and the harness never checked that a refusal
 * emitted nothing — so every one of them passed on any input at all. With the harness fixed, the
 * assignment-target refusal turned out to have NEVER held: `isAssignmentTarget` compared
 * `namedChildren[0]` to the child it walked up from with `===`, and `namedChildren` hands back a
 * fresh wrapper object on each access, so the comparison was always false.
 */
import {
  ALNodeKind,
  type ALSyntaxNode,
  type SemanticContext,
  findAll,
  initParser,
} from "@lethal/engine";
import { swapRecXRec } from "../src/swap-rec-xrec";
import { contextFor, parseClean } from "./parse-clean";

function specsFor(sourceAL: string) {
  const root = parseClean(sourceAL);
  const ctx: SemanticContext = contextFor(root);
  const accesses: ALSyntaxNode[] = findAll(root, ALNodeKind.field_access);
  return accesses
    .filter((n) => swapRecXRec.targets(n, ctx))
    .flatMap((n) => swapRecXRec.generate(n, ctx));
}

describe("swapRecXRec", () => {
  beforeAll(async () => {
    await initParser();
  });

  it("swaps xRec for Rec in a field OnValidate", () => {
    const specs = specsFor(
      `table 50160 "T" { fields { field(1; Amount; Decimal) { trigger OnValidate() begin if Amount <> xRec.Amount then Error('changed'); end; } } }`,
    );
    expect(specs.map((s) => s.before.text)).toEqual(["xRec.Amount"]);
    expect(specs.map((s) => s.after.text)).toEqual(["Rec.Amount"]);
  });

  it("swaps Rec for xRec in an OnRename, keeping the member's own quoting", () => {
    const specs = specsFor(
      `table 50161 "T" { fields { field(1; "No."; Code[20]) { } } trigger OnRename() begin if Rec."No." = '' then Error('empty'); end; }`,
    );
    expect(specs.map((s) => s.before.text)).toEqual([`Rec."No."`]);
    expect(specs.map((s) => s.after.text)).toEqual([`xRec."No."`]);
  });

  it("refuses an assignment target, whose mutant may not compile", () => {
    const specs = specsFor(
      `table 50162 "T" { fields { field(1; Amount; Decimal) { trigger OnValidate() begin xRec.Amount := 5; end; } } }`,
    );
    expect(specs.map((s) => s.before.text)).toEqual([]);
  });

  it("refuses an assignment target nested under an indexer", () => {
    const specs = specsFor(
      `table 50163 "T" { fields { field(1; Name; Text[50]) { trigger OnValidate() begin xRec.Name[1] := 'A'; end; } } }`,
    );
    expect(specs.map((s) => s.before.text)).toEqual([]);
  });

  it("claims a Rec read on the RIGHT of an assignment, which is not a target", () => {
    const specs = specsFor(
      `table 50164 "T" { fields { field(1; Amount; Decimal) { trigger OnValidate() var D: Decimal; begin D := xRec.Amount; end; } } }`,
    );
    expect(specs.map((s) => s.before.text)).toEqual(["xRec.Amount"]);
  });

  it("refuses an OnModify site, measured equivalent", () => {
    const specs = specsFor(
      `table 50165 "T" { fields { field(1; Amount; Decimal) { } } trigger OnModify() begin if Amount <> xRec.Amount then Error('changed'); end; }`,
    );
    expect(specs.map((s) => s.before.text)).toEqual([]);
  });

  it("refuses a member access outside any trigger", () => {
    const specs = specsFor(
      `codeunit 50166 "C" { procedure P() var Rec: Record Customer; begin if Rec.Name = '' then Error('x'); end; }`,
    );
    expect(specs.map((s) => s.before.text)).toEqual([]);
  });
});
