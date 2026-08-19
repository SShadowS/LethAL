import {
  ALNodeKind,
  type ALSyntaxNode,
  type MutationOperator,
  type MutationSpec,
  type SemanticContext,
} from "@lethal/operator-sdk";
import { findOperatorToken, replaceOperatorToken, synthesizeAfter } from "./mutate-helpers";

const OPERATOR_NAME = "lethal.swap-additive";
const OPERATOR_VERSION = "1.0.0";

const ADDITIVE_FLIP: ReadonlyMap<string, string> = new Map([
  ["+", "-"],
  ["-", "+"],
]);

/**
 * AL's numeric types, as the type table spells them.
 *
 * `Duration` is deliberately absent. It is numeric-ish, but its `+` partners are `Date` and
 * `DateTime`, and `Date - Duration` does not typecheck the way `Date + Duration` does, so admitting
 * it would emit AL the compiler rejects.
 */
const NUMERIC_TYPES: ReadonlySet<string> = new Set(["Integer", "Decimal", "BigInteger", "Byte"]);

/**
 * `SwapAdditive`: rewrite `a + b` to `a - b`, and back.
 *
 * ROADMAP R159. Arithmetic Operator Replacement is the most standard mutation in the literature and
 * this product shipped without it, listed in no tier of `design.md` and refused by no roadmap row —
 * an omission rather than a decision, which is what R159 was filed to correct.
 *
 * **The measurement that decided its shape.** Spiked before it was built
 * (`scripts/r159-aor-spike/`, `docs/superpowers/specs/2026-08-19-r159-aor-spike.md`) against
 * `do-rel2/Cloud`, 554 real files:
 *
 *   - 1,121 arithmetic expressions, of which **1,006 of the tokens are `+`**;
 *   - 844 refused because an operand is provably NOT numeric, overwhelmingly `Text + Text` and
 *     friends. **In real AL, `+` is mostly string concatenation.**
 *   - So the literature's headline operator applies to under a tenth of the sites its name suggests.
 *
 * **The MULTIPLICATIVE half is deliberately not here.** `x * y` to `x / y` divides by zero whenever
 * `y` is zero, which raises and scores a kill no test earned — the R121 false-kill shape. It needs a
 * declared `PlatformKillMechanism` and a screen ruling first, and its 13 marginal sites do not pay
 * for that yet. Kept as a separate future operator rather than a mode of this one, because the two
 * carry entirely different hazards and a single name would hide that.
 *
 * ## The type guard, and why it is the whole operator
 *
 * AL overloads `+` across `Text` (concatenation), `Date + Duration`, `DateTime + Duration` and
 * `Label` formatting. Swapping any of those emits AL `alc` rejects, and a rejection arrives as an
 * `AlcCompileError` on the WHOLE project after the expensive instrument-and-publish step. So a site
 * is claimed only when BOTH operands resolve to a numeric type, and an operand the type table
 * cannot answer for is REFUSED rather than assumed numeric: for a compile-safety guard the unsafe
 * direction is claiming too much.
 *
 * **Proven in both directions with `alc`**, which is the part that makes the guard trustworthy
 * rather than merely present. On `fixtures/sandbox-data`: every claimed site compiles (8/8) and
 * every site refused as non-numeric is REJECTED when the mutation is applied anyway (4/4), each with
 * `error AL0175: Operator '-' cannot be applied to operands of type 'Text' and 'Text'`. A positive
 * pass alone would have been satisfied by a guard that refused everything.
 *
 * ## Documented limits
 *
 * - `div` and `mod` are not flipped. They have no natural counterpart in this operator's pair, and
 *   guessing one would be a different mutation wearing this name.
 * - The claimable count is a FLOOR, not a ceiling: R160 lifted it from 100 to 120 by teaching the
 *   type table to read record fields and project procedure returns, and every further improvement
 *   there adds sites here without touching this file.
 * - Equivalence is not detected. `X + 0` to `X - 0` is an equivalent mutant this operator emits and
 *   cannot see, the same blind spot every Tier-1 operator has.
 */
export const swapAdditive: MutationOperator = {
  name: OPERATOR_NAME,
  version: OPERATOR_VERSION,
  tier: 1,
  targetNodeKinds: [ALNodeKind.additive_expression],
  producesNodeKinds: [ALNodeKind.additive_expression],
  requiresSemantic: ["type-info"],

  targets(node: ALSyntaxNode, ctx: SemanticContext): boolean {
    return flipFor(node, ctx) !== null;
  },

  generate(node: ALSyntaxNode, ctx: SemanticContext): readonly MutationSpec[] {
    const flip = flipFor(node, ctx);
    if (flip === null) return [];
    const mutatedText = replaceOperatorToken(node, flip.token, flip.replacement);
    if (mutatedText === null) return [];
    return [
      {
        operatorName: OPERATOR_NAME,
        operatorVersion: OPERATOR_VERSION,
        astNodeId: `${node.startIndex}-${node.endIndex}`,
        before: node,
        after: synthesizeAfter(node, mutatedText),
        parentContext: "statement-position",
      },
    ];
  },

  conformanceTests: [
    {
      name: "flips + to - on two numeric locals",
      sourceAL: `codeunit 51600 "C" { procedure P(A: Integer; B: Integer): Integer begin exit(A + B); end; }`,
      expectedSpecs: [
        {
          parentContext: "statement-position",
          beforeText: "A + B",
          afterText: "A - B",
        },
      ],
    },
    {
      name: "flips - to +",
      sourceAL: `codeunit 51601 "C" { procedure P(A: Decimal; B: Decimal): Decimal begin exit(A - B); end; }`,
      expectedSpecs: [
        {
          parentContext: "statement-position",
          beforeText: "A - B",
          afterText: "A + B",
        },
      ],
    },
    {
      name: "REFUSES Text + Text, which is concatenation and does not compile as a subtraction",
      sourceAL: `codeunit 51602 "C" { procedure P(A: Text; B: Text): Text begin exit(A + B); end; }`,
      expectedSpecs: [],
    },
    {
      name: "REFUSES an operand the type table cannot answer for",
      sourceAL: `codeunit 51603 "C" { procedure P(A: Integer): Integer begin exit(A + Unknown()); end; }`,
      expectedSpecs: [],
    },
  ],
};

interface AdditiveFlip {
  readonly token: string;
  readonly replacement: string;
}

/**
 * The token to replace and what to replace it with, or `null` when any guard refuses.
 *
 * One decision function for both entry points, so `targets()` and `generate()` cannot drift apart
 * about which sites are claimed.
 */
function flipFor(node: ALSyntaxNode, ctx: SemanticContext): AdditiveFlip | null {
  if (node.kind !== ALNodeKind.additive_expression) return null;

  const token = findOperatorToken(node);
  if (token === null) return null;
  const replacement = ADDITIVE_FLIP.get(token.text);
  if (replacement === undefined) return null;

  // `children`, not `namedChildren`: the binary kinds disagree about which tokens are named, and a
  // direct child can never be a descendant's operand. Same reasoning `findOperatorToken` documents.
  const kids = node.children;
  const left = kids[0];
  const right = kids[2];
  if (left === undefined || right === undefined) return null;

  const leftType = ctx.types.typeOf(left);
  const rightType = ctx.types.typeOf(right);
  // An unresolved operand refuses. Claiming it would risk `Text + Text` emitting a subtraction and
  // failing the whole project's compile.
  if (leftType === null || rightType === null) return null;
  if (!NUMERIC_TYPES.has(leftType) || !NUMERIC_TYPES.has(rightType)) return null;

  return { token: token.text, replacement };
}
