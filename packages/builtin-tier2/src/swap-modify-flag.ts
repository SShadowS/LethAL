import { claimsRecordMethod } from "@lethal/engine";
import {
  ALNodeKind,
  type ALSyntaxNode,
  type MutationOperator,
  type MutationSpec,
  type ParentContextHint,
  type PlatformKillMechanism,
  type SemanticContext,
  isStatementPosition,
} from "@lethal/operator-sdk";
import { forcedTriggerCanRaise, resolveForcedTrigger } from "./forced-trigger-raise";
import { insertSkipCanRaise } from "./insert-key-assignment";
import { exactArguments, soleArgument, synthesizeAfter } from "./mutate-helpers";

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
 * R138. The one method of the three whose skipped trigger can ADD an error rather than remove one —
 * see `PlatformKillMechanism` (engine) for the mechanism and for the ruling that `Delete`/`Modify`
 * get none. Matched case-insensitively, like every other method comparison here.
 */
const PLATFORM_KILL_METHOD = "Insert";

/**
 * The tag `Insert` mutants carry. Declared as a typed constant rather than an inline string so a
 * value the engine's union does not know is a compile error here, at the one place that writes it.
 *
 * R143 gave it a detector: `insertSkipCanRaise` (`./insert-key-assignment.ts`) resolves the
 * receiver's table, finds its `OnInsert` and checks whether that trigger assigns a primary-key
 * field. Unlike `write-txn-codeunit-run`'s detector, which fires only on an exact measured shape,
 * this one is a REFUSAL detector: it drops the tag only where the mechanism is provably
 * unavailable, and a receiver the project cannot resolve keeps it. So the tag still means "a kill
 * here CAN be the platform; read it", never "this kill is false".
 */
const RUN_TRIGGER_SKIPPED_INSERT: PlatformKillMechanism = "run-trigger-skipped-insert";

/**
 * R165. The tag the FORWARD direction carries, declared the same typed way so a value the engine's
 * union does not know is a compile error at the one place that writes it.
 */
const RUN_TRIGGER_FORCED: PlatformKillMechanism = "run-trigger-forced";

/** What the forward direction writes into an argument-less call. */
const TRUE_REPLACEMENT = "true";

/**
 * Single source of truth for both places this operator's version must agree
 * (docs/superpowers/specs/2026-08-12-r136-tier2-trio-design.md §2.1): the `version` field below and
 * the `operatorVersion` literal `generate()` writes into every `MutationSpec`. The manifest, and
 * therefore every provenance claim downstream of it, carries the LATTER, not the former: see
 * `packages/runner/tests/operator-version-invariant.test.ts`, which asserts the two can never
 * diverge for any registered operator, this one included.
 */
/**
 * R165 bumped this to 1.2.0: MINOR. The operator GAINED the argument-less form and changed nothing
 * about the mutants it already emitted, so every existing mutant keeps its identity and its history
 * (design.md §5.1 resets history on a MAJOR bump only).
 */
const OPERATOR_VERSION = "1.2.0";

/**
 * `SwapModifyFlag`: rewrite `<rec>.Modify(true)` -> `<rec>.Modify(false)`, and, since 1.1.0, the
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
 * the mutant is scored `killed` without the suite having earned it.
 *
 * Since R138 the `Insert` mutants declare `run-trigger-skipped-insert`, so the report's
 * platform-artifact screen groups them. `Delete` and `Modify` declare nothing, and that is a RULING,
 * not an omission: skipping `OnDelete`/`OnModify` writes LESS than the unmutated program, never
 * more, and the row is still located by the same key, so there is no error the mutation can add.
 *
 * R143 NARROWED the `Insert` tag from "every one" to "every one whose mechanism is not provably
 * unavailable": the receiver's table is resolved, and a table whose `OnInsert` does not assign the
 * primary key (or has no `OnInsert` at all) loses the tag. A receiver this project cannot resolve
 * KEEPS it — see `insertSkipCanRaise` (`./insert-key-assignment.ts`) for that ruling, its three
 * measured limits, and why a screen resolves the unknown case in the opposite direction from every
 * other Tier-2 guard. The tag still means "read this kill", never "this kill is false".
 *
 * The verdict does NOT move. A diagnosis never re-scores a mutant (R72's discipline).
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
    const method = claimedRunTriggerMethod(node, ctx);
    if (method === null) return false;
    // The SKIP direction: an explicit `true` to flip to `false`.
    if (booleanTrueArgument(node) !== null) return true;
    // R165, the FORWARD direction: an argument-less call, which means `RunTrigger = false`.
    return forcedTriggerSite(node, ctx, method) !== null;
  },

  generate(node: ALSyntaxNode, ctx: SemanticContext): readonly MutationSpec[] {
    const arg = booleanTrueArgument(node);
    if (arg === null) return generateForced(node, ctx);
    const mutatedText = replaceArgument(node, arg, FALSE_REPLACEMENT);
    if (mutatedText === null) return [];
    // R138: the tag follows the matched METHOD, not the operator. Re-asking rather than threading
    // the name from `targets()` — `generate()` is called on nodes `targets()` accepted, but the two
    // are separate entry points and an operator that assumed otherwise would be relying on the
    // walker's calling convention rather than on its own guards.
    const method = claimedRunTriggerMethod(node, ctx);
    // R143: and, for `Insert`, only where the mechanism is not PROVABLY unavailable — see
    // `insertSkipCanRaise` (`insert-key-assignment.ts`) for the four cases and for why an
    // unresolvable receiver keeps the tag rather than losing it.
    const platformKillMechanism =
      method !== null &&
      method.toLowerCase() === PLATFORM_KILL_METHOD.toLowerCase() &&
      insertSkipCanRaise(node, ctx)
        ? RUN_TRIGGER_SKIPPED_INSERT
        : undefined;

    return [
      {
        operatorName: "lethal.swap-modify-flag",
        operatorVersion: OPERATOR_VERSION,
        astNodeId: `${node.startIndex}-${node.endIndex}`,
        before: node,
        after: synthesizeAfter(node, mutatedText),
        parentContext: parentContextOf(node),
        ...(platformKillMechanism !== undefined ? { platformKillMechanism } : {}),
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
 * R165 — the forward direction's site test: an ARGUMENT-LESS run-trigger call whose receiver's table
 * this project declares AND which declares the matching trigger. Returns the trigger node, or `null`
 * to refuse.
 *
 * Both halves of that scope are refusals with reasons, measured before the operator was written
 * (`scripts/r165-probe/`, 394 argument-less calls on `do-rel2/Cloud`):
 *
 *   - **table not declared here** (81 sites, plus 93 with an implicit `Rec` receiver). This project
 *     cannot see a base-app trigger, so no screen could classify a kill at such a site, and R143's
 *     "tag when unresolvable" answer would tag every one of them, which separates nothing.
 *   - **table declared but no matching trigger** (171 sites). Forcing a trigger that does not exist
 *     is close to equivalent, and a wave of near-universal survivors is exactly what
 *     `RemoveSetLoadFields` was refused for. "Close to" rather than "provably": running triggers
 *     also raises the platform's integration events, which a subscriber elsewhere can observe. So
 *     this is a scoping COST, recorded as one, not an equivalence proof.
 *
 * That leaves 49 claimable sites on that corpus — above R13's bar of 13, and smaller than the 62 the
 * SKIP direction claims there, which is the opposite of what R165 first estimated.
 */
function forcedTriggerSite(
  node: ALSyntaxNode,
  ctx: SemanticContext,
  method: string,
): ALSyntaxNode | null {
  if (exactArguments(node, 0) === null) return null;
  return resolveForcedTrigger(node, ctx, method);
}

/** R165 — emit `<receiver>.<Method>(true)` for an argument-less run-trigger call. */
function generateForced(node: ALSyntaxNode, ctx: SemanticContext): readonly MutationSpec[] {
  const method = claimedRunTriggerMethod(node, ctx);
  if (method === null) return [];
  const trigger = forcedTriggerSite(node, ctx, method);
  if (trigger === null) return [];
  // The call's own text with `true` placed inside its empty parentheses. Sliced rather than rebuilt
  // so the receiver, casing and any interior trivia survive exactly as written.
  const text = node.text;
  const open = text.lastIndexOf("(");
  const close = text.lastIndexOf(")");
  if (open < 0 || close < open) return [];
  const mutatedText = `${text.slice(0, open + 1)}${TRUE_REPLACEMENT}${text.slice(close)}`;
  return [
    {
      operatorName: "lethal.swap-modify-flag",
      operatorVersion: OPERATOR_VERSION,
      astNodeId: `${node.startIndex}-${node.endIndex}`,
      before: node,
      after: synthesizeAfter(node, mutatedText),
      parentContext: parentContextOf(node),
      // Tagged only where the trigger body PROVABLY contains a raise-capable statement. Unlike the
      // skip direction's blanket tag, this one is emitted from the trigger itself, which is
      // available precisely because the site test refused everything it could not resolve.
      ...(forcedTriggerCanRaise(trigger) ? { platformKillMechanism: RUN_TRIGGER_FORCED } : {}),
    },
  ];
}

/**
 * WHICH of `RUN_TRIGGER_METHODS` does `node` call on a proven record receiver, or `null` for none?
 * Tries each name in order through `claimsRecordMethod` and short-circuits on the first match: a
 * non-matching node costs at most three cheap callee-name comparisons and nothing more, since
 * `claimsRecordMethod` itself rejects on the callee name before doing any symbol-table work.
 *
 * Returns the matched NAME rather than a boolean, which is what R138 needed: only the `Insert`
 * mutants declare a `PlatformKillMechanism`, so `generate()` has to know which of the three names
 * claimed. The name returned is this file's own spelling from `RUN_TRIGGER_METHODS`, not the
 * source's — `claimsRecordMethod` matches case-insensitively, so `INSERT(True)` claims under
 * `"Insert"` and is tagged exactly as `Insert(true)` is.
 */
function claimedRunTriggerMethod(node: ALSyntaxNode, ctx: SemanticContext): string | null {
  return (
    RUN_TRIGGER_METHODS.find((methodName) => claimsRecordMethod(node, ctx, methodName)) ?? null
  );
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
