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

  // R883: `Rec.Validate(xRec."X", V)` is AL0166 ("must be a member"). Revert: drop the
  // `isFieldDesignatingArgument` line in `plan`.
  const onAmount = (specs: ReturnType<typeof specsFor>) =>
    specs.map((s) => s.before.text).filter((t) => t.endsWith(".Amount"));
  const triggerWith = (body: string) =>
    `table 50167 "T" { fields { field(1; Amount; Decimal) { trigger OnValidate() begin ${body} end; } } }`;

  for (const [label, body] of [
    ["Validate", `Rec.Validate(Rec.Amount, 1);`],
    ["TestField", `Rec.TestField(Rec.Amount);`],
    ["SetRange", `Rec.SetRange(Rec.Amount, 1);`],
    ["bare Validate", `Validate(Rec.Amount, 1);`],
    ["CalcFields, every argument", `Rec.CalcFields(Rec.Amount, Rec.Amount);`],
    ["SetCurrentKey, every argument", `Rec.SetCurrentKey(Rec.Amount);`],
  ] as const) {
    it(`refuses the field argument of ${label}`, () => {
      // `Rec.Validate` (the call's own receiver) may still be swapped; only the field is judged.
      expect(onAmount(specsFor(triggerWith(body)))).toEqual([]);
    });
  }

  it("keeps the VALUE argument of Validate and SetRange swappable", () => {
    const specs = specsFor(
      triggerWith(`Rec.Validate(Amount, xRec.Amount); Rec.SetRange(Amount, xRec.Amount);`),
    );
    expect(onAmount(specs)).toEqual(["xRec.Amount", "xRec.Amount"]);
    expect(specs.filter((s) => s.after.text.endsWith(".Amount")).map((s) => s.after.text)).toEqual([
      "Rec.Amount",
      "Rec.Amount",
    ]);
  });
});
