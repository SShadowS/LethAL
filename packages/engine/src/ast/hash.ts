import { blake3 } from "@noble/hashes/blake3";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils";
import { ALNodeKind } from "./node-kinds";
import type { ALSyntaxNode } from "./syntax-node";

export function astSubtreeHash(node: ALSyntaxNode): string {
  const scope = new Map<string, number>();
  const canonical = serializeCanonical(node, scope);
  return bytesToHex(blake3(utf8ToBytes(canonical)));
}

function serializeCanonical(node: ALSyntaxNode, scope: Map<string, number>): string {
  if (node.kind === ALNodeKind.identifier) {
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
