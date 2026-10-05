/**
 * R-307 O5. The EMIT half of `compileSchemataForFile`: the instrumented file's text, built from a
 * frozen `CompilePlan` alone. It reads no node and makes no decision; every refusal and every plain
 * `Error` is PLAN's (`compile-plan.ts`), so EMIT cannot refuse.
 *
 * I4, the one way EMIT can still fail: EMIT builds text of size sum(k+1)·L per component (k
 * members, root text of length L). If that passes the engine's string limit, EMIT crashes the run
 * with `RangeError: Invalid string length`. This is a crash, not a refusal. A dry run runs PLAN
 * only and will not see it. `EMIT_CRASHES` names it, and nothing else.
 */
import { type SpanEdit, joinEdits } from "@lethal/engine";
import type { CompilePlan, PlannedPayload } from "./compile-plan";
import { emitDispatch, endsInTerminator } from "./dispatch-emit";

/** I4: the only failure EMIT can raise, and it is a crash of the run, never a refusal. */
export const EMIT_CRASHES = ["RangeError: Invalid string length"] as const;

/** The instrumented text of one file. Each chain root's text is sliced from `source` once. */
export function emitFile(plan: CompilePlan): string {
  const edits: SpanEdit<string>[] = [];
  for (const edit of plan.edits) {
    edits.push({
      start: edit.start,
      end: edit.end,
      kind: edit.kind,
      payload: payloadText(plan.source, edit.start, edit.end, edit.payload),
    });
  }
  return joinEdits(plan.source, edits);
}

function payloadText(source: string, start: number, end: number, p: PlannedPayload): string {
  if (p.kind === "text") return p.text;
  // The chain replaces exactly the root's span, which is this edit's span.
  const original = source.slice(start, end);
  const chain = emitDispatch(original, p.component, p.latch, p.selector);
  if (!p.wrap) return chain;
  // The `begin ... end` wrap (PLAN decided it; see `needsWrap`). Its closing `;` is reproduced if
  // and only if the consumed root text ended in one.
  return `begin\n${chain}\nend${endsInTerminator(original) ? ";" : ""}`;
}
