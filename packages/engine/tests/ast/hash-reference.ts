// TEST-SIDE REFERENCE, never imported by product code (RUST-03 S4.2d, AMENDMENT 8 Guard 2).
// The body below is `packages/engine/src/ast/hash.ts` VERBATIM as of e71e809f, before the
// single-pass rewrite. Only three things differ: this comment, the import paths (moved from
// "./x" to "../../src/ast/x"), and two export names (`astSubtreeHash` is exported as
// `referenceAstSubtreeHash`, and `serializeCanonical` is exported so a test can read the
// canonical string the reference hashes). The code is verbatim; in two comments an em dash is
// replaced by a colon, per the repo's no-em-dash rule.
import { blake3 } from "@noble/hashes/blake3";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils";
import { ALNodeKind } from "../../src/ast/node-kinds";
import type { ALSyntaxNode } from "../../src/ast/syntax-node";

export function referenceAstSubtreeHash(node: ALSyntaxNode): string {
  const scope = new Map<string, number>();
  const canonical = serializeCanonical(node, scope);
  return bytesToHex(blake3(utf8ToBytes(canonical)));
}

/**
 * Field names on the two node shapes where an identifier is a NAME rather than a variable.
 *
 * R166. Every identifier used to become a positional id, which is right for a local variable and
 * wrong for a method or field name: `DataMain.Delete(false)`, `DataMain.Insert(false)` and
 * `DataMain.Modify(false)` all serialised as `id0.id1(false)` and hashed IDENTICALLY, so three
 * different mutations shared one identity. Measured on the gift card demo, the three guard clauses
 * `Error(CardBlockedErr, CardNo)`, `Error(CardExpiredErr, CardNo)` and
 * `Error(InsufficientBalanceErr, CardNo)` collapsed the same way, and their three mutants are killed
 * by three DIFFERENT tests.
 *
 * `design.md` §5.1 calls the identity key's inputs "local variable names canonicalized to positional
 * ids" and says the hash "changes when the expression's structure or operators change". A method
 * name is neither a local variable nor structure, so erasing it was outside what the rule promised.
 *
 * The narrowing keeps the property the canonicalisation exists for: an identifier in VARIABLE
 * position is still positional, so a local rename still leaves the hash alone. Only these two
 * positions keep their text.
 */
const NAME_POSITION_FIELDS: ReadonlySet<string> = new Set([
  // `Rec.Delete`: the part after the dot, whether it is a method or a field.
  "member",
  // `Foo()`: an unqualified callee.
  "function",
]);

export function serializeCanonical(node: ALSyntaxNode, scope: Map<string, number>): string {
  if (node.kind === ALNodeKind.identifier) {
    // R166: a NAME keeps its text; a variable keeps its positional id.
    if (node.fieldName !== null && NAME_POSITION_FIELDS.has(node.fieldName)) {
      return `(name ${node.text})`;
    }
    const text = node.text;
    if (!scope.has(text)) {
      scope.set(text, scope.size);
    }
    return `(identifier #${scope.get(text)})`;
  }

  if (isLiteral(node.kind)) {
    return `(${node.kind} ${node.text})`;
  }

  // Leaf named nodes (no named children) carry their terminal text as part of
  // their identity. In this grammar, operator tokens like `comparison_operator`
  // are named-but-leaf nodes whose `text` is the actual operator (`>` vs `>=`),
  // and must participate in the hash so that an operator swap changes the hash.
  if (node.namedChildren.length === 0) {
    return `(${node.kind} ${node.text})`;
  }

  const parts: string[] = [`(${node.kind}`];
  for (const child of node.namedChildren) {
    parts.push(" ");
    parts.push(serializeCanonical(child, scope));
  }
  parts.push(")");
  return parts.join("");
}

function isLiteral(kind: string): boolean {
  return (
    kind === ALNodeKind.integer_literal ||
    kind === ALNodeKind.decimal_literal ||
    kind === ALNodeKind.text_literal ||
    kind === ALNodeKind.boolean_literal
  );
}

// ---------------------------------------------------------------------------------------------
// Not part of the verbatim copy: a test-side forwarding wrapper. `mirror(node)` implements
// `ALSyntaxNode` by reading every member through `node`, and wraps each child it hands out, so a
// hash over it never sees a native `FlatNode` and always takes the GENERIC path. Like the product
// wrappers, it builds fresh children on every read.
class Mirror implements ALSyntaxNode {
  constructor(
    private readonly inner: ALSyntaxNode,
    readonly parent: ALSyntaxNode | null,
  ) {}
  get kind() {
    return this.inner.kind;
  }
  get rawKind() {
    return this.inner.rawKind;
  }
  get text() {
    return this.inner.text;
  }
  get startIndex() {
    return this.inner.startIndex;
  }
  get endIndex() {
    return this.inner.endIndex;
  }
  get startPosition() {
    return this.inner.startPosition;
  }
  get endPosition() {
    return this.inner.endPosition;
  }
  get children(): readonly ALSyntaxNode[] {
    return this.inner.children.map((c) => new Mirror(c, this));
  }
  get namedChildren(): readonly ALSyntaxNode[] {
    return this.inner.namedChildren.map((c) => new Mirror(c, this));
  }
  get fieldName() {
    return this.inner.fieldName;
  }
  get isMissing() {
    return this.inner.isMissing;
  }
  get hasError() {
    return this.inner.hasError;
  }
  childForFieldName(name: string): ALSyntaxNode | null {
    const c = this.inner.childForFieldName(name);
    return c === null ? null : new Mirror(c, this);
  }
}

export function mirror(node: ALSyntaxNode): ALSyntaxNode {
  return new Mirror(node, node.parent);
}
