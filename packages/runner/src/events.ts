/**
 * The run's event union and emitter (spec 2026-08-05 §A).
 *
 * Events are EPHEMERAL and IN-PROCESS. There is no durable event log, no replay-as-rebuild, and
 * events are never a resume source — `bun:sqlite` remains the incremental record and the only
 * thing `--resume` reads. A second durable truth can disagree with the first, which is R54's shape
 * reborn.
 *
 * Emission serialises on the JS event loop, but arrival order is COMPLETION order once batches run
 * concurrently. `seq` is stamped monotonically so a crash-truncated stream is detectable; the
 * report fold does not depend on arrival order, and `orchestrator.ts`'s final sort keeps the
 * folded artifact deterministic.
 */
import type { CoverageAttribution } from "./selection";
import type { MutantVerdict, RunnerKind } from "./store";

/** Bumped independently of `REPORT_SCHEMA_VERSION`. Consumers ignore unknown event types. */
export const STREAM_SCHEMA_VERSION = 1;

export type RunPhase = "generate" | "deploy" | "baseline" | "mutants" | "teardown";

interface Base {
  /** Monotonic, starting at 1. A gap means the stream was truncated. */
  readonly seq: number;
}

export type RunEventInput =
  | {
      readonly type: "stream-started";
      readonly streamSchemaVersion: number;
      readonly runId: number;
    }
  | { readonly type: "phase-entered"; readonly phase: RunPhase; readonly detail?: string }
  | { readonly type: "phase-left"; readonly phase: RunPhase; readonly elapsedMs: number }
  | {
      readonly type: "mutation-set-generated";
      readonly siteCount: number;
      readonly deployedCount: number;
      readonly totalFiles: number;
      readonly instrumentableFiles: number;
    }
  | {
      readonly type: "batch-published";
      readonly batchIndex: number;
      readonly guardCount: number;
      readonly elapsedMs: number;
    }
  | { readonly type: "batch-invalidated"; readonly batchIndex: number; readonly reason: string }
  | {
      readonly type: "baseline-finished";
      readonly testCount: number;
      readonly failingCount: number;
    }
  | {
      readonly type: "mutant-scored";
      readonly mutantCode: string;
      readonly verdict: MutantVerdict;
      readonly batchIndex: number;
      readonly durationMs: number;
      readonly killingTest?: string;
      readonly failureNote?: string;
      readonly coveringTests: readonly string[];
      readonly coverageAttribution?: CoverageAttribution;
      readonly guardObserved?: boolean;
      readonly runner?: RunnerKind;
    }
  | {
      /**
       * A verdict `--resume` carried from a prior run.
       *
       * DELIBERATELY has no `durationMs` field. The prior cost lives only in `priorDurationMs`, so
       * the fold cannot sum it into `mutantsMs` even by accident — R54 becomes unrepresentable
       * rather than guarded by a filter someone forgets (`report.ts:865`).
       */
      readonly type: "mutant-carried";
      readonly mutantCode: string;
      readonly verdict: MutantVerdict;
      readonly fromRunId: number;
      readonly priorDurationMs: number;
      readonly coveringTests: readonly string[];
    }
  | { readonly type: "mutant-skipped-stranded"; readonly mutantCode: string; readonly note: string }
  | { readonly type: "warning"; readonly code: string; readonly message: string }
  | { readonly type: "quarantined"; readonly reason: string }
  | { readonly type: "session-finished"; readonly elapsedMs: number };

export type RunEvent = RunEventInput & Base;

export type EventSubscriber = (event: RunEvent) => void;

export type RunEmitter = (event: RunEventInput) => void;

/**
 * A subscriber that throws must not abort the run or cost the other subscribers their event: a
 * broken renderer is a cosmetic failure, and losing a `mutant-scored` event would corrupt the
 * report. The throw is swallowed deliberately and reported once on stderr.
 */
export function createEmitter(subscribers: readonly EventSubscriber[]): RunEmitter {
  let seq = 0;
  const broken = new Set<number>();
  return (input: RunEventInput): void => {
    seq += 1;
    const event = { ...input, seq } as RunEvent;
    subscribers.forEach((sub, i) => {
      try {
        sub(event);
      } catch (err) {
        if (!broken.has(i)) {
          broken.add(i);
          process.stderr.write(
            `[lethal] event subscriber ${i} threw and will keep receiving events: ${String(err)}\n`,
          );
        }
      }
    });
  };
}
