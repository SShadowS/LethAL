import {
  type RunTriggerKind,
  claimedRunTriggerSkip,
  claimsRecordMethod,
  deleteSkipCanRaise,
  exactArguments,
  forceCanRaise,
  inMemberBody,
  insertSkipCanRaise,
  modifySkipCanRaise,
  receiverUnresolved,
} from "@lethal/engine";
import {
  ALNodeKind,
  type ALSyntaxNode,
  type MutationOperator,
  type MutationSpec,
  type PlatformKillMechanism,
  type SemanticContext,
} from "@lethal/operator-sdk";
import { hangCapableForMutatedNode, hasEnclosingLoop } from "./loop-hazard";
import { synthesizeAfter } from "./mutate-helpers";

const OPERATOR_NAME = "lethal.flip-boolean-literal";
/** R459: 1.1.0, MINOR. A two-argument `Insert`'s Booleans are no longer ceded, so the operator
 *  gains sites and changes no existing replacement; the identity tuple reads the major only. */
const OPERATOR_VERSION = "1.1.0";

/**
 * Parent kinds that make a boolean literal a CASE LABEL, where flipping it does not compile.
 *
 * `case Flag of true: ... false: ... end` — flip either label and both branches carry the same one,
 * which `alc` rejects with AL0402 ("Expression False cannot be specified more than once in a 'case'
 * statement"). MEASURED, not reasoned: the first draft of this operator claimed to compile "by
 * construction" because `true` and `false` are the only two values of AL's `Boolean` type, and the
 * compile probe failed 2 of 10 shapes on exactly this. That argument was true about the TYPE and
 * silent about the CONTEXT, which is the same way `swap-multiplicative`'s safety proof failed: true
 * about its operands, silent about the result type.
 *
 * A boolean in a branch BODY is untouched by this — its parent is the assignment or call it sits in,
 * not the branch itself. Costs 37 of 3,559 sites on the corpus, about 1%.
 */
const CASE_LABEL_PARENTS: ReadonlySet<string> = new Set(["case_branch", "case_statement"]);

/**
 * `FlipBooleanLiteral`: rewrite `true` to `false` and `false` to `true`.
 *
 * ROADMAP R159. The node-kind census marks `boolean` as claimed by no operator: 3,620 occurrences
 * inside procedure and trigger bodies on `do-rel2/Cloud`, and it is one of the most standard
 * operators in the mutation-testing literature.
 *
 * **The marginal number took three measurements and the two wrong ones are worth recording**, since
 * this row's own point 1 says overlap must be measured per candidate rather than assumed away:
 *
 *   - Counting a literal as overlapped when it sits INSIDE a span another operator claims gives 26
 *     marginal, because `empty-block` claims the enclosing block of nearly every one. That is wrong
 *     for the reason R159's point 2 states: a whole-block deletion is a coarse mutant and the
 *     fine-grained one is what separates suites. §3.2 displaces on the SAME site, not a containing
 *     one.
 *   - Counting only EXACT span matches gives 3,594 and misses a real duplicate, because
 *     `swap-modify-flag` claims the call `Rec.Modify(true)` rather than the literal inside it.
 *
 * Measured honestly: 3,620 total, 26 declarative, 72 ceded to `swap-modify-flag`, **3,522 marginal**
 * — 271x R13's bar of 13. Where they sit: `argument_list` 2,069, `assignment_statement` 904,
 * `exit_statement` 479, `comparison_expression` 33, `case_branch` 32, `case_statement` 5.
 *
 * **Why it compiles — after one refusal that had to be MEASURED to find.** `true` and `false` are the
 * only two values of AL's `Boolean` type, so the replacement is always the same type as the original.
 * That argument is true and it is not sufficient: a boolean in CASE LABEL position must also be
 * unique among its siblings, and flipping one there gives two branches the same label (AL0402). The
 * compile probe failed 2 of 10 shapes on it. `CASE_LABEL_PARENTS` is the refusal; everywhere else the
 * type argument does hold, verified against real `alc` on every shape the corpus contains.
 *
 * **`PlatformKillMechanism` only on a RunTrigger it skips (R-452) or forces (R-457).** Flipping a
 * value is ordinary changed behaviour. `Rec.Insert(true)` to `Insert(false)` skips a trigger and
 * can die on a duplicate key with no assertion, which is why R138 tagged it, and those sites are
 * ceded to `swap-modify-flag`, which carries the tag. `ModifyAll` and `DeleteAll` are NOT ceded, so their
 * RunTrigger flips are this operator's: `ModifyAll(F, V, true)` and `DeleteAll(true)` flipped to
 * `false` skip `OnModify`/`OnDelete` for every affected row, and carry the same tag as
 * `Modify`/`Delete`, from the same engine detector (`runTriggerTag`). The `false` -> `true`
 * direction FORCES the trigger, at `Modify`/`Insert`/`Delete` (a `false` there is not ceded) as well
 * as `ModifyAll`/`DeleteAll`, and carries `run-trigger-forced` unless `forceCanRaise` proves the
 * table has no such trigger and no observer of it in this project. R459: a two-argument
 * `Insert(RunTrigger, InsertWithSystemId)` is wholly this operator's (Tier 2 claims a sole `true`
 * only); its first literal is tagged both ways, its second gets no RunTrigger tag. R473: a sole
 * `true` on an UNRESOLVED receiver is not ceded (Tier 2 does not claim it), so its flip is this
 * operator's and keeps the skip tag of its kind, as R-364 rules for `ModifyAll`/`DeleteAll`.
 *
 * **Documented limits:**
 *   - Equivalence is not detected. A flipped boolean that no path reads is an equivalent mutant this
 *     operator cannot see, the same blind spot every Tier-1 operator has.
 *   - A boolean passed to a procedure that ignores it is a likely survivor and a likely shrug. The
 *     survivor list is a lead, not a verdict.
 */
export const flipBooleanLiteral: MutationOperator = {
  name: OPERATOR_NAME,
  version: OPERATOR_VERSION,
  tier: 1,
  targetNodeKinds: ["boolean"],
  producesNodeKinds: ["boolean"],
  requiresSemantic: ["symbol-table"],

  targets(node: ALSyntaxNode, ctx: SemanticContext): boolean {
    return flipped(node, ctx) !== null;
  },

  refusesHangCapable(node: ALSyntaxNode, ctx: SemanticContext): boolean {
    return flippedBeforeHang(node, ctx) !== null && hangCapableForMutatedNode(node, ctx) !== null;
  },

  generate(node: ALSyntaxNode, ctx: SemanticContext): readonly MutationSpec[] {
    const after = flipped(node, ctx);
    if (after === null) return [];
    const platformKillMechanism = runTriggerTag(node, ctx);
    return [
      {
        operatorName: OPERATOR_NAME,
        operatorVersion: OPERATOR_VERSION,
        astNodeId: `${node.startIndex}-${node.endIndex}`,
        before: node,
        after: synthesizeAfter(node, after),
        parentContext: "statement-position",
        ...(platformKillMechanism !== undefined ? { platformKillMechanism } : {}),
      },
    ];
  },

  conformanceTests: [
    {
      // Issue #7. `loop-truncate` owns a repeat's exit condition and rewrites it to `true`; this
      // operator flipping the same `false` to the same `true` at the same span made `dedupeSpecs`
      // throw and killed the run at planning. The refusal also removes the `until true` flip, which
      // never terminates.
      name: "REFUSES a repeat's exit condition, which loop-truncate owns",
      sourceAL: `codeunit 51704 "C" { procedure P() var I: Integer; begin I := 0; repeat I += 1; until false; end; }`,
      expectedSpecs: [],
    },
    {
      // GH-07 follow-up. `loop-skip` owns a while's condition and rewrites it to `false`; flipping
      // `while true` emitted the same `false` at the same span, the issue #7 collision one loop kind
      // over. The refusal also removes the `while false` flip, which never terminates.
      name: "REFUSES a while loop's condition, which loop-skip owns",
      sourceAL: `codeunit 51709 "C" { procedure P() var I: Integer; begin while true do begin I += 1; if I > 3 then exit; end; end; }`,
      expectedSpecs: [],
    },
    {
      name: "flips true in an argument",
      sourceAL: `codeunit 51700 "C" { procedure P() var Cust: Record Customer; begin Cust.SetAutoCalcFields(true); end; }`,
      expectedSpecs: [
        { parentContext: "statement-position", beforeText: "true", afterText: "false" },
      ],
    },
    {
      name: "flips false in an assignment",
      sourceAL: `codeunit 51701 "C" { procedure P() var Done: Boolean; begin Done := false; end; }`,
      expectedSpecs: [
        { parentContext: "statement-position", beforeText: "false", afterText: "true" },
      ],
    },
    {
      name: "flips a returned boolean",
      sourceAL: `codeunit 51702 "C" { procedure P(): Boolean begin exit(true); end; }`,
      expectedSpecs: [
        { parentContext: "statement-position", beforeText: "true", afterText: "false" },
      ],
    },
    {
      name: "REFUSES a boolean in a table PROPERTY: there is no statement to guard",
      sourceAL: `table 51710 "T" { fields { field(1; "No."; Code[20]) { } } keys { key(PK; "No.") { Clustered = true; } } }`,
      expectedSpecs: [],
    },
    {
      name: "REFUSES a case LABEL: flipping it duplicates the other branch's label (AL0402)",
      sourceAL: `codeunit 51706 "C" { procedure P(F: Boolean): Integer begin case F of true: exit(1); false: exit(0); end; end; }`,
      expectedSpecs: [],
    },
    {
      name: "CEDES Modify's run-trigger flag to swap-modify-flag",
      sourceAL: `codeunit 51703 "C" { procedure P() var Cust: Record Customer; begin Cust.Modify(true); end; }`,
      expectedSpecs: [],
    },
    {
      // `true` only. The first draft of this case used `Insert(false)` and went red the moment the
      // cession was narrowed correctly — `swap-modify-flag` has no false -> true direction, so that
      // literal is this operator's. The conformance suite caught a stale expectation, which is what
      // it is for.
      name: "CEDES Insert's run-trigger flag when it is `true`",
      sourceAL: `codeunit 51704 "C" { procedure P() var Cust: Record Customer; begin Cust.Insert(true); end; }`,
      expectedSpecs: [],
    },
    {
      name: "does NOT cede Modify(false): swap-modify-flag has no false -> true direction",
      sourceAL: `codeunit 51707 "C" { procedure P() var Cust: Record Customer; begin Cust.Modify(false); end; }`,
      expectedSpecs: [
        { parentContext: "statement-position", beforeText: "false", afterText: "true" },
      ],
    },
    {
      name: "does NOT cede a boolean argument to some OTHER method",
      sourceAL: `codeunit 51705 "C" { procedure P() var Cust: Record Customer; begin Cust.SetAutoCalcFields(false); end; }`,
      expectedSpecs: [
        { parentContext: "statement-position", beforeText: "false", afterText: "true" },
      ],
    },
    {
      name: "REFUSES an in-loop boolean guard that advances the condition (R196), and keeps the preheader one",
      sourceAL: `codeunit 51708 "C" { procedure P() var Continue: Boolean; begin Continue := true; while Continue do Continue := false; end; }`,
      expectedSpecs: [
        {
          parentContext: "statement-position",
          beforeText: "true",
          afterText: "false",
          hangCapable: null,
        },
      ],
    },
    {
      name: "REFUSES a literal nested in a loop condition, or guarding an in-loop if (R239)",
      sourceAL: `codeunit 51711 "C" { procedure P() var Go: Boolean; begin while not (Go or false) do if true then exit; end; }`,
      expectedSpecs: [],
    },
  ],
};

/**
 * R-452: the Record methods whose RunTrigger argument this operator flips, its position under an
 * EXACT argument count, the trigger kind it runs, and the skip detector that judges a `true` ->
 * `false` flip. AL has no named arguments (alc 18: AL0104 on `RunTrigger := true`), so the position
 * is the whole answer. R-457 adds `Modify`/`Delete`/`Insert`: their `true` is ceded to
 * `swap-modify-flag` wherever it claims the call, so a claimed `true` never reaches this operator.
 * R473: their `skip` is reached only on an UNRESOLVED receiver, which Tier 2 does not claim, and
 * there `runTriggerTag` keeps the tag (R-364's rule) without calling `canRaise`.
 */
const RUN_TRIGGER_ARGUMENTS = [
  {
    method: "ModifyAll",
    count: 3,
    index: 2,
    kind: "modify",
    skip: { canRaise: modifySkipCanRaise, tag: "run-trigger-skipped-modify" },
  },
  {
    method: "DeleteAll",
    count: 1,
    index: 0,
    kind: "delete",
    skip: { canRaise: deleteSkipCanRaise, tag: "run-trigger-skipped-delete" },
  },
  {
    method: "Modify",
    count: 1,
    index: 0,
    kind: "modify",
    skip: { canRaise: modifySkipCanRaise, tag: "run-trigger-skipped-modify" },
  },
  {
    method: "Delete",
    count: 1,
    index: 0,
    kind: "delete",
    skip: { canRaise: deleteSkipCanRaise, tag: "run-trigger-skipped-delete" },
  },
  {
    method: "Insert",
    count: 1,
    index: 0,
    kind: "insert",
    skip: { canRaise: insertSkipCanRaise, tag: "run-trigger-skipped-insert" },
  },
  // R459: `Insert(RunTrigger, InsertWithSystemId)`. Index 1 runs no trigger and has no row.
  {
    method: "Insert",
    count: 2,
    index: 0,
    kind: "insert",
    skip: { canRaise: insertSkipCanRaise, tag: "run-trigger-skipped-insert" },
  },
] as const satisfies readonly {
  method: string;
  count: number;
  index: number;
  kind: RunTriggerKind;
  skip: {
    canRaise: (node: ALSyntaxNode, ctx: SemanticContext) => boolean;
    tag: PlatformKillMechanism;
  } | null;
}[];

/**
 * The tag for a literal that IS the RunTrigger argument of a Record method in
 * `RUN_TRIGGER_ARGUMENTS` (the argument itself, span-equal, read comment-aware through
 * `exactArguments`; a `(true)` or any other expression around it is not). A `true` (skip) gets the
 * skip tag when skipping that trigger is not proven harmless; a `false` (force) gets
 * `run-trigger-forced` unless `forceCanRaise` proves nothing runs. Else `undefined`.
 */
function runTriggerTag(
  node: ALSyntaxNode,
  ctx: SemanticContext,
): PlatformKillMechanism | undefined {
  const value = node.text.toLowerCase();
  const call = node.parent?.parent;
  if (call?.kind !== ALNodeKind.procedure_call) return undefined;
  for (const { method, count, index, kind, skip } of RUN_TRIGGER_ARGUMENTS) {
    const arg = exactArguments(call, count)?.[index];
    if (arg === undefined || arg.startIndex !== node.startIndex || arg.endIndex !== node.endIndex) {
      continue;
    }
    // R-364: an UNRESOLVED receiver keeps the SKIP tag (R143's rule; screen tagging is
    // conservative). `claimsRecordMethod` refuses it, which is right for claiming and is left
    // unchanged. R460: the forcing `false` (R-457) is tagged there too, at every method, since
    // nothing proves the forced trigger harmless (`forceCanRaise` itself keeps an unresolved table).
    if (!claimsRecordMethod(call, ctx, method)) {
      if (receiverUnresolved(call, ctx, method)) {
        if (value === "false") return "run-trigger-forced";
        if (skip !== null) return skip.tag;
      }
      continue;
    }
    if (value === "false") return forceCanRaise(call, ctx, kind) ? "run-trigger-forced" : undefined;
    return skip?.canRaise(call, ctx) ? skip.tag : undefined;
  }
  return undefined;
}

/** The flipped text for a boolean this operator will claim, else `null`. */
function flipped(node: ALSyntaxNode, ctx: SemanticContext): string | null {
  const after = flippedBeforeHang(node, ctx);
  // R196: a value written to a variable an enclosing loop's condition reads is refused, and
  // counted per file through `refusesHangCapable` (R447).
  return after !== null && hangCapableForMutatedNode(node, ctx) === null ? after : null;
}

/** `flipped` without R196's hang check: every other check, in the same order (R447). */
function flippedBeforeHang(node: ALSyntaxNode, ctx: SemanticContext): string | null {
  if (node.rawKind !== "boolean") return null;
  const text = node.text.toLowerCase();
  if (text !== "true" && text !== "false") return null;
  if (!inExecutableBody(node)) return null;
  if (isCaseLabel(node)) return null;
  if (isLoopCondition(node)) return null;
  if (isCededRunTriggerFlag(node, ctx)) return null;
  return text === "true" ? "false" : "true";
}

/** The loop kinds whose condition this operator refuses: see `isLoopCondition`. */
const LOOP_STATEMENTS: ReadonlySet<string> = new Set([
  ALNodeKind.repeat_statement,
  ALNodeKind.while_statement,
]);

/**
 * Does this literal reach a `repeat` or `while` loop's exit: its condition, or an in-loop `if`'s?
 *
 * Refused for two reasons that arrive at the same line, one reported and one not.
 *
 * `until false` and `while true` are ordinary AL for a loop whose exits all sit in the body.
 * `loop-truncate` rewrites a repeat's exit condition to `true`, and `loop-skip` rewrites a while's
 * condition to `false`; either way this operator flipping the same literal to the same replacement
 * at the same span made two operators claim ONE identity, and `dedupeSpecs` throws on that rather
 * than letting registration order decide, so a whole-project run died at planning before anything
 * was measured (issue #7, and its `while` twin, GH-07). The loop operator keeps the mutant in both
 * cases: it owns loop bounding, that is what R164 and R179 built it for, and its version terminates.
 *
 * `until true` and `while false` are the other polarity, and nobody reported either: the body
 * still runs at least once (`until true`) or not at all (`while false`), but flipping either one
 * turns a loop that ends into one that ends only if the body exits. Neither loop operator claims
 * that polarity (`loop-truncate` emits nothing at an already-`true` condition; `loop-skip` refuses
 * an already-`false` one), so without this refusal the ONLY mutant at those sites was a hang. R164
 * rules that a hang-capable site must not enter a scored gate, and `shift-integer`, `negate-guard`
 * and `negate-conditional` all already refuse a loop condition on the same reasoning. This makes
 * four operators, now covering `while false` as well as `until true`. At `while false` this leaves
 * the site with NO mutant at all, which is acceptable: the loop is dead code, and its only mutant
 * was a hang.
 *
 * The first version of this refusal reasoned that no loop operator claims a `while`, and named
 * `repeat` only. That stopped being true when `loop-skip` landed (R179, twelve days before the
 * issue #7 fix): `while true do` collided the identical way, one loop kind over, and the mistake
 * was recorded nowhere until it was measured (see `docs/mutation-testing-ourselves.md` on R175).
 *
 * R239 widened it from the WHOLE condition to any literal that reaches a loop's exit. The walk goes
 * up through parentheses, `not` and `and`/`or`/`xor` (`until Done and true`, `while not false`),
 * and it stops at a `while`/`repeat` OR at an `if` that sits inside one, since an in-loop `if`
 * usually guards the body's `exit` (`while true do if true then exit;`). A `#if` tail of either
 * condition (`while false` `#if X or false #endif` `do`) sits BESIDE the `condition` field in the
 * grammar, so a tail that is a direct child of the statement counts as its condition, the way
 * `loop-hazard.ts`'s `conditionIdentifiers` reads it. Both polarities are refused: `until Done or
 * false` -> `or true` still terminates, but a polarity-aware rule tracks parity through every `not`
 * for zero measured sites, so the terminating flip is lost with the hanging one. The walk stops at
 * anything else, so a call ARGUMENT in such a condition (`if not Confirm('x', false) then exit;`)
 * is still claimed.
 *
 * Spans are compared by POSITION, never by node identity, for the reason recorded in [[R209]]: the
 * AST wrappers are rebuilt on access, so reference equality is not reliable.
 */
function isLoopCondition(node: ALSyntaxNode): boolean {
  let current = node;
  for (let p: ALSyntaxNode | null = node.parent; p !== null; p = p.parent) {
    if (
      LOOP_STATEMENTS.has(p.kind) ||
      (p.kind === ALNodeKind.if_statement && hasEnclosingLoop(p))
    ) {
      if (current.rawKind === CONDITION_TAIL) return true;
      const condition = p.childForFieldName("condition");
      return (
        condition !== null &&
        condition.startIndex === current.startIndex &&
        condition.endIndex === current.endIndex
      );
    }
    if (!CONDITION_WRAPPERS.has(p.rawKind)) return false;
    current = p;
  }
  return false;
}

/** R239: what `isLoopCondition` walks up through from a literal towards its condition. R454 adds
 *  the comparison: `until X.Next() = false` -> `= true` removes or inverts the exit just the same. */
const CONDITION_TAIL = "preproc_conditional_expression_tail";
const CONDITION_WRAPPERS: ReadonlySet<string> = new Set([
  ALNodeKind.parenthesized_expression,
  ALNodeKind.unary_expression,
  ALNodeKind.logical_expression,
  ALNodeKind.comparison_expression,
  CONDITION_TAIL,
]);

/** A case LABEL, not a boolean in a branch body — see `CASE_LABEL_PARENTS`. */
function isCaseLabel(node: ALSyntaxNode): boolean {
  const parent = node.parent;
  return parent !== null && CASE_LABEL_PARENTS.has(parent.rawKind);
}

/**
 * A boolean is EXECUTABLE only inside a procedure or trigger body. Everything else is a declarative
 * surface, which R135 rules out and R144 pins the refusal for.
 *
 * Stated as "must have a body ancestor" rather than as a list of declarative parents, because the
 * list version was WRONG and the emit probe is what caught it. The first draft named
 * `label_attribute` only, the 26 sites the corpus census found, and the instrumented artifact then
 * failed to build at all: `resolveSite: no enclosing statement for node at 271..275`, which was
 * `Clustered = true` on a table key. That value is a compile-time property, so there is no statement
 * to wrap a runtime guard around.
 *
 * The naive splice could never have found it: `Clustered = false` is perfectly valid AL. Only the
 * real emit path fails, which is exactly why the spike runs both.
 *
 * An allow-list of executable contexts cannot be outrun by a property nobody enumerated; a deny-list
 * of declarative ones is only ever as complete as the last person's memory.
 *
 * The allow-list is `inMemberBody` (`@lethal/engine`) since R302: a `procedure` or trigger, or a
 * split-header member's shared BODY. Not the whole split node: an attribute inside an `#if` arm
 * is a child of the split node (a plain procedure's attribute is its sibling), so "any ancestor is
 * procedure-like" would admit `[IntegrationEvent(false, false)]`'s booleans.
 */
function inExecutableBody(node: ALSyntaxNode): boolean {
  return inMemberBody(node);
}

/**
 * Is this literal the run-trigger flag `swap-modify-flag` (Tier 2) flips?
 *
 * Such a literal is CEDED: flipping `Rec.Modify(true)` to `Modify(false)` is the same mutation
 * whether reached through the call or the literal, and §3.2 dedup would NOT catch the pair, because
 * it compares SPANS (the call node against the literal inside it). Measured on `do-rel2/Cloud`: 72
 * sites.
 *
 * R459: the cession is `claimedRunTriggerSkip`, the SAME engine answer that operator claims with,
 * span-equal. Every restatement of it orphaned sites: a name-only test refused 55 it does not claim
 * (R171's seam bug), ceding `false` too orphaned 39 more (it has no `false` -> `true` direction),
 * and ceding every `true` of a claimed `Insert` orphaned both literals of `Insert(true, X)` and
 * `Insert(X, true)`, which it never claims (BC.History 30).
 */
function isCededRunTriggerFlag(node: ALSyntaxNode, ctx: SemanticContext): boolean {
  const call = node.parent?.parent;
  if (call?.kind !== ALNodeKind.procedure_call) return false;
  const literal = claimedRunTriggerSkip(call, ctx)?.literal;
  return literal?.startIndex === node.startIndex && literal.endIndex === node.endIndex;
}
