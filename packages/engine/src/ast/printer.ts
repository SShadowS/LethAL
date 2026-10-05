import { joinEdits } from "./join-edits";
import { planEdits } from "./rewrite-plan";
import type { ALSyntaxNode } from "./syntax-node";

export { print } from "./join-edits";

/**
 * R-307 O4: a composition. PLAN (`planEdits`: E4, the stable sort, the overlap refusal) then EMIT
 * (`joinEdits`: the final join). An empty map returns `source` unchanged.
 */
export function printWithRewrites(
  source: string,
  root: ALSyntaxNode,
  rewrites: ReadonlyMap<ALSyntaxNode, string>,
  where?: string,
): string {
  return joinEdits(source, planEdits(source, root, rewrites, where));
}
