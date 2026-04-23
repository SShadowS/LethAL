import type { ALSyntaxNode } from "@lethal/engine";
import { findEnclosingStatement } from "@lethal/engine";

export interface ResolvedSite {
  /** The statement we emit the wrap/duplicate form against. */
  readonly statement: ALSyntaxNode;
  /** `statement.text` with `before`'s span replaced by `afterText`. */
  readonly mutatedText: string;
}

/**
 * Resolve the "site statement" for a spec's `before` node and compute the
 * mutated text of that statement.
 *
 * - If `before` is itself a statement, the site IS the before node and
 *   `mutatedText === afterText`.
 * - Otherwise walk up to the narrowest enclosing statement and splice
 *   `afterText` into `statement.text` at `before`'s byte range.
 *
 * Throws if `before` has no enclosing statement (malformed input — no
 * legitimate operator should ever emit a spec for a node outside a procedure).
 */
export function resolveSite(
  before: ALSyntaxNode,
  afterText: string,
): ResolvedSite {
  const statement = findEnclosingStatement(before);
  if (statement === null) {
    throw new Error(
      `resolveSite: no enclosing statement for node at ${before.startIndex}..${before.endIndex}`,
    );
  }
  if (statement === before) {
    return { statement, mutatedText: afterText };
  }
  const relStart = before.startIndex - statement.startIndex;
  const relEnd = before.endIndex - statement.startIndex;
  const stmtText = statement.text;
  if (relStart < 0 || relEnd > stmtText.length) {
    throw new Error(
      `resolveSite: before span ${before.startIndex}..${before.endIndex} is not contained in statement ${statement.startIndex}..${statement.endIndex}`,
    );
  }
  const mutatedText =
    stmtText.slice(0, relStart) + afterText + stmtText.slice(relEnd);
  return { statement, mutatedText };
}
