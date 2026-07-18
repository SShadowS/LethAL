import type { ALSyntaxNode } from "@lethal/operator-sdk";

/**
 * Produce a synthetic "after" node that reuses every structural field of
 * `before` but swaps `text`. The schemata compiler only reads `.text` from
 * `after`, so the rest of the shape exists to keep TypeScript + downstream
 * consumers from choking on a partial object.
 *
 * Intentionally a thin adapter — operators that need richer synthesis should
 * go through `build.*` in the SDK and wrap the result here.
 */
/** A binary expression's own operator token, in node-relative offsets. */
export interface OperatorToken {
  readonly text: string;
  /** Offset into `node.text`, not into the source file. */
  readonly start: number;
  readonly end: number;
}

/**
 * Locate a binary expression's OWN operator token.
 *
 * Deliberately does not use `childForFieldName("operator")`: tree-sitter-al
 * surfaces that field from a DESCENDANT when the operands are parenthesized.
 * For `(V < 0) or (V > 100)` it returns the nested `<` rather than the
 * top-level `or`, so operators reading the field silently produced no mutant
 * for such conditions (the sandbox fixture generated 15 sites instead of 16).
 *
 * Scanning `namedChildren` for a `*_operator` kind doesn't cover it either,
 * because the two node kinds disagree on what is "named":
 *
 *   comparison_expression `A = 0`  -> named [identifier, comparison_operator, integer]
 *   logical_expression    `A and B` -> named [identifier, identifier]
 *                                     (`and` is an ANONYMOUS token)
 *
 * `children` includes anonymous tokens, so both shapes are uniformly
 * `[left, operator, right]` there — and a direct child can never be a
 * descendant's operator. Anything else (unary, chained, or an unexpected
 * shape) yields null, so callers degrade to producing no mutation.
 */
export function findOperatorToken(node: ALSyntaxNode): OperatorToken | null {
  const kids = node.children;
  if (kids.length !== 3) return null;
  const op = kids[1];
  if (op === undefined) return null;

  return {
    text: op.text,
    start: op.startIndex - node.startIndex,
    end: op.endIndex - node.startIndex,
  };
}

/**
 * Rewrite a binary expression's operator, returning the node's full text with
 * only that token replaced. Null when the operator can't be located or doesn't
 * match `expected` (the caller's view of what it is replacing).
 */
export function replaceOperatorToken(
  node: ALSyntaxNode,
  expected: string,
  replacement: string,
): string | null {
  const op = findOperatorToken(node);
  if (op === null || op.text !== expected) return null;
  const text = node.text;
  return `${text.slice(0, op.start)}${replacement}${text.slice(op.end)}`;
}

export function synthesizeAfter(
  before: ALSyntaxNode,
  text: string,
): ALSyntaxNode {
  return {
    kind: before.kind,
    rawKind: before.rawKind,
    text,
    startIndex: before.startIndex,
    endIndex: before.endIndex,
    startPosition: before.startPosition,
    endPosition: before.endPosition,
    parent: before.parent,
    children: before.children,
    namedChildren: before.namedChildren,
    fieldName: before.fieldName,
    childForFieldName: before.childForFieldName.bind(before),
  };
}
