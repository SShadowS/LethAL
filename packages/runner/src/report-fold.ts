import type { BackendCapabilities } from "./backend";
import type { RunEvent } from "./events";
import type { PermissionCanaryResult } from "./permission-canary";
import type { NotInstrumentedFile, SessionOutcome } from "./report";

/**
 * Folds the run's events into the facts `buildReport` (report.ts) renders (spec 2026-08-05 §A,
 * "AMENDED AFTER TASK-2 REVIEW").
 *
 * THROWS on a missing mandatory event; it never defaults. The bag this replaces
 * (`BuildReportInput`, deleted) deliberately made fields required — `untargetedTriggerCount` was a
 * required `number` because "an absent tally and a measured zero must never look alike"
 * (report.ts). A defaulting fold would turn every missing event into zero/false/empty,
 * industrialising this project's signature bug across the whole report. `finalize()` (the tail of
 * `foldEvents`) throws unless the mandatory events arrived: `mutation-set-generated`;
 * `baseline-batch-finished` OR `quarantined`; `session-finished`.
 *
 * `mutant-carried` has no `durationMs` field (only `priorDurationMs`), so a carried verdict cannot
 * reach the "this run's own cost" clock even by accident — see `SessionOutcome.priorDurationMs`'s
 * doc comment (report.ts) for how that stays true all the way to `SessionReport.timings.mutantsMs`.
 * That is R54 made unrepresentable rather than guarded by a filter someone forgets.
 *
 * Unknown event types are ignored (forward compatibility, per the stream contract in events.ts) —
 * the `default` arm of the switch below does nothing rather than throwing.
 *
 * Order-independent by construction: `events.ts`'s own doc comment notes arrival order is
 * completion order, not emission order, once batches run concurrently. Every case below either
 * accumulates into a running total/Set (order doesn't matter) or overwrites a single scalar with
 * the last-seen value (`quarantined.reason`, `resume-resolved.fromRunId`, ... — each of these fires
 * at most once per real run, so "last write wins" and "first write wins" coincide in practice).
 * `batch-invalidated` is the one event whose effect genuinely depends on "everything else this
 * batch produced" being known first, so it is applied in a second pass, in `finalize()`, after every
 * mutant event has already been folded — never inline, which would silently miss an outcome that
 * happens to arrive after the invalidation in the raw event order.
 */
export interface FoldStatics {
  readonly caps: BackendCapabilities;
  /**
   * R41: the `--only` narrowing this run was GIVEN, if any — patterns only. How many files that
   * excluded is LEARNED (see `mutation-set-generated.excludedByOnly`, events.ts); the fold reunites
   * the two into `FoldedReport.only`.
   */
  readonly only?: { readonly patterns: readonly string[] };
  /** R45: the `--tests-only` narrowing this run was GIVEN, if any. */
  readonly testsOnly?: readonly string[];
  /** R53: whether this run was allowed to end BC sessions to score a non-terminating mutant. */
  readonly stopHungSessions?: boolean;
}

/**
 * Everything `buildReport` needs beyond `FoldStatics` — the fold's output. Deliberately NOT named
 * `BuildReportInput`: that type is deleted (spec 2026-08-05 §A). Same fields the bag used to carry,
 * minus the four closed statics (read directly off `FoldStatics` instead) — every one of them is
 * now LEARNED from events rather than assembled by hand in `orchestrator.ts`.
 */
export interface FoldedReport {
  readonly caps: BackendCapabilities;
  readonly baselineGreen: boolean;
  readonly batches: number;
  readonly outcomes: readonly SessionOutcome[];
  readonly unsupportedTests: readonly string[];
  readonly notInstrumented: {
    readonly totalFiles: number;
    readonly files: readonly NotInstrumentedFile[];
  };
  readonly only?: {
    readonly patterns: readonly string[];
    readonly excludedFileCount: number;
  };
  readonly testsOnly?: readonly string[];
  readonly staleTestApp?: { readonly missingTests: readonly string[] };
  readonly permissionsRefusedTests?: readonly string[];
  readonly testPageUnsupportedTests?: readonly string[];
  readonly runnerDisagreementTests?: readonly string[];
  readonly stopHungSessions?: boolean;
  readonly resumedFrom?: {
    readonly runId: number;
    readonly carriedMutants: number;
    readonly skippedStranded: number;
  };
  readonly timings: {
    readonly totalMs: number;
    readonly generateMutationSetMs: number;
    readonly deployMs: number;
    readonly baselineMs: number;
  };
  readonly baselineTests: readonly { readonly codeunitName: string; readonly file?: string }[];
  readonly untargetedTriggerCount: number;
  readonly quarantined?: { readonly reason: string };
  readonly permissionCanary?: PermissionCanaryResult;
}

interface BatchInvalidation {
  readonly batchIndex: number;
  readonly reason: string;
}

export function foldEvents(statics: FoldStatics, events: readonly RunEvent[]): FoldedReport {
  let sawMutationSetGenerated = false;
  let sawBaselineBatchFinished = false;
  let sawQuarantined = false;
  let sawSessionFinished = false;

  let totalFiles = 0;
  let notInstrumentedFiles: readonly NotInstrumentedFile[] = [];
  let excludedByOnly = 0;
  // How many files `generateMutationSet` found instrumentable — see the mandatory-baseline-evidence
  // check below. 0 means `planArtifacts` returned zero batches (a project with no mutable sites is
  // never added to `files` at all — `orchestrator.ts`'s `if (specs.length === 0) continue;`), which
  // is the one case where the batch loop legitimately never runs and there is nothing wrong.
  let instrumentableFiles = 0;

  // AND across every baseline verdict across every `baseline-batch-finished` event — mirrors
  // `orchestrator.ts`'s `baselineGreenOverall`, which starts true and is never reset once false.
  let baselineGreen = true;
  const unsupportedTests = new Set<string>();
  const staleTestApp = new Set<string>();
  const permissionsRefusedTests = new Set<string>();
  const testPageUnsupportedTests = new Set<string>();
  const runnerDisagreementTests = new Set<string>();

  let baselineTests: readonly { readonly codeunitName: string; readonly file?: string }[] = [];

  // How many times this run entered the deploy phase — one per batch loop iteration, emitted
  // unconditionally before that batch's deploy attempt (including a failed one), so it counts
  // batches ATTEMPTED. Matches `artifacts.length` (batches PLANNED) in the ordinary case; the one
  // divergence is a session that latches unsafe mid-run and never reaches a later planned batch's
  // deploy phase at all — there is no event naming the total planned count independent of attempting
  // it, so this is the closest learnable fact and is used deliberately rather than threaded as a
  // fifth static.
  let deployPhaseEntries = 0;
  // How many batches actually PUBLISHED successfully — see the mandatory-baseline-evidence check
  // below. Baseline runs immediately after a successful publish, unconditionally, so if this stays
  // 0 the baseline never got a chance regardless of `instrumentableFiles` — every batch's deploy
  // failed (environmental, or every bisection subset still failing), which is a real, existing,
  // successfully-COMPLETED session shape (`orchestrator.test.ts`'s bisection/deploy-failure suite).
  let batchPublishedCount = 0;

  let generateMutationSetMs = 0;
  let deployMs = 0;
  let baselineMs = 0;
  let totalMs = 0;

  let untargetedTriggerCount = 0;

  let quarantinedReason: string | undefined;
  let permissionCanary: PermissionCanaryResult | undefined;
  let resumeFromRunId: number | undefined;

  const outcomes: SessionOutcome[] = [];
  const invalidations: BatchInvalidation[] = [];
  let carriedCount = 0;
  let strandedSkipCount = 0;

  for (const e of events) {
    switch (e.type) {
      case "mutation-set-generated":
        sawMutationSetGenerated = true;
        totalFiles = e.totalFiles;
        notInstrumentedFiles = e.notInstrumentedFiles;
        excludedByOnly = e.excludedByOnly;
        instrumentableFiles = e.instrumentableFiles;
        break;
      case "baseline-batch-finished":
        sawBaselineBatchFinished = true;
        for (const v of e.verdicts) {
          if (v.outcome !== "pass") baselineGreen = false;
          // Task 6 (spec §9): "did not pass at baseline" — fail/error only, the SAME predicate
          // `didNotPassAtBaseline` (orchestrator.ts) applies; deadline-exceeded/timeout are
          // infra/timing, not a test-type verdict, and skip/pass are legitimate.
          if (v.outcome === "fail" || v.outcome === "error") unsupportedTests.add(v.name);
          // Classification is orthogonal to outcome (events.ts's own doc comment: computed over
          // ALL baseline verdicts, not just the non-passing ones) — read independently here.
          if (v.classification.includes("stale-test-app")) staleTestApp.add(v.name);
          if (v.classification.includes("tests-permission-refused")) {
            permissionsRefusedTests.add(v.name);
          }
          if (v.classification.includes("tests-testpage-unsupported")) {
            testPageUnsupportedTests.add(v.name);
          }
        }
        break;
      case "quarantined":
        sawQuarantined = true;
        quarantinedReason = e.reason;
        break;
      case "session-finished":
        sawSessionFinished = true;
        totalMs = e.elapsedMs;
        break;
      case "tests-discovered":
        baselineTests = e.tests.map((t) => ({
          codeunitName: t.codeunitName,
          ...(t.file !== undefined ? { file: t.file } : {}),
        }));
        break;
      case "phase-entered":
        if (e.phase === "deploy") deployPhaseEntries += 1;
        break;
      case "batch-published":
        batchPublishedCount += 1;
        break;
      case "phase-left":
        // Per-batch phases (`deploy`, `baseline`) fire once per batch and SUM; `generate` fires
        // once for the whole session — see `SessionReport.timings`'s own doc comment on why a
        // single total cannot be extrapolated across these three.
        if (e.phase === "generate") generateMutationSetMs += e.elapsedMs;
        else if (e.phase === "deploy") deployMs += e.elapsedMs;
        else if (e.phase === "baseline") baselineMs += e.elapsedMs;
        break;
      case "coverage-split":
        untargetedTriggerCount += e.untargetedTriggerCount;
        break;
      case "permission-canary":
        permissionCanary = e.result;
        break;
      case "resume-resolved":
        resumeFromRunId = e.fromRunId;
        break;
      case "mutant-scored":
        outcomes.push({
          mutant: e.mutant,
          verdict: e.verdict,
          batchIndex: e.batchIndex,
          durationMs: e.durationMs,
          coveringTests: e.coveringTests,
          ...(e.coverageAttribution !== undefined
            ? { coverageAttribution: e.coverageAttribution }
            : {}),
          ...(e.guardObserved !== undefined ? { guardObserved: e.guardObserved } : {}),
          ...(e.killingTest !== undefined ? { killingTest: e.killingTest } : {}),
          ...(e.failureNote !== undefined ? { failureNote: e.failureNote } : {}),
          ...(e.cause !== undefined ? { cause: e.cause } : {}),
          ...(e.runner !== undefined ? { runner: e.runner } : {}),
        });
        if (e.runnerDisagreementTest !== undefined) {
          runnerDisagreementTests.add(e.runnerDisagreementTest);
        }
        // R35: the OTHER source of a permissions refusal, alongside `baseline-batch-finished`'s
        // classification — a refusal found at KILL-CONFIRMATION time rather than at baseline. Both
        // feed the SAME `permissionsRefusedTests` set; a run can legitimately hit either or both.
        if (e.permissionRefusedTest !== undefined) {
          permissionsRefusedTests.add(e.permissionRefusedTest);
        }
        break;
      case "mutant-carried":
        carriedCount += 1;
        outcomes.push({
          mutant: e.mutant,
          verdict: e.verdict,
          batchIndex: e.batchIndex,
          carried: true,
          // R54: NOT `durationMs` — this event has no such field (see the doc comment above), so
          // this run's own cost clock structurally cannot see it. `priorDurationMs` carries the
          // prior run's cost for DISPLAY only — see `SessionOutcome.priorDurationMs`.
          priorDurationMs: e.priorDurationMs,
          coveringTests: e.coveringTests,
          ...(e.coverageAttribution !== undefined
            ? { coverageAttribution: e.coverageAttribution }
            : {}),
          ...(e.killingTest !== undefined ? { killingTest: e.killingTest } : {}),
          ...(e.failureNote !== undefined ? { failureNote: e.failureNote } : {}),
          ...(e.runner !== undefined ? { runner: e.runner } : {}),
        });
        break;
      case "mutant-skipped-stranded":
        strandedSkipCount += 1;
        outcomes.push({
          mutant: e.mutant,
          verdict: "error",
          batchIndex: e.batchIndex,
          failureNote: e.note,
        });
        break;
      case "batch-invalidated":
        invalidations.push({ batchIndex: e.batchIndex, reason: e.reason });
        break;
      default:
        break; // unknown event type — ignored, not fatal (forward compatibility, events.ts)
    }
  }

  if (!sawMutationSetGenerated) {
    throw new Error(
      "foldEvents: no mutation-set-generated event in this stream — a report cannot be built " +
        "without knowing what was generated (mutation-set-generated is mandatory).",
    );
  }
  // Two escapes besides `baseline-batch-finished`/`quarantined`, both real and both already
  // exercised by the orchestrator's own test suite:
  //
  //  1. `instrumentableFiles === 0` — a project with no mutable sites at all makes `planArtifacts`
  //     return `[]`; the batch loop never runs a single iteration, so the baseline literally never
  //     runs and nothing ever latches unsafe either.
  //  2. `batchPublishedCount === 0` (with `instrumentableFiles > 0`) — every batch that WAS planned
  //     failed to PUBLISH (an environmental deploy failure, or a bisection that keeps reproducing
  //     regardless of subset). Baseline runs immediately after a successful publish, unconditionally
  //     — no publish ever succeeding means baseline never got a chance, and the batch is instead
  //     recorded `error` with a bisection/environmental note, never scored.
  //
  // Both are real, successfully-COMPLETED sessions (`session-finished` still fires below), not
  // truncated streams. What must still throw: `instrumentableFiles > 0` AND `batchPublishedCount >
  // 0` (a batch WAS planned AND WAS published) with neither `baseline-batch-finished` nor
  // `quarantined` — that combination means a published artifact's baseline outcome is simply
  // missing from the stream, which is exactly the truncation this check exists to catch.
  if (
    !sawBaselineBatchFinished &&
    !sawQuarantined &&
    instrumentableFiles > 0 &&
    batchPublishedCount > 0
  ) {
    throw new Error(
      "foldEvents: neither baseline-batch-finished nor quarantined arrived, and at least one batch " +
        "was published — the fold cannot tell whether that batch's baseline ran, or the session " +
        "quarantined before it could. One of the two is mandatory once a batch has published.",
    );
  }
  if (!sawSessionFinished) {
    throw new Error(
      "foldEvents: no session-finished event in this stream — a truncated stream is not a report.",
    );
  }

  // `batch-invalidated` rewrites history: applied in a SECOND pass, over every outcome folded so
  // far, mirroring `invalidateBatchVerdicts` (orchestrator.ts) exactly — including its two
  // deliberately-untouched cases (an already-specifically-classified error, and a known-survivor,
  // which was never re-tested against this batch's binary at all). Applying invalidations in
  // emission order after full accumulation (rather than inline, mid-loop) is what makes this
  // correct regardless of whether a `batch-invalidated` event happens to arrive before or after the
  // mutant events it invalidates — see the order-independence note on the doc comment above.
  for (const inv of invalidations) {
    for (let i = 0; i < outcomes.length; i++) {
      const o = outcomes[i];
      if (o === undefined || o.batchIndex !== inv.batchIndex) continue;
      if (o.cause !== undefined || o.verdict === "known-survivor") continue;
      outcomes[i] = {
        mutant: o.mutant,
        verdict: "error",
        batchIndex: o.batchIndex,
        failureNote: inv.reason,
      };
    }
  }

  // The final sort — `orchestrator.ts` used to sort its in-memory `outcomes[]` before handing it to
  // `buildReport`; that array is gone, so this is where determinism now lives. Events arrive in
  // COMPLETION order once batches run concurrently (events.ts's own doc comment), not file order, so
  // without this the report's mutant ordering would depend on which worker finished first. Compare
  // (file, startIndex) as (string, number), not a colon-joined string: localeCompare on "file:1000"
  // vs "file:99" sorts ":1000" before ":99" (lexical compare of the numeric suffix), scrambling
  // report order for any file with 100+ mutable start offsets.
  outcomes.sort(
    (a, b) =>
      a.mutant.file.localeCompare(b.mutant.file) || a.mutant.startIndex - b.mutant.startIndex,
  );

  return {
    caps: statics.caps,
    baselineGreen,
    batches: deployPhaseEntries,
    outcomes,
    unsupportedTests: [...unsupportedTests].sort(),
    notInstrumented: { totalFiles, files: notInstrumentedFiles },
    // R41: reunite the GIVEN patterns (statics) with the LEARNED exclusion count
    // (mutation-set-generated.excludedByOnly) — see `FoldStatics.only`'s doc comment. Same
    // condition orchestrator.ts used to gate this field: non-empty patterns, not just "defined".
    ...(statics.only !== undefined && statics.only.patterns.length > 0
      ? { only: { patterns: statics.only.patterns, excludedFileCount: excludedByOnly } }
      : {}),
    ...(statics.testsOnly !== undefined && statics.testsOnly.length > 0
      ? { testsOnly: statics.testsOnly }
      : {}),
    ...(staleTestApp.size > 0 ? { staleTestApp: { missingTests: [...staleTestApp].sort() } } : {}),
    ...(permissionsRefusedTests.size > 0
      ? { permissionsRefusedTests: [...permissionsRefusedTests].sort() }
      : {}),
    ...(testPageUnsupportedTests.size > 0
      ? { testPageUnsupportedTests: [...testPageUnsupportedTests].sort() }
      : {}),
    ...(runnerDisagreementTests.size > 0
      ? { runnerDisagreementTests: [...runnerDisagreementTests].sort() }
      : {}),
    ...(statics.stopHungSessions === true ? { stopHungSessions: true } : {}),
    // R47: `carriedMutants`/`skippedStranded` are counted 1:1 from `mutant-carried`/
    // `mutant-skipped-stranded` events, NOT threaded through `resume-resolved` — see that event's
    // doc comment (events.ts) for why: it is emitted before any mutant event runs, so it can only
    // ever carry what --resume found CARRYABLE, never what this run actually carried.
    ...(resumeFromRunId !== undefined
      ? {
          resumedFrom: {
            runId: resumeFromRunId,
            carriedMutants: carriedCount,
            skippedStranded: strandedSkipCount,
          },
        }
      : {}),
    timings: { totalMs, generateMutationSetMs, deployMs, baselineMs },
    baselineTests,
    untargetedTriggerCount,
    ...(quarantinedReason !== undefined ? { quarantined: { reason: quarantinedReason } } : {}),
    ...(permissionCanary !== undefined ? { permissionCanary } : {}),
  };
}
