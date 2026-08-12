import {
  ALNodeKind,
  type ALSyntaxNode,
  type MutationOperator,
  type MutationSpec,
  type ParentContextHint,
  type SemanticContext,
  isStatementPosition,
} from "@lethal/operator-sdk";
import { countArguments, synthesizeAfter } from "./mutate-helpers";
import { calleeNameNode, claimsRecordMethod } from "./receiver";

const OPERATOR_VERSION = "1.0.0";

/**
 * The two direction pairs this operator swaps, each `[claimedName, replacementName]`. Kept as data
 * rather than two separate `targets()` branches so the loop in `claimedDirection` cannot drift from
 * the replacement it emits: whichever pair's first element `claimsRecordMethod` proves is the pair
 * whose second element is spliced in.
 */
const DIRECTIONS: ReadonlyArray<readonly [string, string]> = [
  ["FindFirst", "FindLast"],
  ["FindLast", "FindFirst"],
];

/**
 * `SwapFindDirection`: rewrite `<rec>.FindFirst()` <-> `<rec>.FindLast()`.
 *
 * Spec: docs/superpowers/specs/2026-08-12-r136-tier2-trio-design.md §2.2.
 *
 * Two guards, both load-bearing on their own:
 *
 *   1. `countArguments(node) === 0`. `Find('-')`, `FindSet()` and `FindSet(true)` are different
 *      operations, not direction variants of `FindFirst`/`FindLast`: this is the guard whose
 *      absence is dangerous rather than merely incomplete, since a `FindSet` rewritten to
 *      `FindLast` would change an iteration into a single read.
 *   2. `claimsRecordMethod(node, ctx, "FindFirst")` or `claimsRecordMethod(node, ctx, "FindLast")`,
 *      tried in order (`DIRECTIONS`) and short-circuiting on the first match. That predicate
 *      carries the receiver proof, the case-insensitivity, and the project-declared-procedure
 *      shadowing refusal, exactly as it does for `swap-modify-flag`.
 *
 * **The method-name span comes from `calleeNameNode` (`./receiver.ts`), not from a re-derived
 * heuristic.** An earlier sketch of this operator proposed locating "the last identifier-kind named
 * descendant that starts before the argument list", a second parser for a fact `claimsRecordMethod`
 * already resolves internally via the same `function` field and `field_access` member path. Both new
 * Tier-2 operators in this wave (`swap-find-direction` here, `validate-to-assign`) splice/slice
 * around that one shared node instead, so neither can disagree with the other, or with
 * `claimsRecordMethod`, about where the name starts or ends.
 *
 * The replacement is always the CANONICAL spelling (`FindLast` or `FindFirst`), never the input's
 * own casing: AL is case-insensitive and the identifier's casing carries no meaning, mirroring how
 * `swap-modify-flag` always emits lowercase `false`. One consequence worth recording: a quoted
 * method spelling (`Rec."FindFirst"()`) is claimed today, because `claimsRecordMethod` strips quotes
 * before comparing names. Splicing the canonical bare name over the QUOTED span produces
 * `Rec.FindLast()`, which is valid AL: nothing needs to change for that case, it is simply what the
 * splice already does (pinned by a test in `tests/swap-find-direction.test.ts`).
 *
 * **`parentContext` is computed, not asserted**, via the same honest `isStatementPosition` hint
 * `swap-modify-flag` uses: `if Rec.FindFirst() then` is a common and real form, and the swap
 * preserves the expression shape (no control-flow change), so restricting to statement position
 * would silently miss it.
 *
 * **This operator does not manufacture the platform-kill class `swap-modify-flag`'s `Insert`
 * extension warns about, and that is a real safety property, not a guess.** `FindFirst` and
 * `FindLast` return the SAME found-or-not-found answer over the same filtered set, so the swap can
 * never turn a found into a not-found and can never raise at the site where the original did not.
 * Only which ROW is loaded changes. That is not quite "free of the class outright" though: a
 * DIFFERENT row carries different data, so a downstream statement can still raise on it, the same
 * mechanism one statement later. The honest form, and the one this operator's behaviour actually
 * supports, is: the swap adds no error at its own site, and a downstream platform error caused by
 * the other row's data remains possible.
 *
 * **Equivalence class, documented rather than feared.** The mutant is equivalent whenever the
 * filtered set holds zero or one row, and invisible to any test that only asks whether something was
 * found. This operator does not tag such sites `likely-equivalent`: today that hint changes only
 * which of two colliding specs wins in dedup, and using it as a "probably survives" annotation would
 * describe a scoring feature that does not exist.
 *
 * **Dedup**: the replacement text is never empty, so this mutant coexists with Tier-1
 * `void-method-call`'s deletion at a statement-position site: neither displaces the other.
 *
 * Documented limits, inherited from `claimsRecordMethod` (see `./receiver.ts`):
 *   - the parenthesis-less call form (`Rec.FindFirst;`) never reaches this predicate and is silently
 *     not claimed: it parses as a `field_access`, not a call.
 *   - a `pageextension`'s implicit `Rec` is refused; a `tableextension`'s resolves fully.
 *   - this operator reasons about nothing regarding which key the record is sorted on: `FindFirst`
 *     and `FindLast` follow the current key and any `Ascending` state, both settable elsewhere. The
 *     mutation is still a direction reversal at that site under whatever ordering is in force.
 */
export const swapFindDirection: MutationOperator = {
  name: "lethal.swap-find-direction",
  version: OPERATOR_VERSION,
  tier: 2,
  targetNodeKinds: [ALNodeKind.procedure_call],
  producesNodeKinds: [ALNodeKind.procedure_call],
  requiresSemantic: ["symbol-table"],

  targets(node: ALSyntaxNode, ctx: SemanticContext): boolean {
    if (node.kind !== ALNodeKind.procedure_call) return false;
    return claimedDirection(node, ctx) !== null;
  },

  generate(node: ALSyntaxNode, ctx: SemanticContext): readonly MutationSpec[] {
    const direction = claimedDirection(node, ctx);
    if (direction === null) return [];
    const [, replacement] = direction;

    const nameNode = calleeNameNode(node);
    if (nameNode === null) return [];
    const mutatedText = replaceNameSpan(node, nameNode, replacement);
    if (mutatedText === null) return [];

    return [
      {
        operatorName: "lethal.swap-find-direction",
        operatorVersion: OPERATOR_VERSION,
        astNodeId: `${node.startIndex}-${node.endIndex}`,
        before: node,
        after: synthesizeAfter(node, mutatedText),
        parentContext: parentContextOf(node),
      },
    ];
  },

  conformanceTests: [
    {
      name: "rewrites FindFirst() to FindLast() in statement position",
      sourceAL: `codeunit 50180 "C" { procedure P() var Cust: Record Customer; begin Cust.FindFirst(); end; }`,
      expectedSpecs: [
        {
          parentContext: "statement-position",
          beforeText: "Cust.FindFirst()",
          afterText: "Cust.FindLast()",
        },
      ],
    },
    {
      name: "rewrites FindLast() to FindFirst() in statement position",
      sourceAL: `codeunit 50181 "C" { procedure P() var Cust: Record Customer; begin Cust.FindLast(); end; }`,
      expectedSpecs: [
        {
          parentContext: "statement-position",
          beforeText: "Cust.FindLast()",
          afterText: "Cust.FindFirst()",
        },
      ],
    },
  ],
};

/**
 * Which direction pair does `node` claim, if any? Returns the matched `[claimedName,
 * replacementName]` pair from `DIRECTIONS`, or `null` for anything the two guards refuse.
 *
 * The zero-argument guard runs FIRST and cheaply, before any receiver/symbol-table work: a call
 * carrying arguments is refused regardless of its name, so `Find('-')` and `FindSet(...)` never
 * reach `claimsRecordMethod` at all.
 */
function claimedDirection(
  node: ALSyntaxNode,
  ctx: SemanticContext,
): readonly [string, string] | null {
  if (node.kind !== ALNodeKind.procedure_call) return null;
  if (countArguments(node) !== 0) return null;
  for (const pair of DIRECTIONS) {
    if (claimsRecordMethod(node, ctx, pair[0])) return pair;
  }
  return null;
}

/**
 * The honest `parentContext` for this site, identical in shape to `swap-modify-flag`'s
 * `parentContextOf`: this operator claims sites that are not in statement position (an `if`
 * condition, an `exit(...)` argument), so hardcoding `"statement-position"` would state something
 * `isStatementPosition` itself measures as false.
 */
function parentContextOf(node: ALSyntaxNode): ParentContextHint {
  return isStatementPosition(node) ? "statement-position" : "expression-position";
}

/**
 * Rewrite `node`'s full text with only `nameNode`'s span replaced by `replacement`. Null when
 * `nameNode`'s byte range does not fall within `node`'s own text (should be impossible for a
 * genuine descendant, guarded rather than assumed, mirroring `swap-modify-flag.ts`'s
 * `replaceArgument`).
 */
function replaceNameSpan(
  node: ALSyntaxNode,
  nameNode: ALSyntaxNode,
  replacement: string,
): string | null {
  const start = nameNode.startIndex - node.startIndex;
  const end = nameNode.endIndex - node.startIndex;
  const text = node.text;
  if (start < 0 || end > text.length) return null;
  return `${text.slice(0, start)}${replacement}${text.slice(end)}`;
}
