import {
  ALNodeKind,
  type ALSyntaxNode,
  type MutationOperator,
  type MutationSpec,
  type SemanticContext,
} from "@lethal/operator-sdk";
import { synthesizeAfter } from "./mutate-helpers";
import { claimsRecordMethod } from "./receiver";

const METHOD_NAME = "Modify";
/** `argument_list` isn't in `ALNodeKind`; the field name is grammar-stable regardless. */
const ARGUMENTS_FIELD = "arguments";
const TRUE_LITERAL = "true";
const FALSE_REPLACEMENT = "false";

/**
 * `SwapModifyFlag` — rewrite `<rec>.Modify(true)` -> `<rec>.Modify(false)`.
 *
 * Spec: docs/superpowers/specs/2026-07-25-tier2-mutation-operators-design.md §4 table + §4 intro.
 *
 * STRUCTURALLY DIFFERENT from the three deletion operators (`RemoveTestField`, `RemoveSetRange`,
 * `RemoveCalcFields`), and deliberately so — this is the point of this operator existing:
 *
 * Every deletion operator requires statement position (`isStatementPosition`) because removing a
 * call sitting as an `if`'s then-branch would leave `if Cond then ;` — a control-flow change, not
 * a statement deletion. This operator REWRITES an argument instead of deleting the call, so that
 * hazard does not apply: `if Rec.FindSet() then Rec.Modify(true);` becomes
 * `if Rec.FindSet() then Rec.Modify(false);` — still exactly one statement, same shape, no
 * control-flow change. Restricting this operator to statement position would therefore be wrong,
 * not merely more conservative: it would silently miss `if Rec.FindSet() then Rec.Modify(true);`,
 * a routine BC idiom, and the grammar probe (`scripts/probe-grammar-table.ts`) measured exactly
 * this shape in the fixture — `Modify` was the only targeted call that did NOT reach statement
 * position, precisely because the fixture writes it as a then-branch. Red-checked accordingly:
 * adding an `isStatementPosition` guard here must turn the then-branch conformance test RED (see
 * `tests/swap-modify-flag.test.ts`).
 *
 * A second, related consequence: because this operator's after-form (`Modify(false)`) differs
 * from Tier-1 `void-method-call`'s deletion (empty after), dedup does not fire at a
 * statement-position `Modify(true)` site — both mutants coexist there, exactly as
 * `conditional-boundary` and `negate-conditional` already coexist on one comparison expression.
 * That is intended, not a bug to "fix".
 *
 * Two guards:
 *
 *   1. `claimsRecordMethod` — is this actually the AL record method `Modify`, on a record?
 *      (Task 2, `./receiver.ts`.) Handles the implicit-`Rec` form, case-insensitivity, and every
 *      receiver/shadowing refusal.
 *   2. `booleanTrueArgument` — is the (sole) argument the literal `true`, case-insensitively?
 *      `Modify(SomeBoolean)` is refused: the semantic layer cannot evaluate an arbitrary Boolean
 *      expression, so anything other than the literal `true` token is out of scope — literal
 *      `true` only, never a variable or comparison that merely happens to be Boolean-typed.
 *      `Modify()` (the zero-argument, default-`RunTrigger=false` form) and an already-`false`
 *      call are refused for the same reason: there is no literal-`true` argument node to swap.
 *
 * The replacement always emits lowercase `false`, regardless of the input literal's own case:
 * `Modify(TRUE)` and `MODIFY(True)` both produce a call ending in `...Modify(false)` — only the
 * boolean VALUE carries meaning here, not the literal's spelling. The method name and receiver
 * either side of the argument are left exactly as written, so `MODIFY(True)` keeps `MODIFY`'s own
 * casing; only the argument span is spliced.
 *
 * Documented limit (spec §4 table): only observable when the table's `OnModify` does something the
 * test asserts. The semantic layer cannot see base-app triggers, so equivalent mutants on base-app
 * records cannot be hinted away.
 */
export const swapModifyFlag: MutationOperator = {
  name: "lethal.swap-modify-flag",
  version: "1.0.0",
  tier: 2,
  targetNodeKinds: [ALNodeKind.procedure_call],
  producesNodeKinds: [ALNodeKind.procedure_call],
  requiresSemantic: ["symbol-table"],

  targets(node: ALSyntaxNode, ctx: SemanticContext): boolean {
    if (node.kind !== ALNodeKind.procedure_call) return false;
    if (!claimsRecordMethod(node, ctx, METHOD_NAME)) return false;
    return booleanTrueArgument(node) !== null;
  },

  generate(node: ALSyntaxNode, _ctx: SemanticContext): readonly MutationSpec[] {
    const arg = booleanTrueArgument(node);
    if (arg === null) return [];
    const mutatedText = replaceArgument(node, arg, FALSE_REPLACEMENT);
    if (mutatedText === null) return [];

    return [
      {
        operatorName: "lethal.swap-modify-flag",
        operatorVersion: "1.0.0",
        astNodeId: `${node.startIndex}-${node.endIndex}`,
        before: node,
        after: synthesizeAfter(node, mutatedText),
        parentContext: "statement-position",
      },
    ];
  },

  conformanceTests: [
    {
      name: "rewrites Modify(true) to Modify(false) in statement position",
      sourceAL: `codeunit 50140 "C" { procedure P() var Cust: Record Customer; begin Cust.Modify(true); end; }`,
      expectedSpecs: [
        {
          parentContext: "statement-position",
          beforeText: "Cust.Modify(true)",
          afterText: "Cust.Modify(false)",
        },
      ],
    },
    {
      name: "rewrites Modify(true) sitting as an if's then-branch (not statement position)",
      sourceAL: `codeunit 50141 "C" { procedure P() var Cust: Record Customer; begin if Cust.FindSet() then Cust.Modify(true); end; }`,
      expectedSpecs: [
        {
          parentContext: "statement-position",
          beforeText: "Cust.Modify(true)",
          afterText: "Cust.Modify(false)",
        },
      ],
    },
  ],
};

/**
 * Does the call carry exactly one argument, and is it the literal `true` (any case)?
 *
 * Returns the argument node so the caller can splice its span, or `null` for anything else: zero
 * arguments (the default-`RunTrigger=false` form), more than one argument (not a real `Modify`
 * overload but not this predicate's contract to police), or a sole argument that is not a
 * `boolean_literal` node at all (an identifier, a comparison, the literal `false`) — the only
 * literal this operator ever swaps is `true`.
 */
function booleanTrueArgument(node: ALSyntaxNode): ALSyntaxNode | null {
  const argumentList = node.childForFieldName(ARGUMENTS_FIELD);
  if (argumentList === null) return null;
  const [only, ...rest] = argumentList.namedChildren;
  if (only === undefined || rest.length > 0) return null;
  if (only.kind !== ALNodeKind.boolean_literal) return null;
  return only.text.toLowerCase() === TRUE_LITERAL ? only : null;
}

/**
 * Rewrite `node`'s full text with only `arg`'s span replaced by `replacement`. Null when `arg`'s
 * byte range does not fall within `node`'s own text (should be impossible for a genuine
 * descendant, guarded rather than assumed — mirrors `return-value.ts`'s `replaceArgInExit`).
 */
function replaceArgument(
  node: ALSyntaxNode,
  arg: ALSyntaxNode,
  replacement: string,
): string | null {
  const start = arg.startIndex - node.startIndex;
  const end = arg.endIndex - node.startIndex;
  const text = node.text;
  if (start < 0 || end > text.length) return null;
  return `${text.slice(0, start)}${replacement}${text.slice(end)}`;
}
