import {
  ALNodeKind,
  type ALSyntaxNode,
  type MutationOperator,
  type MutationSpec,
  type ParentContextHint,
  type SemanticContext,
} from "@lethal/operator-sdk";
import { synthesizeAfter } from "./mutate-helpers";

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
  targetNodeKinds: [
    ALNodeKind.comparison_expression,
    ALNodeKind.logical_expression,
  ],
  producesNodeKinds: [
    ALNodeKind.comparison_expression,
    ALNodeKind.logical_expression,
  ],
  requiresSemantic: [],

  targets(node: ALSyntaxNode, _ctx: SemanticContext): boolean {
    const op = findOperator(node);
    if (op === null) return false;
    if (node.kind === ALNodeKind.comparison_expression) return COMPARISON_FLIP.has(op);
    if (node.kind === ALNodeKind.logical_expression) return LOGICAL_FLIP.has(op);
    return false;
  },

  generate(node: ALSyntaxNode, _ctx: SemanticContext): readonly MutationSpec[] {
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
  const field = node.childForFieldName("operator");
  if (field !== null) return field.text;
  for (const c of node.namedChildren) {
    if (c.kind.endsWith("_operator")) return c.text;
  }
  return null;
}

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
  if (nodeText.slice(opStart, opEnd) !== oldOp) return null;
  return `${nodeText.slice(0, opStart)}${newOp}${nodeText.slice(opEnd)}`;
}
