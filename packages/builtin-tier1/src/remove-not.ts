import {
  ALNodeKind,
  type ALSyntaxNode,
  type MutationOperator,
  type MutationSpec,
  type SemanticContext,
} from "@lethal/operator-sdk";
import { synthesizeAfter } from "./mutate-helpers";

const OPERATOR_NAME = "lethal.remove-not";
const OPERATOR_VERSION = "1.0.0";

/**
 * Operand kinds this operator will strip a `not` from.
 *
 * A `parenthesized_expression` is ABSENT here and handled separately below, because the cession it
 * represents holds only PARTLY. `not (A = B)` hides a comparison and `negate-conditional` owns
 * comparisons, so claiming it here would put two operators on one condition for the same reason. But
 * that operator claims comparisons and logical expressions and NOTHING else, so `not (X in [...])`
 * was ceded to an operator that does not want it and reached by neither (R171). `CEDED_INNER_KINDS`
 * is the corrected line. Measured on `do-rel2/Cloud`: 43 parenthesized `not` sites, of which 15 come
 * back.
 */
const STRIPPABLE_OPERAND_KINDS: ReadonlySet<string> = new Set([
  ALNodeKind.procedure_call,
  ALNodeKind.identifier,
  ALNodeKind.field_access,
  "quoted_identifier",
]);

/**
 * Inner expression kinds a `parenthesized_expression` operand is still ceded for.
 *
 * These are exactly what `negate-conditional` claims. The original cession sent EVERY parenthesized
 * operand there, which was right for `not (A = B)` and wrong for `not (X in [...])`: that operator
 * does not claim `in_expression`, so each operator assumed the other covered it and neither did.
 */
const CEDED_INNER_KINDS: ReadonlySet<string> = new Set([
  ALNodeKind.comparison_expression,
  ALNodeKind.logical_expression,
]);

/**
 * `RemoveNot`: rewrite `not <expr>` to `<expr>`.
 *
 * ROADMAP R163. `negate-conditional` reaches a negation only when it wraps a COMPARISON — it targets
 * `comparison_expression` and `logical_expression`, and a `not` applied to a bare call, identifier
 * or member access is neither. So the commonest negation in Business Central code, `if not
 * Rec.IsEmpty() then`, `if not Codeunit.Run(...) then`, `if not IsHandled then`, was reached by
 * nothing at all.
 *
 * **Measured on `do-rel2/Cloud`** (554 files) before this was written, by operand kind:
 * `call_expression` 627, `identifier` 251, `member_expression` 172, `parenthesized_expression` 43,
 * `quoted_identifier` 1. Unary MINUS is a separate 30 and is not this operator's business. So 1,051
 * claimable sites after ceding the parenthesised ones, none of them claimed by anything today.
 *
 * **Why it compiles.** The operand is already Boolean or the `not` would not have compiled, and the
 * replacement is the operand's own verbatim text. There is no type inference here to get wrong.
 *
 * **No `PlatformKillMechanism`, and that is a ruling rather than an omission.** The obvious worry is
 * `if not Rec.Get(X) then Rec.Insert();`: inverted, it inserts a row that already exists and dies on
 * a duplicate primary key with no test asserting anything. That is real, and it is ALSO exactly what
 * `negate-conditional` does when it turns `if A = B then` into `if A <> B then` — the same branch
 * flip, reached by a different token — and that operator declares no mechanism. R138's mechanisms
 * are for a mutation that changes WHAT IS WRITTEN while leaving control flow alone (a skipped
 * trigger); a branch flip is ordinary changed behaviour, and design §6.7 already treats a mutated
 * program that errors on its own wrong behaviour as legitimately killed, the same way it treats a
 * timeout. Adding a tag here and not to `negate-conditional` would say the two differ when they do
 * not. R121's assertion screen is what tells a reader a kill carried no assertion, and it covers
 * this without a new mechanism.
 *
 * **`parentContext` is `"statement-position"`**, matching `negate-conditional`'s comparison branch:
 * both replace an expression inside an enclosing statement, and the compiler resolves the site by
 * walking to that statement. The hint is not a claim that the `not` is itself a statement.
 *
 * **Documented limits:**
 *   - `not (A = B)` and `not (A and B)` are refused, ceded to `negate-conditional`, which does claim
 *     those. `not (X in [...])` and `not (Rec.Field)` are NOT refused (R171): that operator claims
 *     neither, so ceding them reached nothing. See `CEDED_INNER_KINDS`.
 *   - `not not X` yields `not X`, which is a smaller mutation than a reader might expect but is a
 *     genuine behaviour change and compiles; the inner `not` remains a site of its own.
 *   - Equivalence is not detected. `if not X then A else B` with the branches symmetric is an
 *     equivalent mutant this operator cannot see, the same blind spot every Tier-1 operator has.
 */
export const removeNot: MutationOperator = {
  name: OPERATOR_NAME,
  version: OPERATOR_VERSION,
  tier: 1,
  targetNodeKinds: [ALNodeKind.unary_expression],
  producesNodeKinds: [ALNodeKind.procedure_call, ALNodeKind.identifier, ALNodeKind.field_access],
  requiresSemantic: [],

  targets(node: ALSyntaxNode, _ctx: SemanticContext): boolean {
    return strippableOperand(node) !== null;
  },

  generate(node: ALSyntaxNode, _ctx: SemanticContext): readonly MutationSpec[] {
    const operand = strippableOperand(node);
    if (operand === null) return [];
    return [
      {
        operatorName: OPERATOR_NAME,
        operatorVersion: OPERATOR_VERSION,
        astNodeId: `${node.startIndex}-${node.endIndex}`,
        before: node,
        after: synthesizeAfter(node, operand.text),
        parentContext: "statement-position",
      },
    ];
  },

  conformanceTests: [
    {
      name: "strips not from a call",
      sourceAL: `codeunit 51500 "C" { procedure P() var Cust: Record Customer; begin if not Cust.IsEmpty() then exit; end; }`,
      expectedSpecs: [
        {
          parentContext: "statement-position",
          beforeText: "not Cust.IsEmpty()",
          afterText: "Cust.IsEmpty()",
        },
      ],
    },
    {
      name: "strips not from a bare identifier",
      sourceAL: `codeunit 51501 "C" { procedure P(IsHandled: Boolean) begin if not IsHandled then exit; end; }`,
      expectedSpecs: [
        {
          parentContext: "statement-position",
          beforeText: "not IsHandled",
          afterText: "IsHandled",
        },
      ],
    },
    {
      name: "strips not from a member access",
      sourceAL: `codeunit 51502 "C" { procedure P() var Cust: Record Customer; begin if not Cust.Blocked then exit; end; }`,
      expectedSpecs: [
        {
          parentContext: "statement-position",
          beforeText: "not Cust.Blocked",
          afterText: "Cust.Blocked",
        },
      ],
    },
    {
      name: "REFUSES a parenthesized COMPARISON, which negate-conditional owns",
      sourceAL: `codeunit 51503 "C" { procedure P(A: Integer; B: Integer) begin if not (A = B) then exit; end; }`,
      expectedSpecs: [],
    },
    {
      name: "REFUSES a parenthesized LOGICAL expression, which negate-conditional also owns",
      sourceAL: `codeunit 51504 "C" { procedure P(A: Boolean; B: Boolean) begin if not (A and B) then exit; end; }`,
      expectedSpecs: [],
    },
    {
      name: "R171: strips not from a parenthesized `in`, which negate-conditional never claimed",
      sourceAL: `codeunit 51505 "C" { procedure P(C: Code[10]) begin if not (C in ['DK', 'DE']) then exit; end; }`,
      expectedSpecs: [
        {
          parentContext: "statement-position",
          beforeText: "not (C in ['DK', 'DE'])",
          afterText: "(C in ['DK', 'DE'])",
        },
      ],
    },
    {
      name: "R171: strips not from a parenthesized member access",
      sourceAL: `codeunit 51506 "C" { procedure P() var Cust: Record Customer; begin if not (Cust.Blocked) then exit; end; }`,
      expectedSpecs: [
        {
          parentContext: "statement-position",
          beforeText: "not (Cust.Blocked)",
          afterText: "(Cust.Blocked)",
        },
      ],
    },
  ],
};

/**
 * The operand of a `not`, when this operator will strip it, else `null`.
 *
 * Reads `children` rather than `namedChildren` for the operator token, the same reason
 * `findOperatorToken` does: the two unary shapes disagree about which tokens are named, and `not`
 * is an ANONYMOUS token in this grammar while `-` is not. Keying on the first child's text is
 * uniform across both.
 */
function strippableOperand(node: ALSyntaxNode): ALSyntaxNode | null {
  if (node.kind !== ALNodeKind.unary_expression) return null;
  const kids = node.children;
  if (kids.length !== 2) return null;
  const [op, operand] = kids;
  if (op === undefined || operand === undefined) return null;
  if (op.text.toLowerCase() !== "not") return null;
  if (STRIPPABLE_OPERAND_KINDS.has(operand.rawKind)) return operand;
  // R171: the cession above is to `negate-conditional`, and it only holds where that operator
  // actually claims the inner expression. It claims comparisons and logical expressions, and
  // nothing else — so `not (X in [...])` and `not (Rec.Field)` were ceded to an operator that does
  // not want them and reached by neither. Measured on do-rel2/Cloud: 15 `if` guards, 13 of them
  // marginal. Take back exactly the operands the cession never covered.
  if (operand.rawKind === "parenthesized_expression") {
    const inner = operand.namedChildren[0];
    if (inner === undefined) return null;
    if (CEDED_INNER_KINDS.has(inner.rawKind)) return null;
    return operand;
  }
  return null;
}
