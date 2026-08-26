import {
  ALNodeKind,
  type ALSyntaxNode,
  type MutationOperator,
  type MutationSpec,
  type ParentContextHint,
  type SemanticContext,
} from "@lethal/operator-sdk";
import { findOperatorToken, replaceOperatorToken, synthesizeAfter } from "./mutate-helpers";

const COMPARISON_FLIP: ReadonlyMap<string, string> = new Map([
  ["=", "<>"],
  ["<>", "="],
]);

const LOGICAL_FLIP: ReadonlyMap<string, string> = new Map([
  ["and", "or"],
  ["or", "and"],
]);

export const negateConditional: MutationOperator = {
  name: "lethal.negate-conditional",
  version: "1.0.0",
  tier: 1,
  targetNodeKinds: [ALNodeKind.comparison_expression, ALNodeKind.logical_expression],
  producesNodeKinds: [ALNodeKind.comparison_expression, ALNodeKind.logical_expression],
  requiresSemantic: [],

  targets(node: ALSyntaxNode, _ctx: SemanticContext): boolean {
    if (isRepeatExitCondition(node)) return false;
    const op = findOperator(node);
    if (op === null) return false;
    if (node.kind === ALNodeKind.comparison_expression) return COMPARISON_FLIP.has(op);
    if (node.kind === ALNodeKind.logical_expression) return LOGICAL_FLIP.has(op);
    return false;
  },

  generate(node: ALSyntaxNode, _ctx: SemanticContext): readonly MutationSpec[] {
    if (isRepeatExitCondition(node)) return [];
    const op = findOperator(node);
    if (op === null) return [];

    let flipped: string | undefined;
    let parentContext: ParentContextHint;
    if (node.kind === ALNodeKind.comparison_expression) {
      flipped = COMPARISON_FLIP.get(op);
      parentContext = "statement-position";
    } else if (node.kind === ALNodeKind.logical_expression) {
      flipped = LOGICAL_FLIP.get(op);
      parentContext = "short-circuit-operand";
    } else {
      return [];
    }
    if (flipped === undefined) return [];

    const mutatedText = replaceOperatorToken(node, op, flipped);
    if (mutatedText === null) return [];

    return [
      {
        operatorName: "lethal.negate-conditional",
        operatorVersion: "1.0.0",
        astNodeId: `${node.startIndex}-${node.endIndex}`,
        before: node,
        after: synthesizeAfter(node, mutatedText),
        parentContext,
      },
    ];
  },

  conformanceTests: [
    {
      name: "CEDES a repeat loop's exit condition to loop-truncate, which cannot hang there",
      sourceAL: `codeunit 51400 "C" { procedure P() var Cust: Record Customer; begin if Cust.FindSet() then repeat Cust.Mark(true); until Cust.Next() = 0; end; }`,
      expectedSpecs: [],
    },
    {
      name: "still claims a comparison NESTED inside a repeat exit condition, which is a different mutation",
      sourceAL: `codeunit 51401 "C" { procedure P(B: Boolean) var Cust: Record Customer; begin if Cust.FindSet() then repeat Cust.Mark(true); until (Cust.Next() = 0) or B; end; }`,
      expectedSpecs: [
        {
          parentContext: "statement-position",
          beforeText: "Cust.Next() = 0",
          afterText: "Cust.Next() <> 0",
        },
      ],
    },
    {
      name: "flips = to <>",
      sourceAL: `codeunit 51402 "C" { procedure P(A: Integer): Boolean begin exit(A = 0); end; }`,
      expectedSpecs: [
        {
          parentContext: "statement-position",
          beforeText: "A = 0",
          afterText: "A <> 0",
        },
      ],
    },
    {
      name: "flips and to or as short-circuit-operand",
      sourceAL: `codeunit 51403 "C" { procedure P(A: Boolean; B: Boolean) begin if A and B then exit; end; }`,
      expectedSpecs: [
        {
          parentContext: "short-circuit-operand",
          beforeText: "A and B",
          afterText: "A or B",
        },
      ],
    },
  ],
};

function findOperator(node: ALSyntaxNode): string | null {
  return findOperatorToken(node)?.text ?? null;
}

/**
 * R164's cession: is this node EXACTLY a `repeat` loop's exit condition?
 *
 * `lethal.loop-truncate` owns that position, and this operator has to step aside rather than share
 * it, because §3.2 dedup cannot arbitrate between them. `dedupeSpecs` keys on the replacement TEXT
 * as well as the span, so `Rec.Next() <> 0` and `true` at one span are two identities and BOTH would
 * ship, leaving the hanging mutant exactly where it was.
 *
 * Why this operator and not the other three that also claim loop conditions: at the canonical BC
 * shape its mutant is both the hazard and a duplicate. `until Rec.Next() <> 0` exits after one body
 * execution on a set of two or more rows, which is what `until true` does, and never terminates on a
 * set of one row or none, which is the common fixture shape. MEASURED, not argued:
 * `itest:hang`'s `WalkOneRow` arm scored this mutant `timeout-killed` before the cession landed
 * (`docs/superpowers/specs/2026-08-26-r164-loop-truncate-precommitment.md` §2, stage 1).
 * `conditional-boundary` shifts a bound by one, which runs a loop one extra iteration rather than
 * forever, and it is not a duplicate; ceding it would delete a working, terminating, killed mutant.
 *
 * EXACT SPAN only. A comparison NESTED inside a bigger condition (`until (X = 0) or B`) is a
 * different mutation that `loop-truncate` does not express, so it is still claimed. One such site
 * exists on `do-rel2/Cloud` against 326 exact-span ones.
 */
function isRepeatExitCondition(node: ALSyntaxNode): boolean {
  const parent = node.parent;
  if (parent === null || parent.rawKind !== ALNodeKind.repeat_statement) return false;
  const cond = parent.childForFieldName("condition");
  if (cond === null) return false;
  return cond.startIndex === node.startIndex && cond.endIndex === node.endIndex;
}
