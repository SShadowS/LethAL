/**
 * How the AL compiler's own syntax kinds correspond to tree-sitter-al's, for the one-off audit
 * proposed in GitHub issue #6.
 *
 * **This table is the part of the audit that can lie.** The plumbing either runs or does not; a
 * wrong entry here manufactures a finding. Map a compiler kind to the wrong tree-sitter kind and the
 * diff reports a blind spot that is really a naming difference, or hides a real one behind a
 * coincidence. So it is declarative, it is validated against a fixture whose per-kind counts are
 * known by construction (`scripts/probe-grammar-crosscheck.ts`), and it is deliberately SMALL: only
 * the six families the issue names, which are the ones LethAL's operators target.
 *
 * The correspondence is MANY-TO-ONE by nature. The compiler bakes the operator into the node kind
 * (`GreaterThanExpression`), while tree-sitter keeps one kind and carries the operator as a child
 * (`comparison_expression` with a `comparison_operator`). Measured on the fixture, both parsers
 * counted 6 / 2 / 4 / 2 / 2 / 2 across the six families, which is what makes the table checkable
 * rather than asserted.
 *
 * Verified against `Microsoft.Dynamics.Nav.CodeAnalysis` v18.0.40.47373, the parser shipped in AL
 * Language extension 18.0.2668733.
 */
export const COMPILER_TO_TREE_SITTER: ReadonlyMap<string, string> = new Map([
  // Comparison. AL's six relational operators, one compiler kind each.
  ["GreaterThanExpression", "comparison_expression"],
  ["GreaterThanOrEqualExpression", "comparison_expression"],
  ["LessThanExpression", "comparison_expression"],
  ["LessThanOrEqualExpression", "comparison_expression"],
  ["EqualsExpression", "comparison_expression"],
  ["NotEqualsExpression", "comparison_expression"],

  // Additive.
  ["AddExpression", "additive_expression"],
  ["SubtractExpression", "additive_expression"],

  // Multiplicative. `DIV` and `MOD` are AL's integer division and modulo, and the compiler gives
  // each its own kind rather than folding them into Divide.
  ["MultiplyExpression", "multiplicative_expression"],
  ["DivideExpression", "multiplicative_expression"],
  ["IntegerDivideExpression", "multiplicative_expression"],
  ["ModuloExpression", "multiplicative_expression"],

  // Logical.
  ["LogicalAndExpression", "logical_expression"],
  ["LogicalOrExpression", "logical_expression"],

  // Unary. `not` and arithmetic negation; tree-sitter carries both as one kind.
  ["UnaryNotExpression", "unary_expression"],
  ["UnaryMinusExpression", "unary_expression"],

  // Calls.
  ["InvocationExpression", "call_expression"],
]);

/** The tree-sitter kinds this audit compares, derived from the table so the two cannot drift. */
export const AUDITED_TREE_SITTER_KINDS: ReadonlySet<string> = new Set(
  COMPILER_TO_TREE_SITTER.values(),
);

/**
 * Kinds deliberately NOT mapped, with the reason, so an absence here is a decision rather than an
 * oversight. Read by no code: it exists to be read by a person extending the table.
 *
 * - `MemberAccessExpression` / `member_expression`: both parsers agree on it and LethAL does target
 *   it, but it is not one of the six families the issue scopes, and adding families widens the audit
 *   past what a one-off can validate.
 * - `AssignmentStatement`, `IfStatement`, `ExitStatement`: agreed on the fixture (16 / 9 / 1 both
 *   ways) and worth adding if the audit is ever widened, but they are statements rather than the
 *   expression sites the operators claim.
 * - Literals: the compiler splits by type (`Int32SignedLiteralValue` inside `LiteralExpression`)
 *   where tree-sitter names the literal directly. Mappable, but the nesting differs enough that it
 *   needs its own validation rather than a line in this table.
 */
export const DELIBERATELY_UNMAPPED = [
  "MemberAccessExpression",
  "AssignmentStatement",
  "IfStatement",
  "ExitStatement",
  "LiteralExpression",
] as const;
