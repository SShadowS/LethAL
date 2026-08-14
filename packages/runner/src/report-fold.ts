import type { BackendCapabilities } from "./backend";
import type { RunEvent } from "./events";
import type { PermissionCanaryResult } from "./permission-canary";
import type { DeclarativeSiteFile, NotInstrumentedFile, SessionOutcome } from "./report";

/**
 * Folds the run's events into the facts `buildReport` (report.ts) renders (spec 2026-08-05 §A,
 * "AMENDED AFTER TASK-2 REVIEW").
 *
 * THROWS on a missing mandatory event; it never silently defaults ONE OF THOSE THREE. The bag this
 * replaces (`BuildReportInput`, deleted) deliberately made fields required — `untargetedTriggerCount`
 * was a required `number` because "an absent tally and a measured zero must never look alike"
 * (report.ts). `finalize()` (the tail of `foldEvents`) throws unless the mandatory events arrived:
 * `mutation-set-generated`; `baseline-batch-finished` OR `quarantined`; `session-finished`.
 *
 * That guarantee is scoped to those three. Every OTHER accumulated field — `untargetedTriggerCount`
 * itself included — is summed from whatever matching events actually arrived (`coverage-split` for
 * this one), with no separate presence check of its own; see the accumulation site below for why
 * that is currently accepted rather than closed the same way. `untargetedTriggerCount` staying
 * "required, never `undefined`" on `SessionReport` is unaffected either way — that property comes
 * from initialising the accumulator to 0, which is honest for a session that legitimately never hit
 * the fallback, not from a presence assertion over `coverage-split`.
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
  /**
   * R127: the `--operator` narrowing this run was GIVEN, if any — names only. How many mutation
   * sites that excluded is LEARNED (see `mutation-set-generated.excludedByOperator`, events.ts);
   * the fold reunites the two into `FoldedReport.operators`.
   */
  readonly operators?: { readonly names: readonly string[] };
  /** R45: the `--tests-only` narrowing this run was GIVEN, if any. */
  readonly testsOnly?: readonly string[];
  /** R53: whether this run was allowed to end BC sessions to score a non-terminating mutant. */
  readonly stopHungSessions?: boolean;
  /**
   * R101(c): the AL preprocessor symbols this run compiled the target WITH. Always present, even as
   * an empty array, because `[]` is a real configuration (it selects every `#else` branch) and not
   * an unset one. See `SessionReport.preprocessorSymbols`.
   */
  readonly preprocessorSymbols?: readonly string[];
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
  /** R144: per-file declarative drops, off `mutation-set-generated`. Required and possibly empty —
   *  see `SessionReport.declarativeSites`. */
  readonly declarativeSites: readonly DeclarativeSiteFile[];
  readonly only?: {
    readonly patterns: readonly string[];
    readonly excludedFileCount: number;
  };
  /** R127: the operator narrowing, with the LEARNED site count reunited onto it. */
  readonly operators?: {
    readonly names: readonly string[];
    readonly excludedSiteCount: number;
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
  /** R129 — the BC artifact build al-runner announced it executed against, when it announced one.
   *  Absent on every other backend, and absent on an al-runner session whose runs said nothing. */
  readonly alRunnerBcBuild?: { readonly build: string; readonly announcement: string };
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
  let declarativeSiteFiles: readonly DeclarativeSiteFile[] = [];
  let excludedByOnly = 0;
  let excludedByOperator = 0;

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
  // 0, baseline never got a chance: either there was nothing to publish at all (zero mutable sites —
  // `planArtifacts` returns `[]`, so a `batch-published` event is structurally impossible, not just
  // absent) or every planned batch's deploy failed (environmental, or every bisection subset still
  // failing). Both are real, existing, successfully-COMPLETED session shapes
  // (`orchestrator.test.ts`'s "no mutable sites" test and its bisection/deploy-failure suite) — this
  // one signal covers both, so no separate "were there any instrumentable files" check is needed.
  let batchPublishedCount = 0;

  let generateMutationSetMs = 0;
  let deployMs = 0;
  let baselineMs = 0;
  let totalMs = 0;

  // Summed from `coverage-split` events with no presence check of its own — see this file's own
  // doc comment for why that is scoped out of the three-event mandatory guarantee. `orchestrator.ts`
  // emits one `coverage-split` per batch whenever `caps.coverage !== "none"`; if that assumption
  // were ever violated (a batch running coverage-mode filtering but never emitting the event), this
  // accumulator would silently under-report rather than throw — the same trust model
  // `deployMs`/`baselineMs`/`generateMutationSetMs` above also rely on for their own `phase-left`
  // sums. Flagged (Fix round 1, Important, minors) rather than closed: doing so needs a THIRD
  // signal (was `caps.coverage` ever non-"none" for a published batch) with the same shape as the
  // `instrumentableFiles`/`batchPublishedCount` reasoning above, and is deferred rather than adding
  // scope to this task without a concrete failure it is known to prevent.
  let untargetedTriggerCount = 0;
  /** R106: whether any `coverage-split` arrived, and whether one was ever OWED — see the check at
   *  the end of the fold for why the second half cannot simply be "a batch published". */
  let sawCoverageSplit = false;
  let sawGreenBaselineBatch = false;

  let quarantinedReason: string | undefined;
  let permissionCanary: PermissionCanaryResult | undefined;
  let alRunnerBcBuild: { build: string; announcement: string } | undefined;
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
        declarativeSiteFiles = e.declarativeSiteFiles;
        excludedByOnly = e.excludedByOnly;
        excludedByOperator = e.excludedByOperator;
        break;
      case "baseline-batch-finished":
        sawBaselineBatchFinished = true;
        // R106: a batch with at least one GREEN test is a batch that reaches the coverage filter.
        // A batch whose baseline is entirely red does not — `runSession` records every mutant
        // "no green baseline tests" and `continue`s BEFORE step 5 — so it owes no `coverage-split`
        // and must not be counted as evidence that one is missing.
        if (e.verdicts.some((v) => v.outcome === "pass")) sawGreenBaselineBatch = true;
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
        sawCoverageSplit = true;
        untargetedTriggerCount += e.untargetedTriggerCount;
        break;
      case "permission-canary":
        permissionCanary = e.result;
        break;
      case "al-runner-bc-build":
        alRunnerBcBuild = { build: e.build, announcement: e.announcement };
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
          ...(e.killingTestFailure !== undefined
            ? { killingTestFailure: e.killingTestFailure }
            : {}),
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
          ...(e.killingTestFailure !== undefined
            ? { killingTestFailure: e.killingTestFailure }
            : {}),
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
  // One escape besides `baseline-batch-finished`/`quarantined`: `batchPublishedCount === 0`.
  // Baseline runs immediately after a successful publish, unconditionally, so if no batch ever
  // published, baseline never got a chance to run and nothing ever latched unsafe either — a real,
  // successfully-COMPLETED session (`session-finished` still fires below), not a truncated stream.
  // Two real shapes collapse into this one check: a project with no mutable sites at all (
  // `planArtifacts` returns `[]`, so `batch-published` is structurally impossible to emit, not just
  // absent — `orchestrator.test.ts`'s "no mutable sites" test), and a project where every planned
  // batch's deploy failed (environmental, or a bisection that keeps reproducing regardless of
  // subset — the bisection/deploy-failure suite). An earlier version of this check ALSO required
  // `instrumentableFiles > 0` before treating a zero `batchPublishedCount` as suspicious; that
  // conjunct was redundant (zero instrumentable files already forces zero publishes, by
  // construction) and, worse, gave a hand-built event stream a way to claim `instrumentableFiles: 0`
  // while still emitting mutant events no real project with zero mutable sites could ever produce —
  // exactly the class of bug this task exists to close. Confirmed: dropping it changes nothing about
  // which real orchestrator scenarios pass (still 0 failures across the full suite).
  //
  // What must still throw: `batchPublishedCount > 0` (a batch WAS published) with neither
  // `baseline-batch-finished` nor `quarantined` — a published artifact's baseline outcome missing
  // from the stream is exactly the truncation this check exists to catch.
  if (!sawBaselineBatchFinished && !sawQuarantined && batchPublishedCount > 0) {
    throw new Error(
      "foldEvents: neither baseline-batch-finished nor quarantined arrived, and at least one batch " +
        "was published — the fold cannot tell whether that batch's baseline ran, or the session " +
        "quarantined before it could. One of the two is mandatory once a batch has published.",
    );
  }
  // R106. `untargetedTriggerCount` is summed from `coverage-split` events and used to be trusted
  // unconditionally — so a stream where those events were absent produced a plausible ZERO rather
  // than an error. That is the "absent tally read as a measured zero" shape the two checks above
  // exist to close, left open for this one field.
  //
  // The condition is NOT "a batch published", which is what the row proposing this assumed, and
  // getting that wrong would throw on real sessions. `runSession` emits `coverage-split` at step 5,
  // AFTER the step-4 early `continue` that fires when a batch has no green baseline test at all —
  // an all-red baseline is a legitimate, completed run (it records every mutant "no green baseline
  // tests") and it owes no split. So the debt is only incurred by a batch that actually had a green
  // test to filter on.
  //
  // `caps.coverage === "none"` owes nothing either: that branch gives every mutant every green test
  // by construction and never calls `coverageFilter`.
  if (statics.caps.coverage !== "none" && sawGreenBaselineBatch && !sawCoverageSplit) {
    throw new Error(
      `foldEvents: a batch finished baseline with at least one green test under coverage mode "${statics.caps.coverage}", but no coverage-split event arrived — untargetedTriggerCount would be reported as a measured 0 when nothing measured it. One coverage-split per such batch is mandatory.`,
    );
  }
  if (!sawSessionFinished) {
    throw new Error(
      "foldEvents: no session-finished event in this stream — a truncated stream is not a report.",
    );
  }

  // `batch-invalidated` rewrites history: applied in a SECOND pass, over every outcome folded so
  // far. This is the ONLY implementation of the rule now — `orchestrator.ts`'s own in-memory
  // correction (formerly `invalidateBatchVerdicts`) was deleted (Fix round 1, Important 5; see
  // that function's commit for the reasoning) once confirmed dead for the report, so there is
  // nothing left here to mirror. The two deliberately-untouched cases (an already-specifically-
  // classified error, and a known-survivor, which was never re-tested against this batch's binary
  // at all) are this function's own rule, pinned by `report-fold.test.ts`. Applying invalidations
  // in emission order after full accumulation (rather than inline, mid-loop) is what makes this
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
    declarativeSites: declarativeSiteFiles,
    // R41: reunite the GIVEN patterns (statics) with the LEARNED exclusion count
    // (mutation-set-generated.excludedByOnly) — see `FoldStatics.only`'s doc comment. Same
    // condition orchestrator.ts used to gate this field: non-empty patterns, not just "defined".
    ...(statics.only !== undefined && statics.only.patterns.length > 0
      ? { only: { patterns: statics.only.patterns, excludedFileCount: excludedByOnly } }
      : {}),
    // R127: same reunion for the operator narrowing — GIVEN names, LEARNED site count.
    ...(statics.operators !== undefined && statics.operators.names.length > 0
      ? { operators: { names: statics.operators.names, excludedSiteCount: excludedByOperator } }
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
    ...(alRunnerBcBuild !== undefined ? { alRunnerBcBuild } : {}),
  };
}
