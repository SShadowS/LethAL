import type { MutantManifestEntry } from "@lethal/schemata";
import { type AlRunnerCanaryResult, alRunnerCanaryWarnings } from "./al-runner-canary";
import type { BackendCapabilities } from "./backend";
import { type PermissionCanaryResult, permissionCanaryWarnings } from "./permission-canary";
import type { CoverageAttribution } from "./selection";
import { identityKeyOf } from "./selection";
import type { MutantVerdict } from "./store";

/**
 * Internal accumulation record produced while `runSession` walks batches and
 * mutants. `buildReport` folds a list of these into the public `SessionReport`.
 */
export interface SessionOutcome {
  readonly mutant: MutantManifestEntry;
  readonly verdict: MutantVerdict;
  readonly batchIndex: number;
  readonly killingTest?: string;
  readonly failureNote?: string;
  /**
   * Structural reason for an "error" verdict, set only at the two call
   * sites in orchestrator.ts that actually know it. Deliberately NOT
   * derived from `failureNote` text: `failureNote` also carries arbitrary
   * backend-thrown text (e.g. the batch-deploy-failure handler's
   * `String(err)`), which could otherwise collide with a prefix match.
   */
  readonly cause?: "deadline-exceeded" | "unstable";
  /**
   * Summed duration of the test runs this mutant was scored by, in ms — the same value
   * `record()` already persists to `mutants.duration_ms`. 0 for a mutant nothing ran against
   * (`no-coverage`, known-survivor skip) and for a batch-wide failure that recorded outcomes
   * without executing them.
   *
   * Surfaced so the report can state what a run COST, not only what it found: extrapolating a
   * narrowed run (`--only`) to a whole project needs per-mutant cost separated from the fixed
   * deploy and baseline overhead, and that separation cannot be recovered from a wall-clock total.
   */
  readonly durationMs?: number;
  /**
   * Qualified names of the tests this mutant was actually RUN against. Absent when nothing ran it
   * (`no-coverage`, known-survivor skip, a batch-wide failure).
   *
   * The other half of an actionable survivor: knowing a mutant survived is only half a finding —
   * acting on it means knowing which tests already exercise that code and failed to notice, which
   * is where a new assertion belongs. Without it a consumer has to re-derive coverage selection
   * from outside, which no report reader can do.
   */
  readonly coveringTests?: readonly string[];
  /** Which attribution path placed `coveringTests` — see `MutantOutcome.coverageAttribution`. */
  readonly coverageAttribution?: CoverageAttribution;
  /** Whether any instrumented guard fired while this mutant ran — see
   *  `MutantOutcome.guardObserved`. Absent when nothing ran it, or on a backend that cannot
   *  attest (al-runner). */
  readonly guardObserved?: boolean;
  /** R54: this verdict was CARRIED from a prior run by `--resume`, not measured here — see
   *  `MutantOutcome.carried`. */
  readonly carried?: boolean;
}

/**
 * A file `generateMutationSet` (orchestrator.ts) dropped because no object it declares can carry
 * the injected `var MutationSelector: Codeunit "Mutation Selector";` guard — only a codeunit or
 * a table can (page/report/query/xmlport cannot). See `SessionReport.notInstrumented`.
 */
export interface NotInstrumentedFile {
  readonly file: string;
  /** Object kind(s) this file declares, e.g. `"page_declaration"` — from `describeObjectKinds`. */
  readonly kinds: string;
  /** Mutation sites the tier-1 operators found here, none of which could ever run. */
  readonly sites: number;
}

/**
 * Bumped whenever a field is renamed, removed, or changes meaning. Additive fields do not require
 * a bump. A machine-consumed contract with no version breaks silently the first time it changes,
 * and the consumer has no way to notice.
 */
export const REPORT_SCHEMA_VERSION = 1;

/**
 * What the score is a score OF — the report's own limits, synthesized in one place.
 *
 * The individual caveats already exist (`only`, `notInstrumented`, `baselineGreen`,
 * `unsupportedTests`), but scattered across four fields a consumer has to correlate. A reader —
 * human or agent — quotes `mutationScore` long before it joins four other fields, so the number
 * has to arrive with its own qualifications attached.
 */
export interface ReportValidity {
  /**
   * `full` — whole project, green baseline. `narrowed` — `--only` scoped the run. `degraded` —
   * the baseline was not green, so some mutants could not be scored at all. `narrowed-degraded`
   * — both. Anything other than `full` means the score does NOT describe the project.
   */
  readonly reliability: "full" | "narrowed" | "degraded" | "narrowed-degraded";
  /** Human- and machine-readable reasons, e.g. `baseline-red`, `narrowed`, `uninstrumentable-files`. */
  readonly caveats: readonly string[];
  /** One sentence naming what the score covers. Written for a consumer that will quote it. */
  readonly scoreDescribes: string;
  /** Tests that ran at baseline, and how many of them failed. `failing > 0` bounds how much this
   *  run could measure at all: a mutant covered only by failing tests cannot be scored. */
  readonly baselineTests: { readonly total: number; readonly failing: number };
  /** Mutants that produced a scoreable verdict (killed/survived/timeout-killed), out of all
   *  recorded. The denominator `mutationScore` is actually computed over. */
  readonly scoredMutants: { readonly scored: number; readonly recorded: number };
  /**
   * R60: the execution mode EVERY verdict in this report describes. Always present, on every
   * backend and in both coverage modes — this is a property of how LethAL runs, not a per-run
   * measurement, and it does not vary with the project.
   *
   * LethAL executes every mutant headlessly. A developer running the same suite from VS Code runs
   * GUI-allowed, so the two are not measuring the same branches, and nothing in the report said
   * so. Consequences, in the order they mislead:
   *
   *   (a) A mutant inside a branch reachable only when a user can be prompted never executes, so
   *       it cannot be killed. It is reported `survived` or `no-coverage` — and BOTH read as
   *       statements about the test suite ("your tests are weak here") when the truth is that
   *       LethAL never ran the code.
   *   (b) `Confirm` does not skip its branch, it FORCES the default answer, so the non-default arm
   *       is the unreachable one. `Message` is a no-op and changes nothing. `Page.RunModal` is
   *       different again: it ERRORS, which can fail a test for a reason unrelated to the mutant.
   *   (c) `mutationScore`'s denominator therefore includes sites that were unreachable by
   *       construction.
   *
   * MEASURED, so the caveat is neither alarmism nor complacency (`scripts/measure-gui-guarded.ts`,
   * run 2026-07-31 against Continia Document Output `DocumentOutput/Cloud`, 551 `.al` files):
   * **62 of 19,850 mutation sites — 0.3% — sit lexically inside a `GuiAllowed`- or
   * `Confirm`-guarded branch.** A lower bound (it does not follow calls), but not one hiding a
   * large category: the `if not GuiAllowed then exit;` shape that would guard a whole procedure
   * without any site being lexically inside occurs 3 times in those 551 files. The 5.7% figure the
   * same script reports as an upper bound is dominated by `Message`, which causes no
   * unreachability at all.
   *
   * That measurement is why this is a STATED LIMIT rather than a per-site `guardObserved` signal:
   * 0.3% does not justify machinery, and the fact is structural anyway — no backend LethAL has
   * runs GUI-allowed, so there is nothing to detect per run.
   */
  readonly executionContext: {
    /** Literal `false`: no LethAL execution path is GUI-allowed. A future path that is would have
     *  to change this type, which is the point — it cannot drift silently. */
    readonly guiAllowed: false;
    /** The session kind mutants execute under. */
    readonly clientType: string;
    /** How that is known — measured, or inferred from the runner's shape. Never a bare claim. */
    readonly basis: string;
  };
}

/** Per-procedure survivor rollup — see `SessionReport.survivorsByProcedure`. */
export interface SurvivorGroup {
  readonly file: string;
  readonly codeunitName: string;
  readonly procedureName: string;
  readonly survived: number;
  readonly noCoverage: number;
  readonly killed: number;
  /** `mutantCode`s of the survivors here — references into `mutants[]`, not copies. */
  readonly survivorCodes: readonly string[];
}

export interface SessionReport {
  readonly schemaVersion: number;
  /**
   * The report's own limits, in one place — see `ReportValidity`. Always present.
   */
  readonly validity: ReportValidity;
  /**
   * Survivors grouped by the procedure they live in, most survivors first.
   *
   * 86 survivors in one codeunit is more than anyone fixes at once, and they collapse into far
   * fewer procedures — one missing assertion commonly explains several. Grouping is the ranking
   * INPUT the run itself knows and a consumer would have to re-derive; the ordering policy stays
   * with the consumer, which is why there is no computed priority score here. A number like that
   * would be wrong for someone's context and trusted uncritically anyway.
   */
  readonly survivorsByProcedure: readonly SurvivorGroup[];
  /**
   * Test codeunit name → the project-relative file it was discovered in, for every test that ran
   * at baseline. Acting on a survivor means editing a test file; `coveringTests` carries qualified
   * `Codeunit.method` names, and this is how a consumer turns one into a path without grepping.
   * Indexed once at session level rather than repeated on every mutant.
   */
  readonly testFiles: Readonly<Record<string, string>>;
  readonly backend: string;
  readonly authoritative: boolean;
  readonly baselineGreen: boolean;
  readonly batches: number;
  readonly counts: {
    killed: number;
    survived: number;
    noCoverage: number;
    timeoutKilled: number;
    knownSurvivors: number;
    unstable: number;
    errors: number;
    deadlineExceeded: number;
  };
  /**
   * Mutation score: (killed + timeoutKilled) / (killed + timeoutKilled + survived).
   * Null when denominator is 0.
   * Both killed and timeout-killed count as observable misbehavior (design.md §6.7:
   * "Timeout counts as killed (mutation caused observable misbehavior, including
   * potential nontermination)").
   */
  readonly mutationScore: number | null;
  readonly mutants: readonly MutantOutcome[];
  /**
   * Baseline test methods (qualified `Codeunit.method`) that did NOT pass at
   * baseline — outcome `fail`/`error` (spec §9). A web-service session cannot
   * open TestPages, and an unsupported test type surfaces exactly this way; a
   * genuinely broken test is indistinguishable by outcome, so the honest label
   * is "did not pass at baseline", not a hard "unsupported" claim. Any mutant
   * covered ONLY by one of these is recorded `error` (score-excluded) with a
   * named note rather than a silent `no-coverage` false-negative. Always
   * present; empty when the whole baseline passed. Deduped, sorted.
   */
  readonly unsupportedTests: readonly string[];
  /**
   * Files never instrumented because no object they declare can carry the selector-var guard
   * (R5 — see `NotInstrumentedFile`). `mutationScore` above is computed ONLY over instrumented
   * sites: a project whose skipped files hold a large share of its code can otherwise read as a
   * confident, near-complete score while most of the project was never measured at all. Always
   * present; `files` is empty and `fileCount`/`siteCount` are 0 when nothing was skipped.
   * `totalFiles` is every `.al` source file `generateMutationSet` scanned (the denominator for
   * judging how much of the project `files` represents) — it is NOT the same as `batches` or any
   * other count already in this report.
   */
  readonly notInstrumented: {
    readonly totalFiles: number;
    readonly fileCount: number;
    readonly siteCount: number;
    readonly files: readonly NotInstrumentedFile[];
  };
  /**
   * R41: the `--only` narrowing this run was asked for, if any. Absent means the whole project
   * was considered.
   *
   * Present for the same reason `notInstrumented` is: `mutationScore` covers what was RUN, and a
   * narrowed run's score describes the chosen slice, not the project. A report that recorded the
   * score but not the narrowing would be indistinguishable from a full run at the same number —
   * and would stay that way in the `--out` JSON, long after the console line scrolled away.
   *
   * `excludedFileCount` counts FILES, never sites: the sites in an excluded file are never
   * generated, so their number is not something this run measured (see
   * `MutationSetResult.excludedByOnly`).
   */
  readonly only?: {
    readonly patterns: readonly string[];
    readonly excludedFileCount: number;
  };
  /**
   * R45: the `--tests-only` narrowing, if any. Absent means the whole suite ran at baseline.
   *
   * Carried SEPARATELY from `only`, and flagged in `validity.caveats` as `tests-narrowed`,
   * because the two narrowings differ in kind: `only` selects which mutants run and cannot change
   * a verdict, while this one selects which TESTS run and can — a mutant whose killing test was
   * excluded is reported `survived`. A reader comparing two runs must be able to see that one of
   * them could not have killed everything the other did.
   */
  readonly testsOnly?: readonly string[];
  /**
   * R31: tests the source declares that the SERVER returned no result for, meaning the published
   * test app does not contain them — what is deployed is older than the source being measured.
   * Absent when every discovered test produced a result.
   *
   * Present because the symptom is badly disguised and has cost two debugging sessions: the
   * baseline goes red, dozens of mutants fall to `no-coverage`, and that reads as a
   * mutation-scoring problem. Publishing the test app is deliberately the user's own workflow, so
   * LethAL cannot fix this — but it can name it instead of leaving a scoring puzzle.
   */
  readonly staleTestApp?: { readonly missingTests: readonly string[] };
  /**
   * R35: baseline tests BC refused on PERMISSIONS — a strict subset of `unsupportedTests`, split
   * out because the two demand opposite responses from the reader. "Did not pass at baseline"
   * sends them to debug a test; this is fixed by declaring one property on the target's own test
   * codeunit (`TestPermissions = Disabled`), after which the test runs normally.
   *
   * Measured A/B, 2026-07-26 (see `permission-canary.ts`): two probe codeunits identical except
   * that property, same app, same tables, same server — omitted (AL's Restrictive default) is
   * refused, `Disabled` succeeds, on every path through `Test Runner - Mgt` 130454.
   *
   * KNOWN LIMITATION — the detector matches BC's ENGLISH refusal text, so on a non-English server
   * this field is absent even when refusals occurred, and the affected tests appear only under
   * `unsupportedTests`. That is a silent MISS, never a wrong answer. See ROADMAP R66.
   *
   * Absent when nothing was refused (or when the refusals could not be recognised).
   */
  readonly permissionsRefused?: {
    readonly tests: readonly string[];
    /** The fix, stated once here rather than repeated per mutant. */
    readonly diagnosis: string;
  };
  /**
   * R47: present when this run was assembled with `--resume`, naming the prior run it drew from and
   * how many verdicts it carried instead of measuring.
   *
   * Recorded because a resumed report is a composite: `carriedMutants` verdicts were measured
   * against a DIFFERENT published artifact, in a different session, possibly against a differently
   * behaving environment. Everything that could drift with the source is pinned — a carried verdict
   * only attaches to a mutant whose `astHash` still matches, and a resume across differing
   * `--only`/`--tests-only` scopes is refused outright — but "the environment was the same" is not
   * something LethAL can check, so it says what it did instead of implying one measurement.
   *
   * `carriedMutants: 0` with a `runId` present is meaningful and not a bug: the prior run had
   * nothing carryable (every verdict was an `error`, or every identity key collided), and the
   * reader should see that the resume bought nothing rather than assume it worked.
   */
  readonly resumedFrom?: {
    readonly runId: number;
    readonly carriedMutants: number;
    /**
     * R53: mutants NOT re-run because a prior run's execution of them stranded the tier — a
     * non-terminating mutant reproduces that every time and blocks every mutant behind it. Recorded
     * `error` (score-excluded), never a verdict: the honest statement is "not measured".
     */
    readonly skippedStranded: number;
  };
  /**
   * Wall-clock cost of this run, split into the phases that scale differently — the whole point
   * of recording it. `deploy` scales with PROJECT size (every file compiles, whether or not it
   * was mutated); `mutants` scales with MUTANT count; `baseline` is a fixed per-batch toll. A
   * single total cannot be extrapolated because those three move independently: a `--only` run
   * over 163 mutants pays nearly the same deploy as one over 11,777.
   *
   * `mutantsMs` is the summed per-mutant TEST time (`SessionOutcome.durationMs`), so
   * `totalMs - deployMs - baselineMs - mutantsMs` is the orchestration overhead — activation
   * calls, lease renewals, coverage filtering, store writes. A rise there with the other three
   * flat is the signature of a fencing or lease regression, which no verdict count would show.
   *
   * All values are milliseconds, always present (0, never absent, when a phase did not run —
   * an absent tally and a measured zero must never look alike, the same rule
   * `untargetedTriggerCount` follows).
   */
  readonly timings: {
    readonly totalMs: number;
    readonly generateMutationSetMs: number;
    readonly deployMs: number;
    readonly baselineMs: number;
    readonly mutantsMs: number;
    /** Per-mutant test time across every scored mutant, for extrapolating a larger run.
     *  `count` counts mutants that actually ran (durationMs > 0), not every recorded outcome. */
    readonly perMutant: {
      readonly count: number;
      readonly meanMs: number;
      readonly medianMs: number;
      readonly p95Ms: number;
      readonly maxMs: number;
    };
  };
  /**
   * Table trigger mutants that took `coverageFilter`'s FALLBACK 2 — "coverage places this
   * nowhere at all, so run every green test" (`selection.ts`; summed over every batch).
   *
   * The only signal distinguishing precise trigger attribution (FALLBACK 1, object-level) from
   * giving up, and it is invisible in the verdicts: on a suite where most tests touch the table,
   * running the right tests and running all of them produce the same kills. Commit `0a463fd`
   * deliberately made this branch rare by feeding member-less coverage observations into
   * `byObject`; a regression that re-emptied `byObject` would silently restore the old behaviour
   * with every aggregate count and every per-mutant verdict unchanged. It reached only a
   * `console.warn` before, which no gate can assert — hence a report field.
   *
   * NOT a defect on its own: a genuinely unreachable-by-coverage trigger SHOULD run everything
   * rather than be dropped as `no-coverage`. It is a number to pin, and a rise in it is the thing
   * to explain.
   *
   * 0 on a backend declaring `coverage: "none"` (al-runner) — no coverage filtering happens
   * there at all, every mutant runs every green test by construction, and no mutant reaches any
   * fallback. Read it only alongside `backend`.
   */
  readonly untargetedTriggerCount: number;
  /**
   * Set only when the session latched unsafe (spec §8/§12) — a test run came back
   * in-flight-unknown (the server may still be executing it) and the session recorded a
   * durable tier quarantine and stopped scheduling further mutants. `reason` is
   * `SessionSafety.reason` verbatim: it names the stranded op (method + mutant id) that
   * tripped the latch. Absent on every ordinary session, including one with plain (non-
   * in-flight-unknown) `deadline-exceeded` errors — those stay `counts.errors`/
   * `counts.deadlineExceeded` only, no quarantine.
   */
  readonly quarantined?: {
    readonly reason: string;
  };
  /**
   * R7/R8: set only on an al-runner session that actually ran the startup canary
   * (`packages/runner/src/al-runner-canary.ts`, attached via `cli.ts`'s `withAlRunnerCanary`) —
   * absent on every bcdev session and on the al-runner no-`alRunnerPath` fallback path, where
   * nothing was measured. Persisting the measured verdict here (not just a `console.warn` at
   * session start) is what makes it survive into a `--out` JSON report or reach a CI that
   * discards stderr; `renderConsole` also repeats it at the END of the printed report for the
   * same reason — a warning seen once, before the mutant table, is easy to have already
   * scrolled past by the time a reader gets to the score.
   */
  readonly alRunnerCanary?: AlRunnerCanaryResult;
  /**
   * R26: set on every session that ran the permission canary — an authoritative (bcdev) session,
   * where the fenced `RunMutant` path is the thing being characterised. Absent on al-runner and on
   * every in-memory-backend unit test, which have no fenced path and so nothing to measure.
   *
   * Persisting it here (not just a `console.warn` after the lease is acquired) is what makes the
   * verdict survive into a `--out` JSON report or reach a CI that discards stderr — and it is what
   * lets two runs of the same project on two different servers be compared honestly, since
   * `"mocked"` and `"not-mocked"` produce legitimately different scores for the same code. As with
   * `alRunnerCanary`, `renderConsole` also repeats it AFTER the score: a warning printed before a
   * single mutant ran has scrolled well off screen by the time a reader reaches the number it
   * qualifies.
   *
   * `"inconclusive"` is a first-class value here, never collapsed into `"not-mocked"` — an older
   * control app with no such action, a transport failure, or an unparseable response must stay
   * visibly distinct from a measured clean result.
   */
  readonly permissionCanary?: PermissionCanaryResult;
}

export interface MutantOutcome {
  readonly mutantCode: string;
  readonly file: string;
  readonly line: number;
  readonly operatorName: string;
  readonly verdict: MutantVerdict;
  readonly batchIndex: number;
  readonly killingTest?: string;
  /**
   * Carried through verbatim from `SessionOutcome.failureNote` — for a
   * bisected compile failure (Task 6, design spec §6) this is the culprit's
   * own identity ("bisected to mutant M000x (file:line operator)"); for other
   * `error` verdicts it's whatever diagnostic `record()` was given (deadline/
   * unstable text, the raw backend error). Without this field the note was
   * computed but reached nothing outside `orchestrator.ts` — every mutant in
   * a failed batch read as a bare, indistinguishable "error".
   */
  readonly failureNote?: string;
  /**
   * Structural reason for an "error" verdict — mirrors `SessionOutcome.cause`. Present only
   * for the two call sites that actually know it (deadline/unstable); other `error` verdicts
   * (e.g. a bisected compile failure) leave this undefined.
   */
  readonly cause?: "deadline-exceeded" | "unstable";
  /**
   * Summed test time this mutant was scored by, in ms. 0 when nothing ran against it
   * (`no-coverage`, known-survivor skip, or a batch-wide failure recorded without execution) —
   * always present, so "cost nothing because it did not run" and "field not recorded" cannot be
   * confused. See `SessionReport.timings` for why per-mutant cost is worth carrying.
   */
  readonly durationMs: number;
  /**
   * The mutation itself and where it lives — added so a consumer (a human reading a diff, or an
   * agent asked to strengthen a suite) can act on a survivor without re-deriving anything.
   *
   * Before this, a survivor read `lethal.empty-block at line 6` and nothing more: which span the
   * operator chose, what it became, which procedure it sits in, and which tests ran past it were
   * all absent, so the only way to judge a survivor was to re-open the source at exactly the
   * mutated revision and guess.
   *
   * `mutatedText` is `""` for a deletion operator — the mutation IS the empty string, not a
   * missing field. `coveringTests` is empty when nothing ran (`no-coverage`), which is itself the
   * finding: a survivor with no covering tests wants a NEW test, one with covering tests wants a
   * stronger assertion in an existing one.
   */
  readonly procedureName: string;
  readonly triggerName?: string;
  readonly startIndex: number;
  readonly endIndex: number;
  readonly originalText: string;
  readonly mutatedText: string;
  readonly coveringTests: readonly string[];
  /**
   * How `coverageFilter` placed `coveringTests`, and therefore how much that list is worth.
   *
   * `exact` — a member-level match: these tests executed THIS procedure. "Covered but survived"
   * is a real assertion gap and the covering tests are where to fix it.
   * `object` — object-level fallback: the tests executed something in this object, but whether
   * they reached the mutated member is unknown. Acting on one of these can mean strengthening a
   * test that never ran the code.
   * `all-green` — coverage placed it nowhere, so every green test ran. Least informative.
   * Absent when nothing ran (`no-coverage`).
   *
   * Reporting all three as one undifferentiated list is approximate attribution wearing the
   * costume of an exact one — the shape that produced 10 false survivors out of 20 in R29.
   */
  readonly coverageAttribution?: CoverageAttribution;
  /**
   * Whether ANY instrumented guard executed during this mutant's runs (`RunMutant`'s per-run
   * `observedAny` attestation, OR-ed across the covering tests).
   *
   * The asymmetry is the whole value, and it must not be read as "this mutant activated":
   *
   * - `false` is DECISIVE and damning for a survivor. No guarded site executed at all, so the
   *   mutated code was never reached — the mutant cannot have been given a chance to fail, and
   *   reporting it `survived` overstates the suite. It belongs with `no-coverage`, not with
   *   findings.
   * - `true` is WEAK. It says some instrumented selector fired somewhere in the artifact during
   *   that run, not that THIS mutant's guard did. A survivor with `true` is still unverified.
   *
   * This exists because `LC Control State.IsActive` is a bare string compare: an unactivated
   * mutant behaves byte-identically to baseline, so "the test ran and passed" proves nothing about
   * whether the mutation was ever in play. R32 had to establish that by hand, one mutant at a
   * time, after R29 had already produced 10 false survivors out of 20.
   *
   * Absent when nothing ran the mutant, and on backends that cannot attest (al-runner has no such
   * mechanism) — absent therefore means "not measured", never "not observed".
   */
  readonly guardObserved?: boolean;
  /**
   * R54: this verdict was CARRIED from a prior run by `--resume` rather than measured here.
   *
   * Provenance a consumer needs and cannot derive: the mutant is real and its verdict is real, but
   * it was produced by a DIFFERENT published artifact in an earlier session. Its `durationMs` is
   * therefore excluded from `timings.mutantsMs` and the per-mutant distribution, which describe
   * what THIS run cost.
   */
  readonly carried?: boolean;
  /**
   * Semantic mutant identity components (Layer 5A, `itest/mutant-equality.ts`) — the SAME
   * astHash/codeunitName/operatorMajor triple `identityKeyOf`/`serializeKey` (selection.ts)
   * already use for known-survivor persistence. Unlike `killingTest`/`failureNote`, these are
   * always known at `record()` time, so they're not optional: a mutant-code- or
   * file:line-keyed identity would break the moment a mutant is renumbered or a source line
   * shifts, which is exactly the fragility the per-mutant regression gate (design spec §11)
   * exists to survive.
   */
  readonly astHash: string;
  readonly codeunitName: string;
  readonly operatorMajor: number;
}

export interface BuildReportInput {
  readonly caps: BackendCapabilities;
  readonly baselineGreen: boolean;
  readonly batches: number;
  readonly outcomes: readonly SessionOutcome[];
  /** Deduped, sorted qualified names of baseline tests that did not pass — see `SessionReport.unsupportedTests`. */
  readonly unsupportedTests: readonly string[];
  /** Threaded straight from `generateMutationSet`'s return — see `SessionReport.notInstrumented`. */
  readonly notInstrumented: {
    readonly totalFiles: number;
    readonly files: readonly NotInstrumentedFile[];
  };
  /** R41: the `--only` patterns and how many files they excluded — see `SessionReport.only`.
   *  Absent when the run was not narrowed. */
  readonly only?: {
    readonly patterns: readonly string[];
    readonly excludedFileCount: number;
  };
  /** R45: the `--tests-only` patterns, if any — see `SessionReport.testsOnly`. */
  readonly testsOnly?: readonly string[];
  /** R31: tests the source declares that the server had no result for — see
   *  `SessionReport.staleTestApp`. */
  readonly staleTestApp?: { readonly missingTests: readonly string[] };
  /** R35: baseline tests BC refused on permissions — see `SessionReport.permissionsRefused`.
   *  Pass the names only; the diagnosis text is composed here so it cannot drift per caller. */
  readonly permissionsRefusedTests?: readonly string[];
  /** R47: the prior run `--resume` drew from — see `SessionReport.resumedFrom`. */
  readonly resumedFrom?: {
    readonly runId: number;
    readonly carriedMutants: number;
    readonly skippedStranded: number;
  };
  /** Phase wall-clock measured by `runSession` — see `SessionReport.timings`. The per-mutant
   *  distribution is derived here from `outcomes`, so only the phase totals are passed in. */
  readonly timings: {
    readonly totalMs: number;
    readonly generateMutationSetMs: number;
    readonly deployMs: number;
    readonly baselineMs: number;
  };
  /** Every test that ran at baseline — the denominator `unsupportedTests` needs, and the source
   *  of `SessionReport.testFiles`. "105 failing" means nothing without it. */
  readonly baselineTests: readonly { readonly codeunitName: string; readonly file?: string }[];
  /** Summed over every batch's `coverageFilter` — see `SessionReport.untargetedTriggerCount`.
   *  Required, not optional: an absent tally and a measured zero must never look alike. */
  readonly untargetedTriggerCount: number;
  /** Threaded straight through from `runSession`'s `SessionSafety` — see `SessionReport.quarantined`. */
  readonly quarantined?: {
    readonly reason: string;
  };
  /** R26: the once-per-session permission canary's measured verdict, threaded straight through
   *  from `runSession` — see `SessionReport.permissionCanary`. */
  readonly permissionCanary?: PermissionCanaryResult;
}

/**
 * Nearest-rank percentile over an ASCENDING-sorted array, 0 for an empty one.
 *
 * Nearest-rank rather than interpolated on purpose: these are observed durations, and reporting a
 * p95 of a value no mutant actually took invites reading it as a measurement when it is an
 * average of two. `Math.min` clamps the index so `q = 1` cannot walk off the end.
 */
function percentile(sortedAsc: readonly number[], q: number): number {
  if (sortedAsc.length === 0) return 0;
  const rank = Math.min(sortedAsc.length - 1, Math.ceil(q * sortedAsc.length) - 1);
  return sortedAsc[Math.max(0, rank)] ?? 0;
}

export function buildReport(input: BuildReportInput): SessionReport {
  const counts = {
    killed: 0,
    survived: 0,
    noCoverage: 0,
    timeoutKilled: 0,
    knownSurvivors: 0,
    unstable: 0,
    errors: 0,
    deadlineExceeded: 0,
  };
  const mutants: MutantOutcome[] = [];

  for (const o of input.outcomes) {
    switch (o.verdict) {
      case "killed":
        counts.killed++;
        break;
      case "survived":
        counts.survived++;
        break;
      case "no-coverage":
        counts.noCoverage++;
        break;
      case "timeout-killed":
        counts.timeoutKilled++;
        break;
      case "known-survivor":
        counts.knownSurvivors++;
        break;
      case "error":
        counts.errors++;
        if (o.cause === "unstable") counts.unstable++;
        if (o.cause === "deadline-exceeded") counts.deadlineExceeded++;
        break;
    }
    const identity = identityKeyOf(o.mutant);
    mutants.push({
      mutantCode: o.mutant.mutantId,
      file: o.mutant.file,
      line: o.mutant.startLine,
      operatorName: o.mutant.operatorName,
      verdict: o.verdict,
      batchIndex: o.batchIndex,
      astHash: identity.astHash,
      codeunitName: identity.codeunitName,
      operatorMajor: identity.operatorMajor,
      durationMs: o.durationMs ?? 0,
      procedureName: o.mutant.procedureName,
      startIndex: o.mutant.startIndex,
      endIndex: o.mutant.endIndex,
      originalText: o.mutant.originalText,
      mutatedText: o.mutant.mutatedText,
      coveringTests: o.coveringTests ?? [],
      ...(o.coverageAttribution !== undefined
        ? { coverageAttribution: o.coverageAttribution }
        : {}),
      ...(o.guardObserved !== undefined ? { guardObserved: o.guardObserved } : {}),
      ...(o.carried === true ? { carried: true } : {}),
      ...(o.mutant.triggerName !== undefined ? { triggerName: o.mutant.triggerName } : {}),
      ...(o.killingTest !== undefined ? { killingTest: o.killingTest } : {}),
      ...(o.failureNote !== undefined ? { failureNote: o.failureNote } : {}),
      ...(o.cause !== undefined ? { cause: o.cause } : {}),
    });
  }

  const denom = counts.killed + counts.timeoutKilled + counts.survived;
  const notInstrumentedSites = input.notInstrumented.files.reduce((n, f) => n + f.sites, 0);
  // Only mutants that actually RAN carry a duration; `no-coverage` and known-survivor skips
  // record 0. Including those zeros would drag the mean toward a cost nothing paid, which is the
  // opposite of useful when the number exists to extrapolate a bigger run.
  //
  // R54: a CARRIED verdict (`--resume`) is excluded too, and for a sharper reason than the zeros.
  // Its duration is real but was spent in a DIFFERENT run, so counting it here made `mutantsMs`
  // exceed `totalMs` — measured on a resumed Document Output sweep: 2200.4 s of "mutants" inside a
  // 2109.7 s run, with `overhead` clamped to 0 to hide the contradiction. These numbers exist to
  // extrapolate what a bigger run will COST, and time this run never spent is the one thing that
  // must not be in them.
  const durations = input.outcomes
    .filter((o) => o.carried !== true)
    .map((o) => o.durationMs ?? 0)
    .filter((d) => d > 0)
    .sort((a, b) => a - b);
  const mutantsMs = durations.reduce((n, d) => n + d, 0);
  // Survivors grouped by the procedure they live in — the ranking INPUT, not a ranking.
  type MutableGroup = {
    file: string;
    codeunitName: string;
    procedureName: string;
    survived: number;
    noCoverage: number;
    killed: number;
    survivorCodes: string[];
  };
  const groups = new Map<string, MutableGroup>();
  for (const o of input.outcomes) {
    const key = `${o.mutant.file}::${o.mutant.procedureName || o.mutant.triggerName || "<object>"}`;
    let g = groups.get(key);
    if (g === undefined) {
      g = {
        file: o.mutant.file,
        codeunitName: o.mutant.codeunitName,
        procedureName: o.mutant.procedureName || o.mutant.triggerName || "",
        survived: 0,
        noCoverage: 0,
        killed: 0,
        survivorCodes: [],
      };
      groups.set(key, g);
    }
    if (o.verdict === "survived") {
      g.survived++;
      g.survivorCodes.push(o.mutant.mutantId);
    } else if (o.verdict === "no-coverage") g.noCoverage++;
    else if (o.verdict === "killed" || o.verdict === "timeout-killed") g.killed++;
  }
  const survivorsByProcedure = [...groups.values()]
    .filter((g) => g.survived > 0)
    .sort((a, b) => b.survived - a.survived || a.file.localeCompare(b.file));

  const testFiles: Record<string, string> = {};
  for (const t of input.baselineTests) {
    if (t.file !== undefined) testFiles[t.codeunitName] = t.file;
  }

  const scored = counts.killed + counts.timeoutKilled + counts.survived;
  const caveats: string[] = [];
  if (!input.baselineGreen) caveats.push("baseline-red");
  if (input.only !== undefined) caveats.push("narrowed");
  // Listed distinctly from `narrowed`: this is the one narrowing that can manufacture a survivor.
  if (input.testsOnly !== undefined && input.testsOnly.length > 0) caveats.push("tests-narrowed");
  if (input.notInstrumented.files.length > 0) caveats.push("uninstrumentable-files");
  if (input.staleTestApp !== undefined) caveats.push("stale-test-app");
  // R35: distinct from the `baseline-red` caveat these tests also trigger. That one says the
  // measurement is degraded; this one says the degradation has a known, one-line cause in the
  // TARGET'S source — which is the difference between "your score is unreliable" and "declare
  // TestPermissions = Disabled and run it again".
  const permissionsRefusedTests = input.permissionsRefusedTests ?? [];
  if (permissionsRefusedTests.length > 0) caveats.push("tests-permission-refused");
  // R47: a caveat, not a reliability downgrade. The verdicts carried are real measurements taken
  // over the same source (identity-matched) and the same scope (fingerprint-matched) — calling
  // that "degraded" would put an honest resume in the same bucket as a red baseline. What it IS
  // is a composite of two sessions, and the reader is entitled to know before comparing runs.
  if (input.resumedFrom !== undefined) caveats.push("resumed");
  if (input.untargetedTriggerCount > 0) caveats.push("untargeted-triggers");
  const narrowed =
    input.only !== undefined || (input.testsOnly !== undefined && input.testsOnly.length > 0);
  const degraded = !input.baselineGreen;
  const reliability =
    narrowed && degraded
      ? "narrowed-degraded"
      : narrowed
        ? "narrowed"
        : degraded
          ? "degraded"
          : "full";
  const scopeText = narrowed
    ? `${input.only?.patterns.join(", ") ?? ""} (${input.notInstrumented.totalFiles - (input.only?.excludedFileCount ?? 0)} of ${input.notInstrumented.totalFiles} .al files)`
    : `${input.notInstrumented.totalFiles} .al file(s)`;
  const baselineText = degraded
    ? `, with ${input.unsupportedTests.length} of ${input.baselineTests.length} baseline tests failing`
    : "";

  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    validity: {
      reliability,
      caveats,
      scoreDescribes: `${scored} scored mutant(s) in ${scopeText}${baselineText}`,
      baselineTests: { total: input.baselineTests.length, failing: input.unsupportedTests.length },
      scoredMutants: { scored, recorded: input.outcomes.length },
      // R60. Split by backend rather than asserted once, because only ONE of the two was
      // measured: R57 measured the fenced `RunMutant` path directly (`GuiAllowed=No`,
      // `ClientType=ODataV4`). al-runner is a headless CLI, which is not the same evidence, and
      // saying "measured" of both would be the kind of static claim R7/R8 exist to stop.
      executionContext: input.caps.authoritative
        ? {
            guiAllowed: false,
            clientType: "ODataV4",
            basis:
              "measured on the fenced RunMutant path (R57): every mutant executes in a " +
              "GuiAllowed=No, ClientType=ODataV4 session",
          }
        : {
            guiAllowed: false,
            clientType: "al-runner CLI",
            basis:
              "al-runner executes headlessly by construction (no client session to prompt from); " +
              "not separately measured by LethAL the way the fenced path was under R57",
          },
    },
    ...(permissionsRefusedTests.length > 0
      ? {
          permissionsRefused: {
            tests: [...permissionsRefusedTests].sort(),
            diagnosis:
              "BC's permission system refused these tests, which is neither flakiness nor an " +
              "unsupported test type: the test codeunit most likely omits " +
              "`TestPermissions = Disabled`, and AL's Restrictive default strips a test body of " +
              "write permission on its own app's tables. Declare `TestPermissions = Disabled;` " +
              "on the test codeunit and re-run. Any mutant covered only by these tests is " +
              "recorded `error` (score-excluded), never a silent `no-coverage`.",
          },
        }
      : {}),
    survivorsByProcedure,
    testFiles,
    backend: input.caps.authoritative ? "bcdev" : "al-runner",
    authoritative: input.caps.authoritative,
    baselineGreen: input.baselineGreen,
    batches: input.batches,
    counts,
    mutationScore: denom === 0 ? null : (counts.killed + counts.timeoutKilled) / denom,
    mutants,
    unsupportedTests: input.unsupportedTests,
    notInstrumented: {
      totalFiles: input.notInstrumented.totalFiles,
      fileCount: input.notInstrumented.files.length,
      siteCount: notInstrumentedSites,
      files: input.notInstrumented.files,
    },
    untargetedTriggerCount: input.untargetedTriggerCount,
    ...(input.only !== undefined ? { only: input.only } : {}),
    ...(input.testsOnly !== undefined ? { testsOnly: input.testsOnly } : {}),
    ...(input.staleTestApp !== undefined ? { staleTestApp: input.staleTestApp } : {}),
    ...(input.resumedFrom !== undefined ? { resumedFrom: input.resumedFrom } : {}),
    timings: {
      totalMs: input.timings.totalMs,
      generateMutationSetMs: input.timings.generateMutationSetMs,
      deployMs: input.timings.deployMs,
      baselineMs: input.timings.baselineMs,
      mutantsMs,
      perMutant: {
        count: durations.length,
        meanMs: durations.length === 0 ? 0 : Math.round(mutantsMs / durations.length),
        medianMs: percentile(durations, 0.5),
        p95Ms: percentile(durations, 0.95),
        maxMs: durations.at(-1) ?? 0,
      },
    },
    ...(input.quarantined !== undefined ? { quarantined: input.quarantined } : {}),
    ...(input.permissionCanary !== undefined ? { permissionCanary: input.permissionCanary } : {}),
  };
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

export function renderConsole(r: SessionReport): string {
  const lines: string[] = [];
  if (!r.authoritative) {
    lines.push(`[backend: ${r.backend} — mock runtime, indicative]`);
  }
  lines.push(
    `${pad("mutant", 8)} ${pad("file:line", 34)} ${pad("operator", 28)} ${pad("verdict", 16)} killing test`,
  );
  for (const m of r.mutants) {
    lines.push(
      `${pad(m.mutantCode, 8)} ${pad(`${m.file}:${m.line}`, 34)} ${pad(m.operatorName, 28)} ${pad(m.verdict, 16)} ${m.killingTest ?? ""}`,
    );
    // A short indented line beneath the row rather than a suffix on it: the
    // note (a bisected culprit's identity, a deadline/unstable diagnostic, or
    // a raw backend error) is often much longer than the fixed-width columns
    // above and would blow out the table's alignment if appended inline.
    if (m.verdict === "error" && m.failureNote !== undefined) {
      lines.push(`         ${m.failureNote}`);
    }
  }
  const scoreText = r.mutationScore === null ? "n/a" : `${(r.mutationScore * 100).toFixed(1)}%`;
  lines.push(
    `score: ${scoreText}  ` +
      `(killed ${r.counts.killed}, survived ${r.counts.survived}, no-coverage ${r.counts.noCoverage}, ` +
      `deadline-exceeded ${r.counts.deadlineExceeded}, ` +
      `timeout-killed ${r.counts.timeoutKilled}, known-survivor ${r.counts.knownSurvivors}, ` +
      `error ${r.counts.errors} [unstable ${r.counts.unstable}])`,
  );
  // R5: the score above is computed ONLY over instrumented sites — say so explicitly, right next
  // to it, whenever any file was dropped. A page-heavy project could otherwise read a confident
  // "100%" as full coverage when most of its code was never instrumented at all.
  if (r.notInstrumented.fileCount > 0) {
    const pct =
      r.notInstrumented.totalFiles > 0
        ? `${((r.notInstrumented.fileCount / r.notInstrumented.totalFiles) * 100).toFixed(1)}%`
        : "?";
    lines.push(
      `NOT INSTRUMENTED: ${r.notInstrumented.fileCount}/${r.notInstrumented.totalFiles} .al file(s) (${pct}), ${r.notInstrumented.siteCount} mutation site(s) never measured — the score above excludes them entirely, it is not a full-project score. Only a codeunit or a table can carry the injected selector var; page/report/query/xmlport objects are published unchanged.`,
    );
    for (const f of r.notInstrumented.files) {
      lines.push(`  ${f.file} (${f.kinds}, ${f.sites} site(s))`);
    }
  }
  if (r.staleTestApp !== undefined) {
    const n = r.staleTestApp.missingTests.length;
    lines.push(
      `STALE TEST APP: the server returned no result for ${n} test(s) this project's source declares, so the PUBLISHED test app is older than the source being measured. Republish it before trusting this run — a missing test cannot kill anything, so its mutants land as no-coverage or survived.`,
    );
    for (const t of r.staleTestApp.missingTests.slice(0, 10)) lines.push(`  ${t}`);
    if (n > 10) lines.push(`  ... ${n - 10} more`);
  }
  // R35: printed at the SAME prominence as a stale test app, because it is the same class of
  // problem — a one-line fix in the user's own source that otherwise reads as a scoring puzzle.
  // Without this the reader sees only "N of M baseline tests failing" and goes to debug the tests.
  if (r.permissionsRefused !== undefined) {
    const n = r.permissionsRefused.tests.length;
    // The hedge is deliberate and matches the detector's own ("most likely"): this is a diagnosis
    // read off BC's English refusal text, and the console is the surface readers act on. Stating
    // it flatly here would be the one place the qualification got dropped.
    lines.push(
      `PERMISSIONS REFUSED: ${n} baseline test(s) carry BC's permission-refusal message. ${r.permissionsRefused.diagnosis}`,
    );
    for (const t of r.permissionsRefused.tests.slice(0, 10)) lines.push(`  ${t}`);
    if (n > 10) lines.push(`  ... ${n - 10} more`);
  }
  // R47: its own line rather than relying on the SCOPE line below, which only prints when
  // `reliability` is not "full" — and a resume does not degrade reliability (see the caveat's
  // rationale in `buildReport`). Without this a resumed run would look identical to a fresh one.
  if (r.resumedFrom !== undefined) {
    lines.push(
      `RESUMED: ${r.resumedFrom.carriedMutants} verdict(s) carried from run ${r.resumedFrom.runId} without re-executing. They were measured over the same source (identity-matched) and the same scope, but by a different published artifact in an earlier session.${
        r.resumedFrom.carriedMutants === 0
          ? " Nothing was actually carried — the prior run had no reusable verdict, so this run measured everything itself."
          : ""
      }${
        // R53: stated separately from the carried count, because it is the opposite kind of fact —
        // these mutants have NO verdict from either run and must not be read as covered.
        r.resumedFrom.skippedStranded > 0
          ? ` ${r.resumedFrom.skippedStranded} mutant(s) were NOT re-run: a prior run's execution of them could not be confirmed complete and stranded the tier, which is what a mutant that never terminates does every time — and it would block every mutant behind it. They are recorded as errors and excluded from the score, NOT scored as survived. Pass --retry-stranded to attempt them.`
          : ""
      }`,
    );
  }
  // R60. Printed on EVERY run, including a `full` one — this limit does not depend on scope,
  // baseline health, or anything else the SCOPE line below is gated on. A reader comparing a
  // LethAL score against what they see in VS Code is comparing two different branches of their
  // own app, and until now nothing said so anywhere.
  lines.push(
    `NON-GUI EXECUTION: every verdict here describes the app's non-interactive branch ` +
      `(GuiAllowed=No, ClientType=${r.validity.executionContext.clientType}). Code reachable only ` +
      `when a user can be prompted never runs, so its mutants cannot be killed and land as ` +
      `survived or no-coverage — neither of which is a statement about your tests. Confirm() ` +
      `returns its DEFAULT rather than skipping the branch; Page.RunModal ERRORS. Measured on ` +
      `Continia Document Output: 0.3% of mutation sites (62 of 19,850).`,
  );
  // The score's own limits, immediately after it. A reader quotes `score: 15.7%` long before
  // correlating four separate qualifier fields, so the qualification has to arrive with it.
  if (r.validity.reliability !== "full") {
    lines.push(
      `SCOPE: ${r.validity.reliability} [${r.validity.caveats.join(", ")}] - ${r.validity.scoreDescribes}`,
    );
  }
  // A survivor whose guards never fired was never exercised. Saying so beside the score keeps it
  // out of the "your suite is weak here" bucket it would otherwise land in.
  {
    const unobserved = r.mutants.filter(
      (m) => m.verdict === "survived" && m.guardObserved === false,
    );
    if (unobserved.length > 0) {
      lines.push(
        `UNEXERCISED SURVIVORS: ${unobserved.length} mutant(s) reported survived had NO instrumented guard fire during their runs — the mutated code was never reached, so they were never given a chance to fail. Treat them as no-coverage, not as test-suite gaps: ${unobserved
          .slice(0, 8)
          .map((m) => m.mutantCode)
          .join(", ")}${unobserved.length > 8 ? ", ..." : ""}`,
      );
    }
  }
  // Where the suite is blind, grouped - the part a reader acts on. Ahead of the per-mutant table
  // because a codeunit's survivors collapse into far fewer procedures, and one missing assertion
  // commonly explains several of them.
  if (r.survivorsByProcedure.length > 0) {
    const shown = r.survivorsByProcedure.slice(0, 10);
    lines.push(`SURVIVORS BY PROCEDURE (${r.survivorsByProcedure.length} with survivors):`);
    for (const g of shown) {
      const where = g.procedureName === "" ? "<object>" : g.procedureName;
      lines.push(
        `  ${g.survived.toString().padStart(3)} survived  ${g.codeunitName}.${where}  (${g.killed} killed, ${g.noCoverage} no-coverage)`,
      );
    }
    if (r.survivorsByProcedure.length > shown.length) {
      lines.push(`  ... ${r.survivorsByProcedure.length - shown.length} more`);
    }
  }
  // Cost, next to the result: the three phases scale independently, so this is what makes a
  // narrowed run extrapolate to a bigger one — and what makes a later run comparable to this one.
  {
    const t = r.timings;
    const s = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
    const overheadMs = Math.max(0, t.totalMs - t.deployMs - t.baselineMs - t.mutantsMs);
    lines.push(
      `TIMING: total ${s(t.totalMs)} = generate ${s(t.generateMutationSetMs)} + deploy ${s(t.deployMs)} + baseline ${s(t.baselineMs)} + mutants ${s(t.mutantsMs)} + overhead ${s(overheadMs)}`,
    );
    if (t.perMutant.count > 0) {
      lines.push(
        `  per mutant (n=${t.perMutant.count}): mean ${t.perMutant.meanMs}ms, median ${t.perMutant.medianMs}ms, p95 ${t.perMutant.p95Ms}ms, max ${t.perMutant.maxMs}ms`,
      );
    }
  }
  // R41: a narrowed run's score describes the slice that was asked for, not the project. Same
  // placement rule as NOT INSTRUMENTED — a qualifier on the score belongs next to the score.
  if (r.only !== undefined) {
    lines.push(
      `NARROWED (--only): ${r.only.patterns.map((p) => `"${p}"`).join(", ")} — ${r.only.excludedFileCount} .al file(s) contributed no mutants. The score above covers the narrowed set ONLY, it is not a project score.`,
    );
  }
  // Same reasoning as NOT INSTRUMENTED above: a qualifier on the score belongs next to the score.
  // These mutants were scored against EVERY green test rather than against tests coverage placed
  // in their table — honest (better than dropping them as no-coverage) but slower and coarser, and
  // a rise here is the visible symptom of coverage attribution regressing.
  if (r.untargetedTriggerCount > 0) {
    lines.push(
      `COVERAGE FALLBACK: ${r.untargetedTriggerCount} table trigger mutant(s) coverage could place nowhere — each was run against every green test rather than against an attributed set.`,
    );
  }
  // R7/R8: repeat the al-runner canary's measured verdict at the END too — `announceAlRunnerCanary`
  // (cli.ts) already prints it once via console.warn at the very start of the session, before a
  // single mutant has run, which is exactly the "warning that scrolls past on a long run" pattern
  // that let the original static claim go unnoticed for a session's whole duration. The end of a
  // long run — right after the score — is where a reader actually is.
  if (!r.authoritative && r.alRunnerCanary !== undefined) {
    lines.push("");
    lines.push(...alRunnerCanaryWarnings(r.alRunnerCanary));
  }
  // R26: same reasoning, same lesson — the permission canary is announced once, right after the
  // lease is acquired and before the first mutant runs, which on a real session is many minutes
  // and a full mutant table before the score a reader is actually looking at. Repeat it here.
  // Unlike the al-runner canary above this is NOT gated on `authoritative`: the permission mock is
  // a property of the FENCED (bcdev) path, so an authoritative report is exactly where it belongs
  // — presence of the field alone decides, and nothing else ever sets it.
  if (r.permissionCanary !== undefined) {
    lines.push("");
    lines.push(...permissionCanaryWarnings(r.permissionCanary));
  }
  return lines.join("\n");
}

export async function writeJsonReport(r: SessionReport, path: string): Promise<void> {
  await Bun.write(path, JSON.stringify(r, null, 2));
}
