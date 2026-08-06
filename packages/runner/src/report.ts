import type { MutantManifestEntry } from "@lethal/schemata";
import { type AlRunnerCanaryResult, alRunnerCanaryWarnings } from "./al-runner-canary";
import type { BackendCapabilities } from "./backend";
import type { RunEvent } from "./events";
import type { Interpretation } from "./interpretation";
import { type PermissionCanaryResult, permissionCanaryWarnings } from "./permission-canary";
import { type FoldStatics, foldEvents } from "./report-fold";
import type { CoverageAttribution } from "./selection";
import { identityKeyOf } from "./selection";
import type { MutantVerdict, RunnerKind } from "./store";
import { TESTPAGE_DIAGNOSIS } from "./testpage-unsupported";

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
   * sites in orchestrator.ts that actually know it — see
   * `ERROR_CAUSE_INTERPRETATIONS` for what each value means to a reader.
   * Deliberately NOT derived from `failureNote` text: `failureNote` also
   * carries arbitrary backend-thrown text (e.g. the batch-deploy-failure
   * handler's `String(err)`), which could otherwise collide with a prefix
   * match.
   */
  readonly cause?: MutantErrorCause;
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
  /**
   * Event-stream refactor (spec 2026-08-05 §A): for a CARRIED outcome only, the prior run's own
   * cost — sourced from `mutant-carried.priorDurationMs` (events.ts), which is the ONLY duration
   * field that event carries. `durationMs` above stays absent/0 for a carried outcome (this run
   * spent nothing on it), so the aggregate cost computation in `buildReport` can read `durationMs`
   * alone and structurally never see a carried cost — no filter required, R54 made unrepresentable
   * rather than guarded. This field exists purely so the per-mutant OUTPUT row can still show what
   * the verdict originally cost; `buildReport` reads it ONLY when `carried === true`.
   */
  readonly priorDurationMs?: number;
  /**
   * R69 Phase 2 Task 5 — which execution path produced this verdict (see `RunnerKind`, store.ts).
   * `undefined` means fenced: every call site that predates Task 6's client-services routing, and
   * every verdict recorded before this field existed. `buildReport` is where that reading happens
   * — see `MutantOutcome.runner`, which is never left ambiguous the way this input field is.
   */
  readonly runner?: RunnerKind;
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
export const REPORT_SCHEMA_VERSION = 2;

/**
 * The closed set of reasons `buildReport` can attach to a run — see the 11 `caveats.push(...)`
 * call sites below, which are the only producers. A free `string[]` let a typo silently never
 * match a consumer's check; this union turns that into a compile error at the push site instead.
 */
export type Caveat =
  | "baseline-red"
  | "narrowed"
  | "tests-narrowed"
  | "uninstrumentable-files"
  | "stale-test-app"
  | "tests-permission-refused"
  | "tests-testpage-unsupported"
  | "runner-disagreement"
  | "stop-hung-sessions"
  | "resumed"
  | "untargeted-triggers";

/**
 * What each `Caveat` MEANS for a reader, and — where the roadmap entry that filed it recorded one
 * — what a reader must do before trusting the numbers around it. Co-located with `Caveat` itself
 * for the same reason `ATTRIBUTION_INTERPRETATIONS` sits next to `CoverageAttribution`
 * (selection.ts): whoever adds or edits a `caveats.push(...)` call below is looking at the same
 * file that states what the pushed value means, so the two cannot drift into two accounts of one
 * fact. Promoted from the doc comments already attached to each caveat's push site and its related
 * field below — see `Interpretation` (interpretation.ts) for the shape.
 *
 * WHAT CO-LOCATION BUYS, AND WHAT IT DOES NOT. It buys KEYING: an interpretation cannot exist
 * without a machine value to hang on, cannot drift from that value's own definition, and cannot
 * ship without a `basis` that resolves against `ROADMAP.md` (interpretation.test.ts). `lethal
 * explain` then emits these constants BY REFERENCE and a path pin refuses any other field
 * (explain.ts) — so free-floating prose cannot reach a consumer.
 *
 * It does NOT police what the prose SAYS. Target-prescriptive advice — "these deserve attention
 * first", "consider covering this line" — added to a `meaning` below ships green through every one
 * of those mechanisms, and was measured doing so. The rule that an interpretation states what is
 * proven about the target and never what test to write (see explain.ts's "THE LINE") is a human
 * judgement at review time, enforced by whoever reviews an edit to this constant. Nothing here
 * checks it, and a reader should not believe otherwise.
 */
export const CAVEAT_INTERPRETATIONS: Record<Caveat, Interpretation> = {
  "baseline-red": {
    meaning:
      "The baseline was not green — some tests failed or errored before any mutant ran. " +
      "Consequence (R55): baseline-red dropped those tests from the green set, so mutants " +
      "covered only by them read `no-coverage`, not `survived`. Resolve this before reading " +
      "survivors.",
    entailedNegative:
      "Does not mean the score is merely lower than it should be — it means some mutants could " +
      "not be scored at all.",
    basis: "R55",
  },
  narrowed: {
    meaning:
      "The run was scoped by `--only`. `mutationScore` covers what was RUN, and a narrowed " +
      "run's score describes the chosen slice, not the project.",
    entailedNegative:
      "`only` selects which mutants run and cannot itself change a verdict — unlike " +
      "`tests-narrowed`, which selects which tests run and can.",
    basis: "R41",
  },
  "tests-narrowed": {
    meaning:
      "The `--tests-only` narrowing selects which TESTS run, and it CAN change a verdict — a " +
      "mutant whose killing test was excluded is reported `survived`.",
    entailedNegative:
      "This is the one narrowing that can manufacture a survivor; unlike `narrowed` (`--only`), " +
      "which selects which mutants run and cannot change a verdict.",
    basis: "R45",
  },
  "uninstrumentable-files": {
    meaning:
      "Some files were never instrumented because no object they declare can carry the " +
      "selector-var guard (R5). `mutationScore` is computed ONLY over instrumented sites.",
    entailedNegative:
      "A project whose skipped files hold a large share of its code can otherwise read as a " +
      "confident, near-complete score while most of the project was never measured at all.",
    basis: "R5",
  },
  "stale-test-app": {
    meaning:
      "The server returned no result for tests the source declares, meaning the published test " +
      "app does not contain them: what is deployed is older than the source being measured.",
    entailedNegative:
      "Does not mean mutation scoring is broken: the baseline going red and mutants falling to " +
      "`no-coverage` is a symptom of a stale deploy, not a scoring defect. Publishing the test " +
      "app is the user's own workflow — LethAL can only name the mismatch, not fix it.",
    basis: "R31",
  },
  "tests-permission-refused": {
    meaning:
      "BC's permission system refused these tests, which is neither flakiness nor an " +
      "unsupported test type: the test codeunit most likely omits `TestPermissions = Disabled`, " +
      "and AL's Restrictive default strips a test body of write permission on its own app's " +
      "tables. Declare `TestPermissions = Disabled;` on the test codeunit and re-run.",
    entailedNegative:
      "Distinct from `baseline-red`: that one says the measurement is degraded; this one says " +
      "the degradation has a known, one-line cause in the target's own source.",
    basis: "R35",
  },
  "tests-testpage-unsupported": {
    // TESTPAGE_DIAGNOSIS (testpage-unsupported.ts) is itself already the shared explanation
    // between the session-level report and the per-mutant note "so the two state the same thing
    // rather than drifting into two accounts of one fact" — reusing the constant here, rather
    // than copying its text, extends that same guarantee to this interpretation.
    meaning: TESTPAGE_DIAGNOSIS,
    entailedNegative:
      "Distinct from `baseline-red` AND from `tests-permission-refused`. The first says the " +
      "measurement is degraded; the second says the degradation has a one-line fix in the " +
      "user's own source. This one says the degradation has NO target-side fix at all — these " +
      "tests cannot run on this execution path.",
    basis: "R69",
  },
  "runner-disagreement": {
    meaning:
      "Tests that PASSED on the bc-dev-mcp hub (they were in the green set) and then FAILED, " +
      "unmutated, on the fenced runner that produces every verdict. NOT a wrong-verdict " +
      "warning: the mutants these tests cover are already `error cause=unstable`, because a " +
      "kill requires the unmutated fenced confirmation to PASS.",
    entailedNegative:
      "One confirmation cannot separate a deterministic disagreement from a genuinely flaky " +
      "test — this caveat names the CAUSE so the reader stops debugging flakiness, it does not " +
      "mean any verdict is wrong. Distinct from `baseline-red` and `tests-permission-refused`, " +
      "which describe the user's own tests: this describes LethAL measuring the green set on a " +
      "different session type from the verdicts — a property of the CONFIGURATION, fixed by " +
      "changing it.",
    basis: "R59",
  },
  "stop-hung-sessions": {
    meaning:
      "A `timeout-killed` verdict scored through `--stop-hung-sessions` rests on BC confirming " +
      "it stopped the session — NOT on a failing assertion, and not on any attestation. The run " +
      "cannot even say whether an instrumented site executed.",
    entailedNegative:
      "This verdict is evidentially weaker than every other kill, and it is permanent: " +
      "`timeout-killed` is carryable by `--resume`.",
    basis: "R53",
  },
  resumed: {
    meaning:
      "This run was assembled with `--resume`. The verdicts carried are real measurements " +
      "taken over the same source (identity-matched) and the same scope (fingerprint-matched) " +
      "— a composite of two sessions.",
    entailedNegative:
      "Not a reliability downgrade the way `baseline-red` is — calling a resumed run " +
      "'degraded' would put an honest resume in the same bucket as a red baseline.",
    basis: "R47",
  },
  "untargeted-triggers": {
    meaning:
      "Some TABLE trigger mutants took `coverageFilter`'s FALLBACK 2 — coverage placed them " +
      "nowhere at all, so every green test ran against them.",
    entailedNegative:
      "NOT a defect on its own: a genuinely unreachable-by-coverage trigger SHOULD run " +
      "everything rather than be dropped as `no-coverage`. It is a number to pin, and a rise " +
      "in it is the thing to explain.",
    basis: "R29",
  },
};

/**
 * The closed set of STRUCTURAL reasons an `error` verdict can name — see `MutantOutcome.cause`.
 *
 * A named type rather than the inline union it replaces at both declaration sites, for the same
 * reason `Caveat` is one: `ERROR_CAUSE_INTERPRETATIONS`'s `Record<>` below then makes adding a
 * third cause a COMPILE error until its interpretation exists. An inline union at each site could
 * grow a variant that no reader of the report has any way to interpret.
 */
export type MutantErrorCause = "deadline-exceeded" | "unstable";

/**
 * What each `MutantErrorCause` MEANS for a reader, and — because both are facts about LethAL's OWN
 * machinery rather than about the target's code — what to do about it. Co-located with
 * `MutantErrorCause` for the same reason `CAVEAT_INTERPRETATIONS` sits next to `Caveat`.
 *
 * Prescription is admissible here and NOT admissible for, say, an equivalence guess about a
 * survivor, and the line is not taste: a `cause` is a machine value this report already carries, so
 * the claim is keyed and checkable, and its subject is LethAL's timeout/confirmation machinery,
 * which LethAL is the authority on. A claim about whether the customer's mutated expression is
 * semantically equivalent has no field to key on and no measurement behind it.
 */
export const ERROR_CAUSE_INTERPRETATIONS: Record<MutantErrorCause, Interpretation> = {
  "deadline-exceeded": {
    meaning:
      "LethAL's OWN client-side timer expired — infrastructure, so this mutant was NOT measured. " +
      "R91 measured what this usually is on real AL: mutants that are SLOW, not hung (deleting a " +
      "`SetCurrentKey` makes the following filtered query pick a worse plan and scan). Re-run " +
      "with `--mutant-timeout-ms` raised — 180000 took three consecutive stranding runs to zero " +
      "— together with `--resume`, which keeps the verdicts already measured.",
    entailedNegative:
      "Not a verdict, and in particular not `timeout-killed`, which IS one. R91's control is that " +
      "a genuinely non-terminating mutant still scored `timeout-killed` at 30172 ms in the same " +
      "run where raising the floor eliminated every one of these: the machinery separates the two " +
      "correctly once the budget is honest.",
    basis: "R91",
  },
  unstable: {
    meaning:
      "The killing test ALSO failed unmutated, at baseline confirmation, so the kill could not be " +
      "confirmed and the mutant is recorded `error` (score-excluded) rather than `killed`.",
    entailedNegative:
      'Says nothing about the mutant by construction — neither killed nor survived. "Unstable" is ' +
      "a guess about flakiness, and two named diagnoses replace it when either applies: see " +
      '`CAVEAT_INTERPRETATIONS["tests-permission-refused"]` (a one-line fix in the target\'s own ' +
      'test codeunit) and `CAVEAT_INTERPRETATIONS["runner-disagreement"]` (a configuration ' +
      "property, not flakiness at all).",
    // R27's TITLE is struck through VOID (it followed R1), but its surviving half is precisely this
    // value: "LethAL currently reports those mutants as `error cause=unstable` rather than naming
    // the cause". Read past the strikethrough to the "What survives as a genuine product concern"
    // sentence. Cited here rather than R35 because R35 is about DETECTING a permissions refusal,
    // which is one named cause of `unstable` rather than what the verdict itself means.
    basis: "R27",
  },
};

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
  /** Human- and machine-readable reasons — see `Caveat` for the closed set. */
  readonly caveats: readonly Caveat[];
  /** One sentence naming what the score covers. Written for a consumer that will quote it. */
  readonly scoreDescribes: string;
  /** Tests that ran at baseline, and how many of them failed. `failing > 0` bounds how much this
   *  run could measure at all: a mutant covered only by failing tests cannot be scored. */
  readonly baselineTests: { readonly total: number; readonly failing: number };
  /** Mutants that produced a scoreable verdict (killed/survived/timeout-killed), out of all
   *  recorded. The denominator `mutationScore` is actually computed over. */
  readonly scoredMutants: { readonly scored: number; readonly recorded: number };
  /**
   * R60, widened by R69 Phase 2 Task 5: one entry per execution path that ACTUALLY produced a
   * verdict in this report — never a static claim about every path LethAL could ever use.
   *
   * Until R69 Phase 2 there was exactly one path, so this used to be a single object asserted
   * unconditionally: `{ guiAllowed: false, clientType: "ODataV4", ... }` on EVERY authoritative
   * run. That is why it became an array rather than staying a bare object with an added case —
   * the single-object shape could only ever describe "the one path LethAL has", and the moment a
   * SECOND path exists (client-services, R69: `GuiAllowed=Yes`, `ClientType=Web`) the old sentence
   * is simply false for any run that used it even once. `REPORT_SCHEMA_VERSION` bumped to 2 for
   * exactly this: the field was renamed AND its cardinality changed, which is not a compatible
   * evolution for a machine-read report.
   *
   * LethAL's original (and still default) path executes every mutant headlessly. A developer
   * running the same suite from VS Code runs GUI-allowed, so plain headless execution is not
   * measuring the same branches as the developer would see, and nothing in the report used to say
   * so. Consequences, in the order they mislead, on the FENCED path specifically:
   *
   *   (a) A mutant inside a branch reachable only when a user can be prompted never executes
   *       fenced, so it cannot be killed there. It is reported `survived` or `no-coverage` — and
   *       BOTH read as statements about the test suite ("your tests are weak here") when the truth
   *       is that the fenced path never ran the code.
   *   (b) `Confirm` does not skip its branch on the fenced path, it FORCES the default answer, so
   *       the non-default arm is the unreachable one there. `Message` is a no-op and changes
   *       nothing. `Page.RunModal` is different again: it ERRORS, which can fail a test for a
   *       reason unrelated to the mutant.
   *   (c) `mutationScore`'s denominator therefore includes sites that were unreachable by
   *       construction on the fenced path.
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
   * On the client-services path (R69) the SAME `Confirm` site behaves differently: an unhandled
   * `Confirm` RAISES rather than returning its default, so a mutant inside a `Confirm` branch can
   * genuinely reach a different verdict there than it would fenced. That divergence is exactly why
   * this became a per-path array instead of one asserted fact — a reader comparing two verdicts
   * for the same mutant needs to know they may legitimately differ, not just that one of them is
   * "the" execution mode.
   *
   * A CARRIED verdict (`--resume`) gets its own entry too, even when its runner matches one this
   * run also measured directly — see `buildReport`'s grouping. It was not produced by this run, so
   * folding it into this run's own measured entry would understate what a resumed report actually
   * is: a composite of (at least) two sessions.
   *
   * Always non-empty, even on a run with zero outcomes (e.g. quarantined before scoring anything)
   * — this remains, in the ordinary case, a property of how LethAL runs rather than a per-run
   * measurement, so a run that measured nothing still reports its default (fenced) context with a
   * `verdictCount` of 0.
   */
  readonly executionContexts: readonly ExecutionContext[];
}

/** One entry in `ReportValidity.executionContexts` — see that field for the full rationale. */
export interface ExecutionContext {
  /** Which path produced these verdicts — see `RunnerKind` (store.ts). */
  readonly runner: RunnerKind;
  /**
   * Whether this path can prompt a user. No longer a literal `false`: R69 Phase 2 is the "future
   * path" the old single-object comment predicted, and the type had to change exactly because that
   * happened — a `boolean` cannot drift silently the way widening a comment alone could have.
   */
  readonly guiAllowed: boolean;
  /** The session kind mutants execute under on this path. */
  readonly clientType: string;
  /** How that is known — measured, inferred from the runner's shape, or (for a carried verdict)
   *  named as coming from an earlier run. Never a bare claim. */
  readonly basis: string;
  /** How many of this report's verdicts were produced under this context — the denominator a
   *  reader needs to judge how much of the score this context actually accounts for. */
  readonly verdictCount: number;
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
   * (R5 — see `NotInstrumentedFile`). See `CAVEAT_INTERPRETATIONS["uninstrumentable-files"]` for
   * what this means to a reader.
   *
   * Always present; `files` is empty and `fileCount`/`siteCount` are 0 when nothing was skipped.
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
   * was considered. See `CAVEAT_INTERPRETATIONS.narrowed` for what this means to a reader.
   *
   * Present for the same reason `notInstrumented` is: a report that recorded the score but not
   * the narrowing would be indistinguishable from a full run at the same number — and would stay
   * that way in the `--out` JSON, long after the console line scrolled away.
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
   * R45: the `--tests-only` narrowing, if any. Absent means the whole suite ran at baseline. See
   * `CAVEAT_INTERPRETATIONS["tests-narrowed"]` for what this means to a reader.
   *
   * Carried SEPARATELY from `only` — this field, not that one, is what the `tests-narrowed`
   * caveat flags. A reader comparing two runs must be able to see that one of them could not
   * have killed everything the other did.
   */
  readonly testsOnly?: readonly string[];
  /**
   * R31: tests the source declares that the SERVER returned no result for. Absent when every
   * discovered test produced a result. See `CAVEAT_INTERPRETATIONS["stale-test-app"]` for what
   * this means to a reader.
   *
   * Present because the symptom is badly disguised and has cost two debugging sessions before
   * this field existed.
   */
  readonly staleTestApp?: { readonly missingTests: readonly string[] };
  /**
   * R35: baseline tests BC refused on PERMISSIONS — a strict subset of `unsupportedTests`. See
   * `CAVEAT_INTERPRETATIONS["tests-permission-refused"]` for what this means to a reader and the
   * fix.
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
   * R69: baseline tests refused because they open a `TestPage`, which the fenced session
   * (`GuiAllowed=No`, `ClientType=ODataV4`) cannot create a test service for. Also a strict subset
   * of `unsupportedTests`. See `CAVEAT_INTERPRETATIONS["tests-testpage-unsupported"]` for what
   * this means to a reader.
   *
   * MEASURED 2026-07-31 on Cronus281 (`fixtures/sandbox-probes`, codeunit 79218), and the
   * measurement corrected the original filing: the platform REFUSES in 87 ms rather than hanging.
   * Sized on a real project: 9 of Continia Document Output's 104 test files declare a `TestPage`.
   *
   * Absent when no test hit the refusal.
   */
  readonly testPageUnsupported?: {
    readonly tests: readonly string[];
    /** The explanation, stated once here rather than repeated per mutant. */
    readonly diagnosis: string;
  };
  /**
   * R59: tests that PASSED on the bc-dev-mcp hub (they are in the green set, or they would not
   * have been covering tests) and then FAILED, unmutated, on the fenced runner that produces
   * every verdict. Present only in a hub coverage mode (`procedure`/`line`); in `fenced`/`none`
   * there is one runner and the field would be meaningless. See
   * `CAVEAT_INTERPRETATIONS["runner-disagreement"]` for what this means to a reader.
   */
  readonly runnerDisagreement?: {
    readonly tests: readonly string[];
    readonly explanation: string;
  };
  /**
   * R47: present when this run was assembled with `--resume`, naming the prior run it drew from and
   * how many verdicts it carried instead of measuring. See `CAVEAT_INTERPRETATIONS.resumed` for
   * what this means to a reader.
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
     * R53: mutants NOT re-run because a prior run's execution of them stranded the tier. See
     * `STRANDED_SKIP_INTERPRETATION` for what a non-zero value means to a reader.
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
   * nowhere at all, so run every green test" (`selection.ts`; summed over every batch). See
   * `CAVEAT_INTERPRETATIONS["untargeted-triggers"]` for what this means to a reader.
   *
   * The only signal distinguishing precise trigger attribution (FALLBACK 1, object-level) from
   * giving up, and it is invisible in the verdicts: on a suite where most tests touch the table,
   * running the right tests and running all of them produce the same kills. Commit `0a463fd`
   * deliberately made this branch rare by feeding member-less coverage observations into
   * `byObject`; a regression that re-emptied `byObject` would silently restore the old behaviour
   * with every aggregate count and every per-mutant verdict unchanged. It reached only a
   * `console.warn` before, which no gate can assert — hence a report field.
   *
   * 0 on a backend declaring `coverage: "none"` (al-runner) — no coverage filtering happens
   * there at all, every mutant runs every green test by construction, and no mutant reaches any
   * fallback. Read it only alongside `backend`.
   */
  readonly untargetedTriggerCount: number;
  /**
   * Set only when the session latched unsafe (spec §8/§12) — see `QUARANTINE_INTERPRETATION` for
   * what its presence means to a reader and how to recover. `reason` is `SessionSafety.reason`
   * verbatim: it names the stranded op (method + mutant id) that tripped the latch.
   *
   * Absent on every ordinary session, including one with plain (non-in-flight-unknown)
   * `deadline-exceeded` errors — those stay `counts.errors`/`counts.deadlineExceeded` only, no
   * quarantine.
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

/**
 * What the PRESENCE of `SessionReport.quarantined` means to a reader, and the operator procedure
 * that clears it (design §8). Keyed on a field that is either there or not, so — unlike the
 * `Record<>`s above — it is a single value rather than a map.
 *
 * Prescriptive, and admissibly so: every step below is a LethAL command acting on LethAL's own
 * lease/quarantine state, which is deterministic and this tool's own domain.
 */
export const QUARANTINE_INTERPRETATION: Interpretation = {
  meaning:
    "The session latched UNSAFE: a test run came back in-flight-unknown (the server may still be " +
    "executing it), so LethAL recorded a durable tier quarantine and STOPPED scheduling further " +
    "mutants. Recovery, in order: restart the NST/container, `lethal force-reset-lease --server " +
    "<url> --instance <name> --config <path>`, a clean-state probe, then `lethal clear-quarantine " +
    "--server <url> --instance <name>` — after which `--resume` keeps every verdict this run had " +
    "already measured.",
  entailedNegative:
    "The mutants after the latch were never scheduled: they are ABSENT from this report, not " +
    "`survived`. The counts below describe a run that stopped early, not a project that was " +
    "measured through.",
  basis: "R53",
};

/**
 * What a non-zero `SessionReport.resumedFrom.skippedStranded` means to a reader (R53), and the
 * flag that changes it. Same shape and same reasoning as `QUARANTINE_INTERPRETATION` above.
 */
export const STRANDED_SKIP_INTERPRETATION: Interpretation = {
  meaning:
    "These mutants were NOT re-run on resume: a prior run's execution of them could not be " +
    "confirmed complete and stranded the tier — which is what a mutant that never terminates does " +
    "every time, and it would block every mutant behind it. Pass `--retry-stranded` to attempt " +
    "them anyway.",
  entailedNegative:
    "They are recorded `error` (score-excluded), never `survived`: the honest statement is `not " +
    "measured`, by either run.",
  basis: "R53",
};

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
   * Structural reason for an "error" verdict — mirrors `SessionOutcome.cause`, and see
   * `ERROR_CAUSE_INTERPRETATIONS` for what each value means to a reader. Present only for the two
   * call sites that actually know it (deadline/unstable); other `error` verdicts (e.g. a bisected
   * compile failure, or a stranded operation) leave this undefined, and NOTHING interprets those —
   * `failureNote` is their only account, and it is free text.
   */
  readonly cause?: MutantErrorCause;
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
   * `observedAny` attestation, OR-ed across the covering tests). See
   * `GUARD_EVIDENCE_INTERPRETATIONS` for what each of its three states means to a reader — the
   * asymmetry between `true` and `false` is the whole value, and it must not be read as "this
   * mutant activated".
   *
   * This exists because `LC Control State.IsActive` is a bare string compare: an unactivated
   * mutant behaves byte-identically to baseline, so "the test ran and passed" proves nothing about
   * whether the mutation was ever in play. R32 had to establish that by hand, one mutant at a
   * time, after R29 had already produced 10 false survivors out of 20.
   *
   * Absent when nothing ran the mutant, and on backends that cannot attest (al-runner has no such
   * mechanism).
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
   * R69 Phase 2 Task 5 — which execution path produced this verdict (see `RunnerKind`, store.ts).
   * Unlike `SessionOutcome.runner`, this is NOT optional: every mutant row states it plainly,
   * defaulting an absent input to `"fenced"` here in `buildReport` so a report consumer never has
   * to repeat that translation. A carried verdict keeps the runner IT was produced under, which may
   * differ from what this run itself measured elsewhere — see `ReportValidity.executionContexts`.
   */
  readonly runner: RunnerKind;
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

/**
 * The three states of `MutantOutcome.guardObserved`, as a closed set.
 *
 * `boolean | undefined` cannot key a `Record<>`, and the absent case carries a THIRD meaning ("not
 * measured") that is not a synonym for `false` — collapsing the two is precisely the confusion the
 * interpretations below exist to prevent. Naming the tri-state is what lets the `Record<>` force an
 * interpretation to exist for each.
 */
export type GuardEvidence = "observed" | "not-observed" | "not-measured";

/**
 * The single translation point from `MutantOutcome.guardObserved` to `GuardEvidence`. Exported so
 * a projection (`explain.ts`) reads the tri-state through the same function rather than
 * re-deriving `undefined` handling of its own, which is where the two states would drift back into
 * one.
 */
export function guardEvidenceOf(guardObserved: boolean | undefined): GuardEvidence {
  if (guardObserved === undefined) return "not-measured";
  return guardObserved ? "observed" : "not-observed";
}

/**
 * What each `GuardEvidence` state MEANS for a reader — promoted from `MutantOutcome.guardObserved`'s
 * own doc comment, which now points here, so there is one copy. Co-located with the field for the
 * same reason `CAVEAT_INTERPRETATIONS` sits next to `Caveat`.
 *
 * Every one of these states what is PROVEN about the target and what is not. None of them says what
 * to do about the target's tests: `not-observed` is a statement that the mutated code did not run,
 * which is a fact this report measured; "so write a test for it" would be a claim about the value of
 * a test LethAL has never seen.
 */
export const GUARD_EVIDENCE_INTERPRETATIONS: Record<GuardEvidence, Interpretation> = {
  observed: {
    meaning:
      "WEAK. Some instrumented selector fired somewhere in the artifact during that run — nothing " +
      "more.",
    entailedNegative:
      "Does NOT say that THIS mutant's guard fired, so a survivor carrying it is still unverified: " +
      "the mutation may never have been in play.",
    basis: "R32",
  },
  "not-observed": {
    meaning:
      "DECISIVE. No guarded site executed at all, so the mutated code was never reached and the " +
      "mutant cannot have been given a chance to fail. It belongs with `no-coverage`.",
    entailedNegative:
      "Reporting such a mutant `survived` overstates the suite — this is not a finding about the " +
      "tests, and treating it as one attributes to the test suite something the execution path did.",
    basis: "R32",
  },
  "not-measured": {
    meaning:
      "No attestation exists: either nothing ran the mutant, or the backend cannot attest " +
      "(al-runner has no such mechanism).",
    entailedNegative:
      'Absent means "not measured", never "not observed" — it is not evidence in either direction.',
    basis: "R32",
  },
};

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

/**
 * `guiAllowed`/`clientType`/`basis` for a runner that was MEASURED in this run — i.e. every
 * verdict `buildReport` is grouping here reflects THIS run actually executing on that path.
 * Carried verdicts (`--resume`) never call this directly for their own `basis` — see the caller,
 * which overrides `basis` for those with one naming the prior run instead.
 */
function measuredExecutionContext(
  runner: RunnerKind,
  caps: BackendCapabilities,
): { guiAllowed: boolean; clientType: string; basis: string } {
  if (runner === "client-services") {
    return {
      guiAllowed: true,
      clientType: "Web",
      basis:
        "measured on the client-services batch-runner path (R69 Phase 2): GuiAllowed=Yes, " +
        "ClientType=Web — under this path an unhandled Confirm RAISES rather than returning its " +
        "default, so a mutant inside a Confirm branch can genuinely reach a different verdict " +
        "here than it would on the fenced path",
    };
  }
  // R60. Split by backend rather than asserted once, because only ONE of the two was measured:
  // R57 measured the fenced `RunMutant` path directly (`GuiAllowed=No`, `ClientType=ODataV4`).
  // al-runner is a headless CLI, which is not the same evidence, and saying "measured" of both
  // would be the kind of static claim R7/R8 exist to stop.
  return caps.authoritative
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
      };
}

/**
 * Groups this run's outcomes into `ReportValidity.executionContexts` — one entry per (runner,
 * carried) combination ACTUALLY present, in first-seen order.
 *
 * `carried` is part of the grouping key, not folded into `runner` alone: a carried verdict was NOT
 * measured by this run even when its runner is "fenced" too (this run may ALSO have measured
 * fenced verdicts directly), so conflating the two would let a resumed report understate itself as
 * a single, uniform measurement rather than the composite it actually is — see
 * `ReportValidity.executionContexts` for the full rationale, and the resume-hole note on
 * `CarriedVerdict.runner` (resume.ts) for why this specifically must not regress.
 *
 * Falls back to one zero-count "fenced" entry when there are no outcomes at all, so the field
 * stays non-empty on a run that quarantined before scoring anything — see
 * `ReportValidity.executionContexts`.
 */
function buildExecutionContexts(
  outcomes: readonly SessionOutcome[],
  caps: BackendCapabilities,
  resumedFrom: { readonly runId: number } | undefined,
): ExecutionContext[] {
  const groups = new Map<string, { runner: RunnerKind; carried: boolean; verdictCount: number }>();
  for (const o of outcomes) {
    const runner: RunnerKind = o.runner ?? "fenced";
    const carried = o.carried === true;
    const key = `${runner}|${carried}`;
    const existing = groups.get(key);
    if (existing === undefined) groups.set(key, { runner, carried, verdictCount: 1 });
    else existing.verdictCount += 1;
  }
  if (groups.size === 0) {
    return [{ runner: "fenced", ...measuredExecutionContext("fenced", caps), verdictCount: 0 }];
  }
  return [...groups.values()].map((g) => {
    const measured = measuredExecutionContext(g.runner, caps);
    if (!g.carried) return { runner: g.runner, ...measured, verdictCount: g.verdictCount };
    // A carried verdict's basis names the run it actually came from, never this run's own
    // measurement claim — see the resume-hole rationale above.
    const basis =
      resumedFrom !== undefined
        ? `carried from run ${resumedFrom.runId} by --resume: not measured in this run — the prior run's own report is the authority on how it was produced`
        : "carried from a prior run by --resume: not measured in this run";
    return {
      runner: g.runner,
      guiAllowed: measured.guiAllowed,
      clientType: measured.clientType,
      basis,
      verdictCount: g.verdictCount,
    };
  });
}

/**
 * Builds the report from the run's event stream (spec 2026-08-05 §A). Exactly two parameters —
 * the closed statics set the run was GIVEN (`FoldStatics`: `caps`, `only`, `testsOnly`,
 * `stopHungSessions`) and the events it EMITTED — never a third. `BuildReportInput`, the ~19-field
 * hand-assembled bag this replaces, is deleted: everything beyond the four statics above is now
 * folded from `events` by `foldEvents` (report-fold.ts), which throws rather than defaulting when a
 * mandatory event is missing. See that file's doc comment for the full rationale.
 */
export function buildReport(statics: FoldStatics, events: readonly RunEvent[]): SessionReport {
  const input = foldEvents(statics, events);
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
      // R69 Phase 2 Task 5: the one place an absent input `runner` is read as "fenced" — see
      // `MutantOutcome.runner`.
      runner: o.runner ?? "fenced",
      // R54, event-stream refactor: a carried outcome has NO `durationMs` (see
      // `SessionOutcome.priorDurationMs`'s doc comment) — its ORIGINAL cost is shown here from
      // `priorDurationMs` instead, deliberately never from `durationMs`, which is what keeps the
      // aggregate cost computation below correct without a filter.
      durationMs: o.carried === true ? (o.priorDurationMs ?? 0) : (o.durationMs ?? 0),
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
  //
  // No `.filter((o) => o.carried !== true)` here any more (event-stream refactor): the fold
  // (report-fold.ts) never populates a carried outcome's `durationMs` at all — only
  // `priorDurationMs`, which this map deliberately does not read — so a carried cost cannot reach
  // this sum even by accident. That is R54 made unrepresentable rather than guarded by a filter
  // someone could forget.
  const durations = input.outcomes
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
  const caveats: Caveat[] = [];
  if (!input.baselineGreen) caveats.push("baseline-red");
  if (input.only !== undefined) caveats.push("narrowed");
  // See CAVEAT_INTERPRETATIONS["tests-narrowed"] for what this caveat means to a reader.
  if (input.testsOnly !== undefined && input.testsOnly.length > 0) caveats.push("tests-narrowed");
  if (input.notInstrumented.files.length > 0) caveats.push("uninstrumentable-files");
  if (input.staleTestApp !== undefined) caveats.push("stale-test-app");
  // See CAVEAT_INTERPRETATIONS["tests-permission-refused"] for what this caveat means to a reader.
  const permissionsRefusedTests = input.permissionsRefusedTests ?? [];
  if (permissionsRefusedTests.length > 0) caveats.push("tests-permission-refused");
  // See CAVEAT_INTERPRETATIONS["tests-testpage-unsupported"] for what this caveat means to a
  // reader.
  const testPageUnsupportedTests = input.testPageUnsupportedTests ?? [];
  if (testPageUnsupportedTests.length > 0) caveats.push("tests-testpage-unsupported");
  // See CAVEAT_INTERPRETATIONS["runner-disagreement"] for what this caveat means to a reader.
  const runnerDisagreementTests = input.runnerDisagreementTests ?? [];
  if (runnerDisagreementTests.length > 0) caveats.push("runner-disagreement");
  // R53, spec §5 — see CAVEAT_INTERPRETATIONS["stop-hung-sessions"] for what this caveat means to
  // a reader. `ObservedAny` lives in a SingleInstance codeunit's memory and dies with the stopped
  // session, which is WHY no attestation survives to check.
  //
  // Only when the flag actually produced one. The flag alone is a setting; a scored timeout is a
  // claim, and it is the claim that needs qualifying.
  if (input.stopHungSessions === true && counts.timeoutKilled > 0) {
    caveats.push("stop-hung-sessions");
  }
  // See CAVEAT_INTERPRETATIONS.resumed for what this caveat means to a reader.
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
  const executionContexts = buildExecutionContexts(
    input.outcomes,
    input.caps,
    input.resumedFrom !== undefined ? { runId: input.resumedFrom.runId } : undefined,
  );

  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    validity: {
      reliability,
      caveats,
      scoreDescribes: `${scored} scored mutant(s) in ${scopeText}${baselineText}`,
      baselineTests: { total: input.baselineTests.length, failing: input.unsupportedTests.length },
      scoredMutants: { scored, recorded: input.outcomes.length },
      executionContexts,
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
    ...(testPageUnsupportedTests.length > 0
      ? {
          testPageUnsupported: {
            tests: [...testPageUnsupportedTests].sort(),
            diagnosis: TESTPAGE_DIAGNOSIS,
          },
        }
      : {}),
    ...(runnerDisagreementTests.length > 0
      ? {
          runnerDisagreement: {
            tests: [...runnerDisagreementTests].sort(),
            explanation:
              "These tests pass on the bc-dev-mcp hub and fail, unmutated, on the fenced runner " +
              "that produces every verdict — measured session types, not a guess: hub is " +
              "GuiAllowed=Yes/ClientType=Web, the fence is GuiAllowed=No/ClientType=ODataV4 " +
              "(R57). Every mutant they cover is recorded `error` (score-excluded), never a kill: " +
              "a kill requires the unmutated fenced confirmation to PASS. One confirmation cannot " +
              "tell a deterministic disagreement from an ordinary flaky test — re-run with " +
              'coverageMode "fenced", where one runner produces both the green set and the ' +
              "verdicts, and the question disappears.",
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

/**
 * Sums `verdictCount` across EVERY `executionContexts` entry sharing `runner`, and composes a
 * basis sentence naming all of them — never just the first.
 *
 * `buildExecutionContexts` legitimately emits more than one entry per runner. The ordinary case
 * needs no client-services involvement at all: a `--resume` run that both carries some prior
 * FENCED verdicts and freshly executes other mutants on that SAME fenced path produces two
 * `runner: "fenced"` entries with DIFFERENT `basis` text — one naming this run's own measurement,
 * one naming the prior run it was carried from. A naive `.find()` reads only the first match and
 * silently drops the other group's count from the printed total; a reader reconciling that number
 * against the mutant table would find it does not add up, which is the exact failure class this
 * project treats as its signature bug — an undercount in a report that exists to say what was
 * measured.
 */
function summarizeRunnerContexts(
  contexts: readonly ExecutionContext[],
  runner: RunnerKind,
):
  | { readonly verdictCount: number; readonly clientType: string; readonly basisText: string }
  | undefined {
  const matches = contexts.filter((c) => c.runner === runner);
  if (matches.length === 0) return undefined;
  const [first] = matches;
  if (first === undefined) return undefined; // unreachable: matches.length > 0 just checked
  const verdictCount = matches.reduce((n, c) => n + c.verdictCount, 0);
  // A single contributing group: its own basis stands alone, same wording as before this fix.
  // More than one: name EACH group's count and basis rather than picking one — every group's
  // `basis` already says plainly whether it was measured this run or carried from an earlier one
  // (see `buildExecutionContexts`), so reusing it here needs no extra flag to disambiguate.
  const basisText =
    matches.length === 1
      ? first.basis
      : matches.map((c) => `${c.verdictCount} verdict(s) ${c.basis}`).join("; ");
  return { verdictCount, clientType: first.clientType, basisText };
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
  // R69: same prominence, opposite instruction. Without this the reader sees only "N of M baseline
  // tests failing" for tests that are correct and will never pass here, and goes looking for a bug
  // in them. The line says what LethAL knows: it is the path, and there is nothing to fix in the
  // test. Deliberately NOT folded into the permissions block above — see `testPageUnsupported`.
  if (r.testPageUnsupported !== undefined) {
    const n = r.testPageUnsupported.tests.length;
    lines.push(
      `TESTPAGE UNSUPPORTED ON THIS PATH: ${n} baseline test(s) were refused for opening a TestPage. ${r.testPageUnsupported.diagnosis}`,
    );
    for (const t of r.testPageUnsupported.tests.slice(0, 10)) lines.push(`  ${t}`);
    if (n > 10) lines.push(`  ... ${n - 10} more`);
  }
  // R59: same prominence again, and for the same reason — the reader's default reading of
  // "unstable" is "my tests are flaky", and here the fix is a config key, not a test.
  if (r.runnerDisagreement !== undefined) {
    const n = r.runnerDisagreement.tests.length;
    lines.push(
      `RUNNER DISAGREEMENT: ${n} test(s) pass on the coverage hub and fail on the fenced runner. ${r.runnerDisagreement.explanation}`,
    );
    for (const t of r.runnerDisagreement.tests.slice(0, 10)) lines.push(`  ${t}`);
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
  // R60, scoped by R69 Phase 2 Task 5 to FENCED verdicts only — printed on EVERY run that measured
  // or carried at least one, including a `full` one, because this limit does not depend on scope,
  // baseline health, or anything else the SCOPE line below is gated on. A reader comparing a
  // LethAL score against what they see in VS Code is comparing two different branches of their
  // own app, and until now nothing said so anywhere.
  //
  // Deliberately NOT "every verdict here" any more: since a client-services (interactive) path now
  // exists, that claim would be false the moment ONE verdict came from it — see the companion
  // block below, which states the opposite fact for that runner.
  // Aggregated across EVERY "fenced" entry, not just the first — see `summarizeRunnerContexts`.
  const fenced = summarizeRunnerContexts(r.validity.executionContexts, "fenced");
  if (fenced !== undefined && fenced.verdictCount > 0) {
    lines.push(
      `NON-GUI EXECUTION: ${fenced.verdictCount} verdict(s) here describe the app's non-interactive branch (GuiAllowed=No, ClientType=${fenced.clientType}) — ${fenced.basisText}. Code reachable only when a user can be prompted never runs on this path, so its mutants cannot be killed here and land as survived or no-coverage — neither of which is a statement about your tests. Confirm() returns its DEFAULT rather than skipping the branch; Page.RunModal ERRORS. Measured on Continia Document Output: 0.3% of mutation sites (62 of 19,850).`,
    );
  }
  // The companion fact, for the opposite path. Without this a reader who knows the fenced caveat
  // above would wrongly extend it to an interactive verdict too — the two paths disagree on
  // exactly the code the fenced caveat says is unreachable. Aggregated the same way as `fenced`.
  const interactive = summarizeRunnerContexts(r.validity.executionContexts, "client-services");
  if (interactive !== undefined && interactive.verdictCount > 0) {
    lines.push(
      `INTERACTIVE EXECUTION (client-services): ${interactive.verdictCount} verdict(s) here come from the GuiAllowed=Yes, ClientType=${interactive.clientType} path (R69 Phase 2) instead — ${interactive.basisText}. This is NOT the fenced branch above: under GuiAllowed=Yes an UNHANDLED Confirm RAISES rather than returning its default, so a mutant inside a Confirm branch can genuinely reach a different verdict here than it would fenced — a disagreement between the two paths on such a mutant is not necessarily a bug in either measurement.`,
    );
  }
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
