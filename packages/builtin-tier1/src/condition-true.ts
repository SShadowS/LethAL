import { inMemberBody } from "@lethal/engine";
import {
  ALNodeKind,
  type ALSyntaxNode,
  type MutationOperator,
  type MutationSpec,
  type SemanticContext,
} from "@lethal/operator-sdk";
import { deletedOperandHangs, inLoopExitParts } from "./loop-hazard";
import { synthesizeAfter } from "./mutate-helpers";
import { thenArmHangs } from "./optin-hang";

const NAME = "lethal.condition-true";
const VERSION = "1.0.0";

/**
 * `ConditionTrue` (R868, GitHub #36, condition-to-true form), OPT-IN: `if C then A;` becomes
 * `if true then A;`, so the guarded statements run whatever the guard says. A happy-path suite kills
 * `negate-*` but not this one.
 *
 * WHAT A SURVIVOR MEANS: no test drives the guard to false, or none checks what the then-arm does
 * when it should not run. Name it (`--operator condition-true`); it is not in a default run, because
 * it adds 6% (DO) to 8% (DC) mutants and about a third of its survivors are not a test gap (R-862
 * reading: 6 real, 5 questionable, 1 equivalent of 12).
 *
 * Hang rules beyond `inLoopExitParts` and `deletedOperandHangs`: see `thenArmHangs` in
 * `optin-hang.ts` (a then-arm that moves the exit's cursor or a name the exit reads, holds a
 * non-`Next` loop, or recurses).
 *
 * Scope: an `if` WITHOUT `else` (the issue's coarse form), in a procedure or trigger body. A
 * boolean literal condition is refused: `false` to `true` writes the bytes `flip-boolean-literal`
 * writes, and dedup refuses two operators on one span with one text.
 *
 * Hang: the mutant runs the then-arm always, and `continue` in it skips what follows in the loop.
 * The site is refused when it is in a loop's exit parts, or `deletedOperandHangs` finds progress or
 * a `continue` in the `if` (a call in the condition stops running too, which that rule asks).
 */
function condition(node: ALSyntaxNode): ALSyntaxNode | null {
  if (node.rawKind !== ALNodeKind.if_statement || !inMemberBody(node)) return null;
  if (node.childForFieldName("else_branch") !== null) return null;
  const cond = node.childForFieldName("condition");
  if (cond === null || cond.text.startsWith("#")) return null;
  // R402: a directive tail of the condition (`if A` `#if X and B` `#endif` `then`) sits BESIDE the
  // `condition` field, so `true` would replace only the head and leave `true and B`.
  if (node.namedChildren.some((c) => c.rawKind.startsWith("preproc"))) return null;
  let inner = cond;
  while (inner.kind === ALNodeKind.parenthesized_expression) {
    const next = inner.namedChildren[0];
    if (next === undefined) break;
    inner = next;
  }
  return inner.kind === ALNodeKind.boolean_literal ? null : cond;
}

const hangs = (cond: ALSyntaxNode, ctx: SemanticContext): boolean => {
  const ifNode = cond.parent;
  return (
    inLoopExitParts(cond, ctx) ||
    deletedOperandHangs(cond, cond, ctx) ||
    (ifNode !== null && thenArmHangs(ifNode, ctx))
  );
};

export const conditionTrue: MutationOperator = {
  name: NAME,
  version: VERSION,
  tier: 1,
  optIn: true,
  targetNodeKinds: [ALNodeKind.if_statement],
  producesNodeKinds: [ALNodeKind.boolean_literal],
  requiresSemantic: ["symbol-table"],
  targets(node: ALSyntaxNode, ctx: SemanticContext): boolean {
    const c = condition(node);
    return c !== null && !hangs(c, ctx);
  },
  refusesHangCapable(node: ALSyntaxNode, ctx: SemanticContext): boolean {
    const c = condition(node);
    return c !== null && hangs(c, ctx);
  },
  generate(node: ALSyntaxNode, ctx: SemanticContext): readonly MutationSpec[] {
    const c = condition(node);
    if (c === null || hangs(c, ctx)) return [];
    return [
      {
        operatorName: NAME,
        operatorVersion: VERSION,
        astNodeId: `${c.startIndex}-${c.endIndex}`,
        before: c,
        after: synthesizeAfter(c, "true"),
        parentContext: "statement-position",
      },
    ];
  },
  conformanceTests: [
    {
      name: "forces an if without else",
      sourceAL: `codeunit 51910 "C" { procedure P(A: Boolean) var N: Integer; begin if A then N := 1; end; }`,
      expectedSpecs: [{ parentContext: "statement-position", beforeText: "A", afterText: "true" }],
    },
    {
      name: "REFUSES an if with else and a literal condition",
      sourceAL: `codeunit 51911 "C" { procedure P(A: Boolean) var N: Integer; begin if A then N := 1 else N := 2; if false then N := 3; end; }`,
      expectedSpecs: [],
    },
    {
      name: "REFUSES a condition with a directive tail beside it (true would replace only the head)",
      sourceAL: `codeunit 51913 "C" { procedure P(A: Boolean; B: Boolean) var N: Integer; begin if A\n#if not CLEAN\n and B\n#endif\n then N := 1; end; }`,
      expectedSpecs: [],
    },
    {
      name: "REFUSES a then-arm that holds a loop whose end rests on the guard",
      sourceAL: `codeunit 51914 "C" { procedure P(Step: Integer; N: Integer) var I: Integer; begin if Step > 0 then while I < N do I += Step; end; }`,
      expectedSpecs: [],
    },
    {
      name: "REFUSES a guard on a self-call (recursion)",
      sourceAL: `codeunit 51915 "C" { procedure Self(Level: Integer) begin if Level < 10 then Self(Level + 1); end; }`,
      expectedSpecs: [],
    },
    {
      name: "REFUSES a guard holding continue in a loop",
      sourceAL: `codeunit 51912 "C" { procedure P(A: Boolean) var N: Integer; begin while N < 3 do begin if A then continue; N += 1; end; end; }`,
      expectedSpecs: [],
    },
  ],
};
