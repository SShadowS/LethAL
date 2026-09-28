import {
  ALNodeKind,
  type ALSyntaxNode,
  isProcedureLike,
  isStatementPosition,
  isStatementSlot,
} from "@lethal/engine";
import type { Component, ComponentMember } from "./components";

/**
 * Emit one flat guard chain for a containment component.
 *
 * Only ONE mutant is ever active, so mutants in a component are siblings in an
 * if/else-if chain rather than nested guards. That keeps growth linear (N+1
 * branches for N mutants) and — crucially — keeps evaluation order inside every
 * branch identical to the original statement's, because nothing is hoisted.
 *
 * Each branch is the component ROOT's text with that mutant's `before` span
 * replaced by its `after` text. Uniform for mutation, deletion (empty after) and
 * block replacement.
 */
export function emitDispatch(component: Component, latch: string = REACH_LATCH): string {
  const original = component.root.text;
  const branches = component.members.map((m) => ({
    mutantId: m.mutantId,
    text: placeReach(component.root, m, latch).text,
  }));

  const parts: string[] = [];
  for (const [i, b] of branches.entries()) {
    const lead = i === 0 ? "if" : "end else if";
    parts.push(`${lead} MutationSelector.Active('${b.mutantId}') then begin\n  ${b.text}\n`);
  }
  // The chain replaces exactly the root's span, so it must end with a `;` if
  // and only if that span consumed one — the same consumed-terminator rule as
  // `wrapIfSingleStatementSlot` and `spliceIntoRoot`. Grammar 4.0.0 moved the
  // statement terminator OUT of every statement/block node, so the root's `;`
  // (when it has one) now survives in the source after the replaced span, and
  // appending another here emitted `end;;`. Statements that own an internal
  // `;` (a parenless `call_statement`) still end their text with one and still
  // get it reproduced.
  const consumedTerminator = original.trimEnd().endsWith(";");
  parts.push(`end else begin\n  ${original}\nend${consumedTerminator ? ";" : ""}`);
  return parts.join("");
}

/**
 * R246. The procedure-local Boolean that latches the marker after its first hit. A marker inside a
 * loop otherwise costs two calls (selector, then `LC Control State.NoteReached`) per iteration,
 * which turned `itest:hang`'s 4.4 s Int32-overflow kill into a timeout. With the latch the hot path
 * is one test of a local. It is a LOCAL of the enclosing procedure or trigger (declared by
 * `compileSchemataForFile`), so it starts false on every call: it cannot outlive a test method, and
 * so cannot survive any of the control app's `ObservedActive` resets, which all run between tests.
 * The first hit still reaches `NoteReached`, so a mismatched tuple still latches
 * `ObservedIdentityMismatch` there.
 *
 * This is the DEFAULT name. Where it is already an identifier in the procedure's scope, the compiler picks a
 * suffixed one per procedure (`latchNameFor` in compile.ts) and passes it to `emitDispatch`.
 */
export const REACH_LATCH = "LethALReachLatch";

/**
 * GH-24. The call a statement-grain mutant's branch makes at its OWN statement, so the control app
 * can say that statement began executing. No newline, anywhere: line numbers must not move.
 */
export const REACH_MARKER = (mutantId: string, latch: string = REACH_LATCH): string =>
  `if not ${latch} then begin MutationSelector.Reached('${mutantId}'); ${latch} := true; end;`;

/**
 * Where reach can be measured for one mutant, decided at compile time.
 *
 * - `statement`: the marker sits at the mutant's own statement, so it fires exactly when that
 *   statement begins. For an expression mutant that is its statement BEGINNING, not the
 *   sub-expression being evaluated.
 * - `enclosing`: the mutated code sits in a branch, loop body or case arm that its resolved
 *   statement does not always enter (`if c then Foo()`, a case-arm block). A marker at the
 *   resolved statement would fire when the branch is skipped, so none is placed.
 * - `unplaced`: no placement rule applies. Never a throw: a new shape needs a rule, and the
 *   fixture enumeration test in `packages/runner` fails on any `unplaced` entry.
 */
export type ReachGrain = "statement" | "enclosing" | "unplaced";

/** The grain `emitDispatch` places (or omits) the marker by. Pure; one source for both callers. */
export function reachGrainOf(member: ComponentMember, root: ALSyntaxNode): ReachGrain {
  return placeReach(root, member).grain;
}

/**
 * R303. The last token of a procedure or trigger header: the owner-level `)` that closes the
 * parameter list, else the `return_type` after it (plain or named return), else a `;` directly
 * after either. Attributes before the member and parameters spanning lines do not change it: an
 * attribute's own parentheses sit inside `attribute_item`, and parameters inside `parameter_list`.
 * `null` when the owner has no owner-level `)` (a split header keeps its `)` inside each arm).
 */
function headerEndOf(owner: ALSyntaxNode): ALSyntaxNode | null {
  const kids = owner.children.filter(
    (c) => c.rawKind !== "comment" && c.rawKind !== "multiline_comment",
  );
  const close = kids.find((c) => c.rawKind === ")");
  if (close === undefined) return null;
  const ret = owner.childForFieldName("return_type");
  const end = ret !== null && ret.startIndex > close.startIndex ? ret : close;
  const next = kids.find((c) => c.startIndex >= end.endIndex);
  return next !== undefined && next.rawKind === ";" ? next : end;
}

/**
 * R303. For a procedure or trigger whose `var` section sits inside `#if`
 * (`preproc_conditional_var_block`), the header token to write ONE unconditional
 * `var <latch>: Boolean;` after. The writer then blanks each arm's own `var` keyword, so each
 * arm's declarations become conditional declarations in that one section, which is valid in every
 * build. `null` when the member has no such block, or when the token before the block (comments
 * skipped) is anything but the header's actual end: a pragma-only `#if` block, a split header's
 * `#endif`, or any kind not yet seen. Those members stay refused by name. A
 * `preproc_split_procedure_preamble` never reaches here: `reachLatchRefusedOwner` refuses it first
 * (R309).
 */
export function splitVarHoistAnchor(owner: ALSyntaxNode): ALSyntaxNode | null {
  const kids = owner.children;
  const at = kids.findIndex((c) => c.rawKind === "preproc_conditional_var_block");
  if (at < 0) return null;
  const prev = kids
    .slice(0, at)
    .filter((c) => c.rawKind !== "comment" && c.rawKind !== "multiline_comment")
    .at(-1);
  const end = headerEndOf(owner);
  if (prev === undefined || end === null) return null;
  return prev.startIndex === end.startIndex && prev.endIndex === end.endIndex ? prev : null;
}

/**
 * R303 fix round 1. True when the member's region from the header's end (or the member's start,
 * for a header with no owner-level `)`) to its `begin` holds an ERROR node or a missing node:
 * its var section did not parse cleanly. tree-sitter-al parses two `#if` var blocks in a row, or
 * a nested `#if` wrapping the whole section, that way, so no `preproc_conditional_var_block` is
 * left for `splitVarHoistAnchor` to see, and a latch written by the plain rules lands in one
 * arm (alc AL0118) or beside a `var` that is already there (AL0104). Fail safe: refuse.
 */
export function varSectionUnparsed(owner: ALSyntaxNode): boolean {
  const from = headerEndOf(owner)?.endIndex ?? owner.startIndex;
  const to = owner.children.find((c) => c.kind === ALNodeKind.block)?.startIndex ?? owner.endIndex;
  let bad = false;
  const walk = (n: ALSyntaxNode): void => {
    if (bad || n.endIndex <= from || n.startIndex >= to) return;
    // A missing node is the zero-width token the parser invented; the wrapper has no isMissing.
    if (n.rawKind === "ERROR" || (n.children.length === 0 && n.startIndex === n.endIndex)) {
      bad = true;
      return;
    }
    for (const c of n.children) walk(c);
  };
  for (const c of owner.children) walk(c);
  return bad;
}

/**
 * The member holding `node` when the writer declares no reach latch there, else `null`. Three
 * shapes, each refused by name in the `reach-latch-refused` warning:
 * - R309: a `preproc_split_procedure_preamble`, a split-header procedure whose `#if` arms each
 *   hold their own header and their own `var` section (an arm may have none), with one shared body
 *   after `#endif`. One latch declaration cannot serve every arm's section, and a per-arm placement
 *   is not built (it would measure nothing until R316 gives the member a name and a span). The
 *   node returned is the preamble itself, which is not procedure-like.
 * - R313: a procedure or trigger whose var section did not parse cleanly (`varSectionUnparsed`).
 * - R303: a procedure or trigger whose var section sits inside `#if` in a shape
 *   `splitVarHoistAnchor` does not cover.
 * Such a member gets no latch and no marker: its mutants are `unplaced`, their reach is
 * `not-decided`, never unreached. The member is still instrumented and scored.
 */
export function reachLatchRefusedOwner(node: ALSyntaxNode): ALSyntaxNode | null {
  let owner: ALSyntaxNode | null = node;
  while (
    owner !== null &&
    !isProcedureLike(owner) &&
    owner.kind !== ALNodeKind.trigger &&
    owner.rawKind !== "preproc_split_procedure_preamble"
  )
    owner = owner.parent;
  if (owner === null) return null;
  if (owner.rawKind === "preproc_split_procedure_preamble") return owner;
  if (varSectionUnparsed(owner)) return owner;
  const split = owner.children.some((c) => c.rawKind === "preproc_conditional_var_block");
  return split && splitVarHoistAnchor(owner) === null ? owner : null;
}

/**
 * Span and kind, never object identity: the engine's wrapper nodes are created per traversal, so
 * the same node reached by two walks is two objects.
 */
function sameNode(a: ALSyntaxNode, b: ALSyntaxNode): boolean {
  return a.startIndex === b.startIndex && a.endIndex === b.endIndex && a.kind === b.kind;
}

const LEADING_BEGIN = /^\s*begin(?![A-Za-z0-9_])/i;

/**
 * The member's branch text, with the marker when the grain is `statement` (GH-24 plan, Decisions
 * 4 and 5). `S` is the member's resolved statement, `R` the component root.
 *
 * P0 `S` is `R`: prefix the branch; the chain sits at `R`, so it runs exactly when `R` begins.
 * P1 `S` is a nested block: after its leading `begin` (post-splice), else `unplaced`.
 * P2 `S` sits in a statement list: prefix at `S`.
 * P3 `S` occupies a single-statement slot: `begin <marker> <S> end`.
 */
function placeReach(
  root: ALSyntaxNode,
  m: ComponentMember,
  latch: string = REACH_LATCH,
): { grain: ReachGrain; text: string } {
  const text = spliceIntoRoot(root, m);
  // R303, R309, R313: a member the writer declares no latch in gets no marker.
  if (reachLatchRefusedOwner(root) !== null) return { grain: "unplaced", text };
  const s = m.statement;
  // The walk from the mutated node up to (not including) its resolved statement. Crossing any
  // slot or list member on the way means the statement does not always run the mutated code.
  let n: ALSyntaxNode | null = m.spec.before;
  while (n !== null && !sameNode(n, s)) {
    if (isStatementSlot(n)) return { grain: "enclosing", text };
    n = n.parent;
  }
  if (n === null) return { grain: "unplaced", text };

  const marker = REACH_MARKER(m.mutantId, latch);
  if (sameNode(s, root)) return { grain: "statement", text: `${marker} ${text}` };
  // `S`'s span in the spliced text: the member's edit sits inside `S`, so only its end moves.
  const start = s.startIndex - root.startIndex;
  const end = s.endIndex - root.startIndex + (text.length - root.text.length);
  if (s.kind === ALNodeKind.block) {
    const begin = LEADING_BEGIN.exec(text.slice(start, end));
    if (begin === null) return { grain: "unplaced", text };
    const at = start + begin[0].length;
    return { grain: "statement", text: `${text.slice(0, at)} ${marker}${text.slice(at)}` };
  }
  if (isStatementPosition(s)) {
    return { grain: "statement", text: `${text.slice(0, start)}${marker} ${text.slice(start)}` };
  }
  if (isStatementSlot(s)) {
    return {
      grain: "statement",
      text: `${text.slice(0, start)}begin ${marker} ${text.slice(start, end)} end${text.slice(end)}`,
    };
  }
  return { grain: "unplaced", text };
}

function spliceIntoRoot(root: Component["root"], m: ComponentMember): string {
  const relStart = m.spec.before.startIndex - root.startIndex;
  const relEnd = m.spec.before.endIndex - root.startIndex;
  const text = root.text;
  if (relStart < 0 || relEnd > text.length) {
    throw new Error(
      `emitDispatch: member ${m.mutantId} span ${m.spec.before.startIndex}..${m.spec.before.endIndex} ` +
        `is not contained in component root ${root.startIndex}..${root.endIndex}`,
    );
  }
  // Mirror `wrapIfSingleStatementSlot` (compile.ts)'s consumed-terminator
  // rule at the MEMBER-splice level: if the consumed span's text ended in a
  // `;` the replacement does not reproduce, re-append it — otherwise a
  // following sibling statement loses its separator (`... begin end
  // A := 2;` — invalid AL). The discriminator is what the consumed TEXT
  // actually ends with, never the node's kind: `empty-block`'s span includes
  // the block's trailing `;` when a sibling follows, but the SAME block kind
  // as a bare `if`-branch directly followed by `else` has none — and adding
  // one there would orphan the else (AL0110). Inferring from kind regressed
  // emission in both directions once already (Task 3).
  const consumed = text.slice(relStart, relEnd);
  const needsTerminator = consumed.trimEnd().endsWith(";") && !m.afterText.trimEnd().endsWith(";");
  const filler = emptiedSlotFiller(text, relEnd, m);
  return (
    text.slice(0, relStart) +
    m.afterText +
    filler +
    (needsTerminator ? ";" : "") +
    text.slice(relEnd)
  );
}

/**
 * `;` when a DELETION would leave a single-statement slot with no statement in it at all, otherwise
 * the empty string.
 *
 * R161. `if Cond then Foo();` puts the call in the `then_branch` slot, and the branch's own `;` is
 * the enclosing statement's, sitting OUTSIDE the component root's span since grammar 4.0.0 moved
 * the terminator out. So splicing a deletion's empty `afterText` in emits `if Cond then` followed by
 * the chain's `end`, which is not AL. Measured on the four slot shapes before this existed: the
 * `then_branch`, `else_branch` and `while` body cases all emitted a dangling `then`/`do`, and only
 * the `case_branch` body survived, because there the arm's `;` sits INSIDE the root and survives the
 * splice.
 *
 * That asymmetry is why the condition is "does a `;` already follow within the root" rather than
 * "is this a single-statement slot": emitting one unconditionally would give the case arm `1: ;;`,
 * a second empty statement in a position where the grammar wants the next label.
 *
 * `if Cond then ;` is legal AL, verified by an offline `alc` compile of all five shapes this touches
 * (`then ;`, `else ;`, an empty case arm, `then begin end`, and a braced nested if/else).
 *
 * EXCEPT when the slot is a then-branch whose `else` follows: `if Cond then ; else Bar()` is the
 * "unnecessary semicolon before ELSE" that AL0110 names, because the empty statement's `;` closes
 * the `if` before its `else` is reached. That shape was not among the four measured above, and it
 * is the one that broke first on real code: the R175 re-run of `do rung1` (2026-09-02) emitted it
 * at three sites of one codeunit, `alc` refused the whole artifact, and all 155 mutants scored
 * `error`. An empty block is a statement the grammar accepts in every slot and closes nothing, so
 * that is the filler there. It is used ONLY there, so the four measured shapes keep the emission
 * `scripts/r161-emit-proof.ts` compiled; that script now carries this shape as a fifth case.
 */
function emptiedSlotFiller(rootText: string, relEnd: number, m: ComponentMember): string {
  if (m.afterText.trim() !== "") return "";
  if (isStatementPosition(m.spec.before) || !isStatementSlot(m.spec.before)) return "";
  const rest = rootText.slice(relEnd).trimStart();
  if (rest.startsWith(";")) return "";
  if (/^else(?![A-Za-z0-9_])/i.test(rest)) return "begin end";
  return ";";
}
