import {
  ALNodeKind,
  type ALSyntaxNode,
  isProcedureLike,
  isStatementPosition,
  isStatementSlot,
} from "@lethal/engine";
import { type Component, type ComponentMember, buildComponents } from "./components";
import type { IdedSpec } from "./ids";

/**
 * R-307 (plan amendment O3). The PLAN half of `dispatch.ts`: every decision the dispatch chain
 * depends on (the member splice, reach grain and placement, the reach-latch refusals), made over
 * spans and the file's source, with no chain text built. The text is built in `dispatch-emit.ts`
 * from what these functions return (`PlannedComponent`), so there is one code path for each
 * decision.
 */

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

/**
 * One member's splice into its component root, as offsets relative to the root's start plus the
 * text that replaces `[relStart, relEnd)`: the member's `after` text, the empty-slot filler, and a
 * re-appended `;` when the consumed span ended in one the replacement does not reproduce.
 */
export interface SpliceParts {
  readonly relStart: number;
  readonly relEnd: number;
  readonly insert: string;
}

/**
 * Where a `statement`-grain member's marker goes (GH-24 plan, Decisions 4 and 5). `S` is the
 * member's resolved statement, `R` the component root.
 *
 * - `root` (P0): `S` is `R`; prefix the branch.
 * - `block` (P1): `S` is a nested block; after its leading `begin` in the spliced text, which ends
 *   `beginEnd` characters after `S`'s start.
 * - `list` (P2): `S` sits in a statement list; prefix at `S`.
 * - `slot` (P3): `S` occupies a single-statement slot; `begin <marker> <S> end`.
 * - `none`: no marker (grain `enclosing` or `unplaced`).
 */
export type Placement =
  | { readonly kind: "none" }
  | { readonly kind: "root" }
  | { readonly kind: "block"; readonly beginEnd: number }
  | { readonly kind: "list" }
  | { readonly kind: "slot" };

/**
 * THE splice decision (c1): PLAN uses it for reach grain, EMIT builds splice text from it. `source`
 * is the file's text, so `source.slice(root.startIndex, root.endIndex)` is the root's text.
 *
 * Mirrors `wrapIfSingleStatementSlot` (compile.ts)'s consumed-terminator rule at the MEMBER-splice
 * level: if the consumed span's text ended in a `;` the replacement does not reproduce, re-append
 * it — otherwise a following sibling statement loses its separator (`... begin end A := 2;` —
 * invalid AL). The discriminator is what the consumed TEXT actually ends with, never the node's
 * kind: `empty-block`'s span includes the block's trailing `;` when a sibling follows, but the SAME
 * block kind as a bare `if`-branch directly followed by `else` has none — and adding one there
 * would orphan the else (AL0110). Inferring from kind regressed emission in both directions once
 * already (Task 3).
 */
export function describeSplice(
  root: ALSyntaxNode,
  m: ComponentMember,
  source: string,
): SpliceParts {
  const relStart = m.spec.before.startIndex - root.startIndex;
  const relEnd = m.spec.before.endIndex - root.startIndex;
  if (relStart < 0 || relEnd > root.endIndex - root.startIndex) {
    throw new Error(
      `emitDispatch: member ${m.mutantId} span ${m.spec.before.startIndex}..${m.spec.before.endIndex} ` +
        `is not contained in component root ${root.startIndex}..${root.endIndex}`,
    );
  }
  // The replacement's own `;` first: when it has one, the source is not read at all
  // (manifest-row-cost charges every source read, and EMIT now slices each root once).
  const needsTerminator =
    !m.afterText.trimEnd().endsWith(";") &&
    endsInSemicolon(source, m.spec.before.startIndex, m.spec.before.endIndex);
  const filler = emptiedSlotFiller(source, m.spec.before.endIndex, root.endIndex, m);
  return { relStart, relEnd, insert: m.afterText + filler + (needsTerminator ? ";" : "") };
}

const LEADING_BEGIN = /^\s*begin(?![A-Za-z0-9_])/i;

/**
 * P1's test: the length of the leading `begin` of `S` AFTER the splice, or `null` when the spliced
 * `S` does not start with one. Read over the three-piece window
 * `source[S.start, before.start) + insert + source[before.end, S.end)`, which is exactly the
 * spliced statement: where `before` starts at `S.start`, the replacement and the filler decide.
 */
export function leadingBeginEnd(
  parts: SpliceParts,
  s: ALSyntaxNode,
  root: ALSyntaxNode,
  source: string,
): number | null {
  const window =
    source.slice(s.startIndex, root.startIndex + parts.relStart) +
    parts.insert +
    source.slice(root.startIndex + parts.relEnd, s.endIndex);
  const begin = LEADING_BEGIN.exec(window);
  return begin === null ? null : begin[0].length;
}

/**
 * The member's grain and marker placement, with its splice. The splice is described FIRST, so its
 * containment check (E3) runs for every member, whatever the grain.
 */
export function planPlacement(
  root: ALSyntaxNode,
  m: ComponentMember,
  source: string,
): { readonly grain: ReachGrain; readonly place: Placement; readonly splice: SpliceParts } {
  const splice = describeSplice(root, m, source);
  const none = (grain: ReachGrain) => ({ grain, place: { kind: "none" } as const, splice });
  // R303, R313, R316: a member the writer declares no latch in gets no marker.
  if (reachLatchRefusedOwner(root) !== null) return none("unplaced");
  const s = m.statement;
  // The walk from the mutated node up to (not including) its resolved statement. Crossing any
  // slot or list member on the way means the statement does not always run the mutated code.
  let n: ALSyntaxNode | null = m.spec.before;
  while (n !== null && !sameNode(n, s)) {
    if (isStatementSlot(n)) return none("enclosing");
    n = n.parent;
  }
  if (n === null) return none("unplaced");
  if (sameNode(s, root)) return { grain: "statement", place: { kind: "root" }, splice };
  if (s.kind === ALNodeKind.block) {
    const beginEnd = leadingBeginEnd(splice, s, root, source);
    if (beginEnd === null) return none("unplaced");
    return { grain: "statement", place: { kind: "block", beginEnd }, splice };
  }
  if (isStatementPosition(s)) return { grain: "statement", place: { kind: "list" }, splice };
  if (isStatementSlot(s)) return { grain: "statement", place: { kind: "slot" }, splice };
  return none("unplaced");
}

/**
 * R-307 O5. One member's frozen plan: everything EMIT needs to write its branch, as plain data.
 * `statementStart`/`statementEnd` are its resolved statement's span relative to the root's start,
 * which the `block`, `list` and `slot` placements put the marker by.
 */
export interface PlannedMember {
  readonly mutantId: string;
  readonly grain: ReachGrain;
  readonly place: Placement;
  readonly splice: SpliceParts;
  readonly statementStart: number;
  readonly statementEnd: number;
}

/** R-307 O5. One component's frozen plan: the root's span (never the node) and its members. */
export interface PlannedComponent {
  readonly rootStart: number;
  readonly rootEnd: number;
  readonly members: readonly PlannedMember[];
}

/** R-307 O5. `planPlacement`, frozen: the node is read here and never again. */
export function planMember(root: ALSyntaxNode, m: ComponentMember, source: string): PlannedMember {
  const { grain, place, splice } = planPlacement(root, m, source);
  return {
    mutantId: m.mutantId,
    grain,
    place,
    splice,
    statementStart: m.statement.startIndex - root.startIndex,
    statementEnd: m.statement.endIndex - root.startIndex,
  };
}

/** R-307 O5. Every member of one component, planned in member order. */
export function planComponent(c: Component, source: string): PlannedComponent {
  return {
    rootStart: c.root.startIndex,
    rootEnd: c.root.endIndex,
    members: c.members.map((m) => planMember(c.root, m, source)),
  };
}

/** The grain EMIT places (or omits) the marker by. Pure; one source for every caller. */
export function reachGrainOf(
  member: ComponentMember,
  root: ALSyntaxNode,
  source: string,
): ReachGrain {
  return planPlacement(root, member, source).grain;
}

/** Every mutant's grain in one file, over the same components the compiler builds. */
export function planReachGrains(
  ided: readonly IdedSpec[],
  source: string,
): Map<string, ReachGrain> {
  const out = new Map<string, ReachGrain>();
  for (const c of buildComponents(ided)) {
    for (const m of c.members) out.set(m.mutantId, reachGrainOf(m, c.root, source));
  }
  return out;
}

/**
 * `;` when a DELETION would leave a single-statement slot with no statement in it at all, otherwise
 * the empty string. Looks ahead from the deleted span's end to the ROOT's end only.
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
function emptiedSlotFiller(source: string, from: number, to: number, m: ComponentMember): string {
  if (m.afterText.trim() !== "") return "";
  if (isStatementPosition(m.spec.before) || !isStatementSlot(m.spec.before)) return "";
  let at = from;
  while (at < to && WHITESPACE.test(source.charAt(at))) at++;
  if (at < to && source.charAt(at) === ";") return "";
  // Five characters decide `else` plus its word boundary, exactly as the test on the whole rest.
  if (/^else(?![A-Za-z0-9_])/i.test(source.slice(at, Math.min(at + 5, to)))) return "begin end";
  return ";";
}

/** One character of what `trim` removes (`\s` is the same set: white space and line ends). */
const WHITESPACE = /^\s$/;

/**
 * `source.slice(from, to).trimEnd().endsWith(";")`, read backwards one character at a time, so a
 * member's decision costs its trailing whitespace, not a copy of its span (manifest-row-cost).
 */
function endsInSemicolon(source: string, from: number, to: number): boolean {
  let at = to - 1;
  while (at >= from && WHITESPACE.test(source.charAt(at))) at--;
  return at >= from && source.charAt(at) === ";";
}

/**
 * Span and kind, never object identity: the engine's wrapper nodes are created per traversal, so
 * the same node reached by two walks is two objects.
 */
function sameNode(a: ALSyntaxNode, b: ALSyntaxNode): boolean {
  return a.startIndex === b.startIndex && a.endIndex === b.endIndex && a.kind === b.kind;
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

/** The `#if` directives that open, switch and close a preamble's arms, as its direct children. */
const ARM_MARKERS: ReadonlySet<string> = new Set([
  "preproc_if",
  "preproc_elif",
  "preproc_else",
  "preproc_endif",
]);

/**
 * R316. For a `preproc_split_procedure_preamble`, the last header token of EACH `#if` arm, in
 * source order: the arm's `)`, else its return type after it (plain or named), else a `;` directly
 * after either. `headerEndOf`'s rule, applied per arm: every arm's header tokens are direct
 * children of the preamble. `null` unless every arm holds exactly one `procedure` keyword and one
 * `)`, and an `#endif` closes the arms before the body: any other split is refused, never guessed.
 */
export function preambleArmHeaderEnds(owner: ALSyntaxNode): ALSyntaxNode[] | null {
  const arms: ALSyntaxNode[][] = [];
  let arm: ALSyntaxNode[] | null = null;
  for (const c of owner.children) {
    if (c.kind === ALNodeKind.block) break;
    if (ARM_MARKERS.has(c.rawKind)) {
      if (arm !== null) arms.push(arm);
      arm = c.rawKind === "preproc_endif" ? null : [];
    } else if (arm !== null && c.rawKind !== "comment" && c.rawKind !== "multiline_comment") {
      arm.push(c);
    }
  }
  if (arm !== null || arms.length === 0) return null;
  const ends: ALSyntaxNode[] = [];
  for (const kids of arms) {
    const closes = kids.filter((c) => c.rawKind === ")");
    const [close] = closes;
    const keywords = kids.filter((c) => c.rawKind === "procedure_keyword").length;
    if (close === undefined || closes.length !== 1 || keywords !== 1) return null;
    const ret = kids.find((c) => c.fieldName === "return_type" && c.startIndex > close.startIndex);
    const end = ret ?? close;
    const next = kids.find((c) => c.startIndex >= end.endIndex);
    ends.push(next !== undefined && next.rawKind === ";" ? next : end);
  }
  return ends;
}

/**
 * R303. For a procedure or trigger whose `var` section sits inside `#if`
 * (`preproc_conditional_var_block`), the header token to write ONE unconditional
 * `var <latch>: Boolean;` after. The writer then blanks each arm's own `var` keyword, so each
 * arm's declarations become conditional declarations in that one section, which is valid in every
 * build. `null` when the member has no such block, or when the token before the block (comments
 * skipped) is anything but the header's actual end: a pragma-only `#if` block, a split header's
 * `#endif`, or any kind not yet seen. Those members stay refused by name. A
 * `preproc_split_procedure_preamble` never reaches here: `reachLatchRefusedOwner` decides it by
 * `preambleArmHeaderEnds` first (R316).
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
 * R316: for a `preproc_split_procedure_preamble` the region is the WHOLE preamble before its body,
 * every arm's header included: each arm's header end anchors a latch there, so a parse error in
 * any header, even before the first arm's `)`, must refuse it too.
 */
export function varSectionUnparsed(owner: ALSyntaxNode): boolean {
  const from =
    owner.rawKind === "preproc_split_procedure_preamble"
      ? owner.startIndex
      : (headerEndOf(owner)?.endIndex ?? owner.startIndex);
  const to = owner.children.find((c) => c.kind === ALNodeKind.block)?.startIndex ?? owner.endIndex;
  let bad = false;
  const walk = (n: ALSyntaxNode): void => {
    if (bad || n.endIndex <= from || n.startIndex >= to) return;
    // A missing node is the zero-width token the parser invented. Matched by shape (a zero-width
    // leaf) rather than by `isMissing`: every missing node is such a leaf, so the shape is the wider
    // test, and it is kept as it was so the set of refused members does not move with the parser.
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
 * shapes, each refused by name in the `reach-latch-refused` warning, checked in this order:
 * - R313: a member whose var section did not parse cleanly (`varSectionUnparsed`), one arm's var
 *   section in a preamble included.
 * - R316: a `preproc_split_procedure_preamble` (each `#if` arm holds its own header and its own
 *   `var` section, if any, then one shared body after `#endif`) whose arm header ends
 *   `preambleArmHeaderEnds` cannot all find. No parse is known to reach this: a preamble it can
 *   anchor takes one latch per arm (`injectReachLatches`).
 * - R303: a procedure or trigger whose var section sits inside `#if` in a shape
 *   `splitVarHoistAnchor` does not cover.
 * Such a member gets no latch and no marker: its mutants are `unplaced`, their reach is
 * `not-decided`, never unreached. The member is still instrumented and scored.
 */
export function reachLatchRefusedOwner(node: ALSyntaxNode): ALSyntaxNode | null {
  let owner: ALSyntaxNode | null = node;
  while (owner !== null && !isProcedureLike(owner) && owner.kind !== ALNodeKind.trigger)
    owner = owner.parent;
  if (owner === null) return null;
  if (varSectionUnparsed(owner)) return owner;
  if (owner.rawKind === "preproc_split_procedure_preamble")
    return preambleArmHeaderEnds(owner) === null ? owner : null;
  const split = owner.children.some((c) => c.rawKind === "preproc_conditional_var_block");
  return split && splitVarHoistAnchor(owner) === null ? owner : null;
}
