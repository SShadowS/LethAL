import {
  findOperatorToken,
  replaceOperatorToken,
  synthesizeAfter,
} from "../../packages/builtin-tier1/src/mutate-helpers";
/**
 * SPIKE, Arithmetic Operator Replacement, prototype. NOT registered anywhere.
 *
 * R159 says AOR is the one absent operator with no recorded reason. This is the throwaway
 * implementation the decision needs: enough to census its real sites and to compile its real output,
 * not enough to ship. It is deliberately NOT exported from `builtin-tier1/src/index.ts`, a spike
 * that quietly joins the registry is a shipped operator nobody reviewed.
 *
 * Two mutation groups, kept SEPARATE because their hazards differ:
 *
 *   additive        `+` <-> `-`
 *   multiplicative  `*` <-> `/`
 *
 * The additive group is type-safe once both operands are numeric. The multiplicative group is not
 * comparable: `/` can divide by zero at run time, which scores a KILL that says nothing about the
 * test (the R121 false-kill shape), and on Integer operands `/` yields Decimal, which changes the
 * expression's type and can fail to compile in the assignment it feeds. The census reports the two
 * separately so a decision can take one and refuse the other.
 *
 * The type guard is the load-bearing part. AL overloads `+` across Text (concatenation), Date +
 * Duration, DateTime + Duration and List/Dictionary-adjacent shapes; swapping any of those emits AL
 * that `alc` rejects, which arrives as an `AlcCompileError` on the whole project AFTER the expensive
 * instrument-and-publish step. So a site is claimed ONLY when both operands resolve to a numeric
 * type. An unresolved operand is REFUSED, not assumed numeric: for a compile-safety guard the unsafe
 * direction is claiming too much.
 */
import {
  ALNodeKind,
  type ALSyntaxNode,
  type MutationOperator,
  type MutationSpec,
  type SemanticContext,
} from "../../packages/operator-sdk/src/index";

/** AL's numeric types. `Duration` is deliberately absent, it is numeric-ish but its `+` partners
 *  are Date/DateTime, and those swaps do not typecheck. */
export const NUMERIC_TYPES: ReadonlySet<string> = new Set([
  "Integer",
  "Decimal",
  "BigInteger",
  "Byte",
]);

export const ADDITIVE_FLIP: ReadonlyMap<string, string> = new Map([
  ["+", "-"],
  ["-", "+"],
]);

export const MULTIPLICATIVE_FLIP: ReadonlyMap<string, string> = new Map([
  ["*", "/"],
  ["/", "*"],
]);

export type AorGroup = "additive" | "multiplicative";

/** Why a candidate node was not claimed. Counted by the census, so a refusal is evidence rather
 *  than silence. */
export type AorRefusal =
  | "not-a-candidate-kind"
  | "operator-token-unreadable"
  | "operator-not-in-flip-set"
  | "operand-missing"
  /** At least one operand resolved to a type that is NOT numeric, a provable refusal. */
  | "operand-type-not-numeric"
  /** No operand proved non-numeric, but at least one could not be typed at all. This is a limit of
   *  the type table, NOT a fact about the code, and the census reports it separately so the two are
   *  never added together into a single "refused" number. */
  | "operand-type-unresolved";

export interface AorDecision {
  readonly claimed: boolean;
  readonly refusal?: AorRefusal;
  readonly group?: AorGroup;
  readonly token?: string;
  /** The two operand types as the type table answered, for the census histogram. */
  readonly operandTypes?: readonly [string | null, string | null];
  /** For an unresolved refusal: the node kind of each operand the type table could not answer for,
   *  `null` where it could. This is what turns "the type table is weak" into a named list. */
  readonly unresolvedKinds?: readonly [string | null, string | null];
}

/** The whole decision in one place so the census can report WHY, not just how many. */
export function decide(
  node: ALSyntaxNode,
  ctx: SemanticContext,
  groups: readonly AorGroup[],
): AorDecision {
  const isAdditive = node.kind === ALNodeKind.additive_expression;
  const isMultiplicative = node.kind === ALNodeKind.multiplicative_expression;
  if (!isAdditive && !isMultiplicative) return { claimed: false, refusal: "not-a-candidate-kind" };

  const group: AorGroup = isAdditive ? "additive" : "multiplicative";
  if (!groups.includes(group)) return { claimed: false, refusal: "not-a-candidate-kind" };

  const token = findOperatorToken(node);
  if (token === null) return { claimed: false, refusal: "operator-token-unreadable", group };

  const flips = isAdditive ? ADDITIVE_FLIP : MULTIPLICATIVE_FLIP;
  if (!flips.has(token.text)) {
    return { claimed: false, refusal: "operator-not-in-flip-set", group, token: token.text };
  }

  // `children` (not `namedChildren`) for the same reason `findOperatorToken` uses it: the two
  // binary kinds disagree about which tokens are named, and a direct child can never be a
  // descendant's operand.
  const kids = node.children;
  const left = kids[0];
  const right = kids[2];
  if (left === undefined || right === undefined) {
    return { claimed: false, refusal: "operand-missing", group, token: token.text };
  }

  const leftType = ctx.types.typeOf(left);
  const rightType = ctx.types.typeOf(right);
  const operandTypes: readonly [string | null, string | null] = [leftType, rightType];
  const base = { claimed: false as const, group, token: token.text, operandTypes };
  // Order matters, and it is the opposite of the obvious one. Check "provably NOT numeric" BEFORE
  // "could not be typed": `Text + <untypeable>` is a refusal we can prove from the left operand
  // alone, and reporting it as unresolved would file a settled case under the open one and inflate
  // the apparent headroom of a better type table.
  const provablyNotNumeric =
    (leftType !== null && !NUMERIC_TYPES.has(leftType)) ||
    (rightType !== null && !NUMERIC_TYPES.has(rightType));
  if (provablyNotNumeric) return { ...base, refusal: "operand-type-not-numeric" };
  if (leftType === null || rightType === null) {
    return {
      ...base,
      refusal: "operand-type-unresolved",
      unresolvedKinds: [
        leftType === null ? left.rawKind : null,
        rightType === null ? right.rawKind : null,
      ],
    };
  }
  return { claimed: true, group, token: token.text, operandTypes };
}

export function makeAorOperator(groups: readonly AorGroup[]): MutationOperator {
  const name = `lethal.spike-aor-${groups.join("-")}`;
  return {
    name,
    version: "0.0.0-spike",
    tier: 1,
    targetNodeKinds: [ALNodeKind.additive_expression, ALNodeKind.multiplicative_expression],
    producesNodeKinds: [ALNodeKind.additive_expression, ALNodeKind.multiplicative_expression],
    requiresSemantic: ["types"],

    targets(node: ALSyntaxNode, ctx: SemanticContext): boolean {
      return decide(node, ctx, groups).claimed;
    },

    generate(node: ALSyntaxNode, ctx: SemanticContext): readonly MutationSpec[] {
      const d = decide(node, ctx, groups);
      if (!d.claimed || d.token === undefined) return [];
      const flips = d.group === "additive" ? ADDITIVE_FLIP : MULTIPLICATIVE_FLIP;
      const flipped = flips.get(d.token);
      if (flipped === undefined) return [];
      const mutatedText = replaceOperatorToken(node, d.token, flipped);
      if (mutatedText === null) return [];
      return [
        {
          operatorName: name,
          operatorVersion: "0.0.0-spike",
          astNodeId: `${node.startIndex}-${node.endIndex}`,
          before: node,
          after: synthesizeAfter(node, mutatedText),
          parentContext: "statement-position",
        },
      ];
    },

    conformanceTests: [],
  };
}
