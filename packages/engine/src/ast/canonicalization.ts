/**
 * AST canonicalization — a small auditable ruleset for syntactic equivalence
 * detection (design §7). Each rule preserves semantics and maps an AST node
 * to a stable string representation. Two expressions that canonicalize to the
 * same `form` are considered equivalent-by-construction; used by the mutation
 * generator to dedupe uninteresting mutants.
 *
 * Rules currently applied:
 *   - strip redundant `parenthesized_expression` wrappers
 *   - collapse double negation: `not not X` -> `X`
 *   - sort operands of commutative binary operators into a stable order
 *
 * Grammar note: the SShadowS/tree-sitter-al grammar splits binary expressions
 * into four precedence classes (additive / multiplicative / comparison /
 * logical) rather than a single `binary_expression` kind. Operators are
 * exposed as named leaf nodes whose `kind` ends in `_operator`. We first
 * try tree-sitter field names (`operator`, `left`, `right`, `operand`); if
 * those aren't bound by the grammar, we fall back to scanning `namedChildren`.
 */

import type { ALSyntaxNode } from "./syntax-node";
import { ALNodeKind, isBinaryExpressionKind } from "./node-kinds";

export interface CanonicalForm {
  readonly form: string;
}

const COMMUTATIVE: ReadonlySet<string> = new Set([
  "+",
  "*",
  "=",
  "<>",
  "and",
  "or",
  "xor",
]);

export function canonicalize(node: ALSyntaxNode): CanonicalForm {
  return { form: canon(node) };
}

function canon(node: ALSyntaxNode): string {
  const stripped = stripParens(node);

  if (stripped.kind === ALNodeKind.unary_expression) {
    const operator = findOperator(stripped);
    const operand = findOperand(stripped);
    if (operator === "not" && operand !== null) {
      const inner = stripParens(operand);
      if (
        inner.kind === ALNodeKind.unary_expression &&
        findOperator(inner) === "not"
      ) {
        const innerOperand = findOperand(inner);
        if (innerOperand !== null) return canon(innerOperand);
      }
    }
    return `(unary ${operator ?? "?"} ${operand === null ? "" : canon(operand)})`;
  }

  if (isBinaryExpressionKind(stripped.kind)) {
    const operator = findOperator(stripped);
    const [left, right] = findBinaryOperands(stripped);
    if (left === null || right === null) {
      return `(binary ${operator ?? "?"})`;
    }
    const lc = canon(left);
    const rc = canon(right);
    if (operator !== null && COMMUTATIVE.has(operator)) {
      const [a, b] = lc <= rc ? [lc, rc] : [rc, lc];
      return `(binary ${operator} ${a} ${b})`;
    }
    return `(binary ${operator ?? "?"} ${lc} ${rc})`;
  }

  return `(${stripped.kind} ${stripped.text.trim()})`;
}

function stripParens(node: ALSyntaxNode): ALSyntaxNode {
  let current = node;
  while (
    current.kind === ALNodeKind.parenthesized_expression &&
    current.namedChildren.length === 1
  ) {
    const inner = current.namedChildren[0];
    if (inner === undefined) break;
    current = inner;
  }
  return current;
}

function findOperator(node: ALSyntaxNode): string | null {
  const field = node.childForFieldName("operator");
  if (field !== null) return field.text;
  for (const c of node.namedChildren) {
    if (c.kind.endsWith("_operator")) return c.text;
  }
  return null;
}

function findOperand(node: ALSyntaxNode): ALSyntaxNode | null {
  const field = node.childForFieldName("operand");
  if (field !== null) return field;
  for (const c of node.namedChildren) {
    if (!c.kind.endsWith("_operator")) return c;
  }
  return null;
}

function findBinaryOperands(
  node: ALSyntaxNode,
): readonly [ALSyntaxNode | null, ALSyntaxNode | null] {
  const left = node.childForFieldName("left");
  const right = node.childForFieldName("right");
  if (left !== null && right !== null) return [left, right];
  const nonOperatorChildren = node.namedChildren.filter(
    (c) => !c.kind.endsWith("_operator"),
  );
  return [nonOperatorChildren[0] ?? null, nonOperatorChildren[1] ?? null];
}
