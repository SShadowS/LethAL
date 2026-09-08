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
 * oversight.
 *
 * READ BY THE HARNESS. A compiler kind that is neither mapped nor listed here is reported as an
 * unruled kind, so the mapping's incompleteness is visible instead of silent. That is why this is a
 * Set rather than a comment: an entry here is a decision someone made, and anything outside both
 * lists is a decision nobody has made yet.
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
export const DELIBERATELY_UNMAPPED: ReadonlySet<string> = new Set([
  "MemberAccessExpression",
  "AssignmentStatement",
  "IfStatement",
  "ExitStatement",
  "LiteralExpression",
  // `(A > 0) and (A < 100)`. tree-sitter has `parenthesized_expression` too, so this is mappable,
  // but parentheses change tree SHAPE on both sides and a span comparison across them needs its own
  // validation rather than a line here.
  "ParenthesizedExpression",
  // `V::First`, enum and option access. Not one of the six families, and tree-sitter spells it
  // differently enough that mapping it is a decision rather than a rename.
  "OptionAccessExpression",
  // `TableRelation = Customer."No." where(Blocked = const(false))`. The compiler models a table
  // relation's filter as an expression; it is a DECLARATIVE surface, which R135 refuses as a
  // mutation site and R144 pins the refusal for, so there is nothing here for this audit to
  // compare. Found by the unruled-kind channel on `fixtures/sandbox-data`, which is what that
  // channel is for: before it, both were silently discarded.
  "TableFilterExpression",
  "WhereExpression",
  // `field("No.")` inside a table relation. Same declarative surface as the two above.
  "SimpleFieldExpression",
  // `X in [1, 2, 3]`. A REAL executable expression and the one entry here that is a deferral rather
  // than a refusal. It is not one of the six families the issue scopes, and it has history: [[R171]]
  // is precisely the case where `remove-not` ceded `not (X in [...])` to `negate-conditional`, which
  // does not claim `in_expression`, so neither reached it. Worth auditing if this widens; listed
  // here so that is a choice on record rather than a silent drop.
  "InListExpression",
]);

/**
 * CONTEXT probes: properties an operator's `targets()` predicate consults, which a node-kind
 * comparison cannot see.
 *
 * This exists because the kind comparison is structurally blind to the failure this repository has
 * actually suffered. `packages/engine/vendor/README.md` records a grammar upgrade that inserted
 * `statement_block` containers: every `call_expression` node still existed and still sat at the same
 * offset, so a kind-and-position audit would have reported perfect agreement, while statement
 * position call sites went from 703,239 to ZERO because `void-method-call` depends on parent shape.
 *
 * So each probe names one boolean question and how BOTH parsers answer it in their own idiom. That
 * is deliberately not a structural alignment of two vocabularies: `statement_block` has no compiler
 * counterpart, and trying to map parent kinds would be a mapping burden with no ceiling. Comparing
 * the ANSWER is what the operators actually depend on.
 */
export interface ContextProbe {
  /** What is being compared, used in the report. */
  readonly name: string;
  /** The tree-sitter kind whose sites this probe narrows. */
  readonly treeSitterKind: string;
  /** The compiler kind whose sites this probe narrows. */
  readonly compilerKind: string;
  /** The compiler-side answer: the parent kind that means "yes" for this question. */
  readonly compilerParentKind: string;
}

export const CONTEXT_PROBES: readonly ContextProbe[] = [
  {
    // `void-method-call` and `remove-assignment` both gate on `isStatementSlot`. The compiler wraps
    // a call used as a statement in `ExpressionStatement`, and does not wrap one used as a value:
    // measured, a call on an assignment's right-hand side has parent `AssignmentStatement` and one
    // inside a condition has parent `GreaterThanExpression`.
    name: "call in statement position",
    treeSitterKind: "call_expression",
    compilerKind: "InvocationExpression",
    compilerParentKind: "ExpressionStatement",
  },
];
