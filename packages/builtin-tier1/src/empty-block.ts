import {
  ALNodeKind,
  type ALSyntaxNode,
  type MutationOperator,
  type MutationSpec,
  type SemanticContext,
} from "@lethal/operator-sdk";
import { synthesizeAfter } from "./mutate-helpers";

const BODY_PARENT_KINDS: ReadonlySet<string> = new Set([
  ALNodeKind.procedure,
  ALNodeKind.trigger,
  ALNodeKind.if_statement,
  ALNodeKind.while_statement,
  ALNodeKind.for_statement,
  ALNodeKind.repeat_statement,
  ALNodeKind.case_statement,
]);

export const emptyBlock: MutationOperator = {
  name: "lethal.empty-block",
  version: "1.0.0",
  tier: 1,
  targetNodeKinds: [ALNodeKind.block],
  producesNodeKinds: [ALNodeKind.block],
  requiresSemantic: [],

  targets(node: ALSyntaxNode, _ctx: SemanticContext): boolean {
    if (node.kind !== ALNodeKind.block) return false;
    if (node.parent === null) return false;
    if (!BODY_PARENT_KINDS.has(node.parent.kind)) return false;
    // Skip already-empty blocks. Cheapest signal: whether the block has any
    // namedChildren that aren't `begin` / `end` keywords. The grammar exposes
    // these tokens as named nodes with rawKind `begin_keyword` / `end_keyword`
    // (v3.0.1); older/alternate grammars may use bare `begin` / `end`.
    const hasContent = node.namedChildren.some(
      (c) =>
        c.rawKind !== "begin_keyword" &&
        c.rawKind !== "end_keyword" &&
        c.rawKind !== "begin" &&
        c.rawKind !== "end",
    );
    return hasContent;
  },

  generate(node: ALSyntaxNode, _ctx: SemanticContext): readonly MutationSpec[] {
    return [
      {
        operatorName: "lethal.empty-block",
        operatorVersion: "1.0.0",
        astNodeId: `${node.startIndex}-${node.endIndex}`,
        before: node,
        after: synthesizeAfter(node, "begin end"),
        parentContext: "statement-position",
      },
    ];
  },

  conformanceTests: [
    {
      name: "empties a procedure body",
      sourceAL: `codeunit 51701 "E" { procedure P() begin DoThing(); end; }`,
      expectedSpecs: [
        {
          parentContext: "statement-position",
          // Grammar 4.0.0 moved the statement terminator OUT of `code_block`: the block
          // node now ends at its `end`, and the `;` belongs to the enclosing construct.
          // Under 3.x this beforeText was `begin DoThing(); end;` and the mutation
          // deleted the terminator with the block; now the `;` survives untouched.
          beforeText: "begin DoThing(); end",
          afterText: "begin end",
        },
      ],
    },
  ],
};
