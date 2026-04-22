import { ALNodeKind } from "./node-kinds";
import type { ALSyntaxNode } from "./syntax-node";

const STATEMENT_KINDS: ReadonlySet<string> = new Set([
  ALNodeKind.if_statement,
  ALNodeKind.case_statement,
  ALNodeKind.repeat_statement,
  ALNodeKind.while_statement,
  ALNodeKind.for_statement,
  ALNodeKind.exit_statement,
  ALNodeKind.error_statement,
  ALNodeKind.assignment_statement,
]);

/**
 * Narrowest ancestor that the grammar treats as a statement.
 *
 * Includes the statement kinds plus two positional cases:
 *   - a `code_block` whose parent is a procedure, trigger, or branch
 *   - a `call_expression` whose parent is a `code_block` (expression-statement quirk)
 *
 * Returns `null` if the node has no statement ancestor (e.g., the root node).
 * The node itself is considered a candidate — calling with an `if_statement`
 * returns that same node.
 */
export function findEnclosingStatement(node: ALSyntaxNode): ALSyntaxNode | null {
  let current: ALSyntaxNode | null = node;
  while (current !== null) {
    if (STATEMENT_KINDS.has(current.kind)) return current;
    if (
      current.kind === ALNodeKind.procedure_call &&
      current.parent !== null &&
      current.parent.kind === ALNodeKind.block
    ) {
      return current;
    }
    if (
      current.kind === ALNodeKind.block &&
      current.parent !== null &&
      (current.parent.kind === ALNodeKind.procedure ||
        current.parent.kind === ALNodeKind.trigger ||
        current.parent.kind === ALNodeKind.if_statement ||
        current.parent.kind === ALNodeKind.while_statement ||
        current.parent.kind === ALNodeKind.for_statement ||
        current.parent.kind === ALNodeKind.repeat_statement ||
        current.parent.kind === ALNodeKind.case_statement)
    ) {
      return current;
    }
    current = current.parent;
  }
  return null;
}

/** Narrowest `procedure` ancestor, or `null` if the node is outside any procedure. */
export function findEnclosingProcedure(node: ALSyntaxNode): ALSyntaxNode | null {
  let current: ALSyntaxNode | null = node.parent;
  while (current !== null) {
    if (current.kind === ALNodeKind.procedure) return current;
    current = current.parent;
  }
  return null;
}

/** Narrowest `code_block` ancestor (strictly upward — excludes `node` itself). */
export function findEnclosingCodeBlock(node: ALSyntaxNode): ALSyntaxNode | null {
  let current: ALSyntaxNode | null = node.parent;
  while (current !== null) {
    if (current.kind === ALNodeKind.block) return current;
    current = current.parent;
  }
  return null;
}
