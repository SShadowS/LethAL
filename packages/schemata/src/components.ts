import type { ALSyntaxNode, MutationSpec } from "@lethal/engine";
import { resolveSite } from "./enclosing";
import type { IdedSpec } from "./ids";

export interface ComponentMember {
  readonly mutantId: string;
  readonly spec: MutationSpec;
  /** Statement this spec resolves to (may be nested inside the component root). */
  readonly statement: ALSyntaxNode;
  /** `spec.after`'s text, "" for deletion mutants. */
  readonly afterText: string;
}

export interface Component {
  /** Outermost resolved statement — the node the printer rewrites. */
  readonly root: ALSyntaxNode;
  /** Ordered: outermost mutation first, then by startIndex, then operatorName. */
  readonly members: readonly ComponentMember[];
}

function contains(outer: ALSyntaxNode, inner: ALSyntaxNode): boolean {
  return outer.startIndex <= inner.startIndex && inner.endIndex <= outer.endIndex;
}

/**
 * Group specs whose resolved statements nest. Overlap between mutation sites is
 * always containment (spec §2: AST ranges are laminar), so a component is a
 * containment chain and its root is simply the widest statement in it.
 *
 * The root is what the printer rewrites; every member's edit is spliced into the
 * root's text, so members nested at any depth are handled uniformly.
 */
export function buildComponents(ided: readonly IdedSpec[]): Component[] {
  const resolved: ComponentMember[] = ided.map((entry) => {
    const afterText = (entry.spec.after as unknown as { text?: string }).text ?? "";
    const site = resolveSite(entry.spec.before, afterText);
    return { mutantId: entry.mutantId, spec: entry.spec, statement: site.statement, afterText };
  });

  // Widest statement first, so the first member of a chain is always its root.
  const bySpan = [...resolved].sort((a, b) => {
    const start = a.statement.startIndex - b.statement.startIndex;
    if (start !== 0) return start;
    return b.statement.endIndex - a.statement.endIndex;
  });

  const groups: Array<{ root: ALSyntaxNode; members: ComponentMember[] }> = [];
  for (const m of bySpan) {
    const host = groups.find((g) => contains(g.root, m.statement));
    if (host === undefined) groups.push({ root: m.statement, members: [m] });
    else host.members.push(m);
  }

  return groups.map((g) => ({
    root: g.root,
    members: [...g.members].sort(orderOutermostFirst),
  }));
}

/** Outermost mutation first, then by position, then by operator — fully deterministic. */
function orderOutermostFirst(a: ComponentMember, b: ComponentMember): number {
  const span =
    b.spec.before.endIndex -
    b.spec.before.startIndex -
    (a.spec.before.endIndex - a.spec.before.startIndex);
  if (span !== 0) return span;
  const start = a.spec.before.startIndex - b.spec.before.startIndex;
  if (start !== 0) return start;
  return a.spec.operatorName.localeCompare(b.spec.operatorName);
}
