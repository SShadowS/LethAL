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

const BRANCH_PARENT_KINDS: ReadonlySet<string> = new Set([
  ALNodeKind.procedure,
  ALNodeKind.trigger,
  ALNodeKind.if_statement,
  ALNodeKind.while_statement,
  ALNodeKind.for_statement,
  ALNodeKind.repeat_statement,
  ALNodeKind.case_statement,
]);

/**
 * Is this node a direct member of a block's statement list?
 *
 * Grammar note: v3 wraps a `code_block`'s statements in a `statement_block`
 * container, so a statement's parent is the `statement_block` and its
 * grandparent is the `code_block`. Keying on `code_block` alone — as this
 * codebase did under v2.5.0 — silently matches nothing under v3.
 */
export function isStatementPosition(node: ALSyntaxNode): boolean {
  const parent = node.parent;
  if (parent === null) return false;
  return parent.kind === ALNodeKind.statement_block || parent.kind === ALNodeKind.block;
}

/**
 * The `<parent kind>.<field name>` pairs where the grammar puts a SINGLE statement rather than a
 * statement list: the un-braced body of a branch or a loop.
 *
 * Read off the grammar rather than guessed. A `case_else_branch`'s contents and a `repeat`'s body
 * are NOT here, and deliberately: both wrap their statements in a `statement_block`, so those are
 * already statement position and `isStatementPosition` answers for them.
 */
const SINGLE_STATEMENT_SLOTS: ReadonlySet<string> = new Set([
  `${ALNodeKind.if_statement}.then_branch`,
  `${ALNodeKind.if_statement}.else_branch`,
  "case_branch.body",
  `${ALNodeKind.while_statement}.body`,
  `${ALNodeKind.for_statement}.body`,
  "foreach_statement.body",
]);

/**
 * Does this node occupy a slot where a STATEMENT belongs?
 *
 * `isStatementPosition` answers a narrower question, "is this one of several statements inside a
 * `begin ... end`", and ten operators used it as a proxy for "is this a statement at all". It is
 * not one: `if Cond then Rec.Validate(F, V);` puts the call in the `then_branch` slot, where a
 * statement is exactly what the grammar requires, and every one of those operators refused the site.
 * Measured on `do-rel2/Cloud` (R161): **1,118 call sites**, 723 in a `then_branch`, 253 in a
 * `case_branch` body, 138 in an `else_branch`, 4 in loop bodies.
 *
 * The two predicates are kept SEPARATE rather than one widened, because the schemata compiler reads
 * `isStatementPosition` for the opposite purpose: `wrapIfSingleStatementSlot` braces a dispatch
 * chain precisely when the site is NOT a member of a statement list, and an un-braced branch is the
 * case it braces for. Widening the one predicate would have silently turned that bracing OFF at the
 * 1,118 sites this exists to admit, and an unbraced chain there is an `if` whose `else` binds to the
 * inner `if` — a wrong mutant that compiles and scores, not a compile error.
 */
export function isStatementSlot(node: ALSyntaxNode): boolean {
  if (isStatementPosition(node)) return true;
  const parent = node.parent;
  if (parent === null || node.fieldName === null) return false;
  return SINGLE_STATEMENT_SLOTS.has(`${parent.rawKind}.${node.fieldName}`);
}

/**
 * Narrowest ancestor that the grammar treats as a statement.
 *
 * Includes the statement kinds plus two positional cases:
 *   - a `code_block` whose parent is a procedure, trigger, or branch
 *   - a `call_expression` in statement position (expression-statement quirk;
 *     see `isStatementPosition` for the container-skipping detail)
 *
 * Returns `null` if the node has no statement ancestor (e.g., the root node).
 * The node itself is considered a candidate — calling with an `if_statement`
 * returns that same node.
 */
export function findEnclosingStatement(node: ALSyntaxNode): ALSyntaxNode | null {
  let current: ALSyntaxNode | null = node;
  while (current !== null) {
    if (STATEMENT_KINDS.has(current.kind)) return current;
    if (current.kind === ALNodeKind.procedure_call && isStatementPosition(current)) {
      return current;
    }
    if (
      current.kind === ALNodeKind.block &&
      current.parent !== null &&
      BRANCH_PARENT_KINDS.has(current.parent.kind)
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

/**
 * The statements of a block, skipping v3's `statement_block` container.
 *
 * Returns the block's own named children under a grammar without the
 * container, so callers need no version branching.
 */
export function blockStatements(block: ALSyntaxNode): readonly ALSyntaxNode[] {
  const inner = block.namedChildren.find((c) => c.kind === ALNodeKind.statement_block);
  return inner === undefined ? block.namedChildren : inner.namedChildren;
}

/**
 * The declarations of a `var_section`, skipping v3's `var_body` container.
 */
export function varDeclarations(varSection: ALSyntaxNode): readonly ALSyntaxNode[] {
  const inner = varSection.namedChildren.find((c) => c.kind === ALNodeKind.var_body);
  return inner === undefined ? varSection.namedChildren : inner.namedChildren;
}

/**
 * The members of an object declaration (codeunit/table/page/report),
 * skipping v3's `declaration_body` container.
 *
 * Not named in the Task 4 brief, but required by it: under v3, an object
 * declaration's `var_section` and `procedure` members are not direct
 * `namedChildren` of the object node — they sit one level down inside a
 * `declaration_body`. Without this, `symbol-table.ts` finds neither
 * globals nor procedures for any object.
 */
export function declarationMembers(objectNode: ALSyntaxNode): readonly ALSyntaxNode[] {
  const inner = objectNode.namedChildren.find((c) => c.kind === ALNodeKind.declaration_body);
  return inner === undefined ? objectNode.namedChildren : inner.namedChildren;
}
