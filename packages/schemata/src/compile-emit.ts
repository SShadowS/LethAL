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
import {
  emitDispatch,
  emitDispatchAt,
  emitDispatchOpen,
  endsInTerminator,
  guardOpen,
  wouldGlue,
} from "./dispatch-emit";

/** I4: the only failure EMIT can raise, and it is a crash of the run, never a refusal. */
export const EMIT_CRASHES = ["RangeError: Invalid string length"] as const;

/** The instrumented text of one file. Each chain root's text is sliced from `source` once. */
export function emitFile(plan: CompilePlan): string {
  const edits: SpanEdit<string>[] = [];
  for (const edit of plan.edits) {
    const payload = payloadText(plan.source, edit.start, edit.end, edit.payload);
    // R853: a chain opening right after a word (`begin"My Q"`) must not read `beginif`.
    const chain = edit.payload.kind !== "text" && edit.payload.kind !== "guard";
    const glued = chain && wouldGlue(plan.source.charAt(edit.start - 1), payload);
    edits.push({
      start: edit.start,
      end: edit.end,
      kind: edit.kind,
      payload: glued ? ` ${payload}` : payload,
    });
  }
  return joinEdits(plan.source, edits);
}

/**
 * R926. Where a SOURCE offset lands in the text `emitFile` builds, for the offsets the ORIGINAL
 * code keeps: the copy a run with no mutant active executes. A side table: it builds no text and
 * `emitFile` does not call it. An offset inside a replaced chain maps into the chain's `else begin`
 * copy of the root; any other offset moves by the edits before it.
 */
export function originalPositions(plan: CompilePlan): (source: number) => number | undefined {
  const rows: Array<{ start: number; end: number; delta: number; originalAt: number | undefined }> =
    [];
  for (const edit of plan.edits) {
    const p = edit.payload;
    const payload = payloadText(plan.source, edit.start, edit.end, p);
    const chain = p.kind !== "text" && p.kind !== "guard";
    const glue = chain && wouldGlue(plan.source.charAt(edit.start - 1), payload) ? 1 : 0;
    let originalAt: number | undefined;
    if (p.kind === "chain") {
      const original = plan.source.slice(edit.start, edit.end);
      originalAt =
        glue +
        (p.wrap ? "begin\n".length : 0) +
        emitDispatchAt(original, p.component, p.latch, p.selector).originalAt;
    }
    rows.push({
      start: edit.start,
      end: edit.end,
      delta: glue + payload.length - (edit.end - edit.start),
      originalAt,
    });
  }
  return (at) => {
    let moved = 0;
    for (const r of rows) {
      if (at < r.start) break;
      if (at < r.end) {
        if (r.originalAt === undefined) return undefined; // no original copy: no reach line
        return r.start + moved + r.originalAt + (at - r.start);
      }
      moved += r.delta;
    }
    return at + moved;
  };
}

function payloadText(source: string, start: number, end: number, p: PlannedPayload): string {
  if (p.kind === "text") return p.text;
  if (p.kind === "guard") return guardOpen(p.member, p.latch, p.selector);
  if (p.kind === "chain-open") {
    const { rootStart, rootEnd } = p.component;
    return emitDispatchOpen(
      source.slice(rootStart, rootEnd),
      p.component,
      p.latch,
      p.selector,
      p.wrap,
    );
  }
  // The chain replaces exactly the root's span, which is this edit's span.
  const original = source.slice(start, end);
  const chain = emitDispatch(original, p.component, p.latch, p.selector);
  // A chain ending in `end` (no `;`) must not touch the source after it: `Foo(C + 1)end` would read
  // `endend` (AL0111). A space, never a newline: no line moves.
  const next = source[end];
  const gap = !endsInTerminator(original) && next !== undefined && !/[\s;]/.test(next) ? " " : "";
  if (!p.wrap) return `${chain}${gap}`;
  // The `begin ... end` wrap (PLAN decided it; see `needsWrap`). Its closing `;` is reproduced if
  // and only if the consumed root text ended in one.
  return `begin\n${chain}\nend${endsInTerminator(original) ? ";" : ""}${gap}`;
}
