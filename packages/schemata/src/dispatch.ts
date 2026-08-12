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
    text: spliceIntoRoot(component.root, m),
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
  return text.slice(0, relStart) + m.afterText + (needsTerminator ? ";" : "") + text.slice(relEnd);
}
