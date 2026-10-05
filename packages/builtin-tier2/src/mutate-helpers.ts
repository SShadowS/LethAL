import { withText } from "@lethal/engine";
import type { ALSyntaxNode } from "@lethal/operator-sdk";

// R-452: the argument readers moved to `@lethal/engine` (`ast/arguments.ts`) so a Tier-1 operator
// reads arguments through the same accessor. Re-exported so every Tier-2 import stays as it was.
export { countArguments, exactArguments, soleArgument } from "@lethal/engine";

/**
 * Produce a synthetic "after" node: `before` with only `text` swapped. Every
 * other member reads through `before` on demand (`withText`, RUST-03 S4.2c), so
 * a spec pins no copied child arrays or closure. The schemata compiler only
 * reads `.text` from `after`.
 *
 * Mirrors `packages/builtin-tier1/src/mutate-helpers.ts`'s helper of the same
 * name. Both delegate to the engine rather than Tier 2 importing Tier 1.
 */
export function synthesizeAfter(before: ALSyntaxNode, text: string): ALSyntaxNode {
  return withText(before, text);
}
