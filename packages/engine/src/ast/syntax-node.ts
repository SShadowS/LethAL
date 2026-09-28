import type { ALNodeKind } from "./node-kinds";

// Backed by the WASM reference until the RUST-03 switch (S3.4).
export { wrapWasmRoot as wrapRoot } from "./parser-wasm";

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
  /** A node the parser inserted for a missing token (web-tree-sitter `isMissing`). */
  readonly isMissing: boolean;
  /** This node or a descendant is ERROR or MISSING (web-tree-sitter `hasError`). */
  readonly hasError: boolean;
  childForFieldName(name: string): ALSyntaxNode | null;
}

/** One file's tree as the native addon returns it. Preorder; the first child is at index + 1. */
export interface FlatTree {
  readonly kindNames: readonly string[];
  readonly kind: Uint16Array;
  readonly fieldNames: readonly string[];
  readonly field: Uint16Array;
  readonly flags: Uint8Array;
  readonly childCount: Uint32Array;
  readonly nextSibling: Int32Array;
  readonly startIndex: Uint32Array;
  readonly endIndex: Uint32Array;
  readonly points: Uint32Array;
}

export interface ParsedAL {
  readonly source: string;
  readonly flat: FlatTree;
}

export const FLAG_NAMED = 1;
export const FLAG_MISSING = 2;
export const FLAG_HAS_ERROR = 4;
export const FLAG_EXTRA = 8;

export function findFirst(root: ALSyntaxNode, kind: ALNodeKind): ALSyntaxNode | null {
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

export function visit(root: ALSyntaxNode, fn: (node: ALSyntaxNode) => void): void {
  fn(root);
  for (const child of root.children) {
    visit(child, fn);
  }
}
