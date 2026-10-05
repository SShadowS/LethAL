import {
  ALNodeKind,
  type ALSyntaxNode,
  type HangCapableReason,
  type SemanticContext,
  armOfNode,
  isProcedureLike,
  normalizeAlName,
  resolveVarRef,
} from "@lethal/engine";

/**
 * WHY THIS EXISTS (R196). Four operators can turn a terminating loop into a non-terminating one by
 * mutating a variable the loop's condition reads. Measured on the Document Output Templates slice:
 * eight of 741 mutants never terminate, costing about 40 of the run's 148 minutes in strands,
 * quarantines and resumes. Those four operators now REFUSE every site this names (owner ruling
 * 2026-10-05) rather than tagging it; the `hangCapable` channel stays for plug-in operators.
 *
 * WHAT A CLAIM MEANS, EXACTLY. That the assignment's target is a CONDITION-RELEVANT VARIABLE of an
 * enclosing loop. It does NOT establish that the mutation prevents progress, that the assignment
 * runs on the path that timed out, that nothing else advances the condition, or that an `exit`, an
 * error or an overflow cannot end the loop anyway. R179's `DrainQueue` is this repository's
 * counterexample: its frozen loop terminated by Int32 overflow in ~4.4 s rather than hanging.
 *
 * WHAT IT DELIBERATELY DOES NOT SEE, all UNCLASSIFIED rather than proven safe (spec 3.2): a target
 * read in the loop BODY rather than its condition; preheader assignments; progress that happens
 * through a CALL (which is both hangs in `fixtures/sandbox-hang`); a field target whose receiver
 * does not resolve (implicit `Rec`, `with`; a resolved `R.Field` IS seen since R454); and
 * condition-side mutations, which are not assignments at all.
 *
 * POSITIONAL AND IDENTITY-BASED, never value-based. `empty-block.ts` records the principle this
 * follows: reading the tree is checkable, guessing what a loop does is not. Asking which
 * declaration a name refers to is identity, not value.
 *
 * The type itself now lives on `@lethal/engine` (`MutationSpec.hangCapable`), because the engine
 * cannot depend on this package. Re-exported here so existing importers of this file keep working.
 */
export type { HangCapableReason };

const LOOP_KINDS: ReadonlySet<string> = new Set([
  ALNodeKind.while_statement,
  ALNodeKind.repeat_statement,
]);

/**
 * `for_statement` is absent on purpose. Whether an AL `for` can be made non-terminating by mutating
 * its control variable depends on whether the platform re-evaluates the bound and re-reads the
 * variable each iteration, and this repository has NOT measured that. Unmeasured, so unclassified.
 */
const SCOPE_KINDS: ReadonlySet<string> = new Set([ALNodeKind.procedure, ALNodeKind.trigger]);
/** R302: a walk stops at a `SCOPE_KINDS` node or a split-header member (`isProcedureLike`). Nothing
 *  encloses a member, so no test can tell the split-member stop from its absence (red-checked:
 *  the hang tag inside a split member rests on `resolveVarRef`, i.e. `findEnclosingProcedure`). */
function isScope(n: ALSyntaxNode): boolean {
  return SCOPE_KINDS.has(n.kind) || isProcedureLike(n);
}

/**
 * Does `node` sit inside any enclosing `while`/`repeat`, stopping at the enclosing procedure or
 * trigger boundary. Same walk `classifyHangCapable` runs, minus the per-loop condition check.
 * Exported so a census script's denominator ("is this assignment even a loop-condition-target
 * CANDIDATE") is computed by calling this rather than by copying the walk a second time: two
 * copies of one walk is R80's shape, and this walk is a published rate's denominator.
 */
export function hasEnclosingLoop(node: ALSyntaxNode): boolean {
  let cur: ALSyntaxNode | null = node.parent;
  while (cur !== null && !isScope(cur)) {
    if (LOOP_KINDS.has(cur.kind)) return true;
    cur = cur.parent;
  }
  return false;
}

/**
 * The grammar's quoted-identifier kind, not in `ALNodeKind` (which enumerates only the kinds the
 * mutation pipeline targets, per `node-kinds.ts`'s own header). Same local-constant shape
 * `receiver.ts`'s private `isIdentifierLike` uses, not exported cross-package: this is a static
 * grammar fact, not a rule that could drift the way two hazard predicates could (R80's concern),
 * so a second one-line copy carries none of that risk.
 */
const QUOTED_IDENTIFIER = "quoted_identifier";

/**
 * Is `node` an identifier read, bare or quoted? AL parses `"Line Done"` as `quoted_identifier`, a
 * distinct grammar kind from `identifier`. A bare `.kind === ALNodeKind.identifier` check missed
 * every quoted target and every quoted condition read, which is invisible rather than declined:
 * such a site never even reaches `resolveVarRef`, let alone its DECLINE-on-unresolved rule.
 *
 * Exported so a census script's own "is this really a bare identifier target" invariant check can
 * call this rather than restating the same two-kind test a third time (`receiver.ts` already has an
 * unexported copy of the same shape, for the same static grammar fact).
 */
export function isIdentifierLike(node: ALSyntaxNode): boolean {
  return node.kind === ALNodeKind.identifier || node.rawKind === QUOTED_IDENTIFIER;
}

/** The target identifier of the assignment at, or enclosing, `node`. Bare or quoted (see
 *  `isIdentifierLike`). */
export function assignmentTargetOf(node: ALSyntaxNode): ALSyntaxNode | null {
  let cur: ALSyntaxNode | null = node;
  while (cur !== null && !isScope(cur)) {
    if (cur.kind === ALNodeKind.assignment_statement) {
      const target = cur.childForFieldName("left") ?? cur.namedChildren[0] ?? null;
      if (target === null) return null;
      return isIdentifierLike(target) ? target : null;
    }
    cur = cur.parent;
  }
  return null;
}

/** The condition expression of a `while`/`repeat`, or null when the grammar did not name one.
 *  Measured against the vendored grammar: both `while_statement` and `repeat_statement` (the
 *  `until` expression) expose a `condition` field. */
function conditionOf(loop: ALSyntaxNode): ALSyntaxNode | null {
  return loop.childForFieldName("condition") ?? null;
}

/** A directive marker: `#if`/`#elif`/`#else`/`#endif` and the symbol condition it carries. */
const DIRECTIVE_MARKERS: ReadonlySet<string> = new Set([
  "preproc_if",
  "preproc_elif",
  "preproc_else",
  "preproc_endif",
]);

/**
 * Every identifier the loop's condition reads in THIS build, bare or quoted (`isIdentifierLike`),
 * member names excluded by `resolveVarRef`.
 *
 * R402: the grammar puts a directive tail of the condition (`while (A < 10)` `#if X and (B < 5)`
 * `#endif` `do`) BESIDE the `condition` field, as a `preproc_conditional_expression_tail`, so those
 * are read too. Tails and list elements nested inside the condition are reached by the same walk.
 * A node in an arm the build compiles out is skipped; an UNDECIDED one is read, because for a hang
 * tag the unsafe direction is an untagged hang-capable mutant. Directive markers are never read:
 * their condition is a preprocessor symbol, not a variable.
 */
function conditionIdentifiers(loop: ALSyntaxNode, ctx: SemanticContext): ALSyntaxNode[] {
  const out: ALSyntaxNode[] = [];
  const walk = (n: ALSyntaxNode): void => {
    if (DIRECTIVE_MARKERS.has(n.rawKind)) return;
    if (armOfNode(ctx, n) === "inactive") return;
    if (isIdentifierLike(n)) out.push(n);
    for (const c of n.namedChildren) walk(c);
  };
  for (const part of loopConditionParts(loop)) walk(part);
  return out;
}

/**
 * A loop's exit test: its `condition` field plus the `#if` tails the grammar puts BESIDE it (R402).
 * Exported so `shift-integer`'s loop-condition refusal reads the same parts (R454 shape 1).
 */
export function loopConditionParts(loop: ALSyntaxNode): ALSyntaxNode[] {
  const cond = conditionOf(loop);
  return [
    ...(cond !== null ? [cond] : []),
    ...loop.namedChildren.filter((c) => c.rawKind === "preproc_conditional_expression_tail"),
  ];
}

/**
 * R454 shape 3: a `Rec.Field` read or write, kept as TWO parts, the receiver's resolved declaration
 * and the normalised member name. Never joined into one string: `"A.B".C` and `A."B.C"` can share a
 * declaration list and would join to the same text. An unresolved receiver (`with`, implicit `Rec`)
 * gives null, so the site stays declined (spec 3.1).
 */
interface MemberRef {
  readonly receiver: NonNullable<ReturnType<typeof resolveVarRef>>;
  readonly member: string;
}

function memberRefOf(n: ALSyntaxNode, ctx: SemanticContext): MemberRef | null {
  if (n.kind !== ALNodeKind.field_access) return null;
  const obj = n.childForFieldName("object");
  const mem = n.childForFieldName("member");
  if (obj === null || mem === null || !isIdentifierLike(obj)) return null;
  const receiver = resolveVarRef(obj, ctx);
  return receiver === null ? null : { receiver, member: normalizeAlName(mem.text) };
}

/** Does the loop's condition read `target`? Same arm and marker rules as `conditionIdentifiers`. */
function conditionReadsMember(
  loop: ALSyntaxNode,
  target: MemberRef,
  ctx: SemanticContext,
): boolean {
  const walk = (n: ALSyntaxNode): boolean => {
    if (DIRECTIVE_MARKERS.has(n.rawKind)) return false;
    if (armOfNode(ctx, n) === "inactive") return false;
    const ref = memberRefOf(n, ctx);
    if (
      ref !== null &&
      ref.member === target.member &&
      sameDeclaration(ref.receiver, target.receiver)
    ) {
      return true;
    }
    return n.namedChildren.some(walk);
  };
  return loopConditionParts(loop).some(walk);
}

/** The member target of the assignment at, or enclosing, `node`, as its receiver and member
 *  IDENTIFIERS read from the tree before any resolution (R-364: an unresolved receiver must still
 *  reach the name fallback), or null. `assignmentTargetOf` stays identifier-only, which the census
 *  scripts assert. */
function memberTargetOf(node: ALSyntaxNode): {
  readonly field: ALSyntaxNode;
  readonly receiver: ALSyntaxNode;
  readonly member: ALSyntaxNode;
} | null {
  for (let cur: ALSyntaxNode | null = node; cur !== null && !isScope(cur); cur = cur.parent) {
    if (cur.kind === ALNodeKind.assignment_statement) {
      const left = cur.childForFieldName("left") ?? cur.namedChildren[0] ?? null;
      if (left === null || left.kind !== ALNodeKind.field_access) return null;
      const receiver = left.childForFieldName("object");
      const member = left.childForFieldName("member");
      if (receiver === null || member === null || !isIdentifierLike(receiver)) return null;
      return { field: left, receiver, member };
    }
  }
  return null;
}

/**
 * R-364: a loop-condition target by NAME, for where no declaration can be resolved. Names are
 * compared as AL compares them (any case, quotes stripped); the matcher normalises them itself.
 * `receiver: null` is a plain variable; otherwise the target is `<receiver>.<member>`.
 * `implicitReceiver` (R-458): a plain target also matches `<implicitReceiver>.<member>`, and a
 * target on that receiver also matches a plain `<member>`.
 */
export type NameTarget = {
  readonly receiver: string | null;
  readonly member: string;
  readonly implicitReceiver?: string;
};

/**
 * R-364: does any enclosing loop's condition (to the procedure or trigger boundary) read `target`
 * by NAME? A plain target matches a plain identifier read, including a member read's receiver
 * (R294's `Txt.Contains`), never the member half of `R.Amount`. A member target matches the
 * (receiver, member) PAIR structurally, never joined text (`"A.B".C` is not `A."B.C"`). Same arm
 * and directive-marker rules as `conditionIdentifiers` and `conditionReadsMember`.
 *
 * A name match is a guess (spec 3.1), so this is no classifier by itself: a caller gates it.
 * R-364's gate is `classifyHangCapable` (unresolved target inside an unindexed object); R-458
 * reuses this matcher under its own gate.
 */
export function loopConditionReadsByName(
  assignment: ALSyntaxNode,
  target: NameTarget,
  ctx: SemanticContext,
): boolean {
  const receiver = target.receiver === null ? null : normalizeAlName(target.receiver);
  const member = normalizeAlName(target.member);
  const implicit =
    target.implicitReceiver === undefined ? null : normalizeAlName(target.implicitReceiver);
  const plainMatches = receiver === null || (implicit !== null && receiver === implicit);
  const wanted = receiver ?? implicit;
  const walk = (n: ALSyntaxNode): boolean => {
    if (DIRECTIVE_MARKERS.has(n.rawKind)) return false;
    if (armOfNode(ctx, n) === "inactive") return false;
    if (n.kind === ALNodeKind.field_access) {
      const obj = n.childForFieldName("object");
      const mem = n.childForFieldName("member");
      if (obj !== null && mem !== null && isIdentifierLike(obj) && wanted !== null) {
        if (normalizeAlName(obj.text) === wanted && normalizeAlName(mem.text) === member) {
          return true;
        }
      }
      // The member half is never a plain read; everything else (the receiver, arguments) is.
      return n.namedChildren.filter((c) => c.fieldName !== "member").some(walk);
    }
    if (plainMatches && isIdentifierLike(n) && normalizeAlName(n.text) === member) return true;
    return n.namedChildren.some(walk);
  };
  for (let cur = assignment.parent; cur !== null && !isScope(cur); cur = cur.parent) {
    if (LOOP_KINDS.has(cur.kind) && loopConditionParts(cur).some(walk)) return true;
  }
  return false;
}

/**
 * R-364's gate: is `node` inside an object the symbol table does not index (`unindexedObjects`,
 * R343), where no declaration outside a trigger's own `var` section can resolve? Its OWN enclosing
 * object, matched by file and span, never by wrapper identity or by offset alone (offsets repeat
 * across files). Objects in `unparsedObjects`, failed headers and other unindexed members are out
 * of scope and keep the declaration-only rule.
 */
function inUnindexedObject(node: ALSyntaxNode, ctx: SemanticContext): boolean {
  const unindexed = ctx.symbols.unindexedObjects;
  if (unindexed.length === 0) return false;
  const root = rootOf(node);
  return unindexed.some(
    (o) =>
      o.startIndex <= node.startIndex && node.endIndex <= o.endIndex && sameFile(rootOf(o), root),
  );
}

function rootOf(node: ALSyntaxNode): ALSyntaxNode {
  let cur = node;
  while (cur.parent !== null) cur = cur.parent;
  return cur;
}

/** Two file roots hold the same source. Identical sources give identical answers here, so this is
 *  exact for the question asked. */
function sameFile(a: ALSyntaxNode, b: ALSyntaxNode): boolean {
  return a.endIndex === b.endIndex && a.text === b.text;
}

/**
 * Do two resolved variable references name the SAME declaration?
 *
 * NOT `===`. Measured (probe against this package's own fixtures, 2026-09-06): `resolveVarRef`
 * resolves a TRIGGER-local through `receiver.ts`'s `triggerScopeVar`, which calls
 * `collectVarDeclarations` fresh on every call rather than reading a cached table. Deliberately so,
 * per that file's own comment, because trigger names repeat per-object and are not indexed in the
 * symbol table's maps. Two resolutions of the very same trigger-local `var N: Integer` therefore
 * come back as two DIFFERENT `VarSymbol` objects (verified: same name and type, `=== false`).
 * `globalsOf`/`localsOf`/`resolveProcedure` (the procedure-local and global paths) DO return a
 * cached object and `===` holds there, but a classifier that special-cased "except inside a
 * trigger" would be carrying a landmine for the next scope `lookupVar` grows.
 *
 * `startIndex` of the declaration node is used instead: two distinct declarations can never start
 * at the same byte offset in one file, so this is exactly as precise as reference identity where
 * reference identity happens to hold, and correct where it does not. This is position, not a name
 * match: two same-named locals in DIFFERENT procedures have different declaration offsets, so this
 * still tells them apart on the path where it matters, except that path never opens in the first
 * place. `classifyHangCapable`'s ancestor walk climbs `.parent` pointers only, and a parent-pointer
 * walk starting inside procedure A can reach shared ancestors (the object, the file) but can never
 * DESCEND into a sibling procedure B's subtree: there is no pointer from A's ancestors back down
 * into B. So a sibling procedure's same-named local is structurally unreachable from this walk
 * regardless of where SCOPE_KINDS stops it; the procedure/trigger boundary check never even gets a
 * chance to matter for that case, because the walk was never going to arrive there anyway.
 *
 * PRECONDITION, load-bearing: `startIndex` is a byte offset WITHIN ITS OWN FILE, so two
 * declarations in DIFFERENT files can share one. This comparison is sound here ONLY because both
 * `a` and `b` are always resolved from identifiers inside one procedure of one object, the
 * assignment's target and an enclosing loop's condition, so every symbol either side can resolve
 * to is necessarily declared in the SAME file `classifyHangCapable` was called with. If this
 * function, or its calling pattern, is ever reused to compare symbols that could come from
 * different files, this comparison is wrong and needs a file component added to the key. See
 * ROADMAP R209 for the underlying `resolveVarRef` identity gap this works around, and for why
 * fixing it at the source (caching `triggerScopeVar`'s result) is not a small change.
 *
 * AND THE NAME (R295): every name of `A, B: Integer` is its own symbol, but all of them share the
 * one declaration node. Position alone would make A and B one variable and tag
 * `while A < 10 do B := B + 1` as a hang. Compared as AL compares names: unquoted, any case.
 */
function sameDeclaration(
  a: NonNullable<ReturnType<typeof resolveVarRef>>,
  b: NonNullable<ReturnType<typeof resolveVarRef>>,
): boolean {
  return (
    a.node.startIndex === b.node.startIndex && normalizeAlName(a.name) === normalizeAlName(b.name)
  );
}

/**
 * Does any enclosing loop's condition read this assignment's target?
 *
 * Resolution is by DECLARATION first. In an indexed object an unresolvable target returns `null`:
 * a claim here can force LethAL to end a BC session on the user's own server, and a name match is
 * a guess (spec 3.1). R-364: inside an object the symbol table does not index (`unindexedObjects`,
 * R343) nothing outside a trigger's own `var` section can resolve, so there an unresolved target
 * is matched by NAME (`loopConditionReadsByName`). That is the safe direction: an extra refusal
 * costs a site, a missed one can hang a session.
 */
export function classifyHangCapable(
  node: ALSyntaxNode,
  ctx: SemanticContext,
): HangCapableReason | null {
  const target = assignmentTargetOf(node);
  if (target === null) {
    // R454 shape 3: a member target, matched by receiver declaration and member name separately.
    const parts = memberTargetOf(node);
    if (parts === null) return null;
    const ref = memberRefOf(parts.field, ctx);
    if (ref === null) {
      const byName = { receiver: parts.receiver.text, member: parts.member.text };
      return inUnindexedObject(node, ctx) && loopConditionReadsByName(node, byName, ctx)
        ? "loop-condition-target"
        : null;
    }
    for (let cur = node.parent; cur !== null && !isScope(cur); cur = cur.parent) {
      if (LOOP_KINDS.has(cur.kind) && conditionReadsMember(cur, ref, ctx)) {
        return "loop-condition-target";
      }
    }
    return null;
  }
  const targetSym = resolveVarRef(target, ctx);
  if (targetSym === null) {
    return inUnindexedObject(node, ctx) &&
      loopConditionReadsByName(node, { receiver: null, member: target.text }, ctx)
      ? "loop-condition-target"
      : null;
  }

  let cur: ALSyntaxNode | null = node.parent;
  while (cur !== null && !isScope(cur)) {
    if (LOOP_KINDS.has(cur.kind)) {
      for (const ident of conditionIdentifiers(cur, ctx)) {
        const identSym = resolveVarRef(ident, ctx);
        if (identSym !== null && sameDeclaration(identSym, targetSym)) {
          return "loop-condition-target";
        }
      }
    }
    cur = cur.parent;
  }
  return null;
}

/**
 * The hang-capable reason for the site an OPERATOR is mutating, or null.
 *
 * `classifyHangCapable` answers about an assignment statement. Only one of the four operators that
 * need an answer mutates one: `shift-integer`, `swap-additive` and `flip-boolean-literal` all
 * mutate a node inside an assignment's right-hand side. This walks out to the enclosing assignment
 * and asks about that, because the value written is what an enclosing loop's condition reads.
 *
 * One refusal here is deliberate and load-bearing: a node inside the assignment's `left` field is
 * part of the target expression rather than a value written to the target, so an operator mutating
 * the target itself gets no tag from this (test: "DECLINES the target identifier on the
 * assignment's left"). The `SCOPE_KINDS` check inside the walk below is NOT that kind of guard:
 * see the comment on it.
 *
 * Containment is tested by POSITION rather than by node identity, for the reason recorded in
 * [[R209]]: `resolveVarRef` returns freshly built `VarSymbol` objects for trigger-local variables,
 * and the AST wrapper nodes are reconstructed on access, so reference equality is not reliable
 * here. Positions are unique within a file, and this walk never leaves one.
 */
export function hangCapableForMutatedNode(
  node: ALSyntaxNode,
  ctx: SemanticContext,
): HangCapableReason | null {
  if (node.kind === ALNodeKind.assignment_statement) return classifyHangCapable(node, ctx);

  let cur: ALSyntaxNode | null = node.parent;
  while (cur !== null) {
    if (cur.kind === ALNodeKind.assignment_statement) {
      const right = cur.childForFieldName("right");
      if (right === null) return null;
      // A `#if` tail of the value (`Done := Go` `#if X and true #endif` `;`) sits BESIDE `right`,
      // the shape `conditionIdentifiers` reads for a loop condition, so it is value side too.
      const valueParts = [
        right,
        ...cur.namedChildren.filter((c) => c.rawKind === "preproc_conditional_expression_tail"),
      ];
      const insideValueSide = valueParts.some(
        (v) => node.startIndex >= v.startIndex && node.endIndex <= v.endIndex,
      );
      return insideValueSide ? classifyHangCapable(cur, ctx) : null;
    }
    // Early exit, not a guard that changes any answer: this walk climbs `.parent` pointers only,
    // so it can never descend into a sibling procedure's subtree to begin with, the same reason
    // `sameDeclaration`'s docstring gives (above) for `classifyHangCapable`'s identically shaped
    // walk. Without this line the loop would keep climbing to the file root and return the same
    // null, just after more hops. No test in this file can tell its presence from its absence.
    if (isScope(cur)) return null;
    cur = cur.parent;
  }
  return null;
}
