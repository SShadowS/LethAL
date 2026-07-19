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
  parts.push(`end else begin\n  ${original}\nend;`);
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
  return text.slice(0, relStart) + m.afterText + text.slice(relEnd);
}
