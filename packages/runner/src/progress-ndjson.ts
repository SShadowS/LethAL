/**
 * The NDJSON crash-diagnostic sink for the event stream (spec 2026-08-05 §A, events.ts).
 *
 * Motivation: before this existed, a crashed run produced NO report at all — `report.ts`'s
 * `renderConsole`/`writeJsonReport` only run once `runSession` RETURNS, so a session that dies
 * mid-run leaves nothing but whatever partial rows already landed in `bun:sqlite`. R89 (ROADMAP.md)
 * measured the cost of that directly: three stranded attempts against a real hosted environment
 * each needed manual sqlite queries to reconstruct what had happened. This sink writes one JSON
 * object per line, flushed as each event arrives, so a killed process leaves a file a human OR an
 * agent can read straight through — no query, no waiting for the run to finish. It is also the
 * answer to a DIFFERENT cost from the same campaign: an agent consumer of a run had to shell out to
 * `jq` repeatedly just to discover the report's shape, because there was no structured stream to
 * read at all, only rendered prose.
 *
 * THE HEADER LINE. Line 1 of the file is NOT the first `RunEvent` — it is a header this sink
 * writes itself, on construction, before forwarding anything. That is deliberate: `stream-started`
 * is not actually the first event `runSession` emits (`run-configured` and `tests-discovered` fire
 * before it, because neither needs a `runId` and the "no tests discovered"/bad-`--resume` refusals
 * must be able to fire before any run row exists — forcing `stream-started` first would mean
 * calling `createRun()` earlier and leaving an orphaned, resumable-but-empty run row whenever a
 * session dies during discovery). So "line 1 carries the schema version" is a property THIS SINK
 * guarantees, not a property of the event order. The header carries its own `ndjsonHeader: true`
 * marker precisely so a consumer can tell it apart from a real `stream-started` event (which also
 * carries `streamSchemaVersion`, but is a `RunEvent` with a `seq`, `type: "stream-started"`, and a
 * `runId` this header does not have).
 *
 * THE PROVISIONAL-VERDICT RULE. `batch-invalidated` can supersede verdicts already written to this
 * file — a batch that already reported `mutant-scored` lines for some mutants can later be
 * invalidated (a lease loss, a deploy that turns out unsound) and rerun. A consumer reading this
 * file line by line, or an agent tailing it live, MUST treat every verdict-carrying line
 * (`mutant-scored`, `mutant-carried`, `mutant-skipped-stranded`) as PROVISIONAL until
 * `session-finished` appears: acting on a `survived` line that a later `batch-invalidated` retracts
 * means acting on a fact the run itself no longer stands behind.
 *
 * NEVER THROWS BY DESIGN, not by a defensive wrapper: this sink does not inspect event SHAPE at
 * all, it just serialises whatever `RunEvent` it is given — so a future event type needs no change
 * here, unlike `progress-renderer.ts`'s exhaustive switch. `JSON.stringify` cannot fail on any
 * `RunEvent` (no circular references, no `bigint`, no functions in the union). The one thing that
 * COULD throw is the caller's injected `write` — deliberately not caught here, because `cli.ts`
 * registers this as one of possibly several subscribers and `runSession`'s own `createEmitter`
 * already isolates a throwing subscriber from every other one and from the run itself (events.ts).
 * Swallowing here too would just hide a real disk-full/EBADF failure from that existing mechanism.
 */
import type { EventSubscriber, RunEvent } from "./events";
import { STREAM_SCHEMA_VERSION } from "./events";

/**
 * The sink's own first line — distinguished from a real `stream-started` `RunEvent` by
 * `ndjsonHeader: true` (a `RunEvent` never has this key) and by having no `seq`/`runId` at all.
 */
interface NdjsonHeader {
  readonly ndjsonHeader: true;
  readonly streamSchemaVersion: number;
}

/**
 * Serialises each `RunEvent` as one line of JSON, preceded by a header line (see module doc).
 * `write` is injected so this is testable without a real file — `cli.ts`'s `--progress-out <path>`
 * wires it to a synchronous file write so a killed process still has whatever was written to the
 * OS before the kill, not whatever sat buffered in a stream.
 */
export function createNdjsonSink(write: (chunk: string) => void): EventSubscriber {
  const header: NdjsonHeader = { ndjsonHeader: true, streamSchemaVersion: STREAM_SCHEMA_VERSION };
  write(`${JSON.stringify(header)}\n`);
  return (event: RunEvent): void => {
    write(`${JSON.stringify(event)}\n`);
  };
}
