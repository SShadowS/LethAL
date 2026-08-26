import { claimsRecordMethod } from "@lethal/engine";
import {
  ALNodeKind,
  type ALSyntaxNode,
  type MutationOperator,
  type MutationSpec,
  type SemanticContext,
} from "@lethal/operator-sdk";
import { synthesizeAfter } from "./mutate-helpers";

const OPERATOR_NAME = "lethal.flip-boolean-literal";
const OPERATOR_VERSION = "1.0.0";

/**
 * Record methods whose run-trigger boolean `swap-modify-flag` (Tier 2) already flips.
 *
 * A boolean argument to one of these is CEDED: flipping `Rec.Modify(true)` to `Modify(false)` is the
 * same mutation whether you reach it through the call or through the literal, and emitting both
 * would put two operators on one behaviour change. §3.2 dedup would NOT catch it, because that rule
 * compares SPANS and the two differ (the call node against the literal inside it). Measured on
 * `do-rel2/Cloud`: 72 sites, 2% of the candidate's footprint.
 *
 * The cession asks `claimsRecordMethod` — the SAME predicate `swap-modify-flag` claims with — rather
 * than restating it. The first draft tested the method NAME alone, and that is not what that operator
 * claims: it requires a name AND a receiver that resolves to a Record. Measured on the corpus, the
 * mismatch ORPHANED 55 sites — `Modify`/`Insert`/`Delete` calls whose receiver is unresolvable, which
 * this operator refused and that one never claimed. R171 is the same bug one operator earlier, and
 * `receiver.ts` moved into `@lethal/engine` so a shared predicate makes it structurally impossible
 * instead of a thing to remember. This list still has to track `RUN_TRIGGER_METHODS`, which is what
 * the fixture arm pins.
 */
const CEDED_TO_MODIFY_FLAG = ["Modify", "Insert", "Delete"] as const;

/**
 * A boolean is EXECUTABLE only inside a procedure or trigger body. Everything else is a declarative
 * surface, which R135 rules out and R144 pins the refusal for.
 *
 * Stated as "must have a body ancestor" rather than as a list of declarative parents, because the
 * list version was WRONG and the emit probe is what caught it. The first draft named
 * `label_attribute` only — the 26 sites the corpus census found — and the instrumented artifact then
 * failed to build at all: `resolveSite: no enclosing statement for node at 271..275`, which was
 * `Clustered = true` on a table key. That value is a compile-time property, so there is no statement
 * to wrap a runtime guard around.
 *
 * The naive splice could never have found it: `Clustered = false` is perfectly valid AL. Only the
 * real emit path fails, which is exactly why the spike runs both.
 *
 * An allow-list of executable contexts cannot be outrun by a property nobody enumerated; a deny-list
 * of declarative ones is only ever as complete as the last person's memory.
 */
const BODY_ANCESTORS: ReadonlySet<string> = new Set(["procedure", "trigger_declaration"]);

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
 * **No `PlatformKillMechanism`.** Flipping a value is ordinary changed behaviour. The one shape that
 * could look otherwise is a ceded one: `Rec.Insert(true)` to `Insert(false)` skips a trigger and can
 * die on a duplicate key with no assertion, which is exactly why R138 tagged it — and those sites
 * belong to `swap-modify-flag`, which carries the tag. This operator never reaches them.
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

  generate(node: ALSyntaxNode, ctx: SemanticContext): readonly MutationSpec[] {
    const after = flipped(node, ctx);
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
      name: "CEDES Insert's run-trigger flag",
      sourceAL: `codeunit 51704 "C" { procedure P() var Cust: Record Customer; begin Cust.Insert(false); end; }`,
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
  ],
};

/** The flipped text for a boolean this operator will claim, else `null`. */
function flipped(node: ALSyntaxNode, ctx: SemanticContext): string | null {
  if (node.rawKind !== "boolean") return null;
  const text = node.text.toLowerCase();
  if (text !== "true" && text !== "false") return null;
  if (!inExecutableBody(node)) return null;
  if (isCaseLabel(node)) return null;
  if (isCededRunTriggerFlag(node, ctx)) return null;
  return text === "true" ? "false" : "true";
}

/** A case LABEL, not a boolean in a branch body — see `CASE_LABEL_PARENTS`. */
function isCaseLabel(node: ALSyntaxNode): boolean {
  const parent = node.parent;
  return parent !== null && CASE_LABEL_PARENTS.has(parent.rawKind);
}

/** Inside a procedure or trigger body — see `BODY_ANCESTORS` for why this is an allow-list. */
function inExecutableBody(node: ALSyntaxNode): boolean {
  for (let p: ALSyntaxNode | null = node.parent; p !== null; p = p.parent) {
    if (BODY_ANCESTORS.has(p.rawKind)) return true;
  }
  return false;
}

/**
 * Is this literal the run-trigger flag of a record method `swap-modify-flag` owns?
 *
 * Walks only as far as the ARGUMENT LIST's own call, never further: a `true` nested inside another
 * call that happens to sit within a `Modify(...)` argument is not that call's flag.
 */
function isCededRunTriggerFlag(node: ALSyntaxNode, ctx: SemanticContext): boolean {
  const args = node.parent;
  if (args === null || args.rawKind !== "argument_list") return false;
  const call = args.parent;
  if (call === null || call.rawKind !== ALNodeKind.procedure_call) return false;
  // Only `true` is ceded. `swap-modify-flag` claims the SKIP direction (an explicit `true` to flip
  // to `false`) and, since 1.2.0, the argument-LESS call; it has no `false` -> `true` direction, so
  // `Rec.Modify(false)` is claimed by nobody and belongs here. Measured: ceding `false` as well
  // orphaned a further 39 corpus sites.
  if (node.text.toLowerCase() !== "true") return false;
  // Ask the SAME predicate that operator claims with, never a restatement of it. A name-only test
  // here refused 55 sites it does not claim, leaving them to nobody — R171's seam bug exactly.
  return CEDED_TO_MODIFY_FLAG.some((method) => claimsRecordMethod(call, ctx, method));
}
