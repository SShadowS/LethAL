import type { ALSyntaxNode, MutationSpec } from "@lethal/engine";
import { printWithRewrites } from "@lethal/engine";
import { assignMutantIds } from "./ids";
import { wrapStatement } from "./wrap";

export function compileSchemataForFile(
  source: string,
  root: ALSyntaxNode,
  specs: readonly MutationSpec[],
): string {
  const ided = assignMutantIds(new Map([["<file>", specs]])).get("<file>") ?? [];

  const rewrites = new Map<ALSyntaxNode, string>();
  for (const { mutantId, spec } of ided) {
    if (spec.parentContext !== "statement-position") {
      throw new Error(
        `compileSchemataForFile: parentContext "${spec.parentContext}" not yet supported in Layer 2. ` +
          "Lift and duplicate strategies land in Layer 3.",
      );
    }
    const after = spec.after as unknown as { text?: string };
    const replacement = after.text ?? null;
    rewrites.set(
      spec.before,
      wrapStatement({ mutantId, original: spec.before, replacement }),
    );
  }

  return printWithRewrites(source, root, rewrites);
}
