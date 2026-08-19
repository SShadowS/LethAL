import {
  ALNodeKind,
  type ALSyntaxNode,
  type MutationOperator,
  type MutationSpec,
  type SemanticContext,
  isStatementSlot,
} from "@lethal/operator-sdk";
import { synthesizeAfter } from "./mutate-helpers";

export const voidMethodCall: MutationOperator = {
  name: "lethal.void-method-call",
  version: "1.1.0",
  tier: 1,
  targetNodeKinds: [ALNodeKind.procedure_call],
  producesNodeKinds: [ALNodeKind.procedure_call],
  requiresSemantic: [],

  targets(node: ALSyntaxNode, _ctx: SemanticContext): boolean {
    if (node.kind !== ALNodeKind.procedure_call) return false;
    // Only calls in a statement SLOT. v3 wraps a block's statements in a `statement_block`, so
    // this cannot key on `code_block` directly; R161 widened it from `isStatementPosition` to admit
    // the un-braced body of a branch, where a call is equally a statement.
    return isStatementSlot(node);
  },

  generate(node: ALSyntaxNode, _ctx: SemanticContext): readonly MutationSpec[] {
    return [
      {
        operatorName: "lethal.void-method-call",
        operatorVersion: "1.1.0",
        astNodeId: `${node.startIndex}-${node.endIndex}`,
        before: node,
        after: synthesizeAfter(node, ""),
        parentContext: "statement-position",
      },
    ];
  },

  conformanceTests: [
    {
      name: "deletes a statement-position call",
      sourceAL: `codeunit 51501 "V" { procedure P() begin DoThing(); end; }`,
      expectedSpecs: [
        {
          parentContext: "statement-position",
          beforeText: "DoThing()",
          afterText: "",
        },
      ],
    },
  ],
};
