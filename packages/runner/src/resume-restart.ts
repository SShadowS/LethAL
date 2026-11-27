import type { CoverageMap, TestVerdict } from "./backend";
import type { BaselineObservation } from "./baseline-snapshot";
import { testKeyOf } from "./selection";
import { commonWorkDate } from "./workdate-guard";

/**
 * PR-456 (R1229, spec 2026-11-26-pr456-resume-across-restart.md r3-r5): a resume across a BC restart that
 * lost the database carries SURVIVORS only, and only for a batch whose fresh baseline equals, exactly, the
 * baseline the prior run measured for the same instrumented tree. Kills are re-run (their killer seeds
 * R197's ledger first), and a strand stays skipped as today. This module holds the pure decisions; the
 * orchestrator wires them in.
 */

/** What a restart-mode resume knows about the two sessions: both generations and database ids. */
export interface RestartResume {
  readonly priorGeneration: string;
  readonly priorDatabaseId: string;
  readonly generation: string;
  readonly databaseId: string;
  readonly resourceKey: string;
}

/**
 * Whether a resume across a changed generation AND a changed database id may go on in restart mode:
 * both runs recorded a non-empty database id (a missing id refuses, as before), the ids differ (the
 * same id is R969's lease reset, not this), and both ran on the SAME server tier (`resourceKey`, never
 * null on either side: a run on bc1 is not carried onto bc2 "across a restart"). `undefined`: refuse.
 */
export function restartResumeOf(
  row: {
    readonly serverGeneration: string | null;
    readonly databaseId: string | null;
    readonly resourceKey: string | null;
  },
  current: {
    readonly serverGeneration: string;
    readonly databaseId: string | undefined;
    readonly resourceKey: string | undefined;
  },
): RestartResume | undefined {
  const { serverGeneration: priorGeneration, databaseId: priorDatabaseId, resourceKey: key } = row;
  const { databaseId, resourceKey } = current;
  if (priorGeneration === null || priorGeneration === "") return undefined;
  if (priorDatabaseId === null || priorDatabaseId === "") return undefined;
  if (databaseId === undefined || databaseId === "" || databaseId === priorDatabaseId)
    return undefined;
  if (key === null || resourceKey === undefined || key !== resourceKey) return undefined;
  return {
    priorGeneration,
    priorDatabaseId,
    generation: current.serverGeneration,
    databaseId,
    resourceKey,
  };
}

const coverageEntryKey = (e: CoverageMap["entries"][number]): string =>
  JSON.stringify([
    e.objectType,
    e.objectId,
    e.procedure ?? null,
    e.line ?? null,
    e.overloadIndex ?? null,
  ]);

const sameSet = (a: ReadonlySet<string>, b: ReadonlySet<string>): boolean =>
  a.size === b.size && [...a].every((x) => b.has(x));

/** The first way two stored coverage maps differ, or `undefined`. Entries compare as SETS, not by order. */
function coverageDiff(
  prior: CoverageMap | undefined,
  fresh: CoverageMap | undefined,
): string | undefined {
  if (prior === undefined && fresh === undefined) return undefined;
  if (prior === undefined || fresh === undefined) return "coverage present on one side only";
  if (prior.granularity !== fresh.granularity) {
    return `coverage granularity ${prior.granularity} then ${fresh.granularity}`;
  }
  if (
    !sameSet(
      new Set(prior.entries.map(coverageEntryKey)),
      new Set(fresh.entries.map(coverageEntryKey)),
    )
  ) {
    return "coverage entries differ";
  }
  const gaps = (c: CoverageMap) =>
    new Set((c.namingGaps ?? []).map((g) => `${g.objectType}:${g.objectId}`));
  if (!sameSet(gaps(prior), gaps(fresh))) return "coverage namingGaps differ";
  return undefined;
}

/**
 * r5 #6: why the fresh baseline of a batch is NOT equal to the prior run's baseline of the same tree, or
 * `undefined` when it is. Equal means, for every test: the same outcome; the same start WorkDate (a
 * WorkDate missing on BOTH sides is equal only for a `skip`, a one-sided absence differs); the same whole
 * stored `CoverageMap` (both missing is equal). And the batch-level `commonWorkDate` is present on both
 * sides and equal (no date: hub mode, which never carries).
 */
export function compareRestartBaseline(
  prior: readonly BaselineObservation[],
  fresh: readonly BaselineObservation[],
): string | undefined {
  const priorDate = commonWorkDate(prior);
  const freshDate = commonWorkDate(fresh);
  if (priorDate === undefined || freshDate === undefined) {
    return `the batch's start WorkDate is missing or unstable on ${priorDate === undefined ? "the prior run" : "this session"}'s baseline`;
  }
  if (priorDate !== freshDate)
    return `the batch's start WorkDate moved (${priorDate}, now ${freshDate})`;
  const byKey = (rows: readonly BaselineObservation[]) =>
    new Map(rows.map((r) => [testKeyOf(r.ref), r]));
  const p = byKey(prior);
  const f = byKey(fresh);
  if (p.size !== prior.length || f.size !== fresh.length)
    return "a test appears twice in a baseline";
  if (!sameSet(new Set(p.keys()), new Set(f.keys())))
    return "the two baselines ran different test methods";
  for (const [key, was] of p) {
    const now = f.get(key);
    if (now === undefined) return "the two baselines ran different test methods";
    const name = `${was.ref.codeunitName}.${was.ref.method}`;
    if (was.verdict.outcome !== now.verdict.outcome) {
      return `${name}: outcome ${was.verdict.outcome}, now ${now.verdict.outcome}`;
    }
    const wasDate = was.verdict.workDate;
    const nowDate = now.verdict.workDate;
    if (wasDate !== nowDate || (wasDate === undefined && was.verdict.outcome !== "skip")) {
      return `${name}: start WorkDate ${wasDate ?? "missing"}, now ${nowDate ?? "missing"}`;
    }
    const cov = coverageDiff(was.verdict.coverage, now.verdict.coverage);
    if (cov !== undefined) return `${name}: ${cov}`;
  }
  return undefined;
}

/** A batch's restart decision: carry its survivors (against this snapshot's tree hash), or re-run, by name. */
export type RestartBatchDecision =
  | {
      readonly carry: true;
      readonly priorRunId: number;
      readonly priorBatchIndex: number;
      /** The hash of the snapshot that compared equal: a carried row's own batch must hash to it. */
      readonly batchHash: string;
    }
  | { readonly carry: false; readonly reason: string };

export interface RestartBatchInput {
  /** The prior run's snapshot for this batch's tree hash (`priorRestartSnapshot`), or `null`. */
  readonly prior: {
    readonly runId: number;
    readonly batchIndex: number;
    readonly batchHash: string;
    readonly baseline: readonly BaselineObservation[];
  } | null;
  readonly fresh: readonly BaselineObservation[];
  /** Every test of the batch has a verdict in `fresh`. */
  readonly freshComplete: boolean;
  /** `fresh` is a reused snapshot, not this session's own measurement. */
  readonly reused: boolean;
  /** isolatesTests, isolationAuto or baselineBatchingKnobOff: the baseline's rows depend on the session. */
  readonly isolationMode: boolean;
  /** `stoppedByUs`: a test the session's own stop ended. */
  readonly isStopped: (v: TestVerdict) => boolean;
}

/** r5 #5: the decision for one batch, after its fresh baseline and before any of its mutants is scheduled. */
export function decideRestartBatch(input: RestartBatchInput): RestartBatchDecision {
  const no = (reason: string): RestartBatchDecision => ({ carry: false, reason });
  if (input.isolationMode)
    return no(
      "an isolation or baseline-batching mode is on, so its baseline rows depend on the session",
    );
  if (!input.freshComplete)
    return no("this session's baseline did not complete (a time budget or a stop)");
  if (input.reused) return no("this batch's baseline was reused, not measured fresh");
  if (input.fresh.some((b) => input.isStopped(b.verdict)))
    return no("this session's baseline holds a stopped test");
  const { prior } = input;
  if (prior === null)
    return no("the prior run holds no usable baseline snapshot for this batch's instrumented tree");
  if (prior.baseline.some((b) => input.isStopped(b.verdict)))
    return no("the prior baseline holds a stopped test");
  if (commonWorkDate(input.fresh) === undefined)
    return no("hub mode: this batch's baseline carries no start WorkDate");
  const why = compareRestartBaseline(prior.baseline, input.fresh);
  if (why !== undefined) return no(`the baseline differs from the prior run's: ${why}`);
  return {
    carry: true,
    priorRunId: prior.runId,
    priorBatchIndex: prior.batchIndex,
    batchHash: prior.batchHash,
  };
}

/**
 * r5 #4: a survivor carries across a restart only when the tree hash of ITS batch in the prior run is the
 * hash of the snapshot that compared equal. Anything else is a caller-contract violation: throw, never
 * carry. `rowBatchHash` is `snapshotBatchHash(prior, row.batchIndex)?.batchHash`.
 */
export function assertRestartRowBatch(
  decision: Extract<RestartBatchDecision, { carry: true }>,
  priorRunId: number,
  row: { readonly batchIndex: number | undefined },
  rowBatchHash: string | null | undefined,
): void {
  if (row.batchIndex === undefined || rowBatchHash === undefined || rowBatchHash === null) {
    throw new Error(
      `resume across a restart: a prior survivor of run ${priorRunId} has no batch snapshot to check it against (batch ${row.batchIndex ?? "unknown"}); it is not carried — caller-contract violation (PR-456)`,
    );
  }
  if (rowBatchHash !== decision.batchHash) {
    throw new Error(
      `resume across a restart: a prior survivor of run ${priorRunId} belongs to batch ${row.batchIndex}, whose tree hash is not the hash of the baseline that was compared equal; it is not carried — caller-contract violation (PR-456)`,
    );
  }
}
