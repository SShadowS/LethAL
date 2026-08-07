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
 *
 * AMENDED AFTER TASK-2 REVIEW (docs/superpowers/plans/2026-08-05-event-stream.md, "AMENDED AFTER
 * TASK-2 REVIEW"): a field-by-field comparison against `BuildReportInput` found 12 of its 19
 * top-level fields were not representable from the first-cut union below. The organising rule
 * from that pass, applied throughout: a fact the run was GIVEN is a static (declared once, in
 * `run-configured`); a fact the run LEARNS is an event, carried at the moment it is learned, not
 * before and not aggregated. `resume-resolved` is the case that makes "given" insufficient on its
 * own — `--resume` is resolved at session start yet half of what it produces (carryable/stranded
 * counts) is learned, not configured.
 */
import type { MutantManifestEntry } from "@lethal/schemata";
import type { BackendCapabilities, TestMethodRef, TestOutcome } from "./backend";
import type { PermissionCanaryResult } from "./permission-canary";
import type { MutantErrorCause, NotInstrumentedFile } from "./report";
import type { CoverageAttribution } from "./selection";
import type { MutantVerdict, RunnerKind } from "./store";

/** Bumped independently of `REPORT_SCHEMA_VERSION`. Consumers ignore unknown event types. */
export const STREAM_SCHEMA_VERSION = 1;

export type RunPhase = "generate" | "deploy" | "baseline" | "mutants" | "teardown";

/**
 * Why a baseline test did not pass — see `baseline-batch-finished`'s `verdicts[].classification`.
 * Not invented: these are the SAME identifiers `report.ts`'s own `caveats` array already pushes
 * (`report.ts:918,924,930`) for exactly the three conditions `orchestrator.ts:2438-2463` assigns.
 */
export type BaselineClassification =
  | "tests-permission-refused"
  | "tests-testpage-unsupported"
  | "stale-test-app";

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
  | {
      /**
       * The closed set of statics this run was GIVEN, echoed once from the same config object
       * `buildReport`'s fold receives directly — one source, two carriages, no computation on
       * either path. Hard rule: a static appears in exactly ONE declaration event (this one), and
       * no later event may repeat or update it.
       *
       * `only.excludedFileCount` (`BuildReportInput.only`, report.ts:626-629) is deliberately NOT
       * here: the glob patterns are given at configuration time, but how many files they excluded
       * is only known once `generateMutationSet` runs — that half is LEARNED, and rides
       * `mutation-set-generated.excludedByOnly` instead. The fold reunites the two.
       */
      readonly type: "run-configured";
      readonly caps: BackendCapabilities;
      readonly only?: { readonly patterns: readonly string[] };
      readonly testsOnly?: readonly string[];
      readonly stopHungSessions?: boolean;
    }
  | {
      /**
       * Emitted after `resolveResume` (orchestrator.ts) returns, before any mutant event. Final
       * `carriedMutants`/`skippedStranded` do NOT ride here — the fold counts them 1:1 from
       * `mutant-carried`/`mutant-skipped-stranded` events, which is what lets Task 3 delete the
       * orchestrator's own `resumedMutantCount`/`strandedSkippedCount` counters rather than
       * keeping two accountings of the same quantity.
       */
      readonly type: "resume-resolved";
      readonly fromRunId: number;
      readonly mode: "last" | number;
      readonly carryableCount: number;
      readonly strandedKeyCount: number;
      readonly retryStranded: boolean;
    }
  | {
      readonly type: "phase-entered";
      readonly phase: RunPhase;
      readonly detail?: string;
      /** Populated only when `phase === "baseline"`. */
      readonly testCount?: number;
      readonly batchIndex?: number;
    }
  | { readonly type: "phase-left"; readonly phase: RunPhase; readonly elapsedMs: number }
  | {
      readonly type: "mutation-set-generated";
      readonly siteCount: number;
      readonly deployedCount: number;
      readonly totalFiles: number;
      readonly instrumentableFiles: number;
      /** The full skip list — see `SessionReport.notInstrumented.files`. */
      readonly notInstrumentedFiles: readonly NotInstrumentedFile[];
      /** R41: `.al` files a `--only` glob excluded from spec generation. 0 when no `only` was
       *  given. The LEARNED half of `run-configured.only` — see that event's doc comment. */
      readonly excludedByOnly: number;
    }
  | {
      /** Discovery returns the whole list in one parse — 1,000+ per-item events at one instant
       *  would be false granularity, not liveness. */
      readonly type: "tests-discovered";
      readonly tests: readonly TestMethodRef[];
    }
  | {
      readonly type: "batch-published";
      readonly batchIndex: number;
      readonly guardCount: number;
      readonly elapsedMs: number;
    }
  | { readonly type: "batch-invalidated"; readonly batchIndex: number; readonly reason: string }
  | {
      /**
       * The moment of observation is the batch's baseline RETURNING, not each test inside it: the
       * silence is inside the backend call, so per-test events would buy no liveness. Carries
       * per-test rows, not aggregates — `baselineGreen` and the pass/fail counts are folded from
       * these, never passed in (events carry facts; consumers compute aggregates, which is the
       * rule `baseline-finished` violated and is deleted for).
       */
      readonly type: "baseline-batch-finished";
      readonly batchIndex: number;
      readonly verdicts: readonly {
        readonly name: string;
        readonly outcome: TestOutcome;
        /**
         * Fix round 2: narrowed from a bare `string` to `BaselineClassification` so an emit-side
         * or fold-side spelling drift is a compile error, not a silent mismatch — the same
         * safety `staleTestApp` already had by keying on an exact sentinel
         * (`failureMessage === NO_RESULT_FOR_METHOD`, `orchestrator.ts:2460`) rather than a
         * hand-typed string.
         *
         * Fix round 3: widened from an optional SINGLE tag to a LIST, zero or more.
         * `orchestrator.ts`'s `baseline-batch-finished` emit runs `describeTestPermissionsRefusal`
         * and `describeTestPageUnsupported` as two INDEPENDENT `if`s over the same
         * `b.verdict.failureMessage`, both now gated on `didNotPassAtBaseline(b.verdict.outcome)`
         * (coordinator review, final wave, Fix 1 — an earlier version ran them unconditionally,
         * widening `permissionsRefused`/`testPageUnsupported` beyond what a `pass`/`skip`/`timeout`
         * verdict could ever produce pre-refactor) — nothing stops a test matching both, and a
         * single optional field can only ever record one, silently dropping the other membership.
         * Measured to be low-probability (`describeTestPageUnsupported`'s pattern matches the
         * literal `CreateNavTestService()`; the permission regexes match "you do not have
         * permission"-shaped text — co-occurrence needs BC to concatenate two unrelated exceptions
         * into one `failureMessage`) but expressible, so the list loses nothing where the scalar
         * could. The third member, `"stale-test-app"`, is checked in the SAME `baseline.map(...)`
         * as the other two now (not a separate loop — all three classifications for one verdict are
         * computed together), UNCONDITIONALLY (no `didNotPassAtBaseline` gate: the pre-refactor
         * loop this mirrors, `missingFromServer`, also ran over every baseline verdict, not just the
         * non-passing ones). It uses EXACT equality against `NO_RESULT_FOR_METHOD`
         * (`orchestrator.ts`), not a substring pattern, so — unlike the other two — it structurally
         * CANNOT co-occur with them via concatenation: a `failureMessage` built by concatenating two
         * unrelated exceptions is, by construction, longer than and different from the bare sentinel
         * string, so it can never be `=== NO_RESULT_FOR_METHOD`. The list still covers all three
         * uniformly rather than special-casing the one member that cannot realistically co-occur.
         */
        readonly classification: readonly BaselineClassification[];
        readonly failureMessage?: string;
      }[];
    }
  | {
      /**
       * Accumulated per batch at split time — see `CoverageSplit` (selection.ts). This is the
       * strongest single argument for events over the old bag: a rung with 66% no-coverage would
       * have been visible at batch 1, minutes before the report said so.
       */
      readonly type: "coverage-split";
      readonly batchIndex: number;
      readonly untargetedTriggerCount: number;
      readonly coveredCount: number;
      readonly noCoverageCount: number;
    }
  | {
      /** The once-per-session permission canary's measured verdict — one observation. */
      readonly type: "permission-canary";
      readonly result: PermissionCanaryResult;
    }
  | {
      readonly type: "mutant-scored";
      /**
       * The full manifest entry, not `mutantCode` plus a join. In-process it travels by
       * reference so this costs nothing; on NDJSON a line carrying file/operator/startIndex is
       * exactly what a consumer would otherwise have to `jq`-excavate from a separate manifest;
       * and `orchestrator.ts`'s final sort needs `mutant.file`/`mutant.startIndex` anyway.
       */
      readonly mutant: MutantManifestEntry;
      readonly verdict: MutantVerdict;
      readonly batchIndex: number;
      readonly durationMs: number;
      readonly killingTest?: string;
      readonly failureNote?: string;
      /**
       * NOT in the brief's amendment list — added because `record()`'s kill-confirmation call
       * site (orchestrator.ts:3404-3437) sets this on the SAME `error` verdicts `failureNote`
       * describes, and `SessionOutcome.cause` (report.ts) has no other source. Omitting it would
       * leave `outcomes` — one of `BuildReportInput`'s 19 audited fields — not fully
       * reconstructable from events, reproducing the exact gap this review pass exists to close.
       * Flagged in the task report for confirmation.
       */
      // R114: the NAMED type, not a re-spelled inline union. `MutantErrorCause`'s registry is a
      // `Record<>`, so a new member is a compile error until an interpretation exists — a copy of
      // the union here would quietly go stale instead, which is how `stranded` would have been
      // added to the report and dropped from the event stream `buildReport` actually folds.
      readonly cause?: MutantErrorCause;
      /**
       * R86 — see `MutantRow.killingTestFailure` (store.ts). The failure text of the run that
       * KILLED this mutant, verbatim from the backend. Rides here as well as on the store row
       * because `buildReport` folds events, not `outcomes[]`: without it the report could not
       * reconstruct a `SessionOutcome` in full, which is the gap this union's audit exists to
       * close. Set on `killed` and `timeout-killed` only, and never together with `cause`.
       */
      readonly killingTestFailure?: string;
      readonly coveringTests: readonly string[];
      readonly coverageAttribution?: CoverageAttribution;
      readonly guardObserved?: boolean;
      readonly runner?: RunnerKind;
      /**
       * The constant diagnosis note — `describeRunnerDisagreement(coverageMode)` (
       * `runner-disagreement.ts:72-74`) is keyed ONLY on coverage mode, so this alone cannot
       * identify WHICH test disagreed. Kept because it is still useful prose for a reader.
       */
      readonly runnerDisagreement?: string;
      /**
       * Fix round 2, residual 1: added because `runnerDisagreement` above cannot supply test
       * identity, and `BuildReportInput.runnerDisagreementTests` (report.ts) is a set of
       * qualified TEST NAMES, not coverage-mode notes. `coveringTests` above is the mutant's
       * FULL covering list, not the one test whose kill-confirmation actually disagreed — for a
       * mutant with 2+ covering tests, `coveringTests` alone cannot say which one. The real
       * value: `qualifiedTestName(ref)`, where `ref` is the exact loop variable
       * `orchestrator.ts:3433`'s `args.runnerDisagreementTests.add(qualifiedTestName(ref))` adds
       * (the `for (const ref of covering)` loop, `orchestrator.ts:3193`), captured at the same
       * call site, same instant, as `runnerDisagreement` and `cause: "unstable"` above.
       */
      readonly runnerDisagreementTest?: string;
      /**
       * Task 4 (event-stream refactor, spec 2026-08-05 §A) — the R35 counterpart to
       * `runnerDisagreementTest` above, and NOT in Task 2/3's amended union either. Set at the
       * SAME kill-confirmation call site (`orchestrator.ts`'s `runMutantsOnBackend`), the same
       * instant it decides `cause: "unstable"` for a permissions-refused test — the qualified name
       * `describeTestPermissionsRefusal` matched. Without this field there was no way to fold
       * `SessionReport.permissionsRefused` for a refusal found HERE (kill-confirmation time) rather
       * than at baseline (`baseline-batch-finished`'s `classification` covers only the latter) —
       * the orchestrator's own `args.permissionRefusedTests` Set became a dead sink the moment
       * `buildReport` stopped reading a hand-assembled bag, and nothing replaced it until this.
       */
      readonly permissionRefusedTest?: string;
    }
  | {
      /**
       * A verdict `--resume` carried from a prior run.
       *
       * DELIBERATELY has no `durationMs` field. The prior cost lives only in `priorDurationMs`, so
       * the fold cannot sum it into `mutantsMs` even by accident — R54 becomes unrepresentable
       * rather than guarded by a filter someone forgets (`report.ts:865`).
       *
       * `batchIndex`/`killingTest`/`failureNote`/`runner` are NOT in the brief's amendment list
       * ("full entry, +coverageAttribution") — added because `record()`'s carried-verdict call
       * site (orchestrator.ts:2589-2605) passes all four onto the resulting `SessionOutcome`
       * (batchIndex from the loop; the other three from `CarriedVerdict`, resume.ts:70-85).
       * Without them the fold cannot reconstruct a carried `SessionOutcome` in full. Flagged in
       * the task report for confirmation.
       */
      readonly type: "mutant-carried";
      readonly mutant: MutantManifestEntry;
      readonly verdict: MutantVerdict;
      readonly fromRunId: number;
      readonly batchIndex: number;
      readonly priorDurationMs: number;
      readonly killingTest?: string;
      readonly failureNote?: string;
      /** R86 — see `MutantRow.killingTestFailure`. Carried for the same reason `killingTest` is:
       *  a resumed kill keeps its own account of why it died rather than losing it on the
       *  second run. `CarriedVerdict` (resume.ts) is its source. */
      readonly killingTestFailure?: string;
      readonly coveringTests: readonly string[];
      readonly coverageAttribution?: CoverageAttribution;
      readonly runner?: RunnerKind;
    }
  | {
      /**
       * `batchIndex` is NOT in the brief's amendment list ("full entry") — added because
       * `record()`'s stranded-skip call site (orchestrator.ts:2571-2580) passes it onto the
       * resulting `SessionOutcome`, same as every other recorded verdict. Flagged in the task
       * report for confirmation. `verdict` is not carried: this event's own type already implies
       * `"error"` — record() always passes that literal here (orchestrator.ts:2575).
       */
      readonly type: "mutant-skipped-stranded";
      readonly mutant: MutantManifestEntry;
      readonly batchIndex: number;
      readonly note: string;
    }
  | { readonly type: "warning"; readonly code: string; readonly message: string }
  | { readonly type: "quarantined"; readonly reason: string }
  | { readonly type: "session-finished"; readonly elapsedMs: number };

export type RunEvent = RunEventInput & Base;

export type EventSubscriber = (event: RunEvent) => void;

export type RunEmitter = (event: RunEventInput) => void;

/**
 * A subscriber that throws must not abort the run or cost the other subscribers their event: a
 * broken renderer is a cosmetic failure, and losing a `mutant-scored` event would corrupt the
 * report. The throw is swallowed deliberately and reported once on stderr — once PER SUBSCRIBER,
 * not once per throw: a chronically-throwing subscriber (e.g. a renderer that dies on the first
 * event and would die identically on every one after) must not spam stderr once per mutant while
 * every other subscriber keeps receiving every event without interruption.
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
