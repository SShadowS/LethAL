import type { Component, ComponentMember } from "./components";
import { type SpliceParts, planPlacement } from "./dispatch-plan";

export {
  type Placement,
  type ReachGrain,
  type SpliceParts,
  describeSplice,
  leadingBeginEnd,
  planPlacement,
  planReachGrains,
  preambleArmHeaderEnds,
  reachGrainOf,
  reachLatchRefusedOwner,
  splitVarHoistAnchor,
  varSectionUnparsed,
} from "./dispatch-plan";

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
 * block replacement. `source` is the file's text, which PLAN's splice decisions read.
 */
export function emitDispatch(
  component: Component,
  source: string,
  latch: string = REACH_LATCH,
): string {
  const original = component.root.text;
  const branches = component.members.map((m) => ({
    mutantId: m.mutantId,
    text: branchText(component.root, m, source, latch),
  }));

  const parts: string[] = [];
  for (const [i, b] of branches.entries()) {
    const lead = i === 0 ? "if" : "end else if";
    parts.push(`${lead} MutationSelector.Active('${b.mutantId}') then begin\n  ${b.text}\n`);
  }
  // The chain replaces exactly the root's span, so it must end with a `;` if
  // and only if that span consumed one — the same consumed-terminator rule as
  // `wrapIfSingleStatementSlot` and `describeSplice`. Grammar 4.0.0 moved the
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

/** The root's text with the member's splice applied: built from `SpliceParts` only. */
function splicedText(rootText: string, parts: SpliceParts): string {
  return rootText.slice(0, parts.relStart) + parts.insert + rootText.slice(parts.relEnd);
}

/**
 * The member's branch text, with the marker where `planPlacement` put it (GH-24 plan, Decisions
 * 4 and 5). Every decision is PLAN's; this only builds text.
 */
function branchText(
  root: Component["root"],
  m: ComponentMember,
  source: string,
  latch: string,
): string {
  const { place, splice } = planPlacement(root, m, source);
  const rootText = root.text;
  const text = splicedText(rootText, splice);
  if (place.kind === "none") return text;
  const marker = REACH_MARKER(m.mutantId, latch);
  if (place.kind === "root") return `${marker} ${text}`;
  // `S`'s span in the spliced text: the member's edit sits inside `S`, so only its end moves.
  const s = m.statement;
  const start = s.startIndex - root.startIndex;
  const end = s.endIndex - root.startIndex + (text.length - rootText.length);
  if (place.kind === "block") {
    const at = start + place.beginEnd;
    return `${text.slice(0, at)} ${marker}${text.slice(at)}`;
  }
  if (place.kind === "list") return `${text.slice(0, start)}${marker} ${text.slice(start)}`;
  return `${text.slice(0, start)}begin ${marker} ${text.slice(start, end)} end${text.slice(end)}`;
}
