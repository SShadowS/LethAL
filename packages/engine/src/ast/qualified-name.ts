import type { ALSyntaxNode } from "./syntax-node";

/**
 * R502: a namespace-qualified name (`System.Utilities.Integer`) parses as several sibling children
 * sharing one field, one per segment (tree-sitter-al 4.4.1: a data item's `table_name`, a
 * `record_type`'s `reference`), and `childForFieldName` returns the FIRST, `System`. These read
 * every segment, or the last, so no reader takes the first by accident. Turning segments into a
 * project object is `qualifiedObjectName` (semantic), which also checks the namespace.
 */

/** The last named child in `field`, or null: the name's last segment. */
export function lastFieldChild(node: ALSyntaxNode, field: string): ALSyntaxNode | null {
  return node.namedChildren.filter((c) => c.fieldName === field).at(-1) ?? null;
}

/** Every segment of the name in `field`, in order, each unquoted. Empty when there is none. */
export function fieldSegments(node: ALSyntaxNode, field: string): string[] {
  return node.namedChildren.filter((c) => c.fieldName === field).map((c) => unquote(c.text));
}

/**
 * Every segment of a name written as text, in order, each unquoted, case kept. A quoted segment is
 * one segment whatever it holds: `"Sales.Header"` is a name with a dot in it, not two names. The
 * text must be the name alone (`Record "X" temporary` is not: strip the keyword first).
 */
export function nameSegments(text: string): string[] {
  return (text.trim().match(/"[^"]*"|[^.]+/g) ?? []).map((s) => unquote(s.trim()));
}

function unquote(s: string): string {
  return s.length >= 2 && s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1) : s;
}
