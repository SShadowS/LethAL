import {
  ALNodeKind,
  type ALSyntaxNode,
  type MutationOperator,
  type MutationSpec,
  type SemanticContext,
} from "@lethal/operator-sdk";
import { synthesizeAfter } from "./mutate-helpers";

const OPERATOR_NAME = "lethal.negate-guard";
const OPERATOR_VERSION = "1.0.0";

/**
 * Condition kinds another operator already mutates the POLARITY of. Claiming these would put two
 * operators on one condition for the same reason, which is what §3.2 dedup exists to prevent and
 * what `remove-not` already cedes for.
 *
 *   - `comparison_expression` / `logical_expression` -> `negate-conditional` (and
 *     `conditional-boundary` on the ordering comparisons).
 *   - `unary_expression` -> `remove-not`. Wrapping `not X` would emit `not (not X)`, which is `X`
 *     by another route: a literal duplicate of remove-not's own mutant, not a second test.
 */
const ALREADY_POLARISED: ReadonlySet<string> = new Set([
  ALNodeKind.comparison_expression,
  ALNodeKind.logical_expression,
  ALNodeKind.unary_expression,
]);

/**
 * `NegateGuard`: rewrite `if <cond> then` to `if not (<cond>) then`.
 *
 * ROADMAP R171. `negate-conditional` reaches a condition only when it is a COMPARISON or a LOGICAL
 * expression; `conditional-boundary` shifts an ordering comparison; `remove-not` strips a `not` that
 * is already written. A guard whose condition is a bare Boolean falls through all three, and nothing
 * else in either tier mutates a condition. So the commonest guard shape in Business Central code,
 * `if Rec.Get(No) then`, `if Rec.FindSet() then`, `if Blocked then`, had no polarity mutant at all.
 *
 * **Measured on `do-rel2/Cloud`** (554 files) by `scripts/census-branch-conditions.ts` before this
 * was written: 4,389 `if` guards, of which 2,013 carry no polarity or boundary mutant and 1,891 are
 * MARGINAL, meaning no operator claims any site inside the condition. By condition kind:
 * `call_expression` 1,068, `identifier` 620, `member_expression` 252, `quoted_identifier` 27,
 * `parenthesized_expression` 18, `in_expression` 13, `subscript_expression` 2.
 *
 * **Why it compiles, by construction.** AL requires the condition of an `if` to be Boolean, or the
 * ORIGINAL would not have compiled. `not` applied to a Boolean is Boolean, and the operand is
 * wrapped in parentheses so no precedence question arises. There is no type inference here to get
 * wrong, which is the property `swap-multiplicative` turned out to lack: that operator's safety
 * proof was true about its operands and silent about the RESULT type, and a live run refuted it.
 *
 * **Loops are refused on purpose.** This claims `if_statement` only. Negating a loop-exit condition
 * is R164's non-termination hazard (`repeat ... until Next() = 0` inverted never ends), and the
 * census says refusing costs 4 marginal sites out of 1,895 on the measured corpus. Buying a whole
 * hazard class back for 0.2% of the sites is not a trade worth making.
 *
 * **No `PlatformKillMechanism`, following R163's ruling rather than re-deciding it.** Inverting
 * `if Rec.Get(X) then` can make the body run against a record that was never read, and die. That is
 * real, and it is exactly what `negate-conditional` already does when it turns `if A = B then` into
 * `if A <> B then`: the same branch flip reached through a different token. R138's mechanisms are
 * for a mutation that changes WHAT IS WRITTEN while leaving control flow alone; a branch flip is
 * ordinary changed behaviour, and design §6.7 already treats a mutated program that errors on its
 * own wrong behaviour as legitimately killed. R121's assertion screen is what tells a reader such a
 * kill carried no assertion, and it covers this without a new mechanism.
 *
 * **`parentContext` is `"statement-position"`**, matching `negate-conditional`'s comparison branch
 * and `remove-not`: all three replace an expression inside an enclosing statement, and the compiler
 * resolves the site by walking to that statement.
 *
 * **Documented limits:**
 *   - Equivalence is not detected. `if X then` with an empty `then` branch, or an `if/else` whose
 *     branches are symmetric, is an equivalent mutant this operator cannot see. That is the blind
 *     spot every Tier-1 operator has.
 *   - A guard that controls a loop's exit (`repeat ... if Done then exit; until false`) can be made
 *     non-terminating by this mutation even though the guard itself is not a loop condition. It
 *     scores `timeout-killed` under `--stop-hung-sessions` and quarantines without it, which is
 *     R164's cost on the default path, not a wrong verdict.
 *   - `case` branches are not conditions and are not claimed.
 */
export const negateGuard: MutationOperator = {
  name: OPERATOR_NAME,
  version: OPERATOR_VERSION,
  tier: 1,
  targetNodeKinds: [ALNodeKind.if_statement],
  producesNodeKinds: [ALNodeKind.if_statement],
  requiresSemantic: [],

  targets(node: ALSyntaxNode, _ctx: SemanticContext): boolean {
    return guardCondition(node) !== null;
  },

  generate(node: ALSyntaxNode, _ctx: SemanticContext): readonly MutationSpec[] {
    const cond = guardCondition(node);
    if (cond === null) return [];
    return [
      {
        operatorName: OPERATOR_NAME,
        operatorVersion: OPERATOR_VERSION,
        astNodeId: `${cond.startIndex}-${cond.endIndex}`,
        before: cond,
        after: synthesizeAfter(cond, `not (${cond.text})`),
        parentContext: "statement-position",
      },
    ];
  },

  conformanceTests: [
    {
      name: "negates a bare call guard",
      sourceAL: `codeunit 51600 "C" { procedure P() var Cust: Record Customer; begin if Cust.Get('X') then exit; end; }`,
      expectedSpecs: [
        {
          parentContext: "statement-position",
          beforeText: "Cust.Get('X')",
          afterText: "not (Cust.Get('X'))",
        },
      ],
    },
    {
      name: "negates a bare identifier guard",
      sourceAL: `codeunit 51601 "C" { procedure P(IsHandled: Boolean) begin if IsHandled then exit; end; }`,
      expectedSpecs: [
        {
          parentContext: "statement-position",
          beforeText: "IsHandled",
          afterText: "not (IsHandled)",
        },
      ],
    },
    {
      name: "negates a member-access guard",
      sourceAL: `codeunit 51602 "C" { procedure P() var Cust: Record Customer; begin if Cust.Blocked then exit; end; }`,
      expectedSpecs: [
        {
          parentContext: "statement-position",
          beforeText: "Cust.Blocked",
          afterText: "not (Cust.Blocked)",
        },
      ],
    },
    {
      name: "REFUSES a comparison, which negate-conditional owns",
      sourceAL: `codeunit 51603 "C" { procedure P(A: Integer; B: Integer) begin if A = B then exit; end; }`,
      expectedSpecs: [],
    },
    {
      name: "REFUSES a not, which remove-not owns; not (not X) would duplicate its mutant",
      sourceAL: `codeunit 51604 "C" { procedure P(IsHandled: Boolean) begin if not IsHandled then exit; end; }`,
      expectedSpecs: [],
    },
    {
      name: "REFUSES a while condition: R164's non-termination hazard",
      sourceAL: `codeunit 51605 "C" { procedure P(Go: Boolean) begin while Go do Go := false; end; }`,
      expectedSpecs: [],
    },
  ],
};

/**
 * The `if` condition this operator will negate, else `null`.
 *
 * Keyed off the `condition` FIELD rather than the first named child, so a grammar that re-parents
 * the condition fails loudly by claiming nothing rather than quietly negating the wrong subtree.
 */
function guardCondition(node: ALSyntaxNode): ALSyntaxNode | null {
  if (node.rawKind !== ALNodeKind.if_statement) return null;
  const cond = node.childForFieldName("condition");
  if (cond === null) return null;
  if (ALREADY_POLARISED.has(cond.rawKind)) return null;
  // A parenthesized condition inherits its inner expression's owner: `if (A = B) then` is
  // negate-conditional's, `if (Flag) then` is this operator's.
  if (cond.rawKind === "parenthesized_expression") {
    const inner = cond.namedChildren[0];
    if (inner !== undefined && ALREADY_POLARISED.has(inner.rawKind)) return null;
  }
  return cond;
}
