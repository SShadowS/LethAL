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

const METHOD_NAME = "TestField";

/**
 * `RemoveTestField` — delete `<rec>.TestField(...)`, both the one-argument
 * (`TestField(Field)`) and two-argument (`TestField(Field, ErrText)`) forms.
 *
 * Spec: docs/superpowers/specs/2026-07-25-tier2-mutation-operators-design.md §4 table.
 *
 * The predicate is intentionally two independent guards, each load-bearing on its own:
 *
 *   1. `isStatementPosition` — deletion requires statement position. Deleting a call that sits
 *      as an `if`'s then-branch would leave `if Cond then ;`, which changes control flow rather
 *      than removing a statement. This is `void-method-call`'s own guard (§4: "The three deletion
 *      operators are statement-position only"); reused via `@lethal/operator-sdk`, not
 *      re-derived.
 *   2. `claimsRecordMethod` — is this actually the AL record method `TestField`, on a record?
 *      Handles the implicit-`Rec` form, case-insensitivity, and every receiver/shadowing refusal
 *      (Task 2, `./receiver.ts`).
 *
 * Argument count is deliberately NOT inspected: `claimsRecordMethod` matches by method name only,
 * so both the one- and two-argument forms are claimed identically — there is no arg-count guard
 * to omit or get wrong. (Contrast `RemoveSetRange`, which must additionally refuse a no-value
 * argument list.)
 *
 * Documented limits:
 *   - (spec §4 table) only observable on a failing path. A `TestField` mutant survives trivially
 *     without an `asserterror` negative test in the target suite — that is the intended signal,
 *     but the fixture must supply one or the baseline teaches nothing.
 *   - No site inside a `tableextension`/`pageextension` is ever claimed; see `OBJECT_KINDS` in
 *     `./receiver.ts` for why, and for the rest of that predicate's documented limits.
 */
export const removeTestField: MutationOperator = {
  name: "lethal.remove-testfield",
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
        operatorName: "lethal.remove-testfield",
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
      name: "deletes a one-argument TestField call",
      sourceAL: `table 50100 "T" { fields { field(1; "No."; Code[20]) { } } trigger OnInsert() begin Rec.TestField("No."); end; }`,
      expectedSpecs: [
        {
          parentContext: "statement-position",
          beforeText: 'Rec.TestField("No.")',
          afterText: "",
        },
      ],
    },
    {
      name: "deletes a two-argument TestField call",
      sourceAL: `table 50101 "T" { fields { field(1; "No."; Code[20]) { } } trigger OnInsert() begin Rec.TestField("No.", 'must have a value'); end; }`,
      expectedSpecs: [
        {
          parentContext: "statement-position",
          beforeText: "Rec.TestField(\"No.\", 'must have a value')",
          afterText: "",
        },
      ],
    },
  ],
};
