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
  // R287 (C6): `#if` around an `if` header, the then- and else-branches shared after `#endif`.
  "preproc_split_if_statement.then_branch",
  "preproc_split_if_statement.else_branch",
  // R287 (C5): each arm's then-branch, and the else-branch shared after `#endif`.
  "preproc_split_if_else_statement.then_branch",
  "preproc_split_if_else_statement.else_branch",
  // R285: `#if` around a case label, the arm's body shared after `#endif`.
  "preproc_split_case_extended.body",
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

/** C02-09: bodies that are not SINGLE_STATEMENT_SLOTS because they wrap a statement_block. The
 *  pairs are read off the parser (a `repeat`'s and a `case ... else`'s `statement_block`, both in
 *  their parent's `body` field), not guessed; tree-walks.test.ts pins both. */
const WRAPPED_BRANCH_BODIES: ReadonlySet<string> = new Set([
  `${ALNodeKind.repeat_statement}.body`,
  "case_else_branch.body",
]);

/**
 * C02-09: the innermost branch body holding `node` (itself included): a branch or loop slot, a
 * wrapped repeat/case-else body, or a procedure's or trigger's body block. The file root when none
 * does. A gap groups the survivors of one such block. Never null.
 */
export function gapBlockOf(node: ALSyntaxNode): ALSyntaxNode {
  let n: ALSyntaxNode = node;
  for (;;) {
    const parent = n.parent;
    if (parent === null) return n;
    const slot = n.fieldName === null ? null : `${parent.rawKind}.${n.fieldName}`;
    if (slot !== null && (SINGLE_STATEMENT_SLOTS.has(slot) || WRAPPED_BRANCH_BODIES.has(slot)))
      return n;
    // R301: a split-header procedure's shared body is a direct child too.
    if (
      n.kind === ALNodeKind.block &&
      (isProcedureLike(parent) || parent.kind === ALNodeKind.trigger)
    )
      return n;
    n = parent;
  }
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

/**
 * R301: a `procedure`, or a split-header procedure (`preproc_split_procedure`: one header per `#if`
 * arm, then ONE shared `var` section and body as direct children). The manifest, latch and
 * line-map walks own a split procedure through this. `findEnclosingProcedure` and the semantic
 * walks deliberately do NOT use it yet (R302). A `preproc_split_procedure_preamble` is not
 * procedure-like: each arm has its own `var` section, so one latch cannot serve every arm; the
 * writer refuses it by name (R309), and its missing name and span are R316.
 */
export function isProcedureLike(n: ALSyntaxNode): boolean {
  return n.kind === ALNodeKind.procedure || n.rawKind === "preproc_split_procedure";
}

/**
 * R301: the `name` node of a procedure-like node. A plain procedure: its one name. A split-header
 * procedure has one name per arm; they are returned only when every arm agrees (compared as AL
 * compares names: case-insensitive, quotes ignored). An arm that RENAMES the procedure gives
 * `null`, because which arm is compiled depends on preprocessor symbols the writer never sees, and
 * the first arm's name may be the inactive one: no name is honest, a guessed one attributes
 * coverage to the wrong member.
 */
export function procedureLikeNameNode(n: ALSyntaxNode): ALSyntaxNode | null {
  if (n.kind === ALNodeKind.procedure) return n.childForFieldName("name");
  const names = n.children.filter((c) => c.fieldName === "name");
  const [first] = names;
  if (first === undefined) return null;
  const key = (x: ALSyntaxNode): string => x.text.replace(/^"|"$/g, "").toLowerCase();
  return names.every((x) => key(x) === key(first)) ? first : null;
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

/**
 * R298: the nodes whose children are AL object declarations. A `#if`-wrapped object sits under a
 * `preproc_conditional_object` (one declaration per arm), never directly under `source_file`, so
 * a walk that stops at `source_file`'s children misses it or names the wrapper as the object.
 */
export function isObjectContainer(n: ALSyntaxNode): boolean {
  return n.kind === ALNodeKind.source_file || n.rawKind === "preproc_conditional_object";
}

/**
 * R298: the named children of `root` with every `preproc_conditional_object` flattened
 * recursively and the `preproc_*` markers (`#if`, `#else`, `#endif`, ...) dropped, in source order.
 * Anything else a container holds (a `namespace_declaration`, a `using`, a comment) is returned as
 * is; callers pick the object kinds they care about. A two-arm wrapper yields BOTH arms'
 * declarations, which may be the SAME object id: a caller that counts objects must say so itself.
 */
export function objectDeclarationsOf(root: ALSyntaxNode): ALSyntaxNode[] {
  const out: ALSyntaxNode[] = [];
  for (const c of root.namedChildren) {
    if (c.rawKind === "preproc_conditional_object") out.push(...objectDeclarationsOf(c));
    else if (!c.rawKind.startsWith("preproc_")) out.push(c);
  }
  return out;
}
