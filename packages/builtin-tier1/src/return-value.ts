import {
  ALNodeKind,
  type ALSyntaxNode,
  type MutationOperator,
  type MutationSpec,
  type SemanticContext,
  findEnclosingProcedure,
} from "@lethal/operator-sdk";
import { synthesizeAfter } from "./mutate-helpers";

const NUMERIC_RETURN_TYPES = new Set(["Integer", "Decimal", "BigInteger"]);

export const returnValue: MutationOperator = {
  name: "lethal.return-value",
  version: "1.0.0",
  tier: 1,
  targetNodeKinds: [ALNodeKind.exit_statement],
  producesNodeKinds: [ALNodeKind.exit_statement],
  requiresSemantic: ["symbol-table"],

  targets(node: ALSyntaxNode, _ctx: SemanticContext): boolean {
    if (node.kind !== ALNodeKind.exit_statement) return false;
    const arg = exitArgument(node);
    if (arg === null) return false;
    const rt = resolveReturnType(node);
    if (rt === null) return false;
    if (rt === "Boolean") return true;
    if (NUMERIC_RETURN_TYPES.has(rt)) {
      // skip exit(0) / exit(0.0) — already the target of the numeric mutation
      const trimmed = arg.text.trim();
      return trimmed !== "0" && trimmed !== "0.0";
    }
    return false;
  },

  generate(node: ALSyntaxNode, _ctx: SemanticContext): readonly MutationSpec[] {
    const arg = exitArgument(node);
    if (arg === null) return [];
    const rt = resolveReturnType(node);
    if (rt === null) return [];

    let mutatedArg: string;
    if (rt === "Boolean") {
      mutatedArg = `not (${arg.text.trim()})`;
    } else if (rt === "Decimal") {
      mutatedArg = "0.0";
    } else if (NUMERIC_RETURN_TYPES.has(rt)) {
      mutatedArg = "0";
    } else {
      return [];
    }

    const mutatedText = replaceArgInExit(node, arg, mutatedArg);
    if (mutatedText === null) return [];

    return [
      {
        operatorName: "lethal.return-value",
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
      name: "zeros an Integer return",
      sourceAL: `codeunit 51601 "R" { procedure P(): Integer begin exit(42); end; }`,
      expectedSpecs: [
        {
          parentContext: "statement-position",
          beforeText: "exit(42)",
          afterText: "exit(0)",
        },
      ],
    },
    {
      name: "negates a Boolean return",
      sourceAL: `codeunit 51602 "R" { procedure P(): Boolean begin exit(true); end; }`,
      expectedSpecs: [
        {
          parentContext: "statement-position",
          beforeText: "exit(true)",
          afterText: "exit(not (true))",
        },
      ],
    },
  ],
};

/**
 * Returns the argument expression of `exit(<expr>)`, or null if the exit has
 * no expression (`exit;`).
 *
 * Grammar shape: the exit_statement carries the expression under the
 * `return_value` field. Bare `exit;` has no such field.
 */
function exitArgument(node: ALSyntaxNode): ALSyntaxNode | null {
  return node.childForFieldName("return_value");
}

function resolveReturnType(exitNode: ALSyntaxNode): string | null {
  const proc = findEnclosingProcedure(exitNode);
  if (proc === null) return null;
  const rtNode = proc.childForFieldName("return_type");
  if (rtNode === null) return null;
  const raw = rtNode.text.replace(/^\s*:\s*/, "").trim();
  const first = raw.split(/\s+/)[0] ?? raw;
  return first;
}

function replaceArgInExit(
  exitNode: ALSyntaxNode,
  arg: ALSyntaxNode,
  mutated: string,
): string | null {
  const argStart = arg.startIndex - exitNode.startIndex;
  const argEnd = arg.endIndex - exitNode.startIndex;
  const text = exitNode.text;
  if (argStart < 0 || argEnd > text.length) return null;
  return `${text.slice(0, argStart)}${mutated}${text.slice(argEnd)}`;
}
