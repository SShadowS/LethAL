import type { ALNodeKind } from "./node-kinds";

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
/** This child is what tree-sitter's `child_by_field_id` on its parent returns for its field. The
 *  lookup is not a scan of field names: on an ERROR node it misses fields a hidden child supplies. */
export const FLAG_FIELD_TARGET = 16;

function at<T>(arr: ArrayLike<T>, i: number, what: string): T {
  const v = arr[i];
  if (v === undefined) throw new Error(`flat tree: ${what}[${i}] is out of range`);
  return v;
}

/** An ALSyntaxNode over a native flat tree. Same semantics as the WASM WrappedNode: fresh wrappers
 *  on every children read, no caching. */
class FlatNode implements ALSyntaxNode {
  constructor(
    private readonly p: ParsedAL,
    private readonly i: number,
    readonly parent: ALSyntaxNode | null,
    readonly fieldName: string | null,
  ) {}

  get rawKind(): string {
    return at(this.p.flat.kindNames, at(this.p.flat.kind, this.i, "kind"), "kindNames");
  }
  // Unknown raw kinds (anonymous tokens) are surfaced as-is, exactly as WrappedNode did.
  get kind(): ALNodeKind {
    return this.rawKind as ALNodeKind;
  }
  get text(): string {
    return this.p.source.slice(this.startIndex, this.endIndex);
  }
  get startIndex(): number {
    return at(this.p.flat.startIndex, this.i, "startIndex");
  }
  get endIndex(): number {
    return at(this.p.flat.endIndex, this.i, "endIndex");
  }
  get startPosition(): { readonly row: number; readonly column: number } {
    const pt = this.p.flat.points;
    return { row: at(pt, 4 * this.i, "points"), column: at(pt, 4 * this.i + 1, "points") };
  }
  get endPosition(): { readonly row: number; readonly column: number } {
    const pt = this.p.flat.points;
    return { row: at(pt, 4 * this.i + 2, "points"), column: at(pt, 4 * this.i + 3, "points") };
  }
  get isMissing(): boolean {
    return (at(this.p.flat.flags, this.i, "flags") & FLAG_MISSING) !== 0;
  }
  get hasError(): boolean {
    return (at(this.p.flat.flags, this.i, "flags") & FLAG_HAS_ERROR) !== 0;
  }
  get children(): readonly ALSyntaxNode[] {
    return this.childNodes(false);
  }
  // No-op setters, as on WrappedNode: a runtime assignment is ignored rather than throwing.
  set children(_: readonly ALSyntaxNode[]) {
    /* readonly, ignored */
  }
  get namedChildren(): readonly ALSyntaxNode[] {
    return this.childNodes(true);
  }
  set namedChildren(_: readonly ALSyntaxNode[]) {
    /* readonly, ignored */
  }
  childForFieldName(name: string): ALSyntaxNode | null {
    const f = this.p.flat;
    for (let c = this.firstChild(); c !== -1; c = at(f.nextSibling, c, "nextSibling")) {
      if (this.fieldOf(c) === name && (at(f.flags, c, "flags") & FLAG_FIELD_TARGET) !== 0)
        return new FlatNode(this.p, c, this, name);
    }
    return null;
  }
  private firstChild(): number {
    return at(this.p.flat.childCount, this.i, "childCount") > 0 ? this.i + 1 : -1;
  }
  private fieldOf(c: number): string | null {
    const id = at(this.p.flat.field, c, "field");
    return id === 0 ? null : at(this.p.flat.fieldNames, id, "fieldNames");
  }
  private childNodes(namedOnly: boolean): ALSyntaxNode[] {
    const f = this.p.flat;
    const out: ALSyntaxNode[] = [];
    for (let c = this.firstChild(); c !== -1; c = at(f.nextSibling, c, "nextSibling")) {
      if (namedOnly && (at(f.flags, c, "flags") & FLAG_NAMED) === 0) continue;
      out.push(new FlatNode(this.p, c, this, this.fieldOf(c)));
    }
    return out;
  }
}

/** A spec's `after` node: `before` with its text replaced. Every other member reads through
 *  `before` on demand, so the spec keeps one wrapper (`before`) and pins no child arrays, position
 *  objects or bound closure (RUST-03 S4.2c). */
class TextOverride implements ALSyntaxNode {
  constructor(
    private readonly before: ALSyntaxNode,
    readonly text: string,
  ) {}
  get kind(): ALNodeKind {
    return this.before.kind;
  }
  get rawKind(): string {
    return this.before.rawKind;
  }
  get startIndex(): number {
    return this.before.startIndex;
  }
  get endIndex(): number {
    return this.before.endIndex;
  }
  get startPosition(): { readonly row: number; readonly column: number } {
    return this.before.startPosition;
  }
  get endPosition(): { readonly row: number; readonly column: number } {
    return this.before.endPosition;
  }
  get parent(): ALSyntaxNode | null {
    return this.before.parent;
  }
  get children(): readonly ALSyntaxNode[] {
    return this.before.children;
  }
  get namedChildren(): readonly ALSyntaxNode[] {
    return this.before.namedChildren;
  }
  get fieldName(): string | null {
    return this.before.fieldName;
  }
  get isMissing(): boolean {
    return this.before.isMissing;
  }
  get hasError(): boolean {
    return this.before.hasError;
  }
  childForFieldName(name: string): ALSyntaxNode | null {
    return this.before.childForFieldName(name);
  }
}

/** `before` with only its text replaced: what an operator's `after` node is. */
export function withText(before: ALSyntaxNode, text: string): ALSyntaxNode {
  return new TextOverride(before, text);
}

export function wrapFlatRoot(parsed: ParsedAL): ALSyntaxNode {
  return new FlatNode(parsed, 0, null, null);
}

// The engine's wrapper since RUST-03: the native flat tree (wrapWasmRoot is reference only).
export const wrapRoot = wrapFlatRoot;

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
