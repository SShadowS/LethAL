/**
 * ALNodeKind — enumeration of AST node types produced by the
 * SShadowS/tree-sitter-al grammar (v3.0.1).
 *
 * String values are cross-checked against the grammar's node-types.json.
 * Where the design-plan name differs from the grammar name, the plan's key
 * is preserved (downstream code references `ALNodeKind.codeunit`) but the
 * string value matches the grammar verbatim (e.g. `"codeunit_declaration"`).
 *
 * v3 adds *container* nodes rather than renaming anything from v2.5.0: a
 * `code_block`'s statements now sit inside a `statement_block`, a
 * `var_section`'s declarations inside a `var_body`, and an object
 * declaration's members inside a `declaration_body`. Code that walked
 * straight from the parent to its children under v2.5.0 must skip these
 * containers explicitly.
 */
export const ALNodeKind = {
  // --- Top-level / declarations --------------------------------------------
  source_file: "source_file",
  codeunit: "codeunit_declaration",
  table: "table_declaration",
  page: "page_declaration",
  report: "report_declaration",
  procedure: "procedure",
  trigger: "trigger_declaration",
  var_section: "var_section",
  /** v3 wraps a `var_section`'s declarations in a `var_body` container. */
  var_body: "var_body",
  /** v3 wraps an object declaration's members in a `declaration_body` container. */
  declaration_body: "declaration_body",
  variable_declaration: "variable_declaration",
  parameter_list: "parameter_list",
  parameter: "parameter",

  // --- Statements ----------------------------------------------------------
  /** Grammar calls the compound `begin...end` block `code_block`. */
  block: "code_block",
  /** v3 wraps a `code_block`'s statements in a `statement_block` container. */
  statement_block: "statement_block",
  if_statement: "if_statement",
  case_statement: "case_statement",
  repeat_statement: "repeat_statement",
  while_statement: "while_statement",
  for_statement: "for_statement",
  exit_statement: "exit_statement",
  /** AL uses `asserterror <stmt>` for its error-assert construct. */
  error_statement: "asserterror_statement",
  assignment_statement: "assignment_statement",
  // TODO: grammar does not have this kind yet
  //   The SShadowS grammar does not model a generic `expression_statement`.
  //   Expression-shaped statements appear directly as `call_expression`,
  //   `assignment_expression`, etc. inside a `code_block`.
  // expression_statement: "expression_statement",

  // --- Expressions ---------------------------------------------------------
  // The grammar splits binary expressions by precedence class. Callers that
  // want "any binary expression" should use `isBinaryExpressionKind()` below.
  additive_expression: "additive_expression",
  multiplicative_expression: "multiplicative_expression",
  comparison_expression: "comparison_expression",
  logical_expression: "logical_expression",
  unary_expression: "unary_expression",
  parenthesized_expression: "parenthesized_expression",
  identifier: "identifier",
  /** Grammar names the integer-literal node simply `integer`. */
  integer_literal: "integer",
  /** Grammar names the decimal-literal node simply `decimal`. */
  decimal_literal: "decimal",
  /** Grammar names AL text/string literals `string_literal`. */
  text_literal: "string_literal",
  /** Grammar names the boolean-literal node simply `boolean`. */
  boolean_literal: "boolean",
  /** Record/object member access is expressed as `member_expression`. */
  field_access: "member_expression",
  /** Procedure and method invocations are both `call_expression`. */
  procedure_call: "call_expression",
  // TODO: grammar does not have this kind yet
  //   Method calls are not a distinct node: they appear as a
  //   `call_expression` whose `function` field is a `member_expression`.
  //   Downstream code should classify by inspecting `call_expression`.
  // method_call: "method_call",

  // --- Types ---------------------------------------------------------------
  /** Type annotations in declarations use `type_specification`. */
  type_reference: "type_specification",
  record_type: "record_type",
} as const;

export type ALNodeKind = (typeof ALNodeKind)[keyof typeof ALNodeKind];

const VALID_KINDS: ReadonlySet<string> = new Set(Object.values(ALNodeKind));

export function isALNodeKind(value: unknown): value is ALNodeKind {
  return typeof value === "string" && VALID_KINDS.has(value);
}

/**
 * The four AL precedence-class binary expression kinds. Useful when downstream
 * code wants to treat "any binary expression" uniformly.
 */
export const BINARY_EXPRESSION_KINDS = [
  ALNodeKind.additive_expression,
  ALNodeKind.multiplicative_expression,
  ALNodeKind.comparison_expression,
  ALNodeKind.logical_expression,
] as const;

const BINARY_EXPRESSION_SET: ReadonlySet<string> = new Set(BINARY_EXPRESSION_KINDS);

export function isBinaryExpressionKind(value: unknown): value is ALNodeKind {
  return typeof value === "string" && BINARY_EXPRESSION_SET.has(value);
}
