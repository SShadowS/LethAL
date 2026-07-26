import type { ALSyntaxNode } from "@lethal/operator-sdk";

/**
 * Produce a synthetic "after" node that reuses every structural field of
 * `before` but swaps `text`. The schemata compiler only reads `.text` from
 * `after`, so the rest of the shape exists only to satisfy the `ALSyntaxNode`
 * contract for TypeScript and any downstream consumer that inspects it.
 *
 * Mirrors `packages/builtin-tier1/src/mutate-helpers.ts`'s helper of the same
 * name and shape. Duplicated rather than imported: each tier package owns its
 * own synthesis helper instead of Tier 2 taking a dependency on Tier 1's
 * internals for what is a five-line structural adapter.
 */
export function synthesizeAfter(before: ALSyntaxNode, text: string): ALSyntaxNode {
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
