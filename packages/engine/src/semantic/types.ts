import { ALNodeKind, isBinaryExpressionKind } from "../ast/node-kinds";
/**
 * Type table (Layer 1).
 *
 * Answers "what is the AL type of this expression?" for a minimal set of
 * node kinds: literals, identifiers (resolved via the symbol table), and
 * binary/unary expressions over built-in types.
 *
 * Grammar adjustments (SShadowS/tree-sitter-al v3.0.1):
 *   - There is no single `binary_expression` kind; binary ops are split
 *     across four precedence classes. We dispatch on `isBinaryExpressionKind`.
 *   - Operators are named leaf children (e.g. `comparison_operator`). We
 *     prefer the `operator` field when present and fall back to searching
 *     for a namedChild whose kind ends in `_operator`.
 *   - Literal kinds are `integer`, `decimal`, `string_literal`, `boolean`
 *     (mapped via ALNodeKind.integer_literal etc.).
 */
import type { ALSyntaxNode } from "../ast/syntax-node";
import { enclosingObjectScopeKey } from "./symbol-table";
import type { SourceFile, SymbolTable } from "./symbol-table";

export interface TypeTable {
  typeOf(node: ALSyntaxNode): string | null;
}

export function buildTypeTable(_files: readonly SourceFile[], symbols: SymbolTable): TypeTable {
  return {
    typeOf(node) {
      return computeType(node, symbols);
    },
  };
}

function computeType(node: ALSyntaxNode, symbols: SymbolTable): string | null {
  if (isBinaryExpressionKind(node.kind)) {
    return binaryType(node, symbols);
  }
  switch (node.kind) {
    case ALNodeKind.integer_literal:
      return "Integer";
    case ALNodeKind.decimal_literal:
      return "Decimal";
    case ALNodeKind.text_literal:
      return "Text";
    case ALNodeKind.boolean_literal:
      return "Boolean";
    case ALNodeKind.parenthesized_expression: {
      const inner = node.namedChildren[0];
      return inner === undefined ? null : computeType(inner, symbols);
    }
    case ALNodeKind.unary_expression: {
      const operand = findUnaryOperand(node);
      if (operand === null) return null;
      const op = findOperator(node);
      if (op === "not") return "Boolean";
      if (op === "-" || op === "+") return computeType(operand, symbols);
      return computeType(operand, symbols);
    }
    case ALNodeKind.identifier:
      return resolveIdentifierType(node, symbols);
    default:
      return null;
  }
}

function binaryType(node: ALSyntaxNode, symbols: SymbolTable): string | null {
  const op = findOperator(node) ?? "";
  const [left, right] = findBinaryOperands(node);
  if (left === null || right === null) return null;

  const comparison = new Set(["<", "<=", ">", ">=", "=", "<>"]);
  const logical = new Set(["and", "or", "xor"]);
  if (comparison.has(op) || logical.has(op)) return "Boolean";

  const leftType = computeType(left, symbols);
  const rightType = computeType(right, symbols);
  if (leftType === null || rightType === null) return null;
  if (leftType === rightType) return leftType;
  if (
    (leftType === "Integer" && rightType === "Decimal") ||
    (leftType === "Decimal" && rightType === "Integer")
  ) {
    return "Decimal";
  }
  return leftType;
}

function findOperator(node: ALSyntaxNode): string | null {
  const field = node.childForFieldName("operator");
  if (field !== null) return field.text;
  for (const c of node.namedChildren) {
    if (c.kind.endsWith("_operator")) return c.text;
  }
  return null;
}

function findUnaryOperand(node: ALSyntaxNode): ALSyntaxNode | null {
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
  const nonOperatorChildren = node.namedChildren.filter((c) => !c.kind.endsWith("_operator"));
  return [nonOperatorChildren[0] ?? null, nonOperatorChildren[1] ?? null];
}

/**
 * The declared type of an identifier, resolved in the scope the identifier ACTUALLY sits in.
 *
 * R87. This used to iterate `symbols.objects` and, for each, call
 * `findEnclosingProcedure(node, obj.node)` — a walk up from the identifier that stopped at either a
 * `procedure` or `obj.node`. The identifier's own enclosing procedure is always reached first, so
 * the `current !== objectNode` guard gated nothing and every object answered with the SAME
 * procedure name. The loop therefore resolved against whichever object declared a procedure of that
 * name FIRST IN PARSE ORDER, and then `return null`ed rather than trying the rest.
 *
 * Both halves were measured on `do-rel2/Cloud` (244 objects, 1,793 distinct procedure names, 184 of
 * them declared by more than one object — the precondition is ordinary):
 *
 *   - WRONG TYPE: 27 of 390 claimed sites were typed by an object other than the one declaring the
 *     enclosing procedure. Zero were wrong on that project, by luck of naming rather than by
 *     construction — a two-codeunit counterexample makes `swap-call-arguments` claim a site it
 *     must refuse and emit AL that `alc` 18.0 rejects with `AL0133: cannot convert from
 *     'Record "Data Related"' to 'Record "Data Main"'`, i.e. a whole-project compile failure after
 *     the expensive part of a run.
 *   - LOST SITES: 73 of 463 candidates (15.8%), from the `return null` that gave up after a
 *     first name match in an object that did not declare the identifier.
 *
 * Now it asks one question — which declaration is this identifier inside? — and resolves there.
 * A node has exactly one enclosing declaration, so there is nothing to iterate and no order to
 * depend on.
 */
function resolveIdentifierType(node: ALSyntaxNode, symbols: SymbolTable): string | null {
  const scope = enclosingObjectScopeKey(node);
  if (scope === null) return null;
  const proc = findEnclosingProcedure(node);
  // A member-level declaration wins over an object-level one, which is AL's own shadowing rule:
  // a procedure's local or parameter hides a global of the same name.
  if (proc !== null) {
    const procSym = symbols.resolveProcedure(scope, proc);
    if (procSym !== null) {
      const local = procSym.locals.find((v) => v.name === node.text);
      if (local !== undefined) return extractType(local.typeText);
      const param = procSym.parameters.find((p) => p.name === node.text);
      if (param !== undefined) return extractType(param.typeText);
    }
  }
  // Falling through to globals is deliberate, and it is a second R87 fix rather than a tidy-up:
  // the old code reached globals only on the object it had already (mis)chosen, so an identifier
  // referring to a global inside a procedure that a DIFFERENT object also declares resolved
  // against the wrong object's globals or not at all. Here the scope is the identifier's own by
  // construction, so this is the same object either way.
  const global = symbols.globalsOf(scope).find((g) => g.name === node.text);
  if (global !== undefined) return extractType(global.typeText);
  return null;
}

/** The name of the `procedure` a node sits inside, or `null` at object level (a trigger body, a
 *  field declaration). Takes no object node: R87's whole point is that the enclosing procedure is
 *  a property of the NODE, not of whichever object a caller happened to be iterating. */
function findEnclosingProcedure(node: ALSyntaxNode): string | null {
  let current: ALSyntaxNode | null = node;
  while (current !== null) {
    if (current.kind === ALNodeKind.procedure) {
      return current.childForFieldName("name")?.text ?? null;
    }
    current = current.parent;
  }
  return null;
}

/**
 * The type identity of a declaration — the WHOLE declared type, not its first token (R84).
 *
 * This function used to keep only the first whitespace-delimited token, so `Record "Sales Header"`
 * and `Record "Purchase Header"` both answered `Record`, as did two different `Codeunit`s, two
 * `List of [...]`s, two `Option`s and two `Enum`s. MEASURED on Continia Document Output while
 * counting R82 (`scripts/census-swap-call-arguments.ts`): of 893 call sites whose two arguments the
 * truncated head called same-typed, **135 (15.1%) are not** — 118 `Record`, 9 `Codeunit`, 4 `List`,
 * 2 `Option`, 2 `Enum`. An operator that trusted the head would emit an artifact that does not
 * compile, and the failure would arrive as an `AlcCompileError` on a whole project, i.e. after the
 * expensive part.
 *
 * Two things the grammar already gets right, so they need no handling here: the declaration's
 * `type` field carries the full text (`Record "Data Main"`), and a `Label` declaration's `type`
 * field is the bare word `Label` — its constant lives in a sibling `string_literal`. So two labels
 * with different text compare EQUAL, which is correct: they are the same type.
 *
 * `Code[20]` and `Code[10]` stay DISTINCT, and that is deliberate rather than incidental. It
 * refuses some swaps that would compile, and the conservative direction is the right one: a
 * `Code[20]` value moved into a `Code[10]` position compiles and then fails at RUNTIME on a length
 * overflow, which for a mutation operator is a kill nobody's assertion earned.
 */
function extractType(typeText: string): string {
  return typeText.replace(/\s+/g, " ").trim();
}
