import type { ALSyntaxNode, MutationSpec } from "@lethal/engine";
import { printWithRewrites } from "@lethal/engine";
import { resolveSite } from "./enclosing";
import { assignMutantIds, type IdedSpec } from "./ids";
import { wrapStatement } from "./wrap";

export function compileSchemataForFile(
  source: string,
  root: ALSyntaxNode,
  specs: readonly MutationSpec[],
): string {
  const ided = assignMutantIds(new Map([["<file>", specs]])).get("<file>") ?? [];

  const rewrites = new Map<ALSyntaxNode, string>();
  for (const entry of ided) {
    applyOne(entry, rewrites);
  }

  return printWithRewrites(source, root, rewrites);
}

function applyOne(
  entry: IdedSpec,
  rewrites: Map<ALSyntaxNode, string>,
): void {
  const { mutantId, spec } = entry;
  if (spec.parentContext === "statement-position") {
    const afterText = (spec.after as unknown as { text?: string }).text ?? "";
    const site = resolveSite(spec.before, afterText);
    const replacement =
      afterText === ""
        ? wrapStatement({ mutantId, original: site.statement, replacement: null })
        : wrapStatement({
            mutantId,
            original: site.statement,
            replacement: site.mutatedText,
          });
    assertNoDuplicateRewrite(rewrites, site.statement);
    rewrites.set(site.statement, replacement);
    return;
  }
  throw new Error(
    `compileSchemataForFile: parentContext "${spec.parentContext}" requires Task 12/13. ` +
      "Call is still coming.",
  );
}

function assertNoDuplicateRewrite(
  rewrites: ReadonlyMap<ALSyntaxNode, string>,
  node: ALSyntaxNode,
): void {
  if (rewrites.has(node)) {
    throw new Error(
      `compileSchemataForFile: two specs resolved to the same statement at ${node.startIndex}..${node.endIndex}. ` +
        "Multi-mutation-per-statement composition is not yet supported.",
    );
  }
}
