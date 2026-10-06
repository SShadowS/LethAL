import {
  ALNodeKind,
  type ALSyntaxNode,
  type HangCapableReason,
  type SemanticContext,
  armOfNode,
  declarationMembers,
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
 * R446 and R480: the guards of a `while`/`repeat` loop's body exits (`exit`, `Error`,
 * `CurrReport.Quit`/`Break`, a `break` of that loop) count as its condition (`loopExitParts`), so a
 * write ANY such guard reads is refused. R446 did this for a condition that reads no name and calls
 * nothing (`while true`, `until false`); R480 extends it to every other condition that does not
 * name a cursor method (`namesCursorMethod`). For a name- and call-free condition only, a write that
 * FEEDS a guard's name is refused too, by name and to a fixpoint (`indirectFeeds`: `I += 1; Done :=
 * I >= 3; if Done then exit`). And a write to an enclosing `for`'s control variable is refused
 * (R480 shape 4n, in `classifyHangCapable`); a `for` gets no body guards. A scoped heuristic, not a
 * proof. Not extended; each a known exclusion, pinned as not refused in `loop-exit-refusal.test.ts`,
 * none shown safe: a condition naming a cursor method (`Next`, `Read`, `EOS`, `MoveNext`), which by
 * name also covers a user procedure or field named `Next` and a mixed condition (`(C.Next() <> 0)
 * or KeepGoing`); a write to a `for` loop's end bound; a `foreach` (its list); `asserterror` as the
 * only exit; `CurrReport.Skip`.
 *
 * WHAT IT DELIBERATELY DOES NOT SEE, all UNCLASSIFIED rather than proven safe (spec 3.2): a target
 * read in the loop BODY rather than its condition (beyond R446's body-exit guards); preheader
 * assignments; progress that happens through a CALL (which is both hangs in `fixtures/sandbox-hang`); a field target outside any `with`
 * or implicit record (a resolved `R.Field` IS seen since R454; one written through an implicit
 * record or a `with` subject IS refused by name since R-458, see `byNameRefusal`); and
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
 * variable each iteration, and this repository has NOT measured that. R480 refuses a write to the
 * control variable on relevance (Microsoft: the behaviour "isn't predictable") through a SEPARATE
 * check in `classifyHangCapable`, so `hasEnclosingLoop` and `loopConditionParts`, which other
 * operators' literal refusals read, do not change.
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
  for (const part of loopExitParts(loop, ctx)) walk(part);
  return out;
}

/**
 * R446/R480: the parts that decide whether `loop` ends. Its own condition parts, plus the guard of
 * every exit in its body (`bodyExitGuards`) UNLESS the condition names a cursor method
 * (`namesCursorMethod`). When the condition reads no name and calls nothing in this build
 * (`while true`, `until false`), also every value that feeds those parts (`indirectFeeds`). A scoped
 * heuristic, not a proof that no mutant hangs: see the known exclusions in the header.
 */
function loopExitParts(loop: ALSyntaxNode, ctx: SemanticContext): ALSyntaxNode[] {
  const own = loopConditionParts(loop);
  if (conditionIsNameAndCallFree(own, ctx)) {
    const parts = [...own, ...bodyExitGuards(loop)];
    return [...parts, ...indirectFeeds(loop, parts, ctx)];
  }
  return namesCursorMethod(own, ctx) ? own : [...own, ...bodyExitGuards(loop)];
}

/** R480: a method whose name says it steps a cursor or a stream. By NAME, any receiver. */
const CURSOR_METHODS: ReadonlySet<string> = new Set(["next", "read", "eos", "movenext"]);

/**
 * R480: does the condition (active arms, tails included; undecided read) name a cursor method? A
 * `call_expression` whose callee is a bare name or a member, or a bare `member_expression` (`X.Next`
 * with no parentheses), whose name is in `CURSOR_METHODS`. A heuristic, NOT a proof that the loop
 * advances: a user procedure or field named `Next` matches, and so does a mixed condition
 * (`(C.Next() <> 0) or KeepGoing`). Both are known exclusions.
 */
function namesCursorMethod(parts: ALSyntaxNode[], ctx: SemanticContext): boolean {
  const named = (n: ALSyntaxNode | null): boolean =>
    n !== null && CURSOR_METHODS.has(normalizeAlName(n.text));
  const walk = (n: ALSyntaxNode): boolean => {
    if (DIRECTIVE_MARKERS.has(n.rawKind)) return false;
    if (armOfNode(ctx, n) === "inactive") return false;
    if (n.rawKind === "call_expression") {
      const f = n.childForFieldName("function");
      if (f !== null && isIdentifierLike(f) && named(f)) return true;
    }
    if (n.rawKind === "member_expression" && named(n.childForFieldName("member"))) return true;
    return n.namedChildren.some(walk);
  };
  return parts.some(walk);
}

/**
 * R480 shape 2: the right-hand side (and its `#if` tails) of every body assignment, nested bodies
 * included, whose target is a name `parts` read, to a fixpoint (`I += 1; Done := I >= 3; if Done
 * then exit` makes `I >= 3` a part, then `1`). By NAME, the safe direction for a refusal: every
 * identifier counts, member halves included, and a bare target `X` or a member target `R.X` matches
 * a read of `X`. An assignment in an inactive arm adds nothing, because no name or reader reads an
 * inactive node; an undecided one is followed.
 */
function indirectFeeds(
  loop: ALSyntaxNode,
  parts: ALSyntaxNode[],
  ctx: SemanticContext,
): ALSyntaxNode[] {
  const body = loop.childForFieldName("body");
  if (body === null) return [];
  const names = new Set<string>();
  const collect = (n: ALSyntaxNode): void => {
    if (DIRECTIVE_MARKERS.has(n.rawKind) || armOfNode(ctx, n) === "inactive") return;
    if (isIdentifierLike(n)) names.add(normalizeAlName(n.text));
    for (const c of n.namedChildren) collect(c);
  };
  for (const p of parts) collect(p);
  const assignments: ALSyntaxNode[] = [];
  const find = (n: ALSyntaxNode): void => {
    if (n.kind === ALNodeKind.assignment_statement) assignments.push(n);
    for (const c of n.namedChildren) find(c);
  };
  find(body);
  const out: ALSyntaxNode[] = [];
  const used = new Set<ALSyntaxNode>();
  for (let changed = true; changed; ) {
    changed = false;
    for (const a of assignments) {
      if (used.has(a)) continue;
      const left = a.childForFieldName("left");
      const right = a.childForFieldName("right");
      if (left === null || right === null) continue;
      const name = left.kind === ALNodeKind.field_access ? left.childForFieldName("member") : left;
      if (name === null || !isIdentifierLike(name) || !names.has(normalizeAlName(name.text))) {
        continue;
      }
      used.add(a);
      const fed = [
        right,
        ...a.namedChildren.filter((c) => c.rawKind === "preproc_conditional_expression_tail"),
      ];
      for (const f of fed) {
        out.push(f);
        collect(f);
      }
      changed = true;
    }
  }
  return out;
}

const BREAK_SCOPES: ReadonlySet<string> = new Set([
  "while_statement",
  "repeat_statement",
  "for_statement",
  "foreach_statement",
]);

const samePos = (a: ALSyntaxNode, b: ALSyntaxNode): boolean =>
  a.startIndex === b.startIndex && a.endIndex === b.endIndex;

/** Does the condition (active arms, tails included) read no name and call nothing? True for
 *  `while false` too, which does not loop at all: then the extra guards cost nothing. */
function conditionIsNameAndCallFree(parts: ALSyntaxNode[], ctx: SemanticContext): boolean {
  const walk = (n: ALSyntaxNode): boolean => {
    if (DIRECTIVE_MARKERS.has(n.rawKind)) return true;
    if (armOfNode(ctx, n) === "inactive") return true;
    if (n.rawKind === "call_expression" || isIdentifierLike(n)) return false;
    return n.namedChildren.every(walk);
  };
  return parts.length > 0 && parts.every(walk);
}

/** `CurrReport.Quit`/`Break` and their XMLport twins end the trigger, so the loop (R446). With or
 *  without `()`: both forms hold this `member_expression`. `Skip` is NOT here: its docs do not say
 *  it interrupts an AL loop. */
const REPORT_EXITS: ReadonlySet<string> = new Set(["quit", "break"]);
const REPORT_INSTANCES: ReadonlySet<string> = new Set(["currreport", "currxmlport"]);

/** Does `n` end `loop`: `exit`, `Error(...)` outside `asserterror`, `CurrReport.Quit`/`Break`, or a
 *  `break` whose nearest loop is `loop`. */
function exitsLoop(n: ALSyntaxNode, loop: ALSyntaxNode): boolean {
  if (n.rawKind === "exit_statement") return true;
  if (n.rawKind === "member_expression") {
    const obj = n.childForFieldName("object");
    const mem = n.childForFieldName("member");
    return (
      obj !== null &&
      mem !== null &&
      REPORT_INSTANCES.has(normalizeAlName(obj.text)) &&
      REPORT_EXITS.has(normalizeAlName(mem.text))
    );
  }
  if (n.rawKind === "call_expression") {
    const f = n.childForFieldName("function");
    if (f === null || !isIdentifierLike(f) || normalizeAlName(f.text) !== "error") return false;
    // An error `asserterror` catches does not end the loop.
    for (let a = n.parent; a !== null && !samePos(a, loop); a = a.parent) {
      if (a.rawKind === "asserterror_statement") return false;
    }
    return true;
  }
  if (n.rawKind !== "break_statement") return false;
  for (let a = n.parent; a !== null; a = a.parent) {
    if (BREAK_SCOPES.has(a.rawKind)) return samePos(a, loop);
  }
  return false;
}

/** Every condition between a body exit and `loop`: `if` conditions, `case` selectors and patterns,
 *  inner loop conditions and `for` bounds, with their `#if` tails. */
function bodyExitGuards(loop: ALSyntaxNode): ALSyntaxNode[] {
  const body = loop.childForFieldName("body");
  if (body === null) return [];
  const out = new Map<number, ALSyntaxNode>();
  const add = (n: ALSyntaxNode | null): void => {
    if (n !== null) out.set(n.startIndex, n);
  };
  const visitN = (n: ALSyntaxNode): void => {
    if (exitsLoop(n, loop)) {
      for (let a = n.parent; a !== null && !samePos(a, loop); a = a.parent) {
        switch (a.rawKind) {
          case "if_statement":
          case "while_statement":
          case "repeat_statement":
            add(a.childForFieldName("condition"));
            break;
          case "case_statement":
            add(a.childForFieldName("expression"));
            break;
          case "case_branch":
            add(a.childForFieldName("pattern"));
            break;
          case "for_statement":
            add(a.childForFieldName("start"));
            add(a.childForFieldName("end"));
            break;
          case "foreach_statement":
            add(a.childForFieldName("iterable"));
            break;
        }
        for (const t of a.namedChildren) {
          if (t.rawKind === "preproc_conditional_expression_tail") add(t);
        }
      }
    }
    for (const c of n.namedChildren) visitN(c);
  };
  visitN(body);
  return [...out.values()];
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
  return loopExitParts(loop, ctx).some(walk);
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
    if (LOOP_KINDS.has(cur.kind) && loopExitParts(cur, ctx).some(walk)) return true;
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
 * costs a site, a missed one can hang a session. R-458: when the declaration path says no, the
 * target is also matched by name through every `with` subject and implicit record its name can bind
 * to (`byNameRefusal`).
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
    const byName = { receiver: parts.receiver.text, member: parts.member.text };
    if (ref === null) {
      return inUnindexedObject(node, ctx) && loopConditionReadsByName(node, byName, ctx)
        ? "loop-condition-target"
        : byNameRefusal(node, byName, ctx, "none");
    }
    for (let cur = node.parent; cur !== null && !isScope(cur); cur = cur.parent) {
      if (LOOP_KINDS.has(cur.kind) && conditionReadsMember(cur, ref, ctx)) {
        return "loop-condition-target";
      }
    }
    return byNameRefusal(node, byName, ctx, "local");
  }
  const byName = { receiver: null, member: target.text };
  const targetSym = resolveVarRef(target, ctx);
  if (targetSym === null) {
    return inUnindexedObject(node, ctx) && loopConditionReadsByName(node, byName, ctx)
      ? "loop-condition-target"
      : byNameRefusal(node, byName, ctx, "none");
  }

  let cur: ALSyntaxNode | null = node.parent;
  while (cur !== null && !isScope(cur)) {
    // R480 shape 4n: a write to an enclosing `for`'s control variable, by declaration. A separate
    // check: `for` is not in `LOOP_KINDS`, which the literal refusals of other operators read.
    if (cur.rawKind === "for_statement") {
      const variable = cur.childForFieldName("variable");
      const varSym = variable === null ? null : resolveVarRef(variable, ctx);
      if (varSym !== null && sameDeclaration(varSym, targetSym)) return "loop-condition-target";
    }
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
  return byNameRefusal(node, byName, ctx, bindingOf(targetSym.node));
}

/**
 * R-458: what a resolved or unresolved target's name is bound to, as far as an implicit record can
 * take it over. "none": no declaration (a field of an implicit record or `with` subject, or a name
 * nothing declares). "global": an object-level variable, which an implicit record's field shadows
 * in some scopes (R294). "local": a local, a parameter, or a resolved member receiver, which only a
 * `with` subject's field shadows.
 */
type Binding = "none" | "global" | "local";

function bindingOf(declaration: ALSyntaxNode): Binding {
  for (let p = declaration.parent; p !== null; p = p.parent) if (isScope(p)) return "local";
  return "global";
}

/**
 * R-458: refuse when a loop condition reads the target by NAME through any record the target's
 * name can bind to here: every enclosing `with` subject, then (unless the target is a local) the
 * implicit records. Each candidate goes to R-364's matcher as `implicitReceiver`, so a plain
 * target also matches `<candidate>.<name>` and a target on the candidate matches a plain read.
 * A conservative list: a candidate without such a field costs an over-refusal, never a hang.
 */
function byNameRefusal(
  node: ALSyntaxNode,
  target: NameTarget,
  ctx: SemanticContext,
  binding: Binding,
): HangCapableReason | null {
  const candidates = [
    ...withSubjectsAt(node),
    ...(binding === "local" ? [] : implicitRecordsAt(node, ctx, binding)),
  ];
  return candidates.some((c) =>
    loopConditionReadsByName(node, { ...target, implicitReceiver: c }, ctx),
  )
    ? "loop-condition-target"
    : null;
}

/**
 * Every `with` whose BODY holds `node`, innermost first, to the procedure or trigger boundary. Inside
 * `with R do` a bare name binds R's field before any variable (`types.ts` `insideWithBody`), and an
 * outer subject's field when no inner one has it. A subject that is not a plain name gives "", which
 * pairs with no qualified read but still matches a plain one.
 */
function withSubjectsAt(node: ALSyntaxNode): string[] {
  const out: string[] = [];
  for (let p = node.parent; p !== null && !isScope(p); p = p.parent) {
    if (p.rawKind !== "with_statement") continue;
    const body = p.childForFieldName("body");
    if (body === null || node.startIndex < body.startIndex || node.endIndex > body.endIndex)
      continue;
    const subject = p.childForFieldName("record");
    out.push(subject !== null && isIdentifierLike(subject) ? subject.text : "");
  }
  return out;
}

/**
 * The implicit records a bare name at `node` can bind to, per R294's measured rules (`types.ts`
 * `implicitRecordShadowsGlobals`): `Rec` in a pageextension, a page with a `SourceTable`, a TableNo
 * codeunit's `OnRun`, a request page with a `SourceTable` (or any reportextension request page); the
 * name of EVERY enclosing report dataitem (an outer dataitem's field is visible too) and a
 * reportextension `modify(X)`'s X. In a table or tableextension `Rec` too, but only for a name with
 * no declaration: there a global wins over the field (R294).
 *
 * Known ceiling: in a reportextension `modify(Line)` the BASE report's outer dataitems are not
 * candidates, because the base report's structure is not read.
 */
function implicitRecordsAt(node: ALSyntaxNode, ctx: SemanticContext, binding: Binding): string[] {
  const out: string[] = [];
  let scope: ALSyntaxNode | null = null;
  for (let p = node.parent; p !== null; p = p.parent) {
    if (scope === null && isScope(p)) scope = p;
    switch (p.rawKind) {
      case "report_dataitem": {
        const name = p.childForFieldName("name");
        if (name !== null) out.push(name.text);
        continue;
      }
      case "modify_modification": {
        const name = p.childForFieldName("target");
        if (name !== null) out.push(name.text);
        continue;
      }
      case "requestpage_section":
        return hasProperty(p, "SourceTable", ctx) ||
          p.parent?.parent?.rawKind === "reportextension_declaration"
          ? [...out, "Rec"]
          : out;
    }
    switch (p.kind) {
      case ALNodeKind.pageextension:
        return [...out, "Rec"];
      case ALNodeKind.page:
        return hasProperty(p, "SourceTable", ctx) ? [...out, "Rec"] : out;
      case ALNodeKind.codeunit: {
        const onRun =
          scope !== null &&
          scope.kind === ALNodeKind.trigger &&
          normalizeAlName(scope.childForFieldName("name")?.text ?? "") === "onrun";
        return onRun && hasProperty(p, "TableNo", ctx) ? [...out, "Rec"] : out;
      }
      case ALNodeKind.table:
      case ALNodeKind.tableextension:
        return binding === "none" ? [...out, "Rec"] : out;
      case ALNodeKind.report:
        return out;
    }
    if (p.rawKind === "reportextension_declaration") return out;
  }
  return out;
}

/**
 * Does the object declare property `name`, including inside a member-level `#if`? A property in an
 * arm the build compiles out is absent; an undecided file, or no arm map, counts it as present (the
 * safe direction for a hang refusal: a candidate too many costs a site).
 */
function hasProperty(objectNode: ALSyntaxNode, name: string, ctx: SemanticContext): boolean {
  const want = normalizeAlName(name);
  const found = (m: ALSyntaxNode): boolean => {
    if (m.kind === ALNodeKind.property) {
      const n = m.childForFieldName("name");
      return n !== null && normalizeAlName(n.text) === want && armOfNode(ctx, m) !== "inactive";
    }
    return m.rawKind.startsWith("preproc_") && m.namedChildren.some(found);
  };
  return declarationMembers(objectNode).some(found);
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
