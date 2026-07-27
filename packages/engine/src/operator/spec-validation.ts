import { z } from "zod";
import type { ALSyntaxNode } from "../ast/syntax-node";
import { visit } from "../ast/syntax-node";

const SEMVER = /^\d+\.\d+\.\d+(?:-[\w.]+)?(?:\+[\w.]+)?$/;

const specSchema = z.object({
  operatorName: z.string().min(1),
  operatorVersion: z.string().regex(SEMVER),
  astNodeId: z.string().min(1),
  before: z.object({ kind: z.string() }).passthrough(),
  after: z.object({ kind: z.string() }).passthrough(),
  parentContext: z.enum(["statement-position", "expression-position", "short-circuit-operand"]),
  equivalenceHint: z.enum(["likely-equivalent", "unknown"]).optional(),
});

export type ValidationResult = { ok: true } | { ok: false; error: string };

/** `${startIndex}-${endIndex}` key used by {@link buildSpanIndex} and the
 * indexed branch of {@link validateSpec}. */
function spanKey(start: number, end: number): string {
  return `${start}-${end}`;
}

/**
 * Index every node's `startIndex`/`endIndex` span in `root`, once, so that
 * `validateSpec` can check root-membership in O(1) per spec instead of
 * walking the whole tree per spec. Build this once per file (there's one
 * `root` per parsed file) and pass it to every `validateSpec` call for specs
 * generated against that file — see `generateMutationSet` in
 * `packages/runner/src/orchestrator.ts`.
 */
export function buildSpanIndex(root: ALSyntaxNode): ReadonlySet<string> {
  const index = new Set<string>();
  visit(root, (n) => {
    index.add(spanKey(n.startIndex, n.endIndex));
  });
  return index;
}

/**
 * When `root` is given, `spec.before` must correspond to a real node in that
 * tree, matched by exact start/end byte range. Coalescing (Layer 4.3) relies
 * on mutation sites being laminar — any two sites disjoint or nested, never
 * partially overlapping — which holds for genuine tree-sitter node ranges by
 * construction, but NOT for a synthetic multi-node span a custom operator
 * might invent (e.g. "argument plus separator" for an argument-swap
 * operator), which could produce true partial overlap and silently break the
 * grouping the whole layer rests on. `root` is optional so existing
 * single-argument callers are unaffected.
 *
 * `spanIndex` is an optional pre-built {@link buildSpanIndex} result. When
 * given, membership is a Set lookup instead of a fresh tree walk — callers
 * validating many specs against the same `root` (e.g. one per AST node
 * visited) should build the index once and pass it through, turning an
 * O(specs × nodes) tree-walk-per-spec into O(nodes + specs). When omitted,
 * behavior falls back to walking `root` per call, unchanged from before —
 * so existing `(spec, root)` callers keep their exact prior behavior.
 */
export function validateSpec(
  raw: unknown,
  root?: ALSyntaxNode,
  spanIndex?: ReadonlySet<string>,
): ValidationResult {
  const parsed = specSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: formatZodError(parsed.error) };
  if (root !== undefined) {
    // Read the span off the ORIGINAL `raw.before`, not `parsed.data.before`:
    // zod's `.passthrough()` reconstructs the object from `Object.keys`, which
    // does not pick up `startIndex`/`endIndex` on a real `ALSyntaxNode` (they
    // are non-enumerable prototype getters there), so the parsed copy would
    // spuriously fail this check for genuine nodes.
    const before = (raw as { before: unknown }).before as {
      startIndex?: unknown;
      endIndex?: unknown;
    };
    const start = before.startIndex;
    const end = before.endIndex;
    const matches =
      typeof start === "number" &&
      typeof end === "number" &&
      (spanIndex !== undefined
        ? spanIndex.has(spanKey(start, end))
        : hasNodeWithSpan(root, start, end));
    if (!matches) {
      return {
        ok: false,
        error: `before span ${String(start)}..${String(end)} does not match any node in the parsed tree`,
      };
    }
  }
  return { ok: true };
}

function hasNodeWithSpan(root: ALSyntaxNode, start: number, end: number): boolean {
  let found = false;
  visit(root, (n) => {
    if (n.startIndex === start && n.endIndex === end) found = true;
  });
  return found;
}

function formatZodError(err: z.ZodError): string {
  return err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
}
