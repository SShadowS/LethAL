import {
  ALNodeKind,
  type ALSyntaxNode,
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
export function emitDispatch(component: Component): string {
  const original = component.root.text;
  const branches = component.members.map((m) => ({
    mutantId: m.mutantId,
    text: placeReach(component.root, m).text,
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
 * GH-24. The call a statement-grain mutant's branch makes at its OWN statement, so the control app
 * can say that statement began executing. No newline, anywhere: line numbers must not move.
 */
export const REACH_MARKER = (mutantId: string): string =>
  `MutationSelector.Reached('${mutantId}');`;

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
function placeReach(root: ALSyntaxNode, m: ComponentMember): { grain: ReachGrain; text: string } {
  const text = spliceIntoRoot(root, m);
  const s = m.statement;
  // The walk from the mutated node up to (not including) its resolved statement. Crossing any
  // slot or list member on the way means the statement does not always run the mutated code.
  let n: ALSyntaxNode | null = m.spec.before;
  while (n !== null && !sameNode(n, s)) {
    if (isStatementSlot(n)) return { grain: "enclosing", text };
    n = n.parent;
  }
  if (n === null) return { grain: "unplaced", text };

  const marker = REACH_MARKER(m.mutantId);
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
