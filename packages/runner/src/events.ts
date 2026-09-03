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
import type { Caveat, DeclarativeSiteFile, MutantErrorCause, NotInstrumentedFile } from "./report";
import type { CoverageAttribution } from "./selection";
import type { MutantVerdict, RunnerKind } from "./store";

/** Bumped independently of `REPORT_SCHEMA_VERSION`. Consumers ignore unknown event types. */
export const STREAM_SCHEMA_VERSION = 1;

export type RunPhase = "generate" | "deploy" | "baseline" | "mutants" | "teardown";

/**
 * Why a baseline test did not pass — see `baseline-batch-finished`'s `verdicts[].classification`.
 * Not invented: these are the SAME identifiers `report.ts`'s own `caveats` array already pushes
 * (its `caveats.push("stale-test-app")`, `caveats.push("tests-permission-refused")` and
 * `caveats.push("tests-testpage-unsupported")` calls) for exactly the three conditions
 * `orchestrator.ts`'s `const classification: BaselineClassification[] = []` block assigns.
 *
 * R113: that sentence used to be a claim nothing enforced — an INDEPENDENT copy of three names
 * under a comment asserting they were the same ones. `satisfies readonly Caveat[]` makes the
 * coupling structural: a member `Caveat` does not contain is a compile error naming it.
 *
 * Deliberately NOT the `Extract<Caveat, "a" | "b" | "c">` the roadmap row proposed. `Extract`
 * SILENTLY DROPS a member the union does not contain — `Extract<Caveat, "typo">` is `never`, so a
 * misspelling narrows this type instead of erroring, which is the same class of quiet loss the row
 * exists to close. It also yields no runtime value, and `bun test` is a separate step from
 * `bun run typecheck` here, so a purely type-level coupling is invisible to the test runner
 * (R115). The array below is the runtime half: `events.test.ts` walks it against
 * `CAVEAT_INTERPRETATIONS`'s own keys, so a drift reddens `bun test` too, not only `tsc`.
 */
export const BASELINE_CLASSIFICATIONS = [
  "tests-permission-refused",
  "tests-testpage-unsupported",
  "stale-test-app",
] as const satisfies readonly Caveat[];

export type BaselineClassification = (typeof BASELINE_CLASSIFICATIONS)[number];

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
       * `only.excludedFileCount` (`BuildReportInput.only`'s `readonly excludedFileCount` field in
       * report.ts) is deliberately NOT here: the glob patterns are given at configuration time, but
       * how many files they excluded is only known once `generateMutationSet` runs — that half is
       * LEARNED, and rides `mutation-set-generated.excludedByOnly` instead. The fold reunites the
       * two.
       */
      readonly type: "run-configured";
      readonly caps: BackendCapabilities;
      readonly only?: { readonly patterns: readonly string[] };
      /**
       * R127: the `--operator` narrowing this run was GIVEN. Split the same way `only` is — the
       * NAMES are configured, the count of sites they excluded is LEARNED and rides
       * `mutation-set-generated.excludedByOperator`.
       */
      readonly operators?: { readonly names: readonly string[] };
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
      /** R144: the full per-file declarative-drop list — see `SessionReport.declarativeSites`.
       *  Required, and empty on a project with no declarative surface: an absent list and a
       *  measured zero must not look alike, the same rule `untargetedTriggerCount` follows. */
      readonly declarativeSiteFiles: readonly DeclarativeSiteFile[];
      /** R41: `.al` files a `--only` glob excluded from spec generation. 0 when no `only` was
       *  given. The LEARNED half of `run-configured.only` — see that event's doc comment. */
      readonly excludedByOnly: number;
      /** R127: mutation SITES an `--operator` filter excluded (a site count, not a file count —
       *  see `MutationSetResult.excludedByOperator` for why the two differ). 0 when no operator
       *  filter was given. The LEARNED half of `run-configured.operators`. */
      readonly excludedByOperator: number;
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
         * (`b.verdict.failureMessage === NO_RESULT_FOR_METHOD`, orchestrator.ts) rather than a
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
         * non-passing ones).
         *
         * R139 CORRECTS what this comment used to claim about that third member. It said the
         * stale-test-app check "structurally CANNOT co-occur" with the other two, because exact
         * equality against `NO_RESULT_FOR_METHOD` cannot match a concatenation. That reasoning was
         * sound for the `bcdev_test_run` producer and useless for the one that actually mattered:
         * the fenced RunMutant transport words the same condition differently, so the check never
         * fired on the path where a stale test app twice cost a live gate run. `describeStaleTestApp`
         * (`stale-test-app.ts`) now matches BOTH producers, and the second arm is an anchored
         * prefix/suffix match rather than whole-string equality, so the cannot-co-occur property no
         * longer holds by construction. Nothing depends on it: `classification` is a list precisely
         * so more than one membership is expressible. In practice the other two are now SUPPRESSED
         * for such a message rather than merely unlikely — see the `isRunMutantLineCountMessage`
         * guard in `orchestrator.ts`, which exists because a message proving the test body never ran
         * must not be read as a statement about the test.
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
      /**
       * R175. How many of `noCoverageCount` are `no-coverage` because attribution could not NAME
       * the member that ran, rather than because nothing ran. A subset, never a separate bucket.
       */
      readonly unplaceableCount: number;
      /**
       * R175. WHICH ones, as `mutantId`s. A count tells a reader there is a problem; only the
       * identities tell them which mutants to re-run under coverageMode "none", which is the whole
       * remedy. Sorted, so a gate can assert on it.
       */
      readonly unplaceableMutants: readonly string[];
    }
  | {
      /** The once-per-session permission canary's measured verdict — one observation. */
      readonly type: "permission-canary";
      readonly result: PermissionCanaryResult;
    }
  | {
      /**
       * R129 — which BC artifact build al-runner announced it executed this session's tests
       * against, read off the runner's own `[bc]` line. Emitted once, after the mutant phase, and
       * ONLY when a run actually announced one: a session that never reached the runner, or a
       * runner build that stopped printing the line, emits nothing rather than a defaulted version.
       *
       * al-runner-specific by design. The bcdev path's runtime is the container the config names,
       * which the report already identifies; this exists because the al-runner path chooses a BC
       * build on its own and nothing recorded the choice.
       */
      readonly type: "al-runner-bc-build";
      readonly build: string;
      /** The runner's own line, verbatim — see `AlRunnerBcBuild.announcement`. */
      readonly announcement: string;
    }
  | {
      /**
       * R147 — the Microsoft platform-app directory this session PINNED, so that no invocation after
       * the one-time provisioning run pays for provisioning again.
       *
       * Emitted once, right after the provisioning step, and ONLY when a pin was actually
       * established: a session that declined to pin emits an `al-runner-platform-apps-unpinned`
       * warning carrying the reason instead. Both directions are reported, because a build whose
       * parse had gone stale would otherwise produce exactly the same verdicts, the same counts and
       * no line anywhere.
       *
       * al-runner-specific by design, the same as `al-runner-bc-build`: no other backend provisions
       * anything.
       */
      readonly type: "al-runner-platform-apps";
      readonly dir: string;
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
       * site (orchestrator.ts's `const mutantRowId = record(` call) sets this on the SAME `error`
       * verdicts `failureNote` describes, and `SessionOutcome.cause` (report.ts) has no other
       * source. Omitting it would leave `outcomes` — one of `BuildReportInput`'s 19 audited
       * fields — not fully reconstructable from events, reproducing the exact gap this review pass
       * exists to close. Flagged in the task report for confirmation.
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
      /** R206 — see `MutantRow.killPosition` (store.ts). Set on `killed`/`timeout-killed` only. */
      readonly killPosition?: number;
      readonly coveringTests: readonly string[];
      readonly coverageAttribution?: CoverageAttribution;
      readonly guardObserved?: boolean;
      readonly runner?: RunnerKind;
      /**
       * The constant diagnosis note — `describeRunnerDisagreement(coverageMode)`
       * (runner-disagreement.ts) is keyed ONLY on coverage mode, so this alone cannot identify
       * WHICH test disagreed. Kept because it is still useful prose for a reader.
       */
      readonly runnerDisagreement?: string;
      /**
       * Fix round 2, residual 1: added because `runnerDisagreement` above cannot supply test
       * identity, and `BuildReportInput.runnerDisagreementTests` (report.ts) is a set of
       * qualified TEST NAMES, not coverage-mode notes. `coveringTests` above is the mutant's
       * FULL covering list, not the one test whose kill-confirmation actually disagreed — for a
       * mutant with 2+ covering tests, `coveringTests` alone cannot say which one. The real
       * value: `qualifiedTestName(ref)`, where `ref` is the exact loop variable
       * `orchestrator.ts`'s `runnerDisagreementTest = qualifiedTestName(ref)` assignment reads
       * (the `for (const ref of covering)` loop, orchestrator.ts), captured at the same
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
       * rather than guarded by a filter someone forgets (`report.ts`'s `const mutantsMs` sum).
       *
       * `batchIndex`/`killingTest`/`failureNote`/`runner` are NOT in the brief's amendment list
       * ("full entry, +coverageAttribution") — added because `record()`'s carried-verdict call
       * site (the `carriedVerdictFor(resumeState.index, m)` branch in orchestrator.ts) passes all
       * four onto the resulting `SessionOutcome` (batchIndex from the loop; the other three from
       * `CarriedVerdict`, resume.ts).
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
      /** R206 — see `MutantRow.killPosition`. Carried for the same reason. */
      readonly killPosition?: number;
      readonly coveringTests: readonly string[];
      readonly coverageAttribution?: CoverageAttribution;
      readonly runner?: RunnerKind;
    }
  | {
      /**
       * `batchIndex` is NOT in the brief's amendment list ("full entry") — added because
       * `record()`'s stranded-skip call site (its `true, // strandedSkip` call in orchestrator.ts)
       * passes it onto the resulting `SessionOutcome`, same as every other recorded verdict.
       * Flagged in the task report for confirmation. `verdict` is not carried: this event's own
       * type already implies `"error"` — record() always passes that literal at that same
       * `wasStranded(resumeState.index, m)` branch (orchestrator.ts).
       */
      readonly type: "mutant-skipped-stranded";
      readonly mutant: MutantManifestEntry;
      readonly batchIndex: number;
      readonly note: string;
    }
  | {
      /**
       * R198: one `RunMutantMany` call was made (whatever it answered). Folded into
       * `SessionReport.groupedCalls`, which the gates pin to a NUMBER derived from their frozen
       * baselines, so a feature that silently stopped grouping fails a gate instead of reading
       * as a slow day. `ranCount`/`endedBy` are present when the server answered with verdicts.
       */
      readonly type: "group-call";
      readonly mutantId: string;
      readonly attemptId: string;
      readonly opSeq: number;
      readonly methods: number;
      readonly ranCount?: number;
      readonly endedBy?: "complete" | "failure" | "cap";
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
