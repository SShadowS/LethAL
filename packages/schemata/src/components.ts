import { ALNodeKind, type ALSyntaxNode, type MutationSpec, isProcedureLike } from "@lethal/engine";
import { resolveStatement } from "./enclosing";
import { type IdedSpec, compareCodeUnits } from "./ids";

export interface ComponentMember {
  readonly mutantId: string;
  readonly spec: MutationSpec;
  /** Statement this spec resolves to (may be nested inside the component root). */
  readonly statement: ALSyntaxNode;
  /** `spec.after`'s text, "" for deletion mutants. */
  readonly afterText: string;
}

export interface Component {
  /** Outermost resolved statement, or the loop `rootInFreeBlock` chose: the node the printer rewrites. */
  readonly root: ALSyntaxNode;
  /** Ordered: outermost mutation first, then by startIndex, then operatorName. */
  readonly members: readonly ComponentMember[];
  /** R827: a free `empty-block`: its one member guards `root`, a block, with no chain and no copy. */
  readonly free?: true;
  /**
   * R828 O1: other components sit inside `root`. Then every member is the root's OWN (it resolves to
   * the root), each own branch copies the root PLAIN, and the nested components live in the one
   * ORIGINAL branch, as their own components. Absent: a flat chain, as before (a loop, a root that
   * holds a directive, or a root with nothing nested).
   */
  readonly split?: true;
}

function contains(outer: ALSyntaxNode, inner: ALSyntaxNode): boolean {
  return outer.startIndex <= inner.startIndex && inner.endIndex <= outer.endIndex;
}

const LOOPS: ReadonlySet<string> = new Set([
  "while_statement",
  "repeat_statement",
  "for_statement",
  "foreach_statement",
]);

/** R827 point 1: the outermost loop within `block` that holds `s`, or `s`. Inside a free block a
 *  mutant in a loop stays guarded at loop entry, as the body's chain guarded it at body entry, so
 *  no guard runs on every pass where none did before (R246). */
function rootInFreeBlock(s: ALSyntaxNode, block: ALSyntaxNode): ALSyntaxNode {
  let root = s;
  for (
    let n: ALSyntaxNode | null = s;
    n !== null && n.startIndex > block.startIndex;
    n = n.parent
  ) {
    if (LOOPS.has(n.rawKind)) root = n;
  }
  return root;
}

/** A directive's arm can hold the block's closing `end`, where one insertion reaches one build. */
function holdsDirective(n: ALSyntaxNode): boolean {
  return (
    n.rawKind.startsWith("preproc_") || n.rawKind === "pragma" || n.children.some(holdsDirective)
  );
}

/** R827: does this member's own shape allow a guard? Equal spans are the walk's. A statement whose
 *  parent is a procedure or trigger is its body. A body only: a condition mutant roots every `if`,
 *  so a branch is never free in a default run. */
function isFreeShape(m: ComponentMember): boolean {
  const parent = m.statement.parent;
  return (
    m.spec.operatorName === "lethal.empty-block" &&
    parent !== null &&
    (isProcedureLike(parent) || parent.kind === ALNodeKind.trigger) &&
    !holdsDirective(m.statement)
  );
}

/**
 * Group specs whose resolved statements nest. Overlap between mutation sites is
 * always containment (spec §2: AST ranges are laminar), so a component is a
 * containment chain and its root is simply the widest statement in it.
 *
 * The root is what the printer rewrites; every member's edit is spliced into the
 * root's text, so members nested at any depth are handled uniformly.
 *
 * R827: an `empty-block` of a procedure or trigger body, whose block holds no directive and no other
 * member resolves to, is FREE. It gets a guard pair around the body (`planFile`) and hosts nothing,
 * so what sits inside it groups by this same walk. This is the one definition of free.
 */
export function buildComponents(ided: readonly IdedSpec[]): Component[] {
  const resolved: ComponentMember[] = ided.map((entry) => {
    const afterText = (entry.spec.after as unknown as { text?: string }).text ?? "";
    // R-307 O5: by span, E1 and E2 only; the mutated statement text is never built here.
    const statement = resolveStatement(entry.spec.before);
    return { mutantId: entry.mutantId, spec: entry.spec, statement, afterText };
  });

  // Widest statement first, so a chain's root is seen before anything it holds.
  const bySpan = [...resolved].sort((a, b) => {
    const start = a.statement.startIndex - b.statement.startIndex;
    if (start !== 0) return start;
    return b.statement.endIndex - a.statement.endIndex;
  });

  const spanKey = (n: ALSyntaxNode): string => `${n.startIndex}-${n.endIndex}`;
  const spans = new Map<string, number>();
  for (const m of resolved) {
    spans.set(spanKey(m.statement), (spans.get(spanKey(m.statement)) ?? 0) + 1);
  }

  interface Group {
    root: ALSyntaxNode;
    members: ComponentMember[];
    free?: true;
    /** A loop, or a root holding a directive: everything inside it joins its one flat chain. */
    flat: boolean;
    split?: true;
  }
  const groups: Group[] = [];
  const innermostHost = (root: ALSyntaxNode): Group | undefined => {
    let best: Group | undefined;
    for (const g of groups) {
      if (g.free === true || !contains(g.root, root)) continue;
      const size = g.root.endIndex - g.root.startIndex;
      if (best === undefined || size < best.root.endIndex - best.root.startIndex) best = g;
    }
    return best;
  };
  for (const m of bySpan) {
    const outer = groups.find((g) => g.free === true && contains(g.root, m.statement));
    let root = outer === undefined ? m.statement : rootInFreeBlock(m.statement, outer.root);
    for (;;) {
      const host = innermostHost(root);
      if (host === undefined || host.flat || sameSpan(host.root, root)) {
        // No host, or a flat one that takes everything inside it, or the root's own member.
        if (host !== undefined) host.members.push(m);
        else if (isFreeShape(m) && spans.get(spanKey(m.statement)) === 1) {
          groups.push({ root, members: [m], free: true, flat: false });
        } else groups.push({ root, members: [m], flat: isFlat(root) });
        break;
      }
      // R828 O1: inside a plain-copy root a mutant in a loop stays at the OUTERMOST loop within that
      // root, flat, so no `Active` runs on a pass of a loop that had none (R246). The host is the
      // block, as a free body is for the same rule.
      const lifted = rootInFreeBlock(root, host.root);
      if (!sameSpan(lifted, root)) {
        root = lifted;
        continue;
      }
      host.split = true;
      groups.push({ root, members: [m], flat: isFlat(root) });
      break;
    }
  }

  return groups.map((g) => ({
    root: g.root,
    members: [...g.members].sort(orderOutermostFirst),
    ...(g.free === true ? { free: true as const } : {}),
    ...(g.split === true ? { split: true as const } : {}),
  }));
}

function sameSpan(a: ALSyntaxNode, b: ALSyntaxNode): boolean {
  return a.startIndex === b.startIndex && a.endIndex === b.endIndex;
}

/** A loop keeps all it holds in one chain (R246), and so does a node holding a directive (R827). */
function isFlat(root: ALSyntaxNode): boolean {
  return LOOPS.has(root.rawKind) || holdsDirective(root);
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
  return compareCodeUnits(a.spec.operatorName, b.spec.operatorName);
}
