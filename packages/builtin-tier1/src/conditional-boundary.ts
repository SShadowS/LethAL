import {
  ALNodeKind,
  type ALSyntaxNode,
  type MutationOperator,
  type MutationSpec,
  type SemanticContext,
} from "@lethal/operator-sdk";
import { synthesizeAfter } from "./mutate-helpers";

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
  const field = node.childForFieldName("operator");
  if (field !== null) return field.text;
  for (const c of node.namedChildren) {
    if (c.kind.endsWith("_operator")) return c.text;
  }
  return null;
}

/**
 * Build the mutated comparison text by replacing only the operator token's
 * slice of `node.text`. Avoids re-rendering operands (preserves whitespace,
 * comments within operands, and any other formatting).
 */
function replaceOperatorToken(
  node: ALSyntaxNode,
  oldOp: string,
  newOp: string,
): string | null {
  const opNode =
    node.childForFieldName("operator") ??
    node.namedChildren.find((c) => c.kind.endsWith("_operator")) ??
    null;
  if (opNode === null) return null;
  const opStart = opNode.startIndex - node.startIndex;
  const opEnd = opNode.endIndex - node.startIndex;
  const nodeText = node.text;
  const before = nodeText.slice(0, opStart);
  const after = nodeText.slice(opEnd);
  // Sanity check: the slice we're replacing must match the reported token.
  if (nodeText.slice(opStart, opEnd) !== oldOp) return null;
  return `${before}${newOp}${after}`;
}
