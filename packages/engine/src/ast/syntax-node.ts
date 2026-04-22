import type { Tree, Node as TSSyntaxNode } from "web-tree-sitter";
import { type ALNodeKind, isALNodeKind } from "./node-kinds";

export interface ALSyntaxNode {
  readonly kind: ALNodeKind;
  readonly rawKind: string;
  readonly text: string;
  readonly startIndex: number;
  readonly endIndex: number;
  readonly startPosition: { readonly row: number; readonly column: number };
  readonly endPosition: { readonly row: number; readonly column: number };
  readonly parent: ALSyntaxNode | null;
  readonly children: readonly ALSyntaxNode[];
  readonly namedChildren: readonly ALSyntaxNode[];
  readonly fieldName: string | null;
  childForFieldName(name: string): ALSyntaxNode | null;
}

class WrappedNode implements ALSyntaxNode {
  constructor(
    private readonly ts: TSSyntaxNode,
    private readonly parentNode: ALSyntaxNode | null,
    readonly fieldName: string | null,
  ) {}

  get kind(): ALNodeKind {
    if (!isALNodeKind(this.ts.type)) {
      // Unknown raw kinds (e.g. anonymous tokens) are surfaced via `rawKind`.
      // We still cast for the interface contract; consumers should branch on
      // `isALNodeKind(node.rawKind)` when working with arbitrary nodes.
      return this.ts.type as ALNodeKind;
    }
    return this.ts.type;
  }

  get rawKind(): string {
    return this.ts.type;
  }
  get text(): string {
    return this.ts.text;
  }
  get startIndex(): number {
    return this.ts.startIndex;
  }
  get endIndex(): number {
    return this.ts.endIndex;
  }
  get startPosition(): { readonly row: number; readonly column: number } {
    return this.ts.startPosition;
  }
  get endPosition(): { readonly row: number; readonly column: number } {
    return this.ts.endPosition;
  }
  get parent(): ALSyntaxNode | null {
    return this.parentNode;
  }

  get children(): readonly ALSyntaxNode[] {
    // web-tree-sitter 0.25.x types `children` as `(Node | null)[]`. In practice
    // entries are non-null for rootNode's descendants, but we defensively
    // filter and preserve the original index so `fieldNameForChild` is correct.
    const raw = this.ts.children;
    const out: ALSyntaxNode[] = [];
    for (let i = 0; i < raw.length; i++) {
      const c = raw[i];
      if (c === null || c === undefined) continue;
      out.push(
        new WrappedNode(c, this, this.ts.fieldNameForChild(i) ?? null),
      );
    }
    return out;
  }
  // No-op setter so that ill-typed runtime assignments to this readonly
  // accessor are silently ignored rather than throwing TypeError in strict
  // mode. TypeScript still enforces `readonly` at compile time via the
  // `ALSyntaxNode` interface.
  set children(_: readonly ALSyntaxNode[]) {
    /* readonly — ignored */
  }

  get namedChildren(): readonly ALSyntaxNode[] {
    const raw = this.ts.namedChildren;
    const out: ALSyntaxNode[] = [];
    for (let i = 0; i < raw.length; i++) {
      const c = raw[i];
      if (c === null || c === undefined) continue;
      out.push(
        new WrappedNode(c, this, this.ts.fieldNameForNamedChild(i) ?? null),
      );
    }
    return out;
  }
  set namedChildren(_: readonly ALSyntaxNode[]) {
    /* readonly — ignored */
  }

  childForFieldName(name: string): ALSyntaxNode | null {
    const child = this.ts.childForFieldName(name);
    return child === null ? null : new WrappedNode(child, this, name);
  }
}

export function wrapRoot(tree: Tree): ALSyntaxNode {
  return new WrappedNode(tree.rootNode, null, null);
}

export function findFirst(
  root: ALSyntaxNode,
  kind: ALNodeKind,
): ALSyntaxNode | null {
  if (root.kind === kind) return root;
  for (const child of root.children) {
    const hit = findFirst(child, kind);
    if (hit !== null) return hit;
  }
  return null;
}

export function findAll(root: ALSyntaxNode, kind: ALNodeKind): ALSyntaxNode[] {
  const out: ALSyntaxNode[] = [];
  visit(root, (n) => {
    if (n.kind === kind) out.push(n);
  });
  return out;
}

export function visit(
  root: ALSyntaxNode,
  fn: (node: ALSyntaxNode) => void,
): void {
  fn(root);
  for (const child of root.children) {
    visit(child, fn);
  }
}
