import {
  ALNodeKind,
  type ALSyntaxNode,
  type MutationOperator,
  type MutationSpec,
  type ParentContextHint,
  type SemanticContext,
  isStatementPosition,
} from "@lethal/operator-sdk";
import {
  type FilterMutation,
  mutateFilterContent,
  quoteALString,
  unquoteALString,
} from "./filter-expression";
import { countArguments, exactArguments, synthesizeAfter } from "./mutate-helpers";
import { claimsRecordMethod } from "./receiver";

const OPERATOR_NAME = "lethal.flip-filter-literal";
const OPERATOR_VERSION = "1.0.0";
const METHOD_NAME = "SetFilter";
const FILTER_TEXT_ARGUMENT_INDEX = 1;
/** A field argument plus a filter-text argument, at minimum. */
const MIN_ARGUMENT_COUNT = 2;

/**
 * `FlipFilterLiteral`: mutate INSIDE the filter-expression string literal of
 * `<rec>.SetFilter(F, '...')`, one of four fixed-precedence rules per site (negation flip, boundary
 * shift, open-range flip, drop a placeholder-free alternative), rather than deleting or rewriting
 * the call as a whole.
 *
 * Spec: docs/superpowers/specs/2026-08-12-r134-filter-literal-design.md §2.1-2.7.
 *
 * The CONTENT-level parsing and mutation ladder (unquote, refuse-by-default classification, the
 * four rules, the placeholder-arity invariant, re-encoding) live entirely in the pure module
 * `./filter-expression.ts` (Task B3), consumed here rather than reimplemented: this file's whole
 * job is claiming the right AST sites and splicing the mutated literal back in.
 *
 * **Guards, in the spec's own order (§2.1), all funneled through one shared helper,
 * `plannedFilterMutation`.** Both `targets()` and `generate()` call it so the two can never
 * disagree about which sites produce a mutant — the same "targets() true implies generate()
 * produces exactly one spec" guarantee `validate-to-assign` and `swap-find-direction` give:
 *
 *   1. `claimsRecordMethod(node, ctx, "SetFilter")` — is this actually the AL record method, on a
 *      record, and not a project procedure of the same name? This operator is the FIRST to put
 *      `SetFilter` on that predicate's shadowing-guard surface (verified against source: no
 *      registered operator claims it today), so it needs its own project-wide shadowing refusal
 *      test (see `tests/flip-filter-literal.test.ts`), which a single-file context cannot exercise.
 *   2. `countArguments(node) >= MIN_ARGUMENT_COUNT` — at least a field argument and a filter-text
 *      argument. Kept as an explicit, named check even though the `literalNode === undefined` guard
 *      just below it would also catch a too-short argument list on its own: the same deliberately
 *      redundant double-guard shape `validate-to-assign.ts`'s `validateArguments` uses, so either
 *      layer can be defeated or deleted without the other turning into a crash (confirmed by
 *      red-check: removing this explicit guard alone does not turn any test red, because the
 *      `undefined` check downstream already refuses the same inputs — reported rather than
 *      silently re-justified, see the task report).
 *   3. The SECOND argument (`exactArguments(node, count)`, never a hardcoded index read — `SetFilter`'s
 *      total argument count varies with how many `%N` placeholders the filter text names, unlike
 *      `validate-to-assign`'s fixed two-argument shape) must be a plain `ALNodeKind.text_literal`.
 *      `SetFilter(F, MyFilterVar, V)`, whose filter text is a variable, is invisible to a static
 *      operator and is refused here.
 *   4. `unquoteALString` on that literal's own `.text` must succeed.
 *   5. `mutateFilterContent` on the unquoted content must return a mutation. `null` here covers both
 *      a parser refusal (an unrecognised shape: a wildcard, an embedded quote, a stray character) and
 *      ladder exhaustion (a recognised shape no rule matches, such as a closed range or a lone
 *      placeholder atom) — `flip-filter-literal` never second-guesses which, and never guesses a
 *      mutation of its own for either.
 *
 * **`parentContext` is COMPUTED, not hardcoded**, via the same honest `isStatementPosition` hint
 * `swap-find-direction` and `swap-modify-flag` use. None of the guards above restrict this operator
 * to statement position — unlike `remove-setrange` and `validate-to-assign`, both deletions/rebuilds
 * whose own `isStatementPosition` guard is what lets them hardcode the literal — and this operator
 * does not need one either: a splice never removes a statement or changes control flow, so it stays
 * safe in expression position too (`if F then Rec.SetFilter(...)`, an un-braced then-branch, measures
 * `isStatementPosition` false and is still claimed here rather than silently missed).
 *
 * **Emission is a SPLICE, not a rebuild** (§2.6), the same discipline `swap-find-direction.ts`'s
 * `replaceNameSpan` and `swap-modify-flag.ts`'s `replaceArgument` use: `node.text` is taken verbatim,
 * the filter-literal argument's span is computed relative to the call node's own start, and only
 * that span is replaced with the newly quoted, mutated literal text. Every other character in the
 * call — receiver, method-name casing, field argument, later value arguments, any trivia between
 * arguments — passes through unchanged. Guarded exactly like those two splices: if the literal
 * node's span does not fall inside the call node's own text (should be impossible for a genuine
 * descendant), no mutant is produced rather than corrupted AL.
 *
 * `before: node` (the whole call), never the literal alone: R134's own roadmap row assumed the
 * mutated node would be the literal, but making `before` the whole call is what lets this mutant
 * coexist with Tier-1 `void-method-call`'s deletion under dedup (§2.7) — both set `before: node` for
 * the same call, and `after.text` is never empty for this operator (a splice of a non-empty literal
 * is never empty text), so the two identities always differ by that one field and neither displaces
 * the other.
 *
 * **Why a wrong emission here is costlier than usual.** A mutation this operator emits becomes DATA
 * handed to Business Central at runtime, inside a filter expression BC itself parses. An emission
 * that BC rejects kills the covering test from inside the platform with no assertion having run,
 * scored `killed` with nothing in the report distinguishing it from a real kill (R138). The parser
 * this file consumes is the guard for the filter's CONTENT; this file is the guard for everything
 * around it, which is why every splice here is offset-guarded rather than assumed safe.
 *
 * Documented limits, inherited from `claimsRecordMethod` (`./receiver.ts`): the parenthesis-less call
 * form never reaches this operator; a `pageextension`'s implicit `Rec` is refused; a
 * `tableextension`'s resolves fully.
 */
export const flipFilterLiteral: MutationOperator = {
  name: OPERATOR_NAME,
  version: OPERATOR_VERSION,
  tier: 2,
  targetNodeKinds: [ALNodeKind.procedure_call],
  producesNodeKinds: [ALNodeKind.procedure_call],
  requiresSemantic: ["symbol-table"],

  targets(node: ALSyntaxNode, ctx: SemanticContext): boolean {
    if (node.kind !== ALNodeKind.procedure_call) return false;
    return plannedFilterMutation(node, ctx) !== null;
  },

  generate(node: ALSyntaxNode, ctx: SemanticContext): readonly MutationSpec[] {
    const plan = plannedFilterMutation(node, ctx);
    if (plan === null) return [];

    const replacementLiteral = quoteALString(plan.mutation.mutated);
    const mutatedText = spliceLiteral(node, plan.literalNode, replacementLiteral);
    if (mutatedText === null) return [];

    return [
      {
        operatorName: OPERATOR_NAME,
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
      name: "flips a negation comparator inside a SetFilter literal, in statement position",
      sourceAL: `codeunit 50120 "C" { procedure P(No: Code[20]) var Cust: Record Customer; begin Cust.SetFilter("No.", '<>%1', No); end; }`,
      expectedSpecs: [
        {
          parentContext: "statement-position",
          beforeText: `Cust.SetFilter("No.", '<>%1', No)`,
          afterText: `Cust.SetFilter("No.", '=%1', No)`,
        },
      ],
    },
  ],
};

/** The one claimed literal node plus the single mutation the ladder found for it. */
interface FilterPlan {
  readonly literalNode: ALSyntaxNode;
  readonly mutation: FilterMutation;
}

/**
 * The shared guard chain (spec §2.1, in order): is `node` a `SetFilter` call this project's source
 * proves is the AL builtin, does it carry at least two arguments, is the second a plain string
 * literal, does it unquote, and does the mutation ladder find a rule that applies? Returns `null` for
 * anything any step refuses, or the claimed literal node plus the ladder's single mutation.
 *
 * Both `targets()` and `generate()` call this one function so neither can drift from the other on
 * which sites produce a mutant — the same shared-helper shape `swap-find-direction`'s
 * `claimedDirection` and `validate-to-assign`'s `validateArguments`+`isFieldIdentifier` pair use.
 */
function plannedFilterMutation(node: ALSyntaxNode, ctx: SemanticContext): FilterPlan | null {
  if (node.kind !== ALNodeKind.procedure_call) return null;
  if (!claimsRecordMethod(node, ctx, METHOD_NAME)) return null;

  const count = countArguments(node);
  // Paired with the `literalNode === undefined` check below: red-checked TOGETHER (not
  // separately — each alone stayed green), removing BOTH turns this into a crash reading
  // `.kind` off `undefined` for `SetFilter(F)`. Either one alone is redundant with the other by
  // construction (`exactArguments(node, count)` always returns an array of length `count`), so
  // do not delete one on the strength of a red-check that only defeated the other.
  if (count < MIN_ARGUMENT_COUNT) return null;

  const args = exactArguments(node, count);
  if (args === null) return null;
  const literalNode = args[FILTER_TEXT_ARGUMENT_INDEX];
  // Paired with the `count < MIN_ARGUMENT_COUNT` check above — see that comment.
  if (literalNode === undefined) return null;
  // Paired with the `content === null` check below: red-checked TOGETHER, removing BOTH turns
  // this into a crash inside `classifyContent`'s own `content.split("|")` for a non-literal
  // second argument like `SetFilter(F, SomeVar)`. Each alone is currently redundant with the
  // other (no other node kind's `.text` matches `unquoteALString`'s `'...'` shape today), so a
  // red-check that defeats only one proves nothing about the pair.
  if (literalNode.kind !== ALNodeKind.text_literal) return null;

  const content = unquoteALString(literalNode.text);
  // Paired with the `literalNode.kind !== ALNodeKind.text_literal` check above — see that comment.
  if (content === null) return null;

  const mutation = mutateFilterContent(content);
  if (mutation === null) return null;

  return { literalNode, mutation };
}

/**
 * The honest `parentContext` for this site, identical in shape to `swap-find-direction`'s
 * `parentContextOf`: none of the guards above restrict this operator to statement position, so
 * hardcoding `"statement-position"` would state something `isStatementPosition` itself measures as
 * false for a call sitting as an `if`'s un-braced then-branch or inside an expression.
 */
function parentContextOf(node: ALSyntaxNode): ParentContextHint {
  return isStatementPosition(node) ? "statement-position" : "expression-position";
}

/**
 * Rewrite `node`'s full text with only `literalNode`'s span replaced by `replacementLiteral` (an
 * already-quoted AL string literal, from `quoteALString`). Null when `literalNode`'s byte range does
 * not fall within `node`'s own text — should be impossible for a genuine descendant, guarded rather
 * than assumed, mirroring `swap-find-direction.ts`'s `replaceNameSpan` and
 * `swap-modify-flag.ts`'s `replaceArgument`.
 */
function spliceLiteral(
  node: ALSyntaxNode,
  literalNode: ALSyntaxNode,
  replacementLiteral: string,
): string | null {
  const start = literalNode.startIndex - node.startIndex;
  const end = literalNode.endIndex - node.startIndex;
  const text = node.text;
  if (start < 0 || end > text.length) return null;
  return `${text.slice(0, start)}${replacementLiteral}${text.slice(end)}`;
}
