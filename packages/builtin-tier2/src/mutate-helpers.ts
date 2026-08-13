import type { ALSyntaxNode } from "@lethal/operator-sdk";

/** `argument_list` isn't in `ALNodeKind`; the field name is grammar-stable regardless. */
const ARGUMENTS_FIELD = "arguments";

/**
 * The comma token separating one argument from the next, as it appears among an `argument_list`'s
 * `children`. Anonymous, so it is absent from `namedChildren` — which is exactly why the two are
 * read separately below.
 */
const ARGUMENT_SEPARATOR = ",";

/**
 * Comment kinds the grammar emits as **named** children (measured against the vendored
 * tree-sitter-al v3.0.1 wasm, not assumed):
 *
 *   `C.SetRange("No." <block comment>)` -> ["quoted_identifier", "multiline_comment"]
 *   `C.SetRange("No."  // x` + newline + `)` -> ["quoted_identifier", "comment"]
 *   `C.SetRange("No.")`                 -> ["quoted_identifier"]
 *
 * A raw `namedChildren.length` therefore counts comments as arguments. `///` XML-doc comments
 * parse as plain `comment`, so the two kinds below are the whole comment surface.
 */
const COMMENT_KINDS: ReadonlySet<string> = new Set(["comment", "multiline_comment"]);

/**
 * The argument expressions of `call`, with comment trivia removed.
 *
 * Comments are the only trivia this filters, because they are the only trivia the operators must
 * see *through*: `Modify(true)` followed by a trailing `// why` is still a one-argument
 * `Modify(true)`. Other trivia the grammar also admits inside a parenthesis pair — `pragma`,
 * `preproc_region`,
 * `preproc_endregion`, all measured as named children — is deliberately left in: it inflates this
 * list, and every consumer below treats a longer-than-expected list as "refuse", which is the safe
 * direction.
 */
function argumentNodes(call: ALSyntaxNode): readonly ALSyntaxNode[] {
  const argumentList = call.childForFieldName(ARGUMENTS_FIELD);
  if (argumentList === null) return [];
  return argumentList.namedChildren.filter((n) => !COMMENT_KINDS.has(n.rawKind));
}

/**
 * How many arguments does `call` carry?
 *
 * Counted from the **top-level comma separators**, not from the number of named children, so no
 * trivia node kind — present or future, comment or otherwise — can inflate the answer. A nested
 * call's or subscript's own commas belong to that node's own `argument_list`/brackets and are not
 * children here (measured: `SetRange(GetF(A, B))` -> one named child, zero top-level commas;
 * `SetRange(Arr[1, 2])` likewise).
 *
 * Returns 0 for an empty (or comment-only) argument list, and 0 when there is no argument list at
 * all — a shape that should not parse for the calls Tier 2 targets, but which is not this helper's
 * contract to police.
 */
export function countArguments(call: ALSyntaxNode): number {
  const argumentList = call.childForFieldName(ARGUMENTS_FIELD);
  if (argumentList === null) return 0;
  if (argumentNodes(call).length === 0) return 0;
  const separators = argumentList.children.filter((c) => c.rawKind === ARGUMENT_SEPARATOR).length;
  return separators + 1;
}

/**
 * The `count` argument expressions of `call`, in declaration order, or `null` unless the call
 * carries EXACTLY that many.
 *
 * Checked from both directions at once, the same way `soleArgument` always has: the top-level
 * comma count (`countArguments`) must equal `count`, AND the comment-filtered named-child count
 * (`argumentNodes`) must also equal `count`. Neither check alone is enough. Docs/superpowers/specs/
 * 2026-08-12-r136-tier2-trio-design.md §2.3 amendment 1 is why this is an EXACT-COUNT accessor
 * rather than an indexed one: an indexed `argumentAt(call, 0)` would return whatever sits first
 * among the named children, and this file deliberately leaves non-comment trivia (a pragma, a
 * `#region`) IN that list, on the ground that every consumer here treats a longer-than-expected list
 * as a refusal. An index does not refuse anything; it just reads whatever is first, trivia or not.
 * The exact-count contract keeps that refusal for every caller, this one included.
 */
export function exactArguments(call: ALSyntaxNode, count: number): readonly ALSyntaxNode[] | null {
  if (countArguments(call) !== count) return null;
  const nodes = argumentNodes(call);
  return nodes.length === count ? nodes : null;
}

/**
 * The single argument of `call`, or `null` if it does not carry exactly one.
 *
 * Delegates to `exactArguments(call, 1)`, so this predicate's own behaviour is unchanged by that
 * function's introduction: "exactly one" is still checked from both directions, no top-level comma
 * separator AND exactly one non-comment named child, which is what makes an unrecognised trivia node
 * (a `#region` between the parens, say) refuse rather than be mistaken for the argument.
 */
export function soleArgument(call: ALSyntaxNode): ALSyntaxNode | null {
  return exactArguments(call, 1)?.[0] ?? null;
}

/**
 * Produce a synthetic "after" node that reuses every structural field of
 * `before` but swaps `text`. The schemata compiler only reads `.text` from
 * `after`, so the rest of the shape exists only to satisfy the `ALSyntaxNode`
 * contract for TypeScript and any downstream consumer that inspects it.
 *
 * Mirrors `packages/builtin-tier1/src/mutate-helpers.ts`'s helper of the same
 * name and shape. Duplicated rather than imported: each tier package owns its
 * own synthesis helper instead of Tier 2 taking a dependency on Tier 1's
 * internals for what is a five-line structural adapter.
 */
export function synthesizeAfter(before: ALSyntaxNode, text: string): ALSyntaxNode {
  return {
    kind: before.kind,
    rawKind: before.rawKind,
    text,
    startIndex: before.startIndex,
    endIndex: before.endIndex,
    startPosition: before.startPosition,
    endPosition: before.endPosition,
    parent: before.parent,
    children: before.children,
    namedChildren: before.namedChildren,
    fieldName: before.fieldName,
    childForFieldName: before.childForFieldName.bind(before),
  };
}
