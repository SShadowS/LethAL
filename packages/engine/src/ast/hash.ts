import { blake3 } from "@noble/hashes/blake3";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils";
import { ALNodeKind } from "./node-kinds";
import type { ALSyntaxNode } from "./syntax-node";

export function astSubtreeHash(node: ALSyntaxNode): string {
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
  // `Rec.Delete` — the part after the dot, whether it is a method or a field.
  "member",
  // `Foo()` — an unqualified callee.
  "function",
]);

function serializeCanonical(node: ALSyntaxNode, scope: Map<string, number>): string {
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
