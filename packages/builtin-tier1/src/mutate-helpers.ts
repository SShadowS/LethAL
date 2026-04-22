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
