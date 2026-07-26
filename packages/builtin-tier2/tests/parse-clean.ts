/**
 * Shared test plumbing for the Tier-2 operator suites.
 *
 * `parseClean` exists because every Tier-2 test that asserts a REFUSAL is one malformed snippet
 * away from passing for the wrong reason: a snippet the grammar cannot parse produces no
 * `call_expression`, so the operator "refuses" it no matter what the operator's guards do. Failing
 * loudly on `ERROR`/`MISSING` nodes turns that class of false green into a red.
 *
 * Not a `*.test.ts` file, so `bun test` does not run it as a suite.
 */
import {
  type ALSyntaxNode,
  type SemanticContext,
  buildSemanticContext,
  parseAL,
  visit,
  wrapRoot,
} from "@lethal/engine";

/** Parse, and throw if the fixture itself is malformed. */
export function parseClean(src: string): ALSyntaxNode {
  const root = wrapRoot(parseAL(src));
  const bad: string[] = [];
  visit(root, (n) => {
    if (n.rawKind === "ERROR" || n.rawKind === "MISSING") {
      bad.push(`${n.rawKind}@${n.startIndex}:${JSON.stringify(n.text.slice(0, 40))}`);
    }
  });
  if (bad.length > 0) {
    throw new Error(`test fixture does not parse cleanly: ${bad.join(", ")}\n---\n${src}`);
  }
  return root;
}

/**
 * A single-file semantic context.
 *
 * Adequate for every rule whose evidence lives in the same file as the call site. The one guard it
 * CANNOT exercise is the project-declared-procedure refusal for a qualified receiver, which needs
 * the receiver's table in the context — see `projectContextFor` and the orchestrator-shaped tests
 * in `receiver.test.ts`.
 */
export function contextFor(root: ALSyntaxNode): SemanticContext {
  return buildSemanticContext([{ path: "fixture.al", root }]);
}

/**
 * A semantic context built the way `generateMutationSet`
 * (`packages/runner/src/orchestrator.ts`) builds one: over EVERY file of the project at once.
 *
 * Tests of the shadowing guard must use this, not `contextFor` on a concatenated blob: a
 * single-file context certifies a configuration the pipeline never produces (one AL object per
 * file is the normal layout).
 */
export function projectContextFor(files: readonly ALSyntaxNode[]): SemanticContext {
  return buildSemanticContext(files.map((root, i) => ({ path: `file${i}.al`, root })));
}
