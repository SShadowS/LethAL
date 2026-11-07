import { enclosingObjectScopeKey, objectScopeKey, resolveVarRef } from "@lethal/engine";
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
import { calleeLoopUsesParam, calleeRecurses } from "./optin-hang";

const NAME = "lethal.blank-argument";
const VERSION = "1.0.0";

/**
 * `BlankArgument` (R868, GitHub #34), OPT-IN: a call argument that is a variable or a field of a
 * scalar type is replaced by that type's blank constant, to find a computed value nobody checks was
 * passed on.
 *
 * WHAT A SURVIVOR MEANS: the callee's tests do not tell a real value from a blank one. Name it
 * (`--operator blank-argument`); it is not in a default run (about +3% mutants on DO, +5% on DC,
 * and the R-862 reading was 6 real of 12, the rest mostly attribute-by-attribute export lines and
 * event arguments).
 *
 * Hang rules: see `calleeLoopUsesParam` and `calleeRecurses` in `optin-hang.ts`, and the three
 * loop rules below.
 *
 * The callee must be KNOWN not to take that argument by `var` (a literal in a `var` slot does not
 * compile, AL0133 family). Known means a project procedure the object declares exactly once: a bare
 * call, or a call on a `Codeunit "X"` variable. Every other callee (a record builtin, a codeunit
 * outside the project, an event publisher in a dependency, an overload) is refused. That is why the
 * site count is far below the issue's census, which did not resolve callees.
 */
const BLANKS: readonly (readonly [RegExp, string])[] = [
  [/^(text|code)(\[\d+\])?$/i, "''"],
  [/^(integer|biginteger|decimal|byte)$/i, "0"],
  [/^boolean$/i, "false"],
  [/^date$/i, "0D"],
  [/^datetime$/i, "0DT"],
  [/^time$/i, "0T"],
];

function blankOf(type: string | null): string | null {
  if (type === null) return null;
  return BLANKS.find(([re]) => re.test(type.trim()))?.[1] ?? null;
}

/** The blank text for `node`, when it is an argument of a callee known to take it by value. */
interface BlankPlan {
  readonly blank: string;
  readonly paramInCalleeLoop: boolean;
}

function blankFor(node: ALSyntaxNode, ctx: SemanticContext): BlankPlan | null {
  // The dispatch asks `targets` of every node: a literal is not a variable or a field.
  if (!isIdentifierLike(node) && node.kind !== ALNodeKind.field_access) return null;
  const list = node.parent;
  const call = list?.parent;
  if (list === null || list === undefined || call === null || call === undefined) return null;
  if (list.rawKind !== "argument_list") return null;
  if (call.rawKind !== "call_expression" && call.rawKind !== "call_statement") return null;
  const blank = blankOf(ctx.types.typeOf(node));
  if (blank === null || node.text.trim().toLowerCase() === blank.toLowerCase()) return null;
  const args = list.namedChildren.filter(
    (n) => n.rawKind !== "comment" && n.rawKind !== "multiline_comment",
  );
  const index = args.findIndex(
    (a) => a.startIndex === node.startIndex && a.endIndex === node.endIndex,
  );
  if (index < 0 || args.length !== list.namedChildren.length) return null;
  const fn = call.childForFieldName("function");
  if (fn === null) return null;
  let owner: string | null = null;
  let procName: string | null = null;
  if (fn.kind === ALNodeKind.identifier) {
    owner = enclosingObjectScopeKey(call);
    procName = fn.text;
  } else if (fn.kind === ALNodeKind.field_access) {
    const recv = fn.childForFieldName("object");
    const method = fn.childForFieldName("member");
    if (recv === null || method === null || recv.kind !== ALNodeKind.identifier) return null;
    const v = resolveVarRef(recv, ctx);
    const m = v === null ? null : /^\s*Codeunit\s+(.+?)\s*$/i.exec(v.typeText);
    const raw = m?.[1];
    if (raw === undefined) return null;
    owner = objectScopeKey("codeunit", raw.replace(/^"(.*)"$/, "$1"));
    procName = method.text;
  }
  if (owner === null || procName === null) return null;
  const proc = ctx.symbols.uniqueProcedure(owner, procName);
  const param = proc?.parameters[index];
  if (param === undefined || proc?.parameters.length !== args.length) return null;
  if (/^\s*var\b/i.test(param.node.text)) return null;
  // Hang rules of this operator: the parameter, or a copy of it, is read in a loop of the callee
  // (or of the object, for a global it is stored in); or the callee leads back to the caller.
  const sameObject = owner === enclosingObjectScopeKey(call);
  const refused =
    calleeLoopUsesParam(proc.node, param.name, ctx) ||
    (sameObject && calleeRecurses(call, procName, ctx));
  return { blank, paramInCalleeLoop: refused };
}

const hangs = (node: ALSyntaxNode, ctx: SemanticContext, loopParam: boolean): boolean =>
  loopParam ||
  inLoopExitParts(node, ctx) ||
  hangCapableForMutatedNode(node, ctx) !== null ||
  deletedOperandHangs(node, node, ctx);

export const blankArgument: MutationOperator = {
  name: NAME,
  version: VERSION,
  tier: 1,
  optIn: true,
  targetNodeKinds: [ALNodeKind.identifier, ALNodeKind.field_access],
  producesNodeKinds: [ALNodeKind.identifier, ALNodeKind.field_access],
  requiresSemantic: ["type-info", "symbol-table"],
  targets(node: ALSyntaxNode, ctx: SemanticContext): boolean {
    const p = blankFor(node, ctx);
    return p !== null && !hangs(node, ctx, p.paramInCalleeLoop);
  },
  refusesHangCapable(node: ALSyntaxNode, ctx: SemanticContext): boolean {
    const p = blankFor(node, ctx);
    return p !== null && hangs(node, ctx, p.paramInCalleeLoop);
  },
  generate(node: ALSyntaxNode, ctx: SemanticContext): readonly MutationSpec[] {
    const p = blankFor(node, ctx);
    if (p === null || hangs(node, ctx, p.paramInCalleeLoop)) return [];
    return [
      {
        operatorName: NAME,
        operatorVersion: VERSION,
        astNodeId: `${node.startIndex}-${node.endIndex}`,
        before: node,
        after: synthesizeAfter(node, p.blank),
        parentContext: "expression-position",
      },
    ];
  },
  conformanceTests: [
    {
      name: "blanks a by-value argument of a project procedure",
      sourceAL: `codeunit 51930 "C" { procedure P(T: Text) begin Q(T); end; local procedure Q(X: Text) begin end; }`,
      expectedSpecs: [{ parentContext: "expression-position", beforeText: "T", afterText: "''" }],
    },
    {
      name: "REFUSES a parameter the callee reads inside a loop (a zero step would never end)",
      sourceAL: `codeunit 51932 "C" { procedure P(S: Integer) begin Q(S); end; local procedure Q(Step: Integer) var N: Integer; begin while N < 9 do N += Step; end; }`,
      expectedSpecs: [],
    },
    {
      name: "REFUSES a copy of the parameter that a loop reads (L := Step; while ... do I += L)",
      sourceAL: `codeunit 51933 "C" { procedure P(S: Integer) begin Q(S); end; local procedure Q(Step: Integer) var N: Integer; L: Integer; begin L := Step; while N < 9 do N += L; end; }`,
      expectedSpecs: [],
    },
    {
      name: "REFUSES the depth argument of a recursion",
      sourceAL: `codeunit 51934 "C" { procedure Self(Level: Integer) var Next: Integer; begin Next := Level + 1; if Level < 3 then Self(Next); end; }`,
      expectedSpecs: [],
    },
    {
      name: "claims nothing at a boolean literal argument (flip-boolean-literal owns it)",
      sourceAL: `codeunit 51935 "C" { procedure P() begin Q(true); end; local procedure Q(B: Boolean) begin end; }`,
      expectedSpecs: [],
    },
    {
      name: "REFUSES a var parameter and an unknown callee",
      sourceAL: `codeunit 51931 "C" { procedure P(T: Text) begin Q(T); Unknown(T); end; local procedure Q(var X: Text) begin end; }`,
      expectedSpecs: [],
    },
  ],
};
