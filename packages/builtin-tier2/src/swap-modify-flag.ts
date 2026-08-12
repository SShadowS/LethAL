import {
  ALNodeKind,
  type ALSyntaxNode,
  type MutationOperator,
  type MutationSpec,
  type ParentContextHint,
  type SemanticContext,
  isStatementPosition,
} from "@lethal/operator-sdk";
import { soleArgument, synthesizeAfter } from "./mutate-helpers";
import { claimsRecordMethod } from "./receiver";

const TRUE_LITERAL = "true";
const FALSE_REPLACEMENT = "false";

/**
 * The three AL record methods that take a run-trigger flag boolean and mutate the record. Kept as
 * one list rather than three separate `targets()` branches so a fourth such method (there is not
 * one today) is a one-line addition, and so `generate()` cannot drift from `targets()` on which
 * names are in scope.
 */
const RUN_TRIGGER_METHODS = ["Modify", "Insert", "Delete"] as const;

/**
 * Single source of truth for both places this operator's version must agree
 * (docs/superpowers/specs/2026-08-12-r136-tier2-trio-design.md §2.1): the `version` field below and
 * the `operatorVersion` literal `generate()` writes into every `MutationSpec`. The manifest, and
 * therefore every provenance claim downstream of it, carries the LATTER, not the former: see
 * `packages/runner/tests/operator-version-invariant.test.ts`, which asserts the two can never
 * diverge for any registered operator, this one included.
 */
const OPERATOR_VERSION = "1.1.0";

/**
 * `SwapModifyFlag` — rewrite `<rec>.Modify(true)` -> `<rec>.Modify(false)`, and, since 1.1.0, the
 * same rewrite for `Insert` and `Delete`.
 *
 * Spec: docs/superpowers/specs/2026-07-25-tier2-mutation-operators-design.md §4 table + §4 intro;
 * extended to `Insert`/`Delete` by docs/superpowers/specs/2026-08-12-r136-tier2-trio-design.md §2.1.
 *
 * THE NAME IS HISTORICAL. It shipped covering `Modify` alone and now covers three record methods
 * that share one shape: each takes a run-trigger flag boolean and mutates the record. Renaming it
 * was considered and rejected: `operatorName` is part of the baseline identity key
 * (`packages/runner/src/selection.ts`), so a rename would re-key every existing
 * `swap-modify-flag` row in the frozen baselines, exactly the cost the MINOR version bump below is
 * designed to avoid.
 *
 * ONLY THE `true` -> `false` DIRECTION IS COVERED. The reverse (`false` to `true`) is a different
 * bug class: it ADDS a trigger run rather than skipping one, so its observable effect is whatever
 * side effect that trigger has, which an ordinary suite rarely asserts on. Its population is also
 * unmeasured. Out of scope, recorded here so it is not read as an oversight later.
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
 *   1. `claimsAnyRunTriggerMethod`: is this actually one of the three AL record methods above, on
 *      a record? Tries each name in `RUN_TRIGGER_METHODS` through `claimsRecordMethod`
 *      (Task 2, `./receiver.ts`), which handles the implicit-`Rec` form, case-insensitivity, and
 *      every receiver/shadowing refusal, short-circuiting on the first match. Everything downstream
 *      of the claim (the boolean-argument predicate, the argument splice, and `parentContextOf`) is
 *      already method-name-agnostic and needed no change to cover the two new names.
 *   2. `booleanTrueArgument` — is the (sole) argument the literal `true`, case-insensitively?
 *      `Modify(SomeBoolean)` is refused: the semantic layer cannot evaluate an arbitrary Boolean
 *      expression, so anything other than the literal `true` token is out of scope — literal
 *      `true` only, never a variable or comparison that merely happens to be Boolean-typed.
 *      `Modify()` (the zero-argument, default-`RunTrigger=false` form) and an already-`false`
 *      call are refused for the same reason: there is no literal-`true` argument node to swap.
 *      Likewise `Insert(true, true)` (two arguments) is refused: `soleArgument` requires exactly
 *      one.
 *
 * The replacement always emits lowercase `false`, regardless of the input literal's own case:
 * `Modify(TRUE)` and `MODIFY(True)` both produce a call ending in `...Modify(false)` — only the
 * boolean VALUE carries meaning here, not the literal's spelling. The method name and receiver
 * either side of the argument are left exactly as written, so `MODIFY(True)` keeps `MODIFY`'s own
 * casing; only the argument span is spliced.
 *
 * THE VERSION BUMP IS MINOR, NOT MAJOR, AND THAT IS A DELIBERATE IDENTITY DECISION. A baseline row
 * is keyed on `astHash|codeunitName|operatorName|operatorMajor`
 * (`packages/runner/src/selection.ts`), and `astHash` hashes only the ORIGINAL subtree, never the
 * operator's version or the replacement text (`astSubtreeHash`, `packages/schemata/src/project.ts`).
 * `operatorMajor` is `Number(operatorVersion.split(".")[0])`, so 1.0.0 and 1.1.0 share a major digit
 * and every existing `Modify(true)` row keeps its identity and its recorded verdict across the bump.
 * A MAJOR bump would buy a distinction nothing reads, at the cost of re-keying three frozen
 * baselines. The full version string still reaches every manifest entry
 * (`MutantManifestEntry.operatorVersion`), so provenance is not lost, only identity-insensitive.
 *
 * PLATFORM-KILL CLASS: `Insert(true)` to `Insert(false)` can kill through a PLATFORM error rather
 * than an assertion. The common real shape is a table whose `OnInsert` assigns the primary key from
 * a No. Series; with the trigger skipped the key stays blank, and either a second insert of the same
 * shape raises a duplicate-key error or a later `Get`/`Modify` on the expected key raises "the
 * record does not exist". Either way the test dies on the platform before any assertion runs, and
 * the mutant is scored `killed` without the suite having earned it. This operator does not tag that
 * class (no `PlatformKillMechanism` is emitted here); closing the screen gap is `docs/roadmap/R138.md`,
 * filed separately so the next reader finds the class named rather than rediscovering it live.
 *
 * Documented limits:
 *   - (spec §4 table) only observable when the table's `OnModify`/`OnInsert`/`OnDelete` does
 *     something the test asserts. The semantic layer cannot see base-app triggers, so equivalent
 *     mutants on base-app records cannot be hinted away.
 *   - Both `tableextension` and `pageextension` ARE admitted as enclosing objects (R30): a site
 *     written inside either can be claimed. Only a `pageextension`'s implicit `Rec` is refused,
 *     because its record is the extended page's `SourceTable`, usually invisible to this project;
 *     a `tableextension`'s implicit `Rec` resolves fully, to the extended table. See `OBJECT_KINDS`
 *     in `./receiver.ts` for the rest of that predicate's documented limits.
 */
export const swapModifyFlag: MutationOperator = {
  name: "lethal.swap-modify-flag",
  version: OPERATOR_VERSION,
  tier: 2,
  targetNodeKinds: [ALNodeKind.procedure_call],
  producesNodeKinds: [ALNodeKind.procedure_call],
  requiresSemantic: ["symbol-table"],

  targets(node: ALSyntaxNode, ctx: SemanticContext): boolean {
    if (node.kind !== ALNodeKind.procedure_call) return false;
    if (!claimsAnyRunTriggerMethod(node, ctx)) return false;
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
          // Not statement position — `isStatementPosition` measures `false` for an un-braced
          // then-branch, and the hint says so rather than repeating the statement-position claim.
          parentContext: "expression-position",
          beforeText: "Cust.Modify(true)",
          afterText: "Cust.Modify(false)",
        },
      ],
    },
    {
      name: "sees through a comment inside the parentheses",
      sourceAL: `codeunit 50142 "C" { procedure P() var Cust: Record Customer; begin Cust.Modify(true /* run the trigger */); end; }`,
      expectedSpecs: [
        {
          parentContext: "statement-position",
          beforeText: "Cust.Modify(true /* run the trigger */)",
          afterText: "Cust.Modify(false /* run the trigger */)",
        },
      ],
    },
    {
      name: "rewrites Insert(true) to Insert(false) in statement position",
      sourceAL: `codeunit 50143 "C" { procedure P() var Cust: Record Customer; begin Cust.Insert(true); end; }`,
      expectedSpecs: [
        {
          parentContext: "statement-position",
          beforeText: "Cust.Insert(true)",
          afterText: "Cust.Insert(false)",
        },
      ],
    },
    {
      name: "rewrites Delete(true) to Delete(false) in statement position",
      sourceAL: `codeunit 50144 "C" { procedure P() var Cust: Record Customer; begin Cust.Delete(true); end; }`,
      expectedSpecs: [
        {
          parentContext: "statement-position",
          beforeText: "Cust.Delete(true)",
          afterText: "Cust.Delete(false)",
        },
      ],
    },
  ],
};

/**
 * Does `node` call ANY of `RUN_TRIGGER_METHODS` on a proven record receiver? Tries each name in
 * order through `claimsRecordMethod` and short-circuits on the first match: a non-matching node
 * costs at most three cheap callee-name comparisons and nothing more, since `claimsRecordMethod`
 * itself rejects on the callee name before doing any symbol-table work.
 */
function claimsAnyRunTriggerMethod(node: ALSyntaxNode, ctx: SemanticContext): boolean {
  return RUN_TRIGGER_METHODS.some((methodName) => claimsRecordMethod(node, ctx, methodName));
}

/**
 * The honest `parentContext` for this site.
 *
 * Unlike the three deletion operators, this one claims sites that are NOT in statement position
 * (`Ok := Cust.Modify(true)`, `if not Cust.Modify(true) then ...`, an un-braced then-branch).
 * Hardcoding `"statement-position"` there would state something `isStatementPosition` itself
 * measures as false. Nothing downstream branches on the hint today — it is validated
 * (`spec-validation.ts`) and reported — which is precisely why it must not be allowed to drift
 * into a lie.
 */
function parentContextOf(node: ALSyntaxNode): ParentContextHint {
  return isStatementPosition(node) ? "statement-position" : "expression-position";
}

/**
 * Does the call carry exactly one argument, and is it the literal `true` (any case)?
 *
 * Returns the argument node so the caller can splice its span, or `null` for anything else: zero
 * arguments (the default-`RunTrigger=false` form), more than one argument (not a real `Modify`
 * overload but not this predicate's contract to police), or a sole argument that is not a
 * `boolean_literal` node at all (an identifier, a comparison, the literal `false`) — the only
 * literal this operator ever swaps is `true`.
 *
 * "Exactly one argument" comes from `soleArgument` (`./mutate-helpers.ts`), shared with
 * `RemoveSetRange`'s `countArguments` so the two cannot drift apart on the same grammar fact: the
 * grammar emits comments as **named** children of an `argument_list`, so a plain
 * `namedChildren.length === 1` test refuses a `Modify(true)` with a comment inside its
 * parentheses. Here that refusal was merely a missed site; in `RemoveSetRange` the same blindness
 * produced an inverted mutation, which is why both now read the argument list through one helper.
 */
function booleanTrueArgument(node: ALSyntaxNode): ALSyntaxNode | null {
  const only = soleArgument(node);
  if (only === null) return null;
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
