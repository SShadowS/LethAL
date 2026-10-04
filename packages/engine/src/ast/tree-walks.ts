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
 *
 * R214: a statement directly inside a statement-level `#if` arm counts too, when that `#if` sits in
 * a statement list: the arm is itself a statement list. A `#if` in a single-statement slot does not
 * count, since only its first statement would fill the slot. This moves three consumers:
 * `wrapIfSingleStatementSlot` (`packages/schemata/src/compile.ts`: no `begin ... end` wrap for an
 * in-arm statement, correct because the arm is a list), `placeReach`'s P2 (statement grain, R342)
 * and `isConsumedCodeunitRun` (a bare in-arm `Codeunit.Run` is bare).
 */
export function isStatementPosition(node: ALSyntaxNode): boolean {
  const parent = node.parent;
  if (parent === null) return false;
  if (parent.kind === ALNodeKind.statement_block || parent.kind === ALNodeKind.block) return true;
  return parent.rawKind === "preproc_conditional_statement" && isStatementPosition(parent);
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
 *   - a `code_block` whose parent is a procedure, trigger, or branch, or a split member's shared
 *     body (R302: the prototype found this one; without it a split body's whole-body mutant was
 *     generated and then dropped as not executable)
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
      (BRANCH_PARENT_KINDS.has(current.parent.kind) || isProcedureLike(current.parent))
    ) {
      return current;
    }
    current = current.parent;
  }
  return null;
}

/**
 * R301, R316: a `procedure`, or one of the two split-header procedure shapes. A
 * `preproc_split_procedure` has one header per `#if` arm, then ONE shared `var` section and body
 * as direct children. A `preproc_split_procedure_preamble` has one header AND one optional `var`
 * section per arm, then one shared body; every arm's header and var section are direct children
 * too. The manifest, latch and line-map walks own both shapes through this, and since R302 so do
 * `findEnclosingProcedure`, the symbol table and the semantic walks. A body walk must not treat the
 * WHOLE split node as a procedure body: an arm's header region can hold an attribute (an
 * `[Obsolete(...)]` inside `#if`), which a plain procedure keeps as a sibling. `inMemberBody`
 * states that once.
 */
export function isProcedureLike(n: ALSyntaxNode): boolean {
  return (
    n.kind === ALNodeKind.procedure ||
    n.rawKind === "preproc_split_procedure" ||
    n.rawKind === "preproc_split_procedure_preamble"
  );
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

/**
 * R318: the names coverage may attribute a RENAMED split member under (one whose `#if` arms give it
 * different names, so `procedureLikeNameNode` is `null`). Each arm's name once, quotes stripped,
 * compared as AL compares names (case-insensitive), first spelling kept, in source order, MINUS any
 * name another declaration of the same object uses: every arm of every other procedure-like
 * (`allProcedureLikes`, so `#if`-wrapped and swallowed ones count) and every trigger.
 *
 * Why that is safe: one arm is compiled per build, so the member carries exactly one of its names,
 * and coverage names the compiled member. A name no other declaration of the object carries, in any
 * arm, can only be this member in any build, so a coverage row under it is this member's row. A
 * shared name (an overload included, since name-keyed coverage cannot split overloads) is dropped.
 * An object that did not parse gets `[]`: a declaration inside an ERROR node could carry the name.
 * `[]` for anything that is not a renamed split member.
 */
export function renamedMemberCoverageNames(member: ALSyntaxNode): string[] {
  if (member.kind === ALNodeKind.procedure || procedureLikeNameNode(member) !== null) return [];
  let object: ALSyntaxNode | null = member;
  while (object !== null && !(object.parent !== null && isObjectContainer(object.parent))) {
    object = object.parent;
  }
  if (object === null || object.hasError) return [];
  const key = (t: string): string => t.toLowerCase();
  const taken = new Set<string>();
  for (const p of allProcedureLikes(object)) {
    if (p.startIndex === member.startIndex && p.endIndex === member.endIndex) continue;
    for (const t of procedureLikeArmNames(p)) taken.add(key(t));
  }
  const walk = (n: ALSyntaxNode): void => {
    for (const c of n.namedChildren) {
      if (c.kind === ALNodeKind.trigger) {
        const name = c.childForFieldName("name");
        if (name !== null) taken.add(key(name.text.replace(/^"|"$/g, "")));
      } else if (!isProcedureLike(c)) {
        walk(c);
      }
    }
  };
  walk(object);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of procedureLikeArmNames(member)) {
    const k = key(t);
    if (k === "" || seen.has(k) || taken.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out;
}

/**
 * R318: every name a procedure-like declares, one per arm for a split member (the `name` field of
 * each arm; a named return value is `return_value`, not a name), quotes stripped, as written. One
 * rule for `renamedMemberCoverageNames` and for the line map's re-key check (`LineMap.renamedMemberAt`),
 * so the two cannot disagree about what a member's own names are.
 */
export function procedureLikeArmNames(member: ALSyntaxNode): string[] {
  return member.children
    .filter((c) => c.fieldName === "name")
    .map((c) => c.text.replace(/^"|"$/g, ""));
}

/** R302: narrowest procedure-like ancestor (`isProcedureLike`), or `null` outside any. */
export function findEnclosingProcedure(node: ALSyntaxNode): ALSyntaxNode | null {
  let current: ALSyntaxNode | null = node.parent;
  while (current !== null) {
    if (isProcedureLike(current)) return current;
    current = current.parent;
  }
  return null;
}

const ARM_MARKERS: ReadonlySet<string> = new Set(["preproc_if", "preproc_elif", "preproc_else"]);

/**
 * R302: a split member's arms, each as the node's children between two `#if`/`#elif`/`#else`
 * markers (the header, and for a preamble its own `var` section). The shared body after `#endif`
 * belongs to no arm. A plain procedure is one arm: its own children.
 */
export function memberArms(n: ALSyntaxNode): ALSyntaxNode[][] {
  if (n.kind === ALNodeKind.procedure) return [[...n.children]];
  const arms: ALSyntaxNode[][] = [];
  let cur: ALSyntaxNode[] | null = null;
  for (const c of n.children) {
    if (ARM_MARKERS.has(c.rawKind)) {
      cur = [];
      arms.push(cur);
    } else if (c.rawKind === "preproc_endif") {
      cur = null;
    } else if (cur !== null) {
      cur.push(c);
    }
  }
  return arms;
}

/**
 * R302: the return type text every arm declares (whitespace-normalised), or `null` when any arm
 * declares none or two arms differ. Which arm compiles depends on symbols the engine never sees, so
 * a type only some builds use is no type (the `exit(0.0)` against `exit(0)` case).
 */
export function procedureLikeReturnType(n: ALSyntaxNode): string | null {
  let agreed: string | null = null;
  for (const arm of memberArms(n)) {
    const rt = arm.find((c) => c.fieldName === "return_type");
    if (rt === undefined) return null;
    const t = rt.text.replace(/\s+/g, " ").trim();
    if (agreed !== null && agreed !== t) return null;
    agreed = t;
  }
  return agreed;
}

/**
 * R302: whether `node` sits in the executable body of its member: anywhere under a `procedure` or
 * a trigger, and under a split member only through its shared `code_block`. The header region of a
 * split member is its arms, and an arm can hold an attribute whose literals are not code.
 */
export function inMemberBody(node: ALSyntaxNode): boolean {
  let child: ALSyntaxNode = node;
  for (let p: ALSyntaxNode | null = node.parent; p !== null; child = p, p = p.parent) {
    if (p.rawKind === "procedure" || p.rawKind === "trigger_declaration") return true;
    if (isProcedureLike(p)) return child.kind === ALNodeKind.block;
  }
  return false;
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

/** R405 (a): where a member sits: a direct member of the object, or inside a member-level `#if`. */
export type MemberPlace = "direct" | "inside-if";

/** R405 (a): one member `liveMembers` yields, with its place. */
export interface PlacedMember {
  readonly node: ALSyntaxNode;
  readonly place: MemberPlace;
}

/**
 * R405 (a): the members of an object the BUILD has, for the readers that index or look up members
 * (the symbol table, `findTableTrigger`, `onInsertTrigger`). Not for "does the object declare this
 * name" questions: those must also count what the grammar put elsewhere (`allProcedureLikes`).
 *
 * - The direct members (`declarationMembers`), each `direct`, minus one the build compiles out.
 * - When `armOf` is given, also the members inside each member-level `#if` (a `preproc_conditional`
 *   in the object body), recursively for a nested one, each `inside-if`, but ONLY when its arm is
 *   `active`. An undecided arm is dropped there: "undecided" is per FILE, so every arm of every
 *   `#if` in the file is undecided, and keeping them would let the first arm in the text win.
 *   An undecided DIRECT member stays, as before.
 * - A member-level `#if` itself is never yielded (no reader selects its kind).
 * - When `armOf` is ABSENT (no arm map), the direct members only, exactly as before. Callers pass
 *   the raw optional `SemanticContext.armOf`, never a closure that answers "active" without a map:
 *   that would yield BOTH arms.
 */
export function liveMembers(
  objectNode: ALSyntaxNode,
  armOf?: (node: ALSyntaxNode) => "active" | "inactive" | "undecided",
): PlacedMember[] {
  const out: PlacedMember[] = [];
  const inside = (cond: ALSyntaxNode): void => {
    if (armOf === undefined) return;
    for (const c of cond.namedChildren) {
      if (c.rawKind === "preproc_conditional") inside(c);
      // The `#if`/`#elif`/`#else`/`#endif` markers; a split member is `preproc_*` but a member.
      else if (c.rawKind.startsWith("preproc_") && !isProcedureLike(c)) continue;
      else if (armOf(c) === "active") out.push({ node: c, place: "inside-if" });
    }
  };
  for (const member of declarationMembers(objectNode)) {
    if (member.rawKind === "preproc_conditional") {
      inside(member);
      continue;
    }
    if (armOf !== undefined && armOf(member) === "inactive") continue;
    out.push({ node: member, place: "direct" });
  }
  return out;
}

/**
 * R327: split members the grammar placed INSIDE an object-level `var` section. A split member that
 * follows the object's global `var` section parses as a child of that section's `var_body`, where
 * a plain procedure in the same place is a member of the object. They are still members of the
 * object, so every "does the object declare this name" question must count them; the symbol table
 * does not index them, so their own names resolve to nothing (see `buildSymbolTable`).
 */
export function swallowedSplitMembers(objectNode: ALSyntaxNode): readonly ALSyntaxNode[] {
  const out: ALSyntaxNode[] = [];
  for (const member of declarationMembers(objectNode)) {
    if (member.kind !== ALNodeKind.var_section) continue;
    for (const c of varDeclarations(member)) if (isProcedureLike(c)) out.push(c);
  }
  return out;
}

/**
 * R330: every procedure-like declaration of an object, wherever the grammar put it: a direct member,
 * one inside a `#if` region (`preproc_conditional`), or one swallowed by the global `var` section
 * (R327). The symbol table indexes only the direct ones; this list is what "does the object declare
 * a procedure of this name" must be answered against, so an unindexed declaration still counts.
 * Walks down to each procedure-like node and not into it.
 */
export function allProcedureLikes(objectNode: ALSyntaxNode): readonly ALSyntaxNode[] {
  const out: ALSyntaxNode[] = [];
  const walk = (n: ALSyntaxNode): void => {
    for (const c of n.namedChildren) {
      if (isProcedureLike(c)) {
        if (c.children.some((x) => x.fieldName === "name")) out.push(c);
      } else {
        walk(c);
      }
    }
  };
  walk(objectNode);
  return out;
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
