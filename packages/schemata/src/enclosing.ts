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
/**
 * True when `before` sits inside executable AL — i.e. `resolveSite` can place it.
 *
 * Exists because not every node an operator can pattern-match is CODE. AL page and report
 * properties are declarative but parse with the same expression shapes as statements: a
 * `SubPageLink` reads `"No." = field("Customer No.")` and a filter reads
 * `"Electronic Document Format" = ''`, both of which tree-sitter yields as comparison
 * expressions. `NegateConditional`/`ConditionalBoundary` therefore claim them, and nothing can
 * wrap them — there is no statement to rewrite.
 *
 * Measured on Continia Document Output the moment R40 admitted pages: 154 such specs across 47
 * files (152 negate-conditional, 2 conditional-boundary), which aborted the whole session at
 * `buildComponents`. Checked once here, at spec generation, rather than in each operator: it is a
 * structural precondition of emitting a mutant at all, and a per-operator fix would have to be
 * repeated for every operator ever added.
 */
export function isMutableSite(before: ALSyntaxNode): boolean {
  return findEnclosingStatement(before) !== null;
}

/**
 * R-307 O5. The statement a spec's `before` node resolves to, checked by span: E1 (no enclosing
 * statement) and E2 (`before` not contained in it), both plain `Error`s, a caller bug. This is what
 * PLAN calls; it builds no text. `resolveSite` adds the mutated text on top for its own callers.
 */
export function resolveStatement(before: ALSyntaxNode): ALSyntaxNode {
  const statement = findEnclosingStatement(before);
  if (statement === null) {
    throw new Error(
      `resolveSite: no enclosing statement for node at ${before.startIndex}..${before.endIndex}`,
    );
  }
  if (statement === before) return statement;
  const relStart = before.startIndex - statement.startIndex;
  const relEnd = before.endIndex - statement.startIndex;
  if (relStart < 0 || relEnd > statement.endIndex - statement.startIndex) {
    throw new Error(
      `resolveSite: before span ${before.startIndex}..${before.endIndex} is not contained in statement ${statement.startIndex}..${statement.endIndex}`,
    );
  }
  return statement;
}

export function resolveSite(before: ALSyntaxNode, afterText: string): ResolvedSite {
  const statement = resolveStatement(before);
  if (statement === before) {
    return { statement, mutatedText: afterText };
  }
  const relStart = before.startIndex - statement.startIndex;
  const stmtText = statement.text;
  const relEnd = before.endIndex - statement.startIndex;
  const mutatedText = stmtText.slice(0, relStart) + afterText + stmtText.slice(relEnd);
  return { statement, mutatedText };
}
