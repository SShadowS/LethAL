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
  parentContext: z.enum([
    "statement-position",
    "expression-position",
    "short-circuit-operand",
  ]),
  equivalenceHint: z.enum(["likely-equivalent", "unknown"]).optional(),
});

export type ValidationResult =
  | { ok: true }
  | { ok: false; error: string };

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
 */
export function validateSpec(raw: unknown, root?: ALSyntaxNode): ValidationResult {
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
    if (
      typeof start !== "number" ||
      typeof end !== "number" ||
      !hasNodeWithSpan(root, start, end)
    ) {
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
  return err.issues
    .map((i) => `${i.path.join(".")}: ${i.message}`)
    .join("; ");
}
