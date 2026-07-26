import {
  ALNodeKind,
  type ALSyntaxNode,
  type MutationOperator,
  type MutationSpec,
  type SemanticContext,
  isStatementPosition,
} from "@lethal/operator-sdk";
import { synthesizeAfter } from "./mutate-helpers";
import { claimsRecordMethod } from "./receiver";

const METHOD_NAME = "CalcFields";

/**
 * `RemoveCalcFields` — delete `<rec>.CalcFields(...)` where the Boolean return is unused.
 *
 * Spec: docs/superpowers/specs/2026-07-25-tier2-mutation-operators-design.md §4 table.
 *
 * Same two-guard shape as `RemoveTestField`/`RemoveSetRange`:
 *
 *   1. `isStatementPosition` — deletion requires statement position, same reasoning as the other
 *      two deletion operators and `void-method-call`'s own guard.
 *   2. `claimsRecordMethod` — is this actually the AL record method `CalcFields`, on a record?
 *      (Task 2, `./receiver.ts`.)
 *
 * `CalcFields` differs from `TestField`/`SetRange` in one respect the brief calls out explicitly:
 * it has a Boolean return (whether every FlowField was successfully calculated) that CAN be
 * consumed — `if Rec.CalcFields(X) then ...`, `Success := Rec.CalcFields(X);`. Deleting a call
 * whose return is consumed would change control flow or leave a dangling assignment RHS — exactly
 * the hazard `isStatementPosition` already exists to prevent.
 *
 * No second guard is needed for this, because "return value unused" and "statement position" are
 * the same fact about this call, seen from two angles: whenever the return value IS consumed, the
 * call is necessarily not a direct member of a `statement_block`/`block` — it sits inside the
 * `if_statement`'s condition field, or inside the assignment's RHS expression — so
 * `isStatementPosition` already returns `false` there. The guard does double duty rather than
 * needing a re-derivation specific to this operator.
 *
 * Argument count is deliberately NOT inspected, mirroring `RemoveTestField`: `CalcFields(X)` and
 * the multi-field form `CalcFields(X, Y)` are both claimed identically — there is no arg-count
 * guard to omit or get wrong.
 *
 * Documented limit (spec §4 table): no signal when the FlowField is never read afterwards, when
 * `SetAutoCalcFields` or a second `CalcFields` makes it redundant, or when the call retrieves a
 * BLOB (where "FlowField stays 0" is the wrong model).
 */
export const removeCalcFields: MutationOperator = {
  name: "lethal.remove-calcfields",
  version: "1.0.0",
  tier: 2,
  targetNodeKinds: [ALNodeKind.procedure_call],
  producesNodeKinds: [ALNodeKind.procedure_call],
  requiresSemantic: ["symbol-table"],

  targets(node: ALSyntaxNode, ctx: SemanticContext): boolean {
    if (node.kind !== ALNodeKind.procedure_call) return false;
    if (!isStatementPosition(node)) return false;
    return claimsRecordMethod(node, ctx, METHOD_NAME);
  },

  generate(node: ALSyntaxNode, _ctx: SemanticContext): readonly MutationSpec[] {
    return [
      {
        operatorName: "lethal.remove-calcfields",
        operatorVersion: "1.0.0",
        astNodeId: `${node.startIndex}-${node.endIndex}`,
        before: node,
        after: synthesizeAfter(node, ""),
        parentContext: "statement-position",
      },
    ];
  },

  conformanceTests: [
    {
      name: "deletes a one-field CalcFields call whose return is unused",
      sourceAL: `table 50130 "T" { fields { field(1; "No."; Code[20]) { } } trigger OnAfterGetRecord() begin Rec.CalcFields("No."); end; }`,
      expectedSpecs: [
        {
          parentContext: "statement-position",
          beforeText: 'Rec.CalcFields("No.")',
          afterText: "",
        },
      ],
    },
    {
      name: "deletes a multi-field CalcFields call",
      sourceAL: `table 50131 "T" { fields { field(1; "No."; Code[20]) { } field(2; "Name"; Text[50]) { } } trigger OnAfterGetRecord() begin Rec.CalcFields("No.", "Name"); end; }`,
      expectedSpecs: [
        {
          parentContext: "statement-position",
          beforeText: 'Rec.CalcFields("No.", "Name")',
          afterText: "",
        },
      ],
    },
  ],
};
