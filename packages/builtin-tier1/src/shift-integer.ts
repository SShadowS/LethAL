import {
  ALNodeKind,
  type ALSyntaxNode,
  type MutationOperator,
  type MutationSpec,
  type SemanticContext,
} from "@lethal/operator-sdk";
import { synthesizeAfter } from "./mutate-helpers";

const OPERATOR_NAME = "lethal.shift-integer";
const OPERATOR_VERSION = "1.0.0";

/** AL's `Integer` is 32-bit signed. `n + 1` at the ceiling does not fit, so the site is refused. */
const AL_MAX_INTEGER = 2147483647;

/**
 * Comparison operators this operator CEDES to `conditional-boundary`.
 *
 * `if X < 5` becomes `X <= 5` there and `X < 6` here, and those two admit exactly the same values:
 * the same mutation reached through the operator instead of the constant. §3.2 dedup would NOT catch
 * it, because that rule compares SPANS and these differ (the comparison node against the literal
 * inside it), which is precisely how `flip-boolean-literal` came to duplicate `swap-modify-flag`
 * before R159's spike measured it. Measured here: 196 of the 873 non-loop behavioural integers.
 */
const CEDED_TO_CONDITIONAL_BOUNDARY: ReadonlySet<string> = new Set(["<", "<=", ">", ">="]);

/** The equality family, where nothing else touches the constant. */
const CLAIMED_COMPARISONS: ReadonlySet<string> = new Set(["=", "<>"]);

/**
 * `ShiftInteger`: rewrite an integer literal `n` to `n + 1`, the off-by-one probe.
 *
 * ROADMAP R159. `integer` was the largest kind the node-kind census left unclaimed, and sizing it is
 * the whole story: the raw count is 3,016 inside procedure and trigger bodies and the claimable
 * number is **677**, after three deductions each of which had to be measured rather than assumed.
 *
 * | deduction | remaining |
 * | --- | ---: |
 * | raw, in bodies | 3,016 |
 * | behavioural contexts only (comparison operand, assigned value) | 1,212 |
 * | minus loop conditions | 873 |
 * | minus ordering comparisons | **677** |
 *
 * The discarded 1,804 are not noise, they are other things wearing the same node kind: `Code[20]`
 * and `Text[250]` are type LENGTHS (530 and 181 occurrences of those two values alone), and field
 * declarations, enum values and page properties are declarative surfaces R135 already refuses.
 *
 * **Loop conditions are refused, not claimed.** 339 behavioural integers sit in a `repeat` or
 * `while` condition and 336 of those compare against `.Next(...)`. Shifting the `0` in
 * `until Rec.Next() = 0` makes the loop non-terminating on a one-row set, which is R164's measured
 * hazard, 290 such loops on this corpus, each costing a session on the default path where
 * `--stop-hung-sessions` is off. `negate-guard` refuses loop conditions for the same reason.
 *
 * **Why it compiles.** `n + 1` is an integer literal wherever `n` was, so the replacement is the same
 * type in the same position. The one shape that does not fit is a literal already at AL's 32-bit
 * ceiling, which `AL_MAX_INTEGER` refuses rather than emitting an overflow whose kill would say
 * nothing about the test, the false-kill shape `swap-multiplicative` was refused over.
 *
 * **No `PlatformKillMechanism`.** Changing a constant is ordinary changed behaviour, the same ruling
 * `remove-assignment` and `toggle-blank-string` carry, and R121's screen reports a kill that carried
 * no assertion.
 *
 * **Documented limits:**
 *   - **Equivalence is this operator's real cost**, inherited from the same place
 *     `remove-assignment`'s is: an assigned integer that is never read again gives an equivalent
 *     mutant, and no source-derived layer can see that without dataflow. 435 of the 677 sites are
 *     assignments, so expect survivors and read them as leads.
 *   - Only `+ 1`. A single direction is enough to ask "does anything depend on this exact value",
 *     and a second would double the mutant count to ask the same question twice.
 */
export const shiftInteger: MutationOperator = {
  name: OPERATOR_NAME,
  version: OPERATOR_VERSION,
  tier: 1,
  targetNodeKinds: [ALNodeKind.integer_literal],
  producesNodeKinds: [ALNodeKind.integer_literal],
  requiresSemantic: [],
  // R172: MEASURED equivalent on `sandbox-hang`: `Counter := 0` -> `1` still returns 3, because the loop walks 2,3 instead of 1,2,3.
  equivalenceRisk: "value-rewrite",

  targets(node: ALSyntaxNode, _ctx: SemanticContext): boolean {
    return shifted(node) !== null;
  },

  generate(node: ALSyntaxNode, _ctx: SemanticContext): readonly MutationSpec[] {
    const after = shifted(node);
    if (after === null) return [];
    return [
      {
        operatorName: OPERATOR_NAME,
        operatorVersion: OPERATOR_VERSION,
        astNodeId: `${node.startIndex}-${node.endIndex}`,
        before: node,
        after: synthesizeAfter(node, after),
        parentContext: "statement-position",
      },
    ];
  },

  conformanceTests: [
    {
      name: "shifts an equality comparison operand",
      sourceAL: `codeunit 52000 "I" { procedure P(N: Integer): Integer begin if N = 5 then exit(1); exit(0); end; }`,
      expectedSpecs: [{ parentContext: "statement-position", beforeText: "5", afterText: "6" }],
    },
    {
      name: "shifts an assigned value",
      sourceAL: `codeunit 52001 "I" { procedure P() var Total: Integer; begin Total := 41; end; }`,
      expectedSpecs: [{ parentContext: "statement-position", beforeText: "41", afterText: "42" }],
    },
    {
      name: "CEDES an ordering comparison to conditional-boundary, which shifts the same boundary",
      sourceAL: `codeunit 52002 "I" { procedure P(N: Integer): Integer begin if N < 5 then exit(1); exit(0); end; }`,
      expectedSpecs: [],
    },
    {
      name: "REFUSES a loop-exit condition: R164's non-termination hazard",
      sourceAL: `codeunit 52003 "I" { procedure P() var Cust: Record Customer; begin if Cust.FindSet() then repeat until Cust.Next() = 0; end; }`,
      expectedSpecs: [],
    },
    {
      name: "REFUSES a literal at AL's 32-bit ceiling: n + 1 does not fit",
      sourceAL: `codeunit 52004 "I" { procedure P() var Total: Integer; begin Total := 2147483647; end; }`,
      expectedSpecs: [],
    },
    {
      name: "REFUSES a declarative type length, which is not a value the program branches on",
      sourceAL: `table 52005 "T" { fields { field(1; "No."; Code[20]) { } } }`,
      expectedSpecs: [],
    },
  ],
};

/** The shifted literal text, or `null` where this operator does not claim the site. */
function shifted(node: ALSyntaxNode): string | null {
  if (node.rawKind !== ALNodeKind.integer_literal) return null;
  if (!inExecutableBody(node)) return null;
  if (inLoopCondition(node)) return null;

  const parent = node.parent;
  if (parent === null) return null;
  if (parent.rawKind === ALNodeKind.comparison_expression) {
    const op = parent.children.find(
      (c) => CLAIMED_COMPARISONS.has(c.text) || CEDED_TO_CONDITIONAL_BOUNDARY.has(c.text),
    );
    if (op === undefined || !CLAIMED_COMPARISONS.has(op.text)) return null;
  } else if (parent.rawKind !== ALNodeKind.assignment_statement) {
    return null;
  }

  const value = Number.parseInt(node.text, 10);
  if (!Number.isSafeInteger(value) || value >= AL_MAX_INTEGER) return null;
  return String(value + 1);
}

/**
 * Inside a procedure or trigger body, an ALLOW-list, because a deny-list of declarative parents is
 * only ever as complete as the last person's memory. `flip-boolean-literal` paid for that lesson
 * when a table key's `Clustered = true` reached the emit path and the artifact would not build.
 */
function inExecutableBody(node: ALSyntaxNode): boolean {
  for (let p: ALSyntaxNode | null = node.parent; p !== null; p = p.parent) {
    if (p.rawKind === "procedure" || p.rawKind === "trigger_declaration") return true;
  }
  return false;
}

/** In the CONDITION of a `repeat` or `while`, see the doc comment for why those are refused. */
function inLoopCondition(node: ALSyntaxNode): boolean {
  for (let p: ALSyntaxNode | null = node.parent; p !== null; p = p.parent) {
    if (p.rawKind === "repeat_statement" || p.rawKind === "while_statement") {
      const cond = p.childForFieldName("condition");
      if (cond !== null && node.startIndex >= cond.startIndex && node.endIndex <= cond.endIndex) {
        return true;
      }
    }
    if (p.rawKind === "procedure" || p.rawKind === "trigger_declaration") break;
  }
  return false;
}
