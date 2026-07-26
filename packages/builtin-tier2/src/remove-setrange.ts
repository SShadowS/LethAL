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

const METHOD_NAME = "SetRange";
/** `argument_list` isn't in `ALNodeKind`; the field name is grammar-stable regardless. */
const ARGUMENTS_FIELD = "arguments";
/**
 * Below this many arguments, the call is the no-value form (`SetRange(F)`), which *clears* a
 * filter rather than setting one. `SetRange(F, V)` and the three-argument range form
 * `SetRange(F, From, To)` both carry the field plus at least one value.
 */
const MIN_VALUE_ARGUMENTS = 2;

/**
 * `RemoveSetRange` — delete `<rec>.SetRange(F, ...)`.
 *
 * Spec: docs/superpowers/specs/2026-07-25-tier2-mutation-operators-design.md §4 table.
 *
 * Three independent guards, each load-bearing on its own:
 *
 *   1. `isStatementPosition` — deletion requires statement position, same reasoning as
 *      `RemoveTestField` and `void-method-call`.
 *   2. `claimsRecordMethod` — is this actually the AL record method `SetRange`, on a record?
 *      (Task 2, `./receiver.ts`.)
 *   3. `hasValueArguments` — **the rule specific to this operator, and the one whose absence is
 *      dangerous rather than merely incomplete.** `SetRange(F)` with no value *clears* any
 *      existing filter on `F`. Deleting that call therefore *preserves* a filter instead of
 *      removing one — the exact inverse of what every other deletion operator does at its site.
 *      A missing guard here doesn't just miss a mutant; it emits a backwards one that would
 *      quietly corrupt kill/survive results. `SetRange(F, V)` and `SetRange(F, From, To)` both
 *      pass; the bare `SetRange(F)` form does not.
 *
 * Documented limit (spec §4 table): highly data-dependent. With only in-range rows present in
 * the target suite's data, the mutant is equivalent with respect to that data — the fixture must
 * seed out-of-filter decoy rows for a kill to be possible at all.
 */
export const removeSetRange: MutationOperator = {
  name: "lethal.remove-setrange",
  version: "1.0.0",
  tier: 2,
  targetNodeKinds: [ALNodeKind.procedure_call],
  producesNodeKinds: [ALNodeKind.procedure_call],
  requiresSemantic: ["symbol-table"],

  targets(node: ALSyntaxNode, ctx: SemanticContext): boolean {
    if (node.kind !== ALNodeKind.procedure_call) return false;
    if (!isStatementPosition(node)) return false;
    if (!claimsRecordMethod(node, ctx, METHOD_NAME)) return false;
    return hasValueArguments(node);
  },

  generate(node: ALSyntaxNode, _ctx: SemanticContext): readonly MutationSpec[] {
    return [
      {
        operatorName: "lethal.remove-setrange",
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
      name: "deletes a two-argument SetRange call",
      sourceAL: `codeunit 50110 "C" { procedure P() var Cust: Record Customer; begin Cust.SetRange("No.", 'A'); end; }`,
      expectedSpecs: [
        {
          parentContext: "statement-position",
          beforeText: "Cust.SetRange(\"No.\", 'A')",
          afterText: "",
        },
      ],
    },
    {
      name: "deletes a three-argument (range) SetRange call",
      sourceAL: `codeunit 50111 "C" { procedure P() var Cust: Record Customer; begin Cust.SetRange("No.", 'A', 'Z'); end; }`,
      expectedSpecs: [
        {
          parentContext: "statement-position",
          beforeText: "Cust.SetRange(\"No.\", 'A', 'Z')",
          afterText: "",
        },
      ],
    },
  ],
};

/**
 * Does the call carry a value (or a from/to range) beyond the field itself?
 *
 * Grammar shape (measured, not assumed — see `packages/builtin-tier2/src/receiver.ts`'s own
 * grammar notes): a `call_expression`'s `arguments` field is an `argument_list` whose
 * `namedChildren` are exactly the argument expressions, with the surrounding parens and commas
 * as anonymous tokens. `SetRange(F)` yields one named child (the field); `SetRange(F, V)` and
 * `SetRange(F, From, To)` yield two and three.
 *
 * No argument list at all (a shape that shouldn't parse for `SetRange`, but the grammar is not
 * this function's contract to enforce) is treated the same as the no-value form: refuse.
 */
function hasValueArguments(node: ALSyntaxNode): boolean {
  const argumentList = node.childForFieldName(ARGUMENTS_FIELD);
  if (argumentList === null) return false;
  return argumentList.namedChildren.length >= MIN_VALUE_ARGUMENTS;
}
