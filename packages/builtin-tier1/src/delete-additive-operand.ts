import {
  ALNodeKind,
  type ALSyntaxNode,
  type MutationOperator,
  type MutationSpec,
  type SemanticContext,
} from "@lethal/operator-sdk";
import {
  deletedOperandHangs,
  hangCapableForMutatedNode,
  inLoopExitParts,
  isIdentifierLike,
} from "./loop-hazard";
import { synthesizeAfter } from "./mutate-helpers";

const VERSION = "1.0.0";
type Side = "left" | "right";
const NUMERIC: ReadonlySet<string> = new Set(["Integer", "Decimal", "BigInteger", "Byte"]);

/** In a divisor, at any depth: `T / (A + B)` to `T / B` raises at a zero `B`. So does `D /= A + B`. */
function inDivisor(node: ALSyntaxNode): boolean {
  for (let n = node; n.parent !== null; n = n.parent) {
    const p = n.parent;
    if (p.kind === ALNodeKind.multiplicative_expression && n.fieldName === "right") {
      if (p.childForFieldName("operator")?.text !== "*") return true;
    }
    if (p.kind === ALNodeKind.assignment_statement) {
      return n.fieldName === "right" && p.childForFieldName("operator")?.text === "/=";
    }
    if (p.rawKind.endsWith("_statement")) return false;
  }
  return false;
}

/** A name or a call in it: without one, `kept` is a constant (`3 * 100`, `-(300)`, `'a'`). */
const holdsName = (n: ALSyntaxNode): boolean =>
  isIdentifierLike(n) || n.namedChildren.some(holdsName);

/**
 * The operand to delete and the one to keep, or null. Numeric and of one type, so the result's type
 * stands and it assigns back (`swap-additive`'s guard, stricter). An unresolved type is refused.
 */
function operands(node: ALSyntaxNode, side: Side, ctx: SemanticContext) {
  if (node.kind !== ALNodeKind.additive_expression) return null;
  const token = node.childForFieldName("operator")?.text;
  if (token !== "+" && token !== "-") return null;
  const left = node.childForFieldName("left");
  const right = node.childForFieldName("right");
  if (left === null || right === null) return null;
  const type = ctx.types.typeOf(left);
  if (type === null || type !== ctx.types.typeOf(right) || !NUMERIC.has(type)) return null;
  if (inDivisor(node)) return null;
  const pair = side === "right" ? { deleted: right, kept: left } : { deleted: left, kept: right };
  // Left only for `+`: `A - B` to `B` flips a sign, not an operand. `A + B + C` to `C` removes two
  // operands. `x + x`: both sides write the same bytes, and dedup refuses that.
  if (side === "left") {
    if (token !== "+" || left.kind === ALNodeKind.additive_expression) return null;
    if (right.text === left.text) return null;
  }
  // A constant left over: `I + 300` to `300` does not compile into a Byte (AL0369), and it says
  // little. An operand opening with a directive never gets here: it has no type.
  return holdsName(pair.kept) ? pair : null;
}

const hangs = (node: ALSyntaxNode, deleted: ALSyntaxNode, ctx: SemanticContext): boolean =>
  hangCapableForMutatedNode(node, ctx) !== null ||
  inLoopExitParts(node, ctx) ||
  deletedOperandHangs(deleted, node, ctx);

/**
 * `DeleteAdditiveOperand` (GitHub #41): `x + y` to `x` and to `y`, `x - y` to `x`. One operator per
 * deleted side, as `delete-logical-*`. An array index stays in, by ruling: `Arr[i - 1]` to `Arr[i]`
 * can raise, and that is ordinary changed behaviour (R163).
 *
 * `Days := EndDate - StartDate + 1` gets no mutant: the type table reads `Date - Date` as `Date`.
 */
function make(side: Side): MutationOperator {
  const name = `lethal.delete-additive-${side}`;
  return {
    name,
    version: VERSION,
    tier: 1,
    targetNodeKinds: [ALNodeKind.additive_expression],
    producesNodeKinds: [ALNodeKind.additive_expression],
    requiresSemantic: ["type-info", "symbol-table"],
    targets(node: ALSyntaxNode, ctx: SemanticContext): boolean {
      const o = operands(node, side, ctx);
      return o !== null && !hangs(node, o.deleted, ctx);
    },
    refusesHangCapable(node: ALSyntaxNode, ctx: SemanticContext): boolean {
      const o = operands(node, side, ctx);
      return o !== null && hangs(node, o.deleted, ctx);
    },
    generate(node: ALSyntaxNode, ctx: SemanticContext): readonly MutationSpec[] {
      const o = operands(node, side, ctx);
      if (o === null || hangs(node, o.deleted, ctx)) return [];
      return [
        {
          operatorName: name,
          operatorVersion: VERSION,
          astNodeId: `${node.startIndex}-${node.endIndex}`,
          before: node,
          after: synthesizeAfter(node, o.kept.text),
          parentContext: "statement-position",
        },
      ];
    },
    conformanceTests: side === "right" ? RIGHT_TESTS : LEFT_TESTS,
  };
}

const unit = (id: number, vars: string, body: string): string =>
  `codeunit ${id} "C" { procedure P(${vars}): Integer begin ${body} end; }`;
const one = (beforeText: string, afterText: string) => ({
  parentContext: "statement-position" as const,
  beforeText,
  afterText,
});

const RIGHT_TESTS: MutationOperator["conformanceTests"] = [
  {
    name: "keeps the left of a `+`",
    sourceAL: unit(51620, "A: Integer; B: Integer", "exit(A + B);"),
    expectedSpecs: [one("A + B", "A")],
  },
  {
    name: "keeps the left of a `-`",
    sourceAL: unit(51621, "A: Integer; B: Integer", "exit(A - B);"),
    expectedSpecs: [one("A - B", "A")],
  },
  {
    name: "REFUSES a bare literal left over",
    sourceAL: unit(51622, "A: Integer", "exit(1 + A);"),
    expectedSpecs: [],
  },
  {
    name: "REFUSES a divisor, where the mutant can raise",
    sourceAL: unit(51623, "T: Integer; A: Integer; B: Integer", "exit(T div (A + B));"),
    expectedSpecs: [],
  },
  {
    name: "REFUSES mixed types",
    sourceAL: unit(51624, "A: Integer; B: Decimal", "exit(A + B);"),
    expectedSpecs: [],
  },
  {
    name: "REFUSES Text + Text and an unresolved operand",
    sourceAL: unit(51625, "A: Text; B: Integer", "Message(A + A); exit(B + Unknown());"),
    expectedSpecs: [],
  },
];

const LEFT_TESTS: MutationOperator["conformanceTests"] = [
  {
    name: "keeps the right of a `+`",
    sourceAL: unit(51626, "A: Integer; B: Integer", "exit(A + B);"),
    expectedSpecs: [one("A + B", "B")],
  },
  {
    name: "never the left of a `-`",
    sourceAL: unit(51627, "A: Integer; B: Integer", "exit(A - B);"),
    expectedSpecs: [],
  },
  {
    name: "a chain's left goes through its own node, so no mutant removes two operands",
    sourceAL: unit(51628, "A: Integer; B: Integer; C: Integer", "exit(A + B + C);"),
    expectedSpecs: [one("A + B", "B")],
  },
  {
    name: "REFUSES equal operands",
    sourceAL: unit(51629, "A: Integer", "exit(A + A);"),
    expectedSpecs: [],
  },
];

export const deleteAdditiveLeft = make("left");
export const deleteAdditiveRight = make("right");
