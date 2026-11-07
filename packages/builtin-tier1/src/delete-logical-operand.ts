import {
  ALNodeKind,
  type ALSyntaxNode,
  type MutationOperator,
  type MutationSpec,
  type SemanticContext,
} from "@lethal/operator-sdk";
import { deletedOperandHangs, inLoopExitParts } from "./loop-hazard";
import { synthesizeAfter } from "./mutate-helpers";

const VERSION = "1.0.0";
type Side = "left" | "right";

/** Issue #35's scope: an `and`/`or` in an `if` condition or an `exit` value, through parentheses, `not` and other logic. */
function inScope(node: ALSyntaxNode): boolean {
  for (let n: ALSyntaxNode = node; n.parent !== null; n = n.parent) {
    const p = n.parent;
    if (p.rawKind === "if_statement") return n.fieldName === "condition";
    if (p.rawKind === "exit_statement") return n.fieldName === "return_value";
    if (
      p.kind !== ALNodeKind.parenthesized_expression &&
      p.kind !== ALNodeKind.unary_expression &&
      p.kind !== ALNodeKind.logical_expression
    ) {
      return false;
    }
  }
  return false;
}

/** The operand to delete and the one to keep, or null. */
function operands(node: ALSyntaxNode, side: Side) {
  if (node.kind !== ALNodeKind.logical_expression || !inScope(node)) return null;
  const left = node.childForFieldName("left");
  const right = node.childForFieldName("right");
  const op = node.childForFieldName("operator")?.text.toLowerCase();
  if (left === null || right === null || (op !== "and" && op !== "or")) return null;
  if (side === "right") {
    return left.text.startsWith("#") ? null : { deleted: right, kept: left };
  }
  // A left that is the same operator is a chain: deleting it whole removes two operands, and its
  // own node deletes each. `A or A`: both sides write the same bytes, and dedup refuses two tier 1
  // operators doing that. An operand opening with a directive does not compile (AL0620).
  const chained =
    left.kind === ALNodeKind.logical_expression &&
    left.childForFieldName("operator")?.text.toLowerCase() === op;
  if (chained || right.text === left.text || right.text.startsWith("#")) return null;
  return { deleted: left, kept: right };
}

const hangs = (node: ALSyntaxNode, deleted: ALSyntaxNode, ctx: SemanticContext): boolean =>
  inLoopExitParts(node, ctx) || deletedOperandHangs(deleted, node, ctx);

/**
 * `DeleteLogicalOperand` (GitHub #35): `A or B` to `A`, and to `B`; the same for `and`. One operator
 * per deleted side, because `numberIdentityOrdinals` throws on two mutants of one operator on one
 * span. A suite that kills `or` to `and` can still leave a whole clause unchecked: this finds it.
 *
 * Both sides are kept for `and` too: AL does not short-circuit. Measured on BC 28.4, 2026-11-06
 * (`/coord/handoff/R-855/probe`): `false and Bump()` runs `Bump()`, and `(C > 0) and (T / C > 1)`
 * raises at `C = 0` in the ORIGINAL. So deleting an operand cannot raise from inside the condition.
 *
 * Not typed: both sides are Boolean by the grammar.
 */
function make(side: Side): MutationOperator {
  const name = `lethal.delete-logical-${side}`;
  return {
    name,
    version: VERSION,
    tier: 1,
    targetNodeKinds: [ALNodeKind.logical_expression],
    producesNodeKinds: [ALNodeKind.logical_expression],
    requiresSemantic: ["symbol-table"],
    targets(node: ALSyntaxNode, ctx: SemanticContext): boolean {
      const o = operands(node, side);
      return o !== null && !hangs(node, o.deleted, ctx);
    },
    refusesHangCapable(node: ALSyntaxNode, ctx: SemanticContext): boolean {
      const o = operands(node, side);
      return o !== null && hangs(node, o.deleted, ctx);
    },
    generate(node: ALSyntaxNode, ctx: SemanticContext): readonly MutationSpec[] {
      const o = operands(node, side);
      if (o === null || hangs(node, o.deleted, ctx)) return [];
      return [
        {
          operatorName: name,
          operatorVersion: VERSION,
          astNodeId: `${node.startIndex}-${node.endIndex}`,
          before: node,
          after: synthesizeAfter(node, o.kept.text),
          parentContext: "short-circuit-operand",
        },
      ];
    },
    conformanceTests: side === "right" ? RIGHT_TESTS : LEFT_TESTS,
  };
}

const unit = (id: number, body: string): string =>
  `codeunit ${id} "C" { procedure P(A: Boolean; B: Boolean; C: Boolean): Boolean begin ${body} end; }`;
const one = (beforeText: string, afterText: string) => ({
  parentContext: "short-circuit-operand" as const,
  beforeText,
  afterText,
});

const RIGHT_TESTS: MutationOperator["conformanceTests"] = [
  {
    name: "keeps the left of an `or` in an `if`",
    sourceAL: unit(51610, "if A or B then exit(true);"),
    expectedSpecs: [one("A or B", "A")],
  },
  {
    name: "keeps the left of an `and` in an `exit`",
    sourceAL: unit(51611, "exit(A and B);"),
    expectedSpecs: [one("A and B", "A")],
  },
  {
    name: "a chain gives one mutant per right operand",
    sourceAL: unit(51612, "if A or B or C then exit(true);"),
    expectedSpecs: [one("A or B or C", "A or B"), one("A or B", "A")],
  },
  {
    name: "REFUSES an assignment and a call argument: out of scope",
    sourceAL: unit(51613, "B := A or C; Message('%1', A and C);"),
    expectedSpecs: [],
  },
  {
    name: "REFUSES a loop's own condition",
    sourceAL: unit(51614, "while A or B do C := not C;"),
    expectedSpecs: [],
  },
];

const LEFT_TESTS: MutationOperator["conformanceTests"] = [
  {
    name: "keeps the right of an `or`",
    sourceAL: unit(51615, "if A or B then exit(true);"),
    expectedSpecs: [one("A or B", "B")],
  },
  {
    name: "keeps the right of an `and`: AL does not short-circuit",
    sourceAL: unit(51616, "if A and B then exit(true);"),
    expectedSpecs: [one("A and B", "B")],
  },
  {
    name: "a chain's left goes through its own node, so no mutant removes two operands",
    sourceAL: unit(51617, "if A or B or C then exit(true);"),
    expectedSpecs: [one("A or B", "B")],
  },
  {
    name: "REFUSES equal operands, whose two sides write the same bytes",
    sourceAL: unit(51618, "if A or A then exit(true);"),
    expectedSpecs: [],
  },
  {
    name: "REFUSES a loop's own condition",
    sourceAL: unit(51619, "repeat C := not C; until A or B;"),
    expectedSpecs: [],
  },
];

export const deleteLogicalLeft = make("left");
export const deleteLogicalRight = make("right");
