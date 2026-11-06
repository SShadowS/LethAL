import type { ALSyntaxNode, MutationSpec } from "@lethal/engine";
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
  /** Outermost resolved statement — the node the printer rewrites. */
  readonly root: ALSyntaxNode;
  /** Ordered: outermost mutation first, then by startIndex, then operatorName. */
  readonly members: readonly ComponentMember[];
  /** R827: a free `empty-block`: its one member guards `root`, a block, with no chain and no copy. */
  readonly free?: true;
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
    n.rawKind.startsWith("preproc_") || n.rawKind === "ERROR" || n.children.some(holdsDirective)
  );
}

/** R827: does this member's own shape allow a guard? Chain roots and equal spans are the walk's. */
function isFreeShape(m: ComponentMember): boolean {
  const { before, operatorName } = m.spec;
  return (
    operatorName === "lethal.empty-block" &&
    /^begin\s+end;?$/i.test(m.afterText.trim()) &&
    m.statement.rawKind === "code_block" &&
    before.startIndex === m.statement.startIndex &&
    before.endIndex === m.statement.endIndex &&
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
 * R827: an `empty-block` no chain root contains, whose block holds no directive and no other member
 * resolves to, is FREE. It gets a guard pair around the block's body (`planFile`) and hosts nothing,
 * so what sits inside it groups by this same walk. This is the one definition of free.
 */
export function buildComponents(ided: readonly IdedSpec[]): Component[] {
  const resolved: ComponentMember[] = ided.map((entry) => {
    const afterText = (entry.spec.after as unknown as { text?: string }).text ?? "";
    // R-307 O5: by span, E1 and E2 only; the mutated statement text is never built here.
    const statement = resolveStatement(entry.spec.before);
    return { mutantId: entry.mutantId, spec: entry.spec, statement, afterText };
  });

  // Widest statement first, so the first member of a chain is always its root.
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

  const groups: Array<{ root: ALSyntaxNode; members: ComponentMember[]; free?: true }> = [];
  for (const m of bySpan) {
    const outer = groups.find((g) => g.free === true && contains(g.root, m.statement));
    const root = outer === undefined ? m.statement : rootInFreeBlock(m.statement, outer.root);
    const host = groups.find((g) => g.free !== true && contains(g.root, root));
    if (host !== undefined) host.members.push(m);
    else if (root === m.statement && isFreeShape(m) && spans.get(spanKey(m.statement)) === 1) {
      groups.push({ root, members: [m], free: true });
    } else groups.push({ root, members: [m] });
  }

  return groups.map((g) => ({
    root: g.root,
    members: [...g.members].sort(orderOutermostFirst),
    ...(g.free === true ? { free: true as const } : {}),
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
  return compareCodeUnits(a.spec.operatorName, b.spec.operatorName);
}
