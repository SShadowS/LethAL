import {
  ALNodeKind,
  type ALSyntaxNode,
  type MutationOperator,
  type MutationSpec,
  type SemanticContext,
} from "@lethal/operator-sdk";
import { synthesizeAfter } from "./mutate-helpers";

const OPERATOR_NAME = "lethal.loop-skip";
const OPERATOR_VERSION = "1.0.0";

/**
 * `LoopSkip`: rewrite a `while` loop's condition to `false`, so the body never runs.
 *
 * ROADMAP R179, and it is a HAZARD candidate rather than a coverage one. That distinction decides
 * whether it should exist at all, so it is stated first.
 *
 * **On coverage it fails R13's bar.** 33 `while` loops on `do-rel2/Cloud`, and `empty-block` already
 * claims the BODY at 28 of them, leaving 5 marginal against a bar of 13.
 *
 * **On hazard it passes, and that is the ground it ships on.** At **19** of those 28, `empty-block`'s
 * existing mutant DOES NOT TERMINATE: a `while` loop's body is what advances its condition (it must
 * be, or the original would never end), so emptying the body freezes the condition forever. Measured
 * on `do-rel2/Cloud`, 25 loop bodies are frozen this way, 19 `while` and 6 `repeat`. Each one strands
 * its tier on the default path, where `--stop-hung-sessions` is off because it ends a session on the
 * user's own server.
 *
 * `while false` asks the same question — does anything notice if this body does not run — and cannot
 * hang on any input. That is exactly `loop-truncate`'s relationship to `negate-conditional` at
 * `repeat`, which R164 accepted; there the raw count was 334 so the bar question never arose.
 *
 * **The ruling this required, recorded because it was not previously explicit:** R13's >=13-site bar
 * was calibrated for a candidate that adds COVERAGE, and asks whether new mutants are worth their
 * cost. A candidate that replaces an existing NON-TERMINATING mutant with a terminating one adds
 * little coverage by construction, and refusing it on that basis would preserve the hang it exists to
 * remove. Hazard candidates are judged on hazards removed. See `docs/roadmap/R179.md`.
 *
 * **The cession that comes with it.** `empty-block` now refuses a `while` loop's body outright and
 * this operator claims the condition. The refusal is POSITIONAL and syntactic, deliberately: the
 * precise rule would be "refuse where the body advances the condition", and that is an inference
 * about VALUES, which is the class of reasoning R175 was. 28 `empty-block` mutants leave, 33 arrive,
 * and 19 hangs go with them.
 *
 * **Documented limits:**
 *   - **`while` only.** A `repeat` body always runs at least once, so `until true` does not remove
 *     its effect and `loop-truncate` is not a substitute. The 6 frozen `repeat` bodies measured on
 *     the corpus are NOT addressed here and are recorded on R179.
 *   - A loop whose body a test never depended on yields an equivalent mutant, the same way
 *     `loop-truncate`'s does on a one-iteration loop.
 */
export const loopSkip: MutationOperator = {
  name: OPERATOR_NAME,
  version: OPERATOR_VERSION,
  tier: 1,
  targetNodeKinds: [ALNodeKind.while_statement],
  producesNodeKinds: [ALNodeKind.boolean_literal],
  requiresSemantic: [],
  // R172: a loop whose body nothing depended on is an equivalent mutant, the same shape
  // `loop-truncate` carries.
  equivalenceRisk: "loop-truncation",

  targets(node: ALSyntaxNode, _ctx: SemanticContext): boolean {
    return skipCondition(node) !== null;
  },

  generate(node: ALSyntaxNode, _ctx: SemanticContext): readonly MutationSpec[] {
    const cond = skipCondition(node);
    if (cond === null) return [];
    return [
      {
        operatorName: OPERATOR_NAME,
        operatorVersion: OPERATOR_VERSION,
        astNodeId: `${cond.startIndex}-${cond.endIndex}`,
        before: cond,
        after: synthesizeAfter(cond, "false"),
        parentContext: "statement-position",
      },
    ];
  },

  conformanceTests: [
    {
      name: "skips a counter-driven while loop",
      sourceAL: `codeunit 51800 "L" { procedure P(Limit: Integer) var N: Integer; begin while N < Limit do N += 1; end; }`,
      expectedSpecs: [
        { parentContext: "statement-position", beforeText: "N < Limit", afterText: "false" },
      ],
    },
    {
      name: "skips a stream walk, the shape `empty-block` cannot mutate without hanging",
      sourceAL: `codeunit 51801 "L" { procedure P() var S: InStream; T: Text; begin while not S.EOS do S.ReadText(T); end; }`,
      expectedSpecs: [
        { parentContext: "statement-position", beforeText: "not S.EOS", afterText: "false" },
      ],
    },
    {
      name: "REFUSES a repeat loop: `until true` still runs the body once, so it is not the same question",
      sourceAL: `codeunit 51802 "L" { procedure P(Limit: Integer) var N: Integer; begin repeat N += 1; until N >= Limit; end; }`,
      expectedSpecs: [],
    },
    {
      name: "REFUSES a condition that is already `false`, which would be an unkillable no-op",
      sourceAL: `codeunit 51803 "L" { procedure P() var N: Integer; begin while false do N += 1; end; }`,
      expectedSpecs: [],
    },
    {
      name: "REFUSES a while outside an executable body",
      sourceAL: `table 51804 "T" { fields { field(1; "No."; Code[20]) { } } }`,
      expectedSpecs: [],
    },
  ],
};

/** The `while` loop's condition, or `null` where this operator does not claim it. */
function skipCondition(node: ALSyntaxNode): ALSyntaxNode | null {
  if (node.rawKind !== ALNodeKind.while_statement) return null;
  if (!inExecutableBody(node)) return null;
  const cond = node.childForFieldName("condition");
  if (cond === null) return null;
  // `while false` is already the mutated form; mutating it again ships an unkillable mutant.
  if (cond.text.trim().toLowerCase() === "false") return null;
  return cond;
}

/**
 * Inside a procedure or trigger body, an ALLOW-list for the reason `shift-integer`'s doc comment
 * gives: a deny-list of declarative parents is only ever as complete as the last person's memory.
 */
function inExecutableBody(node: ALSyntaxNode): boolean {
  for (let p: ALSyntaxNode | null = node.parent; p !== null; p = p.parent) {
    if (p.rawKind === "procedure" || p.rawKind === "trigger_declaration") return true;
  }
  return false;
}
