import {
  ALNodeKind,
  type ALSyntaxNode,
  type MutationOperator,
  type MutationSpec,
  type SemanticContext,
} from "@lethal/operator-sdk";
import { findOperatorToken, replaceOperatorToken, synthesizeAfter } from "./mutate-helpers";

const BOUNDARY_FLIP: ReadonlyMap<string, string> = new Map([
  [">", ">="],
  [">=", ">"],
  ["<", "<="],
  ["<=", "<"],
]);

export const conditionalBoundary: MutationOperator = {
  name: "lethal.conditional-boundary",
  version: "1.0.0",
  tier: 1,
  targetNodeKinds: [ALNodeKind.comparison_expression],
  producesNodeKinds: [ALNodeKind.comparison_expression],
  requiresSemantic: [],

  targets(node: ALSyntaxNode, _ctx: SemanticContext): boolean {
    if (node.kind !== ALNodeKind.comparison_expression) return false;
    const op = findOperator(node);
    return op !== null && BOUNDARY_FLIP.has(op);
  },

  generate(node: ALSyntaxNode, _ctx: SemanticContext): readonly MutationSpec[] {
    const op = findOperator(node);
    if (op === null) return [];
    const flipped = BOUNDARY_FLIP.get(op);
    if (flipped === undefined) return [];
    const mutatedText = replaceOperatorToken(node, op, flipped);
    if (mutatedText === null) return [];
    return [
      {
        operatorName: "lethal.conditional-boundary",
        operatorVersion: "1.0.0",
        astNodeId: `${node.startIndex}-${node.endIndex}`,
        before: node,
        after: synthesizeAfter(node, mutatedText),
        parentContext: "statement-position",
      },
    ];
  },

  conformanceTests: [
    {
      name: "flips > to >=",
      sourceAL: `codeunit 51302 "C" { procedure P(A: Integer) begin if A > 0 then exit(1); end; }`,
      expectedSpecs: [
        {
          parentContext: "statement-position",
          beforeText: "A > 0",
          afterText: "A >= 0",
        },
      ],
    },
    {
      name: "flips <= to <",
      sourceAL: `codeunit 51303 "C" { procedure P(A: Integer) begin if A <= 5 then exit(1); end; }`,
      expectedSpecs: [
        {
          parentContext: "statement-position",
          beforeText: "A <= 5",
          afterText: "A < 5",
        },
      ],
    },
  ],
};

function findOperator(node: ALSyntaxNode): string | null {
  return findOperatorToken(node)?.text ?? null;
}
