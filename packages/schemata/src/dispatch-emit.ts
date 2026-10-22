import type { PlannedComponent, PlannedMember } from "./dispatch-plan";
import { REACH_LATCH } from "./reach-latch";

/**
 * R-307 O5. The EMIT half of `dispatch.ts`: chain and marker TEXT, built from a frozen
 * `PlannedComponent` only. It reads no node and decides nothing; every decision (grain, placement,
 * the splice) is PLAN's (`dispatch-plan.ts`).
 */

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
 * block replacement. `original` is the root's text: the caller slices it from the file's source
 * by the component's span, once.
 */
export function emitDispatch(
  original: string,
  component: PlannedComponent,
  latch: string,
  /** R470: the selector variable PLAN named for the component's object. */
  selector = "MutationSelector",
): string {
  const parts: string[] = [];
  for (const [i, m] of component.members.entries()) {
    const lead = i === 0 ? "if" : "end else if";
    const text = branchText(original, m, latch, selector);
    parts.push(`${lead} ${selector}.Active('${m.mutantId}') then begin\n  ${text}\n`);
  }
  // The chain replaces exactly the root's span, so it must end with a `;` if
  // and only if that span consumed one — the same consumed-terminator rule as
  // the `begin ... end` wrap (compile-emit.ts) and `describeSplice`. Grammar 4.0.0 moved the
  // statement terminator OUT of every statement/block node, so the root's `;`
  // (when it has one) now survives in the source after the replaced span, and
  // appending another here emitted `end;;`. Statements that own an internal
  // `;` (a parenless `call_statement`) still end their text with one and still
  // get it reproduced.
  parts.push(`end else begin\n  ${original}\nend${endsInTerminator(original) ? ";" : ""}`);
  return parts.join("");
}

/** True when `text`, trailing white space aside, ends in `;`: the consumed-terminator rule. */
export function endsInTerminator(text: string): boolean {
  return text.trimEnd().endsWith(";");
}

/**
 * GH-24. The call a statement-grain mutant's branch makes at its OWN statement, so the control app
 * can say that statement began executing. No newline, anywhere: line numbers must not move.
 */
export const REACH_MARKER = (
  mutantId: string,
  latch: string = REACH_LATCH,
  selector = "MutationSelector",
): string =>
  `if not ${latch} then begin ${selector}.Reached('${mutantId}'); ${latch} := true; end;`;

/**
 * The member's branch text, with the marker where PLAN placed it (GH-24 plan, Decisions 4 and 5).
 * The root's text with the member's splice applied, built from `SpliceParts` only.
 */
function branchText(original: string, m: PlannedMember, latch: string, selector: string): string {
  const { splice, place } = m;
  const text = original.slice(0, splice.relStart) + splice.insert + original.slice(splice.relEnd);
  if (place.kind === "none") return text;
  const marker = REACH_MARKER(m.mutantId, latch, selector);
  if (place.kind === "root") return `${marker} ${text}`;
  // `S`'s span in the spliced text: the member's edit sits inside `S`, so only its end moves.
  const start = m.statementStart;
  const end = m.statementEnd + (text.length - original.length);
  if (place.kind === "block") {
    const at = start + place.beginEnd;
    return `${text.slice(0, at)} ${marker}${text.slice(at)}`;
  }
  if (place.kind === "list") return `${text.slice(0, start)}${marker} ${text.slice(start)}`;
  return `${text.slice(0, start)}begin ${marker} ${text.slice(start, end)} end${text.slice(end)}`;
}
