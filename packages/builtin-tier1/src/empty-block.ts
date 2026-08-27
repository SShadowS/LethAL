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
    // R179: CEDE a `while` loop's body to `lethal.loop-skip`.
    //
    // A `while` loop's body is what advances its condition — it must be, or the original would never
    // end — so emptying the body freezes the condition and the mutant CANNOT terminate. MEASURED on
    // `do-rel2/Cloud` at 19 of the 28 `while` bodies claimed here, and MEASURED live on
    // `itest:hang`'s `DrainQueue` arm, where this exact mutant was scored `timeout-killed` before
    // this cession landed. Each one strands its tier on the default path, where
    // `--stop-hung-sessions` is off because it ends a session on the user's own server.
    //
    // `loop-skip` asks the same question, "does anything notice if this body does not run", as
    // `while false`, and cannot hang on any input. This is `loop-truncate`'s relationship to
    // `negate-conditional` at `repeat` (R164), one visibility level out.
    //
    // POSITIONAL on purpose. The precise rule would be "refuse where the body advances the
    // condition", which is an inference about VALUES — the class of reasoning R175 was. Reading the
    // parent node is checkable; guessing what a loop does is not. Cost: at the 9 `while` bodies
    // where this mutant currently terminates, it is replaced by `loop-skip`'s, which asks nearly the
    // same question.
    //
    // `repeat` is NOT ceded: its body always runs once, so `until true` does not remove the body's
    // effect and `loop-truncate` is no substitute. The 6 frozen `repeat` bodies on the corpus stay,
    // and stay recorded on R179.
    if (node.parent.kind === ALNodeKind.while_statement) return false;
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
