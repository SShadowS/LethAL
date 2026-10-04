import type { SpanEdit } from "./rewrite-plan";
import type { ALSyntaxNode } from "./syntax-node";

/**
 * R-307 O4: the EMIT half of `printWithRewrites`. Joins edits PLAN already sorted and checked
 * (`planEdits`) into the rewritten text. It decides nothing and cannot refuse.
 */
export function joinEdits(source: string, edits: readonly SpanEdit<string>[]): string {
  if (edits.length === 0) return source;
  const parts: string[] = [];
  let cursor = 0;
  for (const edit of edits) {
    parts.push(source.slice(cursor, edit.start));
    parts.push(edit.payload);
    cursor = edit.end;
  }
  parts.push(source.slice(cursor));
  return parts.join("");
}

export function print(source: string, _root: ALSyntaxNode): string {
  // unmodified round-trip is just the original source
  return source;
}
