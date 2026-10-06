import { IDENTITY_SCHEME, type ReachGrain, coarseIdentityTupleOf } from "@lethal/schemata";
import type { CoverageMode } from "./backend";
import { MARK_REASON_PLACEHOLDER } from "./equivalence-marks";
import { GapGroupingError, type GapRow, type GapTally, tallyGaps } from "./gaps";
import type { Interpretation } from "./interpretation";
import {
  CAVEAT_INTERPRETATIONS,
  COVERAGE_NOT_MEASURED_INTERPRETATION,
  ERROR_CAUSE_INTERPRETATIONS,
  GUARD_EVIDENCE_INTERPRETATIONS,
  MARK_KEYS_STALE_INTERPRETATION,
  QUARANTINE_INTERPRETATION,
  REACH_INTERPRETATIONS,
  REPORT_SCHEMA_VERSION,
  STRANDED_SKIP_INTERPRETATION,
  guardEvidenceOf,
  markIdentityOf,
  markTupleOfRow,
  survivorReachOf,
} from "./report";
import type {
  Caveat,
  GuardEvidence,
  MutantErrorCause,
  MutantOutcome,
  ReportValidity,
  SessionReport,
  SurvivorReach,
} from "./report";
import { ATTRIBUTION_INTERPRETATIONS, twinSiteOf } from "./selection";
import type { CoverageAttribution } from "./selection";
import type { MutantVerdict } from "./store";

/**
 * `lethal explain <report.json>` — a projection of a finished `SessionReport` that says what the
 * data MEANS, next to the machine values the meaning is keyed to.
 *
 * WHY THIS EXISTS, measured: during a real campaign an agent handed a mutation report derived, by
 * hand and at a cost of $18.56, the sentence *"'survived' here means 'some test touched the
 * codeunit', not 'a test executed this line'. Do not read those 87 as weak assertions."* That
 * sentence already existed, in `CoverageSplit.attribution`'s doc comment; the report simply could
 * not emit it. A weaker reader would have written ~87 pointless tests instead of paying to
 * re-derive it. (The run is `docs/campaign/2026-08-03-do/rung1.report.json`: 107 survivors, 88
 * `object` and 19 `exact`.)
 *
 * ── THE ADMISSIBILITY RULE ────────────────────────────────────────────────────────────────────
 *
 * An interpretation may appear in this output ONLY if it is (1) keyed to a machine value the
 * report already carries, (2) co-located in source with that value, and (3) carries a `basis` that
 * resolves (`assertBasisResolves`, interpretation.ts). This module therefore contains NO prose of
 * its own about a report's contents: every `Interpretation` it emits is a reference to a shared
 * constant in `report.ts` or `selection.ts`, and `ADMISSIBLE_INTERPRETATIONS` below is that closed
 * set.
 *
 * FOUR tests enforce that, and it takes all four. Each was added because the previous set was
 * described as covering something it did not — the list below states the scope of each, and the
 * hole it does NOT close, deliberately.
 *
 * READ THE WHOLE LIST BEFORE TRUSTING IT: all four police WHAT MAY APPEAR — which prose, at which
 * path — and none of them polices whether what appears is RIGHT. That gap was measured twice.
 * Swapping `scored` with `recorded` and `noCoverage` with `knownSurvivors` left the entire runner
 * suite green at 1441 pass / 0 fail, reporting a run that scored 160 of 473 as scoring 473 of 160.
 * Then, after that fix, swapping a survivor's `file` with its `codeunitName` was still 1444 pass /
 * 0 fail, because nine of the 25 `[verbatim]` paths had no value assertion at all.
 *
 * So: the `[verbatim]` test is the ONLY thing checking values, and all 25 `[verbatim]`-tagged paths
 * are now asserted in it against their source — the per-row ones as WHOLE-ROW `toEqual`s, which
 * cannot be partially written the way a list of per-field assertions can. Two things make that
 * effective and both are themselves pinned: the fixture's values must be pairwise DISTINCT (a
 * fixture with two zeros in it cannot tell a swap from a correct wiring — that is exactly how the
 * first defect stayed green), and it must describe a state `buildReport` could actually produce.
 *
 *   - An IDENTITY check over every `Interpretation`-shaped object in the output. Stops an inline
 *     interpretation, and only that. SHAPE-SCOPED by construction, so a new `summary: string` on
 *     the output or an `advice: string` on every survivor is invisible to it — measured: three such
 *     fields, carrying "these deserve attention first", shipped green past it (fix round 1).
 *   - A PATH PIN over every leaf in the output (`EXPLAIN_LEAF_PATHS`, explain.test.ts). Any leaf at
 *     an unlisted path fails, whatever its type or wording. A new field carrying advice — prose or
 *     a priority NUMBER, which `SessionReport.survivorsByProcedure`'s own doc comment refuses for
 *     the same reason — dies by construction. Blind to new TEXT at a path that already exists.
 *   - A STRING-PROVENANCE check: every string in the output must come from the report, from a
 *     registry interpretation, or from the projection's own shipped constants (`EXPLAIN_CONTRACT`'s
 *     values, the two interpretation-registry key sets, `TOOL_CONDITIONS`) — DERIVED, so there is no
 *     list to append to. Closes new text at an existing path in general.
 *   - An EQUALITY PIN on `EXPLAIN_CONTRACT.note`, the one string authored here. Appending
 *     target-prescriptive advice to it slipped all three checks above at once and shipped into the
 *     real rung1 artifact (fix round 2); the pin reddens on any edit at all, whatever its wording.
 *
 * The pinned path set is also, exactly, the structure `EXPLAIN_SCHEMA_VERSION` versions: the test
 * that stops smuggled advice is the same test that stops an unversioned schema change.
 *
 * THE BYPASS ALL FOUR USED TO SHARE — CLOSED 2026-08-08 (R115 gaps 1 and 3), and stated here
 * because the shape of what closed it is worth knowing. Both pins were built from OBSERVED data:
 * hand-maintained lists checked against what the fixture and the six committed reports actually
 * produce. A new GLOBAL field therefore shipped green with four small coordinated edits — two here,
 * one in each list — at 45 pass / 0 fail, and a field emitted under a condition NO report reaches
 * (`survivors.length > 200`) was invisible in both directions at 43 pass / 0 fail.
 *
 * Neither is now. `EXPLAIN_LEAF_PATHS` is asserted equal to the leaf set walked out of
 * `ExplainOutput`'s own DECLARATION, so an unreachable field enters the pin and then fails the
 * reachability test for having no producer (both halves red-checked). And the authored-string
 * allowlist is DERIVED from shipped constants rather than listed, so the fourth edit has nowhere to
 * land: the same probe now reddens string provenance, naming the sentence, on the real rung1 report.
 *
 * What that does NOT close, stated rather than glossed: a new field on `EXPLAIN_CONTRACT` would
 * still widen the admitted-string set, since its values are admitted wholesale. The whole-object
 * equality pin on `EXPLAIN_CONTRACT` in the test is what makes adding one loud, and dropping that
 * pin re-opens this. A diff that adds a field to `ExplainOutput` or to the contract is still a
 * review event.
 *
 * What NONE of them can do is judge whether an ADMISSIBLE string's prose respects the target/tool
 * line below. Advice added to a shared registry constant ships green — see the note on
 * `CAVEAT_INTERPRETATIONS` (report.ts). Co-location buys keying, not editorial discipline; that
 * half is a human judgement at review time, and saying so is better than implying a mechanism
 * covers it. The same is true one layer out, at the `failureNote` write sites this projection
 * copies through verbatim — see the note at `orchestrator.ts`'s `let failureNote` declaration.
 *
 * If a useful thing to say has no field to hang on, the fix is to add the FIELD to the report
 * first, as its own change with its own justification — never to let this projection assert
 * something free-floating.
 *
 * ── THE LINE: TARGET SEMANTICS vs TOOL MECHANICS ──────────────────────────────────────────────
 *
 * About the TARGET's code, this says what is PROVEN, what is NOT, and what the data cannot
 * support — never what test to write. Both halves of that are measured. The weak reader's failure
 * (~87 pointless tests) is prevented by a meaning statement carrying its entailed negative. But the
 * strong reader's WIN was reframing the task entirely, and a projection saying "strengthen these
 * 19" would have anchored against it: the campaign's own pre-commitment framed "kill survivors",
 * and the agent did better by ignoring that frame.
 *
 * About the TOOL, it is fully prescriptive, because those steps are deterministic and LethAL's own
 * domain: `ERROR_CAUSE_INTERPRETATIONS["deadline-exceeded"]` names `--mutant-timeout-ms` (R91),
 * `QUARANTINE_INTERPRETATION` names the whole design-§8 recovery (R53).
 *
 * The line is target-semantics vs tool-mechanics, and it is NOT "no operator-specific advice". An
 * equivalence guess ("a surviving `remove-setrange` is often equivalent") is a claim about the
 * customer's code that no LethAL machinery measures — there is no field to key it on, so rule (1)
 * excludes it without anyone needing taste. That matters concretely: the campaign's own
 * pre-commitment carried exactly that guess and rung 3 DISPROVED it, killing those mutants
 * legitimately with decoy rows. R91's slow-not-hung finding, by contrast, is a claim about LethAL's
 * own timeout machinery, keyed on a `cause` the report carries, with a basis. Future proposals get
 * decided by the mechanism, not by whoever remembers that.
 *
 * ── THE SPLIT CONTRACT ────────────────────────────────────────────────────────────────────────
 *
 * STRUCTURE (field names, nesting, value domains) is versioned and stable under
 * `EXPLAIN_SCHEMA_VERSION`; the header also records the `REPORT_SCHEMA_VERSION` it was derived
 * from — the same two-version pattern the event stream uses. PROSE is explicitly non-contractual
 * and may improve without a version bump. The keying rule is what makes that safe rather than
 * aspirational: every machine-usable atom appears as a structured field BY CONSTRUCTION, so no
 * consumer has a reason to regex prose. `EXPLAIN_CONTRACT` states all of this inside the output.
 */

/**
 * Bumped whenever a field of `ExplainOutput` is renamed, removed, or changes meaning, or a value
 * domain CHANGES — in either direction. Additive FIELDS do not require a bump. Prose changes NEVER
 * do — see `EXPLAIN_CONTRACT`.
 *
 * "In either direction" was ambiguous until R114 had to decide it, so it is written down rather
 * than re-argued. The old wording said "or a value domain shrinks", which reads as though GROWING
 * one is additive and free. It is not, and the reason is the same one this file already gives for
 * validating a copied enum: `EXPLAIN_CONTRACT` publishes value domains as stable, so a consumer
 * branches on `cause` exactly as this projection branches on `verdict`, and a value it has never
 * seen lands in whatever its else-branch says — invisibly, and with no version to have caught it.
 * A new field cannot do that, because a consumer that does not read a field is unaffected by it.
 *
 * 2 — R114 added `stranded` to `MutantErrorCause`, so `$.notMeasured[].cause` has a third value.
 * `REPORT_SCHEMA_VERSION` deliberately did NOT move for the same change: on that side
 * `assertExplainableReport` already refuses an unrecognised `cause` by name, loudly, so the hole
 * this version exists to close is closed there by a check instead — and bumping it would make every
 * committed campaign baseline unreadable to this build, which is a real cost for no gain.
 *
 * 3 — R122 added `result-lost` for the case where the run provably COMPLETED and only its answer
 * was unreadable. Same reasoning as 2 on both counts, including `REPORT_SCHEMA_VERSION` again not
 * moving. Two bumps in one day is what a domain that is still being discovered looks like; the
 * alternative was leaving two more `error` shapes with no machine value at all, which is what R114
 * was filed about in the first place.
 *
 * 5: GH-24 added `reached-unnoticed` to `$.survivors[].reach`, and `covered-but-unreached` and
 * `unreached-and-uncovered` changed meaning: the mutant's own `guardReached` now decides them,
 * and a row carrying `reachGrain` without it reads `not-decided` instead of falling back to the
 * batch-wide guard signal. The new `reachGrain` and `reachedBy` leaves are additive. R233 records
 * that v4 drifted: five commits grew its `caveat` and `cause` domains without this bump, v4 is
 * left as it was published, and `schemas.test.ts` now pins every value domain so the next one
 * cannot ship silently.
 * C02-09 added `gaps`, `noCoverageBlocks` and `survivors[].gapId`, fields only;
 * `gaps[].artifactIdAbsent` reuses the survivor's domain; no bump.
 *
 * 6: R-236c added the caveat value `tests-testpage-refused`.
 *
 * 7: R265 added the REQUIRED `survivors[].markKey` and `markIdentityScheme`, and the optional
 * `markKeysStale`. A new required field is a new shape, so it bumps even though it is additive.
 * R351 added the optional `coverageArmNames` to survivors, gaps and no-coverage blocks: an optional
 * additive field, so no bump.
 *
 * 8: R252 added the value `not-measured` to `$.survivors[].attribution`, for a survivor of a report
 * whose `coverageMode` is `"none"`. A new value, so it bumps (R233); v7 is frozen.
 *
 * 9: R214 added the caveat value `preproc-files-refused`. A new value, so it bumps (R233).
 *
 * 10: R403 added the caveat values `tests-compiled-out` and `test-symbols-unverified`. New values,
 * so it bumps (R233).
 *
 * 11: R307 added the caveat value `files-refused` (a file refused whole at instrumentation). A new
 * value, so it bumps (R233); v10 is frozen. R307 added no explain field.
 * R447 withholds the already optional `gaps[].unobservedBlock` also per file, where a
 * `hang-refused` row has sites: no new field or value, so no bump.
 *
 * 12: R443 added `survivors[].mark`, the whole mark a reader pastes into `lethal.equivalent.json`.
 * Additive, but `survivors[].markKey` CHANGED MEANING: a mark holding the key alone is now refused
 * (`no-proof`), so the key is no longer a usable mark by itself. A changed meaning bumps.
 *
 * 13: R-204b added the cause value `stop-outcome-unconfirmed` to `$.notMeasured[].cause`. A new
 * value, so it bumps (R233); v12 is frozen. R275 added the optional `gaps[].verifyCommand`: an
 * optional additive field, so no bump. R276 changed how a NEW artifact's gap ids are computed (line
 * span and LF text, not offsets and raw text): the field is an opaque id, read verbatim, so no bump.
 */
export const EXPLAIN_SCHEMA_VERSION = 13;

/**
 * Thrown when the input is not an explainable `SessionReport` — a caller-contract violation, not a
 * normal refusal. Extends `Error` DIRECTLY, never another typed error class (CLAUDE.md's
 * typed-error-classes convention); in particular it is unrelated to `BasisResolutionError`, which
 * is about this repo's own shipped constants rather than about a consumer's input.
 */
export class MalformedReportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MalformedReportError";
  }
}

/**
 * Every `Interpretation` this projection is allowed to emit — the closed set rule (1) of the
 * admissibility rule above resolves to. Membership is by object IDENTITY, not by text: a copy of a
 * registry member's prose is NOT a member, which is what makes "emit the shared constant, never
 * restate it" checkable rather than a convention.
 *
 * Also the list `interpretation.test.ts` resolves every `basis` against the real `ROADMAP.md`.
 */
export const ADMISSIBLE_INTERPRETATIONS: readonly Interpretation[] = [
  ...Object.values(ATTRIBUTION_INTERPRETATIONS),
  ...Object.values(CAVEAT_INTERPRETATIONS),
  ...Object.values(GUARD_EVIDENCE_INTERPRETATIONS),
  ...Object.values(REACH_INTERPRETATIONS),
  ...Object.values(ERROR_CAUSE_INTERPRETATIONS),
  COVERAGE_NOT_MEASURED_INTERPRETATION,
  QUARANTINE_INTERPRETATION,
  STRANDED_SKIP_INTERPRETATION,
  MARK_KEYS_STALE_INTERPRETATION,
];

/**
 * R252: a survivor's `attribution` in the output. The report's `CoverageAttribution`, plus
 * `not-measured` for a survivor of a report whose `coverageMode` is `"none"`, where no attribution
 * exists because no coverage was collected.
 */
export type ExplainAttribution = CoverageAttribution | "not-measured";

/** What each `ExplainAttribution` means. The report's own registry, plus R252's constant. Exported
 *  so `schemas.test.ts` can pin the published enum to this domain. */
export const EXPLAIN_ATTRIBUTION_INTERPRETATIONS: Record<ExplainAttribution, Interpretation> = {
  ...ATTRIBUTION_INTERPRETATIONS,
  "not-measured": COVERAGE_NOT_MEASURED_INTERPRETATION,
};

/** The split contract, stated in the output itself — see this module's doc comment. */
export interface ExplainContract {
  /** The field whose value versions this output's STRUCTURE. */
  readonly structureStableUnder: "explainSchemaVersion";
  /** Always `false`. A consumer branches on this rather than reading `note`. */
  readonly proseIsContractual: boolean;
  /** The statement itself. Non-contractual, like every other prose string here. */
  readonly note: string;
}

/** One caveat, with the shared constant that says what it means. */
export interface ExplainCaveat {
  readonly caveat: Caveat;
  readonly interpretation: Interpretation;
}

/**
 * The score, with the qualifications that decide whether it may be quoted at all.
 *
 * `excludedFromScore` is DERIVED, not restated: `mutationScore`'s denominator is
 * killed + timeoutKilled + survived, so these three counts are outcomes the number does not
 * describe. A reader who adds them to the survivors would be double-counting; one who ignores them
 * would think the run measured more than it did.
 */
export interface ExplainScore {
  readonly mutationScore: number | null;
  readonly reliability: ReportValidity["reliability"];
  /** Verbatim from `ReportValidity.scoreDescribes` — the report's own sentence, not a new one. */
  readonly scoreDescribes: string;
  readonly scored: number;
  readonly recorded: number;
  readonly excludedFromScore: {
    readonly errors: number;
    readonly noCoverage: number;
    readonly knownSurvivors: number;
  };
}

/**
 * One survivor: the machine fields a consumer acts on, each beside the shared constant that says
 * what it is worth.
 *
 * `executionProven` is the atom the $18.56 sentence had to be derived to obtain. It is `true` only
 * for `exact` attribution — a MEMBER-level coverage match, i.e. a test measured to have executed
 * this procedure. `object` and `all-green` mean some test touched the object, or nothing placed the
 * mutant at all; neither proves the mutated code ran.
 */
export interface ExplainSurvivor {
  readonly mutantCode: string;
  readonly file: string;
  readonly line: number;
  readonly codeunitName: string;
  readonly procedureName: string;
  readonly operatorName: string;
  /** Verbatim from the report. `mutatedText` is `""` for a deletion operator. */
  readonly originalText: string;
  readonly mutatedText: string;
  /**
   * The report's `coverageAttribution`, under the name its own source uses
   * (`CoverageSplit.attribution`, selection.ts). Same value, two spellings — see that field's
   * doc comment in report.ts for why they are not aligned.
   */
  readonly attribution: ExplainAttribution;
  readonly executionProven: boolean;
  readonly coveringTests: readonly string[];
  readonly guardEvidence: GuardEvidence;
  /**
   * R116: what `attribution` and `guardEvidence` say TOGETHER about whether the mutated statement
   * was reached — the one claim neither can carry alone, and the reason this field exists rather
   * than a note. `covered-but-unreached` is the actionable case the two signals were previously
   * read as contradicting: a test enters the procedure and never reaches this statement.
   *
   * GH-24: the report's per-mutant `guardReached` decides first where present; see
   * `survivorReachOf` for the whole order.
   */
  readonly reach: SurvivorReach;
  /** GH-24: verbatim from the report row. Absent for a report written before GH-24. */
  readonly reachGrain?: ReachGrain;
  /** GH-24: verbatim from the report row, the tests whose run reached this mutant's own
   *  statement. Present exactly when the row has `guardReached`, so `[]` means none reached. */
  readonly reachedBy?: readonly string[];
  /** `EXPLAIN_ATTRIBUTION_INTERPRETATIONS[attribution]`, by reference. */
  readonly interpretation: Interpretation;
  /** `GUARD_EVIDENCE_INTERPRETATIONS[guardEvidence]`, by reference. */
  readonly guardInterpretation: Interpretation;
  /** `REACH_INTERPRETATIONS[reach]`, by reference. */
  readonly reachInterpretation: Interpretation;
  /**
   * C02-01: the batch of THIS run the row was recorded in; for a carried row it is this run's
   * batch, not the prior run's. Mutant ids restart per batch, so `(batchIndex, mutantCode)` names
   * a row and `mutantCode` alone does not. Always written by this build; optional in the schema
   * so an older explain output still validates.
   */
  readonly batchIndex?: number;
  /** C02-01: present on a trigger mutant, whose `procedureName` is `""`. */
  readonly triggerName?: string;
  /** R351: verbatim from the report row, the arm names of a renamed split member (R318), whose
   *  `procedureName` is `""`. Absent on every other member. */
  readonly coverageArmNames?: readonly string[];
  /** C02-01: verbatim from the report row; see `MutantOutcome.procedureStartLine`. */
  readonly procedureStartLine?: number;
  /** C02-01: verbatim from the report row; see `MutantOutcome.procedureEndLine`. */
  readonly procedureEndLine?: number;
  /** C02-01: the report's `equivalenceRisk`, an open string as the report types it (ruling c).
   *  Absent: not recorded, never "not equivalent". */
  readonly equivalenceRisk?: string;
  /** C02-01: the report's `readerMark`, copied field by field, never spread. */
  readonly readerMark?: { readonly key: string; readonly reason: string };
  /**
   * C02-01: verbatim from the `SessionReport.artifacts[]` entry whose `batchIndex` equals this
   * row's. It is the artifact THIS run recorded for the row's batch, and nothing more: it is NOT
   * proof that the verdict came from that binary (a pool worker ran its own copy, and a later
   * batch replaces an earlier one on the server). Absent exactly when `artifactIdAbsent` is present;
   * this build writes one of the two on every row. Optional so an older explain output validates.
   */
  readonly artifactId?: string;
  /** C02-01: why `artifactId` is absent. See `ARTIFACT_ID_ABSENCES`. */
  readonly artifactIdAbsent?: ArtifactIdAbsence;
  /** C02-09: verbatim from the report row, the gap this survivor belongs to. Absent on a row from
   *  a report written before C02-09. */
  readonly gapId?: string;
  /**
   * R265: the key a `lethal.equivalent.json` mark on this survivor needs, made by report.ts's
   * `markIdentityOf`, the one definition the mark join matches against. Valid under
   * `ExplainOutput.markIdentityScheme`, not necessarily under this build's (see `markKeysStale`).
   */
  readonly markKey: string;
  /**
   * R443: the mark to paste into `lethal.equivalent.json`'s `marks` array, with its proof. Absent
   * when the report records no numbering facts (a report from before R443): a mark without proof
   * is refused, so none is offered.
   */
  readonly mark?: ExplainMark;
}

/**
 * R443: one ready-to-paste equivalence mark. Every field is what `parseEquivalenceMarks` reads.
 * `reason` is a placeholder the parser refuses until the reader replaces it.
 */
export interface ExplainMark {
  /** `markKey`, restated so the object pastes alone. */
  readonly key: string;
  readonly reason: string;
  /** The survivor's file, `/` separators. */
  readonly file: string;
  /** The report's `numberingDigest`. */
  readonly numberingDigest: string;
  /**
   * True only when the survivor's (file, tuple) is not one of the report's RECORDED `twinSites`,
   * its coarse tuple is not in `carryHidden.tuples` and its file is not in `carryHidden.files`.
   * Never counted from the report's rows: a twin a line filter dropped has no row.
   */
  readonly fileSingleton: boolean;
  /** The report's `buildSymbols`, when non-empty: a mark applies only to a build with that set. */
  readonly preprocessorSymbols?: readonly string[];
}

/**
 * R265: present exactly when the report's identity scheme is not this build's `IDENTITY_SCHEME`.
 * A mark written from these keys would be stale on the next run under this build (R325).
 */
export interface ExplainMarkKeysStale {
  /** `markIdentityScheme`, restated so the block reads alone. */
  readonly reportScheme: number;
  /** This build's `IDENTITY_SCHEME`, the scheme the next run keys under. */
  readonly buildScheme: number;
  /** `MARK_KEYS_STALE_INTERPRETATION`, by reference. */
  readonly interpretation: Interpretation;
}

/**
 * C02-09: the survivors of one gap block (the innermost branch body holding them), with the counts
 * of every RECORDED row of that block. One entry per gap id with at least one `survived` row.
 */
export interface ExplainGap {
  readonly gapId: string;
  readonly batchIndex: number;
  readonly file: string;
  readonly blockStartLine: number;
  readonly blockEndLine: number;
  readonly codeunitName: string;
  readonly procedureName: string;
  readonly triggerName?: string;
  /** R351: verbatim from the report row, the arm names of a renamed split member (R318), whose
   *  `procedureName` is `""`. Absent on every other member. */
  readonly coverageArmNames?: readonly string[];
  /** mutantCodes of the gap's `survived` rows, ordered by line then mutantCode. */
  readonly members: readonly string[];
  readonly survived: number;
  readonly killed: number;
  readonly noCoverage: number;
  readonly other: number;
  /** Every RECORDED row of the block survived. Absent on an operator- or line-narrowed run, on a
   *  quarantined run, and in a file with a `hang-refused` row with sites (R447). */
  readonly unobservedBlock?: boolean;
  /** The artifact to pass to `lethal verify --artifact` for this gap. Exactly one of this and
   *  `artifactIdAbsent` is present. */
  readonly artifactId?: string;
  /** Why there is no artifact to verify this gap against. Same values as on a survivor. */
  readonly artifactIdAbsent?: ArtifactIdAbsence;
  /** R275: the `lethal verify` line for this gap (`gapVerifyCommand`), with `<project>` and
   *  `<tests-dir>` left to fill in. Present exactly when `artifactId` is. */
  readonly verifyCommand?: string;
}

/** C02-09: a block with at least one `no-coverage` row. A location list, not a verify input, so it
 *  carries no gap id and no counts. */
export interface ExplainNoCoverageBlock {
  readonly batchIndex: number;
  readonly file: string;
  readonly blockStartLine: number;
  readonly blockEndLine: number;
  readonly codeunitName: string;
  readonly procedureName: string;
  readonly triggerName?: string;
  /** R351: verbatim from the report row, the arm names of a renamed split member (R318), whose
   *  `procedureName` is `""`. Absent on every other member. */
  readonly coverageArmNames?: readonly string[];
  /** mutantCodes of the block's `no-coverage` rows, ordered by line then mutantCode. */
  readonly members: readonly string[];
}

/** Why a survivor has no `artifactId`. Tokens; consumers branch on the exact value.
 *  - `carried`: the verdict was carried by `--resume` from a prior run and measured against
 *    THAT run's artifact, which this report does not name. Wins even when this run recorded an
 *    artifact for the same batch index.
 *  - `not-recorded`: the report has no `artifacts` field at all: written before C02-02.
 *  - `not-published`: the report has `artifacts`, but no entry for this batch: the backend
 *    returned no artifact for it (al-runner, or a `deploy()` that returned `null`). Other
 *    batches of the same run may still have one. */
export const ARTIFACT_ID_ABSENCES = ["carried", "not-recorded", "not-published"] as const;
export type ArtifactIdAbsence = (typeof ARTIFACT_ID_ABSENCES)[number];

/**
 * One `error`-verdict mutant: recorded, score-excluded, and NOT a verdict about the mutant.
 *
 * `interpretation` is present only when the report recorded a structural `cause`. LethAL sets that
 * at the two call sites that actually know it; a stranded operation or a bisected compile failure
 * arrives with `cause` absent, and this projection then says nothing rather than inventing a
 * meaning nothing keys. The absence is itself readable: `failureNote` is that row's only account,
 * and it is free text.
 *
 * `no-coverage` and `known-survivor` outcomes are deliberately NOT listed here — they are counted
 * in `score.excludedFromScore` instead. Listing them adds no interpretation (nothing keys them
 * beyond the verdict word itself) while, on a real report, burying the rows that do: rung2 has 313
 * of them against 125 survivors.
 */
export interface ExplainNotMeasured {
  readonly mutantCode: string;
  readonly file: string;
  readonly line: number;
  readonly operatorName: string;
  readonly cause?: MutantErrorCause;
  /** Verbatim from the report. Free text, and the only account of a cause-less error. */
  readonly failureNote?: string;
  /** `ERROR_CAUSE_INTERPRETATIONS[cause]`, by reference. Absent exactly when `cause` is. */
  readonly interpretation?: Interpretation;
}

/**
 * A session-level condition about LethAL's OWN state — the half of the line this projection is
 * fully prescriptive about. Each is keyed 1:1 to a report field: `quarantined` to
 * `SessionReport.quarantined`'s presence, `stranded-skips` to a non-zero
 * `SessionReport.resumedFrom.skippedStranded`.
 *
 * The TOKENS are the source and the type is derived from them, not the other way round, so the two
 * cannot drift apart. R115 gap (3): `explain.test.ts` builds its allowed-authored-string set from
 * runtime constants rather than from a hand-maintained list, and these two literals are the only
 * strings in the output with no registry or report behind them. A hand list would have been one
 * more place a new authored string could be quietly added.
 */
export const TOOL_CONDITIONS = ["quarantined", "stranded-skips"] as const;
export type ToolCondition = (typeof TOOL_CONDITIONS)[number];

export interface ExplainToolCondition {
  readonly condition: ToolCondition;
  /** How many mutants the condition accounts for. 0 for `quarantined`, which is not a tally: the
   *  mutants it cost were never scheduled, so the report cannot count them. */
  readonly count: number;
  /** Verbatim from the report (`quarantined.reason`). Absent when the field carries no text. */
  readonly detail?: string;
  readonly interpretation: Interpretation;
}

/**
 * How the `survivors` array was ORDERED, and therefore which ones a cap kept.
 *
 * A token rather than prose, so a consumer branches on an exact value (the same reason
 * `TOOL_CONDITIONS` are tokens). Two values, and the distinction is the whole point:
 *
 * - `report-order` — every survivor is present, in the order the report recorded them. Nothing was
 *   selected, so nothing needed ranking. This is what an uncapped `explain` emits.
 * - `actionability` — the list was RANKED and may be a prefix of it. See `survivorActionabilityRank`
 *   for the order, which is total and deterministic: the same report and the same cap produce the
 *   same rows in the same sequence, on any machine.
 */
export const SURVIVOR_RANKINGS = ["report-order", "actionability"] as const;
export type SurvivorRanking = (typeof SURVIVOR_RANKINGS)[number];

/**
 * What the `survivors` array is a view OF — always emitted, whether or not a cap was applied.
 *
 * R150. Measured on `docs/campaign/2026-08-03-do/rung2.report.json` (473 mutants, 125 survivors):
 * the projection is 243 KB, 206 KB of it survivors, and `--top 15` makes it 30 KB. An agent
 * consuming the uncapped file has a context window and that file does not fit in a small one.
 * `--top` bounds it. The danger a cap introduces is the one
 * this repository is most careful about: a truncated list that reads exactly like a complete one,
 * so an agent reports "20 survivors" when there were 125. That is why the count block is present
 * even when nothing was omitted, rather than appearing only on truncation — a consumer reads
 * `total` unconditionally and never has to infer completeness from the absence of a field.
 *
 * `total` is the number of survivors the REPORT holds. `shown` is `survivors.length`. Both are
 * emitted rather than one plus a flag, because a consumer that wants "how many did I not see"
 * should not have to subtract, and `omitted` is stated for the same reason.
 */
export interface ExplainSurvivorSelection {
  /** Survivors in the report, before any cap. */
  readonly total: number;
  /** Survivors in `survivors` — i.e. `survivors.length`, restated so the block reads alone. */
  readonly shown: number;
  /** `total - shown`. Zero when nothing was capped. */
  readonly omitted: number;
  readonly rankedBy: SurvivorRanking;
}

export interface ExplainOutput {
  readonly explainSchemaVersion: number;
  /** The `REPORT_SCHEMA_VERSION` the input declared: 2 or this build's 3, the only versions
   *  `assertExplainableReport` accepts (R231). Recorded so the output is self-describing
   *  once it has been written to a file and outlived the binary that made it. */
  readonly derivedFromReportSchemaVersion: number;
  readonly contract: ExplainContract;
  readonly score: ExplainScore;
  readonly caveats: readonly ExplainCaveat[];
  /** What `survivors` is a view of. Read this BEFORE treating the array as the whole set. */
  readonly survivorSelection: ExplainSurvivorSelection;
  readonly survivors: readonly ExplainSurvivor[];
  readonly notMeasured: readonly ExplainNotMeasured[];
  readonly toolConditions: readonly ExplainToolCondition[];
  /** C02-09: present exactly when the report's rows carry gap ids, `[]` when none survived.
   *  Absent, never `[]`, on an older report. Never capped by `--top`. */
  readonly gaps?: readonly ExplainGap[];
  /** C02-09: present exactly when `gaps` is. */
  readonly noCoverageBlocks?: readonly ExplainNoCoverageBlock[];
  /**
   * R265: the `identityScheme` a marks file needs for `survivors[].markKey`: the report's own, and
   * 1 when the report has none (R325: an absent scheme reads as 1). Never absent, never guessed.
   */
  readonly markIdentityScheme: number;
  /** R265: present exactly when `markIdentityScheme` is not this build's scheme. */
  readonly markKeysStale?: ExplainMarkKeysStale;
}

/**
 * The contract text, as one constant so redeploys of the same `EXPLAIN_SCHEMA_VERSION` say the
 * identical thing.
 *
 * Fix round 2. EXPORTED, and its exact text pinned by `explain.test.ts`, because `note` is the one
 * SENTENCE in the output authored in this file: not `Interpretation`-shaped (so the identity check
 * cannot see it), sitting at a path the leaf pin already lists (so the pin stays green), and not
 * copied from the report (so the verbatim check does not reach it). Appending target-prescriptive
 * advice to it shipped 43 pass / 0 fail into the real rung1 artifact — Important 1's exact failure
 * mode, relocated onto an existing pinned path.
 *
 * Fix round 3 corrects this comment's own overclaim: `note` is NOT the only string authored here.
 * Three more are — `structureStableUnder`'s `"explainSchemaVersion"` below, and the two
 * `ToolCondition` literals `"quarantined"` / `"stranded-skips"` in `toolConditionsOf`. They need no
 * pin of their own because they are single TOKENS that consumers filter on by exact value, so
 * widening one into a sentence breaks the code that reads it rather than smuggling anything: putting
 * advice inside `"quarantined"` (through an `as ToolCondition` cast, since the type refuses it
 * outright) fails FIVE tests — string-provenance, the verbatim check, and three that select the
 * condition by name. Measured, not assumed. `note` is the only one of the four with room to hide a
 * claim, which is why it alone is pinned.
 *
 * The closure is by EQUALITY against a literal in the test, not by phrasing: any edit at all
 * reddens, whatever it says. That is the right trade HERE and would be the wrong one for a registry
 * interpretation — `c76cc50` deliberately dropped an equality pin on
 * `ATTRIBUTION_INTERPRETATIONS.object.entailedNegative` because a legitimate reword would have
 * turned a behavioural detector red for the wrong reason. The difference is what the string is
 * ABOUT: a registry `meaning` describes report data and is expected to improve, and this project
 * says so by declaring prose non-contractual; `note` describes THIS ARTIFACT'S OWN CONTRACT, so a
 * change to it is a change to what the output promises — precisely the moment
 * `EXPLAIN_SCHEMA_VERSION` deserves a look.
 */
export const EXPLAIN_CONTRACT: ExplainContract = {
  structureStableUnder: "explainSchemaVersion",
  proseIsContractual: false,
  note:
    "STRUCTURE is contractual: field names, nesting and value domains are stable under " +
    "`explainSchemaVersion`, which bumps when one is renamed, removed, or changes meaning. " +
    "`derivedFromReportSchemaVersion` records the report schema this was projected from, so a " +
    "stored output stays self-describing. PROSE is NOT contractual — do not parse `meaning`, " +
    "`entailedNegative`, `note`, `scoreDescribes`, `detail`, `readerMark.reason` or " +
    "`failureNote`; they may be reworded " +
    "at any time without a version bump. That is safe rather than merely asked-for, because every " +
    "machine-usable atom already appears as a structured field beside the prose that explains it " +
    "(`attribution`/`executionProven`/`guardEvidence`/`cause`/`caveat`/`condition`), so there is " +
    "nothing a consumer would need to recover from a sentence. `basis` points at the evidence for " +
    "a claim (a ROADMAP id, or a file) and IS stable enough to key on.",
};

/**
 * The closed sets a report's values must belong to for this projection to key on them.
 *
 * Each is DERIVED from a type-checked object rather than hand-listed, so a new variant of the
 * underlying union cannot slip past: the three interpretation registries are `Record<Union, …>`
 * (adding a variant fails to compile until an interpretation exists), and `KNOWN_VERDICTS` gets the
 * same guarantee from `satisfies Record<MutantVerdict, 0>` — which is also why the literal is
 * spelled out rather than being a bare array. `MutantVerdict` has no interpretation registry
 * (nothing keys a verdict beyond the word itself), so this is where its exhaustiveness lives.
 */
const KNOWN_CAVEATS: ReadonlySet<string> = new Set(Object.keys(CAVEAT_INTERPRETATIONS));
const KNOWN_ATTRIBUTIONS: ReadonlySet<string> = new Set(Object.keys(ATTRIBUTION_INTERPRETATIONS));
/** R252. A `Record` so adding a `CoverageMode` variant fails to compile until it is listed here. */
const COVERAGE_MODES: Record<CoverageMode, true> = {
  none: true,
  procedure: true,
  line: true,
  fenced: true,
  "al-runner": true,
};
const KNOWN_COVERAGE_MODES: ReadonlySet<string> = new Set(Object.keys(COVERAGE_MODES));
const KNOWN_ERROR_CAUSES: ReadonlySet<string> = new Set(Object.keys(ERROR_CAUSE_INTERPRETATIONS));
/** GH-24. A `Record` so adding a `ReachGrain` variant fails to compile until it is listed here.
 *  Exported so `schemas.test.ts` can pin the published schema's `reachGrain` enum to this, the
 *  same runtime domain every other published enum is checked against. */
export const REACH_GRAINS: Record<ReachGrain, true> = {
  statement: true,
  enclosing: true,
  unplaced: true,
};
const KNOWN_REACH_GRAINS: ReadonlySet<string> = new Set(Object.keys(REACH_GRAINS));
const KNOWN_VERDICTS: ReadonlySet<string> = new Set(
  Object.keys({
    killed: 0,
    survived: 0,
    "no-coverage": 0,
    "timeout-killed": 0,
    "known-survivor": 0,
    error: 0,
  } satisfies Record<MutantVerdict, 0>),
);
const KNOWN_RELIABILITIES: ReadonlySet<string> = new Set(
  Object.keys({
    full: 0,
    narrowed: 0,
    degraded: 0,
    "narrowed-degraded": 0,
  } satisfies Record<ReportValidity["reliability"], 0>),
);

function refuse(what: string, got: unknown, closedSet?: ReadonlySet<string>): never {
  const set =
    closedSet === undefined ? "" : ` Expected one of: ${[...closedSet].sort().join(", ")}.`;
  const why =
    "This report cannot be explained as it stands. It is refused rather than projected with the " +
    "unrecognised value dropped: a caveat this build cannot interpret is exactly the case where a " +
    "consumer must NOT be told there is nothing to qualify.";
  throw new MalformedReportError(
    `lethal explain: ${what} — got ${JSON.stringify(got)}.${set} ${why}`,
  );
}

/** The report versions `assertExplainableReport` accepts. See the R231 note at its check. */
const EXPLAINABLE_REPORT_VERSIONS: readonly number[] = [2, REPORT_SCHEMA_VERSION];

/**
 * Turns an untrusted value — the parse of a report file — into a `SessionReport`, or throws.
 *
 * R113: two existing sites (`campaign-freeze.ts`, `campaign-anchors-run.ts`) do
 * `JSON.parse(await readFile(...)) as SessionReport`, a blind cast that would carry a corrupted or
 * foreign caveat string straight past the `Caveat` union with no check, compile-time or runtime.
 * That is dormant for those callers; `lethal explain` reads a committed report off disk and is the
 * consumer that meets it first, so this is where it stops.
 *
 * WHAT IS CHECKED, and the rule is exact: every value this projection BRANCHES on, PLUS every
 * closed-set ENUM the contract publishes even when only copied. Not "keys on" loosely — branching
 * is what turns a bad value into a silently different ANSWER, so the first list is decided by
 * reading the projection for `if`/`filter`/`>` rather than by judgement:
 *
 *   - `schemaVersion`                      — the whole projection's meanings are pinned to it
 *   - every `validity.caveats` member      — selects a `CAVEAT_INTERPRETATIONS` entry
 *   - every mutant's `verdict`             — selects `survivors` vs `notMeasured` vs neither
 *   - every mutant's `coverageAttribution` — selects an interpretation AND decides `executionProven`
 *   - a `survived` mutant HAVING one       — without it `executionProven` cannot be computed, and
 *                                            defaulting it either way claims what the data does not
 *   - `coverageMode`                       : R252, the ONE exception to the line above: a survivor may
 *                                            lack an attribution only when this says `"none"`
 *   - every mutant's `guardObserved`       — a tri-state, one of whose states (`not-observed`) moves
 *                                            a mutant out of the survivor reading entirely
 *   - every mutant's `guardReached`, `reachGrain` and `reachedBy` : GH-24, decide `reach`; also
 *                                            refused in a combination the producer cannot write
 *   - every mutant's `cause`               — selects an `ERROR_CAUSE_INTERPRETATIONS` entry
 *   - every mutant's `carried`             : C02-01, decides `artifactIdAbsent` before the lookup;
 *                                            GH-24b, decides `reach` first and refuses reach fields
 *   - `artifacts` (each `batchIndex` once, `artifactId` a string) : C02-01, the per-batch lookup
 *   - a `survived` row's `batchIndex`      : C02-01, a required row field copied to the survivor
 *                                            and the artifact lookup key; a bad one would silently
 *                                            read as `not-published`
 *   - every mutant's `readerMark` (an object with string `key` and `reason`) : C02-01, read field
 *                                            by field; a bad one would throw or project as `{}`
 *   - every mutant's `gapId` (a string), with positive integer `blockStartLine`/`blockEndLine` and
 *     a `batchIndex`, on all rows or none : C02-09, groups rows; a bad one would merge or split a gap
 *   - `quarantined` / `resumedFrom.skippedStranded` — presence and a `> 0` test emit tool conditions
 *
 * `verdict` is the one that shows why the rule has to be mechanical rather than intuitive.
 * Corrupting every `"survived"` to `"Survived"` in a real report produced a projection BYTE-IDENTICAL
 * to the same report with `mutants: []` — 107 survivors gone, `caveats` and `mutationScore`
 * unchanged, nothing said. That is empty-vs-empty in the one command whose job is telling a reader
 * what the data means. The realistic vector is not hand-editing: `REPORT_SCHEMA_VERSION`'s own rule
 * is "additive fields do not require a bump", so a future `MutantVerdict` variant clears the version
 * gate and then simply disappears here.
 *
 * The SECOND clause exists because that justification has a limit. A copied value is trusted on the
 * grounds that a wrong copy is VISIBLY wrong — which holds for an open domain (a number, free text)
 * and fails for a closed-set enum, since `EXPLAIN_CONTRACT.note` publishes value domains as stable
 * and a consumer therefore branches on one exactly as this file branches on `verdict`. That is the
 * `verdict` finding one layer out: not branched on HERE, branched on THERE, mis-branched invisibly.
 * `validity.reliability` is the only copy-through in that class and is validated for it.
 *
 * It is still NOT a full structural validator, and the boundary is that same distinction: a value
 * this projection only COPIES over an OPEN domain (`scoreDescribes`, `failureNote`, `counts`,
 * `file`, `line`) is trusted, because a wrong value there produces a visibly wrong copy rather than
 * a confidently wrong MEANING.
 *
 * Every failure THROWS. The alternative — skipping the unrecognised value — would produce a
 * projection whose empty `caveats` is indistinguishable from a genuinely unqualified run, which is
 * this project's signature bug (empty-vs-empty "matches") in the one place it does most damage.
 */
export function assertExplainableReport(value: unknown): SessionReport {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    refuse("input is not a JSON object", value);
  }
  const record = value as Record<string, unknown>;
  // R231 ruling 1: v3 changed only the run-level mutant lists (bare codes became
  // `<batchIndex>/<mutantCode>`), and explain reads none of them, so a v2 report still projects
  // with the same meanings. A change that makes explain read one of those lists must revisit this.
  if (!EXPLAINABLE_REPORT_VERSIONS.includes(record.schemaVersion as number)) {
    const why =
      "A REPORT_SCHEMA_VERSION bump means a field was renamed, removed, or changed meaning (v1 -> " +
      "v2 renamed `executionContext` and changed its cardinality), so projecting a report of " +
      "another version would attach this build's meanings to another build's fields — the one " +
      "error a projection must not make.";
    throw new MalformedReportError(
      `lethal explain: report schemaVersion is ${JSON.stringify(record.schemaVersion)}, but this build explains ${EXPLAINABLE_REPORT_VERSIONS.join(" and ")}. ${why}`,
    );
  }
  const validity = record.validity;
  if (typeof validity !== "object" || validity === null) {
    refuse("report has no `validity` object", validity);
  }
  // Final review, Minor 8. NOT a value this projection branches on — it is copied straight through
  // — so the branch rule above does not reach it, and that is the rule being too narrow rather than
  // this being an exception. The rule's justification is that a wrong COPY is visibly wrong; that
  // holds for an open domain (a number, free text) and fails for a closed-set ENUM, because
  // `EXPLAIN_CONTRACT.note` publishes value domains as stable, so a consumer branches on
  // `reliability` exactly as this file branches on `verdict` — and an unrecognised value is then
  // mis-branched downstream, invisibly. So: validate every value the projection branches on, PLUS
  // every closed-set enum the contract publishes. `reliability` is the only copy-through in that
  // second class; `mutationScore`, `scoreDescribes`, `counts`, `failureNote` are all open domains.
  const reliability = (validity as Record<string, unknown>).reliability;
  if (typeof reliability !== "string" || !KNOWN_RELIABILITIES.has(reliability)) {
    refuse(
      "`validity.reliability` is a value this build cannot interpret",
      reliability,
      KNOWN_RELIABILITIES,
    );
  }
  const caveats = (validity as Record<string, unknown>).caveats;
  if (!Array.isArray(caveats)) {
    refuse("`validity.caveats` is not an array", caveats);
  }
  for (const c of caveats) {
    if (typeof c !== "string" || !KNOWN_CAVEATS.has(c)) {
      refuse("`validity.caveats` contains a value this build cannot interpret", c, KNOWN_CAVEATS);
    }
  }
  // R265: decides `markIdentityScheme` and whether `markKeysStale` is emitted. A coerced value
  // would hand a reader a scheme their marks file then carries.
  const identityScheme = record.identityScheme;
  if (
    identityScheme !== undefined &&
    !(Number.isInteger(identityScheme) && (identityScheme as number) >= 1)
  ) {
    refuse("`identityScheme` is present but is not a positive integer", identityScheme);
  }
  // R443: decide every survivor's `mark` (its `numberingDigest` and `fileSingleton`). Written
  // together by the producer, so some without the others is a corrupt report.
  const strings = (v: unknown): boolean =>
    Array.isArray(v) && v.every((s) => typeof s === "string");
  const numbering = [record.numberingDigest, record.twinSites, record.carryHidden];
  if (numbering.some((v) => v !== undefined)) {
    if (numbering.some((v) => v === undefined)) {
      refuse(
        "`numberingDigest`, `twinSites` and `carryHidden` are written together, and this report has only some of them",
        Object.fromEntries(
          ["numberingDigest", "twinSites", "carryHidden"].map((k, i) => [k, numbering[i]]),
        ),
      );
    }
    if (
      typeof record.numberingDigest !== "string" ||
      !/^[0-9a-f]{64}$/.test(record.numberingDigest)
    ) {
      refuse("`numberingDigest` is not a sha256 hex digest", record.numberingDigest);
    }
    if (!strings(record.twinSites))
      refuse("`twinSites` is not an array of strings", record.twinSites);
    const hidden = record.carryHidden as Record<string, unknown> | null;
    if (
      typeof hidden !== "object" ||
      hidden === null ||
      !strings(hidden.tuples) ||
      !strings(hidden.files)
    ) {
      refuse("`carryHidden` is not { tuples: string[], files: string[] }", hidden);
    }
  }
  // R443: copied into every mark, and a mark under the wrong set is stale.
  if (record.buildSymbols !== undefined && !strings(record.buildSymbols)) {
    refuse("`buildSymbols` is present but is not an array of strings", record.buildSymbols);
  }
  // R252: branched on below (it decides whether a survivor may lack an attribution), so a value
  // outside the closed set is refused rather than read as "not none".
  const coverageMode = record.coverageMode;
  if (
    coverageMode !== undefined &&
    (typeof coverageMode !== "string" || !KNOWN_COVERAGE_MODES.has(coverageMode))
  ) {
    refuse(
      "`coverageMode` is a value this build cannot interpret",
      coverageMode,
      KNOWN_COVERAGE_MODES,
    );
  }
  const mutants = record.mutants;
  if (!Array.isArray(mutants)) {
    refuse("`mutants` is not an array", mutants);
  }
  for (const m of mutants) {
    if (typeof m !== "object" || m === null) refuse("`mutants` contains a non-object entry", m);
    const mutant = m as Record<string, unknown>;
    const where = `mutant ${JSON.stringify(mutant.mutantCode)}`;
    // Fix round 1, Important 2. Unvalidated, a corrupted or future verdict matches neither
    // `survived` nor `error` and the mutant vanishes from the projection with nothing said — see
    // this function's doc comment for the measured byte-identical collision.
    if (typeof mutant.verdict !== "string" || !KNOWN_VERDICTS.has(mutant.verdict)) {
      refuse(`${where} has a verdict this build cannot interpret`, mutant.verdict, KNOWN_VERDICTS);
    }
    // Fix round 1, Important 3. `guardEvidenceOf` takes `boolean | undefined`, so within the typed
    // world it is total; the hole is untrusted JSON reaching it through the cast. `null` would
    // coerce to `not-observed` — the DECISIVE state, the one that says the mutated code was never
    // reached — and `"false"` to `observed`. A tri-state `report.ts` argues that carefully for must
    // not be settled by JS truthiness over a field nothing checked.
    if (mutant.guardObserved !== undefined && typeof mutant.guardObserved !== "boolean") {
      refuse(
        `${where} has a non-boolean guardObserved, which would decide its guard evidence by coercion`,
        mutant.guardObserved,
      );
    }
    // GH-24: `guardReached` and `reachGrain` decide `reach`; `reachedBy` is copied. A coerced value
    // or a combination the producer cannot write would decide reach from a corrupt row.
    const { guardReached, reachedBy, reachGrain } = mutant;
    if (guardReached !== undefined && typeof guardReached !== "boolean") {
      refuse(
        `${where} has a non-boolean guardReached, which would decide reach by coercion`,
        guardReached,
      );
    }
    if (
      reachedBy !== undefined &&
      (!Array.isArray(reachedBy) || reachedBy.some((t) => typeof t !== "string"))
    ) {
      refuse(`${where} has a reachedBy that is not an array of test names`, reachedBy);
    }
    // R351: copied onto survivors, gaps and no-coverage blocks. Spread unchecked, a string would
    // project as its characters; the writer sets it only as a non-empty list of names.
    const { coverageArmNames } = mutant;
    if (
      coverageArmNames !== undefined &&
      (!Array.isArray(coverageArmNames) ||
        coverageArmNames.length === 0 ||
        coverageArmNames.some((n) => typeof n !== "string"))
    ) {
      refuse(
        `${where} has a coverageArmNames that is not a non-empty array of names`,
        coverageArmNames,
      );
    }
    if (
      reachGrain !== undefined &&
      (typeof reachGrain !== "string" || !KNOWN_REACH_GRAINS.has(reachGrain))
    ) {
      refuse(
        `${where} has a reachGrain this build cannot interpret`,
        reachGrain,
        KNOWN_REACH_GRAINS,
      );
    }
    if ((guardReached === undefined) !== (reachedBy === undefined)) {
      refuse(
        `${where} has one of guardReached and reachedBy without the other; the report writes both or neither`,
        { guardReached, reachedBy },
      );
    }
    if (guardReached !== undefined && reachGrain !== "statement") {
      refuse(
        `${where} has guardReached on a mutant whose reachGrain is not "statement"; only a statement-grain mutant carries a marker`,
        reachGrain,
      );
    }
    if (guardReached === true && mutant.guardObserved === false) {
      refuse(
        `${where} has guardReached true beside guardObserved false; a marker runs only inside a branch whose guard ran`,
        { guardReached, guardObserved: mutant.guardObserved },
      );
    }
    // GH-24b: a marker that fired names at least one covering test. guardReached true with an
    // empty reachedBy is the same corruption as the pairs above, just inside one field instead of
    // across two.
    if (guardReached === true && Array.isArray(reachedBy) && reachedBy.length === 0) {
      refuse(
        `${where} has guardReached true with an empty reachedBy; a marker that fired names at least one covering test`,
        reachedBy,
      );
    }
    // GH-24b: "not reached" beside a test that reached the marker is the same corruption, reversed.
    if (guardReached === false && Array.isArray(reachedBy) && reachedBy.length > 0) {
      refuse(
        `${where} has guardReached false with a non-empty reachedBy; a test that reached the marker contradicts "not reached"`,
        reachedBy,
      );
    }
    // C02-01: `carried` decides `artifactIdAbsent`, and wins over the batch lookup, so a coerced
    // `"true"` or `null` would hand a carried verdict this run's artifact or the reverse.
    if (mutant.carried !== undefined && typeof mutant.carried !== "boolean") {
      refuse(
        `${where} has a non-boolean carried, which would decide its artifactId by coercion`,
        mutant.carried,
      );
    }
    // GH-24b: a carried row's reach was not measured in this run, so the writer never gives it a
    // reach answer; one present came from somewhere else and would be projected as this run's.
    if (mutant.carried === true && (guardReached !== undefined || reachedBy !== undefined)) {
      refuse(
        `${where} is carried and has guardReached or reachedBy; a carried row's reach was not measured in this run`,
        { guardReached, reachedBy },
      );
    }
    // C02-01: `survivorOf` reads `readerMark.key` and `.reason`. `null` would throw a TypeError
    // there, and a string would project as `readerMark: {}`, breaking the schema's required keys.
    const mark = mutant.readerMark;
    if (
      mark !== undefined &&
      (typeof mark !== "object" ||
        mark === null ||
        typeof (mark as Record<string, unknown>).key !== "string" ||
        typeof (mark as Record<string, unknown>).reason !== "string")
    ) {
      refuse(`${where} has a readerMark that is not { key: string, reason: string }`, mark);
    }
    const attribution = mutant.coverageAttribution;
    if (
      attribution !== undefined &&
      (typeof attribution !== "string" || !KNOWN_ATTRIBUTIONS.has(attribution))
    ) {
      refuse(
        `${where} has a coverageAttribution this build cannot interpret`,
        attribution,
        KNOWN_ATTRIBUTIONS,
      );
    }
    // R265: a survivor's `markKey` is serialized from these, so a missing or coerced one would
    // hand a reader a key that matches nothing and reads like any other key.
    if (mutant.verdict === "survived") {
      const ordinal = mutant.identityOrdinal;
      if (
        typeof mutant.astHash !== "string" ||
        mutant.astHash.length === 0 ||
        !Number.isInteger(mutant.operatorMajor) ||
        (ordinal !== undefined && !(Number.isInteger(ordinal) && (ordinal as number) >= 0))
      ) {
        refuse(
          `${where} is \`survived\` with an astHash, operatorMajor or identityOrdinal its mark key cannot be made from`,
          {
            astHash: mutant.astHash,
            operatorMajor: mutant.operatorMajor,
            identityOrdinal: ordinal,
          },
        );
      }
    }
    // R252: a missing attribution is accepted ONLY when the report says on purpose that coverage
    // was off. Never inferred from the missing field itself: under any other mode it is a defect.
    if (mutant.verdict === "survived" && attribution === undefined) {
      if (coverageMode === undefined) {
        refuse(
          `${where} is \`survived\` with no coverageAttribution, and the report predates \`coverageMode\` (R252), so whether coverage was measured at all cannot be decided. Re-run with this LethAL: its report records \`coverageMode\`, which makes a coverage-off report explainable`,
          mutant.coverageAttribution,
          KNOWN_ATTRIBUTIONS,
        );
      }
      if (coverageMode !== "none") {
        refuse(
          `${where} is \`survived\` with no coverageAttribution, so whether any test is measured to have executed it cannot be decided`,
          mutant.coverageAttribution,
          KNOWN_ATTRIBUTIONS,
        );
      }
    }
    const cause = mutant.cause;
    if (cause !== undefined && (typeof cause !== "string" || !KNOWN_ERROR_CAUSES.has(cause))) {
      refuse(`${where} has an error cause this build cannot interpret`, cause, KNOWN_ERROR_CAUSES);
    }
  }
  // C02-01: each survivor's `artifactId` is looked up here by `batchIndex`. Two entries for one
  // batch would make that lookup a guess. The id's 32-hex shape is a copied open value and is not
  // checked.
  const { artifacts } = record;
  if (artifacts !== undefined) {
    if (!Array.isArray(artifacts)) refuse("`artifacts` is present but is not an array", artifacts);
    const seen = new Set<number>();
    for (const a of artifacts) {
      if (typeof a !== "object" || a === null) {
        refuse("`artifacts` contains a non-object entry", a);
      }
      const entry = a as Record<string, unknown>;
      const { batchIndex } = entry;
      if (typeof batchIndex !== "number" || !Number.isInteger(batchIndex) || batchIndex < 0) {
        refuse(
          "`artifacts` has an entry whose batchIndex is not a non-negative integer",
          batchIndex,
        );
      }
      if (typeof entry.artifactId !== "string") {
        refuse("`artifacts` has an entry whose artifactId is not a string", entry.artifactId);
      }
      if (seen.has(batchIndex)) {
        refuse(
          "`artifacts` names the same batchIndex twice, so its artifact is ambiguous",
          batchIndex,
        );
      }
      seen.add(batchIndex);
    }
  }
  // A survivor's `batchIndex` is a REQUIRED report-row field: `survivorOf` copies it, and it is the
  // artifact lookup key. Missing, `"1"` or `1.5` is a malformed report whether or not `artifacts`
  // exists; with artifacts it would also never match an entry and read as `not-published`, a
  // confident wrong answer. Every committed report carries it, so every one still projects.
  for (const m of mutants) {
    const mutant = m as Record<string, unknown>;
    if (mutant.verdict !== "survived") continue;
    const bi = mutant.batchIndex;
    if (typeof bi !== "number" || !Number.isInteger(bi) || bi < 0) {
      refuse(
        `mutant ${JSON.stringify(mutant.mutantCode)} is \`survived\` with a batchIndex that is not a non-negative integer`,
        bi,
      );
    }
  }
  // C02-09: `gapId`, its block lines and its batch group rows into gaps; a bad one would merge or
  // split a gap. Rows carry gap ids all or none: a mix would drop the unmarked rows from every
  // gap's counts, so a block could read as unobserved while its killed neighbour went uncounted.
  let gapped = 0;
  for (const m of mutants) {
    const mutant = m as Record<string, unknown>;
    const { gapId } = mutant;
    const where = `mutant ${JSON.stringify(mutant.mutantCode)}`;
    // Only a row with NONE of the three keys is a pre-C02-09 row. Block lines without a gapId are
    // a damaged new row, which would otherwise read as an old report and omit both gap lists.
    if (gapId === undefined) {
      const stray = (["blockStartLine", "blockEndLine"] as const).filter(
        (k) => mutant[k] !== undefined,
      );
      if (stray.length === 0) continue;
      refuse(`${where} has ${stray.join(" and ")} but no gapId`, stray);
    }
    if (typeof gapId !== "string") refuse(`${where} has a gapId that is not a string`, gapId);
    for (const k of ["blockStartLine", "blockEndLine"] as const) {
      const v = mutant[k];
      if (typeof v !== "number" || !Number.isInteger(v) || v < 1) {
        refuse(`${where} has a gapId with a ${k} that is not a positive integer`, v);
      }
    }
    const bi = mutant.batchIndex;
    if (typeof bi !== "number" || !Number.isInteger(bi) || bi < 0) {
      refuse(`${where} has a gapId with a batchIndex that is not a non-negative integer`, bi);
    }
    gapped++;
  }
  if (gapped !== 0 && gapped !== mutants.length) {
    refuse(
      `${gapped} of ${mutants.length} mutants carry a gapId; a report carries gap ids on all or none of its rows`,
      gapped,
    );
  }
  // The two session-level branches. `quarantined: null` would pass a bare `!== undefined` test and
  // then emit a tool condition whose `detail` read off a null — and `skippedStranded: "2"` compares
  // `> 0` as true, putting a string where the output declares a count.
  const { quarantined, resumedFrom } = record;
  if (quarantined !== undefined) {
    if (
      typeof quarantined !== "object" ||
      quarantined === null ||
      typeof (quarantined as Record<string, unknown>).reason !== "string"
    ) {
      refuse("`quarantined` is present but is not `{ reason: string }`", quarantined);
    }
  }
  if (resumedFrom !== undefined) {
    if (typeof resumedFrom !== "object" || resumedFrom === null) {
      refuse("`resumedFrom` is present but is not an object", resumedFrom);
    }
    const skipped = (resumedFrom as Record<string, unknown>).skippedStranded;
    if (typeof skipped !== "number" || !Number.isInteger(skipped) || skipped < 0) {
      refuse("`resumedFrom.skippedStranded` is not a non-negative integer", skipped);
    }
  }
  return value as SessionReport;
}

/** Looks up a keyed interpretation, throwing rather than substituting one. `assertExplainableReport`
 *  has already checked the value, so reaching the throw means the two drifted apart. */
function keyed<K extends string>(
  registry: Record<K, Interpretation>,
  key: K,
  what: string,
): Interpretation {
  const found: Interpretation | undefined = registry[key];
  if (found === undefined) refuse(`${what} has no interpretation`, key);
  return found;
}

/**
 * C02-01: the artifact THIS run recorded for the row's batch, or why there is none. The order is
 * the rule: `carried` first, because a carried verdict was measured against a prior run's artifact
 * even when this run published the same batch index. Looked up by the entry's `batchIndex` FIELD,
 * never by array position. Never throws; `assertExplainableReport` has checked the inputs.
 */
/**
 * R275: the one `lethal verify` line for a gap (the C02-07 recipe), its two ids filled in. The
 * report records neither the project nor the tests folder, so those stay named placeholders, written
 * exactly as the agent guide's recipe writes them.
 */
export function gapVerifyCommand(artifactId: string, gapId: string): string {
  return `lethal verify --db <project>/lethal.sqlite --artifact ${artifactId} --survivors ${gapId} --tests <tests-dir>`;
}

function artifactOf(
  m: MutantOutcome,
  artifacts: SessionReport["artifacts"],
): { readonly artifactId: string } | { readonly artifactIdAbsent: ArtifactIdAbsence } {
  if (m.carried === true) return { artifactIdAbsent: "carried" };
  if (artifacts === undefined) return { artifactIdAbsent: "not-recorded" };
  const entry = artifacts.find((a) => a.batchIndex === m.batchIndex);
  return entry !== undefined
    ? { artifactId: entry.artifactId }
    : { artifactIdAbsent: "not-published" };
}

function survivorOf(
  m: MutantOutcome,
  artifacts: SessionReport["artifacts"],
  coverageMode: CoverageMode | undefined,
): ExplainSurvivor {
  const measured = m.coverageAttribution;
  if (measured === undefined && coverageMode !== "none") {
    // Unreachable via `explain` (validated above); kept because this function is where the claim
    // `executionProven` makes would otherwise be fabricated.
    refuse(`survivor ${JSON.stringify(m.mutantCode)} has no coverageAttribution`, undefined);
  }
  const attribution: ExplainAttribution = measured ?? "not-measured";
  const guardEvidence = guardEvidenceOf(m.guardObserved);
  // R252: with coverage not measured, the reach states that name coverage ("covered-but-unreached",
  // "unreached-and-uncovered") would state a coverage fact no one collected. Only the mutant's own
  // measured reach is kept; everything else is not decided.
  const reach: SurvivorReach =
    measured === undefined
      ? m.carried !== true && m.guardReached === true
        ? "reached-unnoticed"
        : "not-decided"
      : survivorReachOf(measured, guardEvidence, m.guardReached, m.reachGrain, m.carried === true);
  return {
    mutantCode: m.mutantCode,
    file: m.file,
    line: m.line,
    codeunitName: m.codeunitName,
    procedureName: m.procedureName,
    operatorName: m.operatorName,
    originalText: m.originalText,
    mutatedText: m.mutatedText,
    attribution,
    // The one derivation this projection makes about the TARGET, and it is a restatement of a
    // measurement rather than a judgement: `exact` is a member-level coverage match.
    executionProven: attribution === "exact",
    coveringTests: m.coveringTests,
    guardEvidence,
    reach,
    interpretation: keyed(EXPLAIN_ATTRIBUTION_INTERPRETATIONS, attribution, "coverageAttribution"),
    guardInterpretation: keyed(GUARD_EVIDENCE_INTERPRETATIONS, guardEvidence, "guardObserved"),
    reachInterpretation: keyed(REACH_INTERPRETATIONS, reach, "reach"),
    ...(m.reachGrain !== undefined ? { reachGrain: m.reachGrain } : {}),
    ...(m.reachedBy !== undefined ? { reachedBy: [...m.reachedBy] } : {}),
    // C02-01: copied field by field, never an object spread, so an unexpected extra property on
    // the report row cannot ride through into the output.
    batchIndex: m.batchIndex,
    ...(m.triggerName !== undefined ? { triggerName: m.triggerName } : {}),
    ...(m.coverageArmNames !== undefined ? { coverageArmNames: [...m.coverageArmNames] } : {}),
    ...(m.procedureStartLine !== undefined ? { procedureStartLine: m.procedureStartLine } : {}),
    ...(m.procedureEndLine !== undefined ? { procedureEndLine: m.procedureEndLine } : {}),
    ...(m.equivalenceRisk !== undefined ? { equivalenceRisk: m.equivalenceRisk } : {}),
    ...(m.readerMark !== undefined
      ? { readerMark: { key: m.readerMark.key, reason: m.readerMark.reason } }
      : {}),
    ...artifactOf(m, artifacts),
    ...(m.gapId !== undefined ? { gapId: m.gapId } : {}),
    markKey: markIdentityOf(m),
  };
}

/**
 * C02-09: the report's rows grouped by gap id through `tallyGaps`, the one grouping rule `explain`
 * and `verify` share. `undefined` when no row carries a gap id (a report written before C02-09),
 * so the caller omits both lists rather than emitting `[]`.
 *
 * Rows sharing a gap id must agree on `file`, `blockStartLine`, `blockEndLine` (checked here) and
 * `batchIndex` (checked by `tallyGaps`). The limit, stated: two different blocks on the SAME lines
 * of one file that share an id cannot be told apart here, because the report carries block lines,
 * not offsets. Only the manifest writer, which produced the report, catches that case.
 */
function blocksOf(
  report: SessionReport,
):
  | { readonly gaps: ExplainGap[]; readonly noCoverageBlocks: ExplainNoCoverageBlock[] }
  | undefined {
  if (!report.mutants.some((m) => m.gapId !== undefined)) return undefined;
  const firstRow = new Map<string, MutantOutcome>();
  const firstMember = new Map<string, MutantOutcome>();
  const carriedGaps = new Set<string>();
  const rows: GapRow[] = [];
  for (const m of report.mutants) {
    const { gapId } = m;
    // Unreachable: `assertExplainableReport` refuses a report with gap ids on some rows only.
    if (gapId === undefined) refuse(`mutant ${JSON.stringify(m.mutantCode)} has no gapId`, m.gapId);
    const first = firstRow.get(gapId);
    if (first === undefined) firstRow.set(gapId, m);
    else if (
      first.file !== m.file ||
      first.blockStartLine !== m.blockStartLine ||
      first.blockEndLine !== m.blockEndLine
    ) {
      refuse(`gap id ${gapId} names two blocks`, [
        {
          mutantCode: first.mutantCode,
          file: first.file,
          blockStartLine: first.blockStartLine,
          blockEndLine: first.blockEndLine,
        },
        {
          mutantCode: m.mutantCode,
          file: m.file,
          blockStartLine: m.blockStartLine,
          blockEndLine: m.blockEndLine,
        },
      ]);
    }
    if (m.verdict === "survived") {
      if (!firstMember.has(gapId)) firstMember.set(gapId, m);
      if (m.carried === true) carriedGaps.add(gapId);
    }
    rows.push({
      mutantCode: m.mutantCode,
      verdict: m.verdict,
      gapId,
      batchIndex: m.batchIndex,
      line: m.line,
    });
  }
  let tallies: ReadonlyMap<string, GapTally>;
  try {
    tallies = tallyGaps(rows);
  } catch (e) {
    if (e instanceof GapGroupingError) refuse(e.message, undefined);
    throw e;
  }
  // An operator- or line-narrowed run drops mutants INSIDE a block, and a quarantined run stops
  // scheduling mutants mid-run, so "every recorded row survived" says nothing about the block's
  // unrecorded neighbours.
  const withhold =
    report.quarantined !== undefined ||
    report.validity.caveats.some((c) => c === "operator-narrowed" || c === "line-narrowed");
  // R447: per FILE, where R196 refused a loop step: that step has no row, so "every recorded row
  // survived" says nothing about it. Per file, not per block: the row carries no spans.
  const hangRefusedFiles = new Set(
    (report.excludedSites?.files ?? [])
      .filter((f) => f.reason === "hang-refused" && f.sites > 0)
      .map((f) => f.file),
  );
  const gaps: { readonly key: string; readonly gap: ExplainGap }[] = [];
  const noCoverageBlocks: { readonly key: string; readonly block: ExplainNoCoverageBlock }[] = [];
  for (const [gapId, t] of tallies) {
    const r = firstRow.get(gapId);
    if (r === undefined) refuse(`gap id ${gapId} has no row`, gapId);
    const { blockStartLine, blockEndLine } = r;
    if (blockStartLine === undefined || blockEndLine === undefined) {
      refuse(`gap id ${gapId} has no block lines`, r.mutantCode);
    }
    // Field by field, never a spread, so an extra property on the row cannot ride through.
    const location = {
      batchIndex: t.batchIndex,
      file: r.file,
      blockStartLine,
      blockEndLine,
      codeunitName: r.codeunitName,
      procedureName: r.procedureName,
      ...(r.triggerName !== undefined ? { triggerName: r.triggerName } : {}),
      ...(r.coverageArmNames !== undefined ? { coverageArmNames: [...r.coverageArmNames] } : {}),
    };
    if (t.survived > 0) {
      const member = firstMember.get(gapId);
      if (member === undefined) refuse(`gap id ${gapId} has survivors but no member row`, gapId);
      // `carried` when ANY member is: the gap was not measured by one artifact, and verify
      // refuses a carried member anyway.
      const artifact = carriedGaps.has(gapId)
        ? { artifactIdAbsent: "carried" as const }
        : artifactOf(member, report.artifacts);
      gaps.push({
        key: gapId,
        gap: {
          gapId,
          ...location,
          members: [...t.members],
          survived: t.survived,
          killed: t.killed,
          noCoverage: t.noCoverage,
          other: t.other,
          ...(withhold || hangRefusedFiles.has(r.file)
            ? {}
            : { unobservedBlock: t.unobservedBlock }),
          ...artifact,
          // R275: the C02-07 recipe, filled in with this gap's ids; only where there is an
          // artifact to verify against.
          ...("artifactId" in artifact
            ? { verifyCommand: gapVerifyCommand(artifact.artifactId, gapId) }
            : {}),
        },
      });
    }
    if (t.noCoverage > 0) {
      noCoverageBlocks.push({
        key: gapId,
        block: { ...location, members: [...t.noCoverageMembers] },
      });
    }
  }
  const byBlock = (
    a: { readonly key: string; readonly file: string; readonly blockStartLine: number },
    b: { readonly key: string; readonly file: string; readonly blockStartLine: number },
  ): number =>
    a.file !== b.file
      ? a.file < b.file
        ? -1
        : 1
      : a.blockStartLine - b.blockStartLine || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  return {
    gaps: gaps
      .sort((a, b) => byBlock({ key: a.key, ...a.gap }, { key: b.key, ...b.gap }))
      .map((g) => g.gap),
    noCoverageBlocks: noCoverageBlocks
      .sort((a, b) => byBlock({ key: a.key, ...a.block }, { key: b.key, ...b.block }))
      .map((b) => b.block),
  };
}

function notMeasuredOf(m: MutantOutcome): ExplainNotMeasured {
  const { cause } = m;
  return {
    mutantCode: m.mutantCode,
    file: m.file,
    line: m.line,
    operatorName: m.operatorName,
    ...(cause !== undefined ? { cause } : {}),
    ...(m.failureNote !== undefined ? { failureNote: m.failureNote } : {}),
    ...(cause !== undefined
      ? { interpretation: keyed(ERROR_CAUSE_INTERPRETATIONS, cause, "cause") }
      : {}),
  };
}

function toolConditionsOf(report: SessionReport): ExplainToolCondition[] {
  const conditions: ExplainToolCondition[] = [];
  const { quarantined, resumedFrom } = report;
  if (quarantined !== undefined) {
    conditions.push({
      condition: "quarantined",
      count: 0,
      ...(quarantined.reason !== "" ? { detail: quarantined.reason } : {}),
      interpretation: QUARANTINE_INTERPRETATION,
    });
  }
  // Non-zero only. A zero here is an honest "the resume skipped nothing", and emitting a condition
  // for it would put a clean resume in the same shape as a stranded one.
  if (resumedFrom !== undefined && resumedFrom.skippedStranded > 0) {
    conditions.push({
      condition: "stranded-skips",
      count: resumedFrom.skippedStranded,
      interpretation: STRANDED_SKIP_INTERPRETATION,
    });
  }
  return conditions;
}

/**
 * Where one survivor sits in the ranking a cap selects by. LOWER is kept first.
 *
 * The order is over EVIDENCE, not over importance: it is a restatement of what the run measured
 * about each row, in the order of how much of the "is this a real gap" question is already
 * settled. It is deliberately not a judgement about the target's code, which rule (1) of this
 * file's admissibility rule forbids, and it tells no one what test to write.
 *
 * - 0: `reach: "reached-unnoticed"` (GH-24). The mutant's own statement is measured to have run
 *   under a covering test, and every one passed. The most evidence any survivor here carries.
 * - 1: `executionProven` and `reach: "not-decided"`. A test is measured to have executed this
 *   PROCEDURE, and nothing says the statement went unreached.
 * - 2: `executionProven` and `reach: "covered-but-unreached"`. A test enters the procedure and the
 *   statement did not run: the R116 pair. Strong evidence too, about a different situation, and
 *   ranked below 1 only because 1's rows may be ones whose covering test ran what was mutated.
 * - 3: not `executionProven`, `reach: "not-decided"`. Some test touched the OBJECT. Whether the
 *   mutated member ran is unknown, which is FALLBACK 1's whole warning.
 * - 4: `reach: "unreached-and-uncovered"`. Neither signal places a test at this code. The least
 *   any survivor carries, so the first to drop off a capped list.
 *
 * Ties break on `file`, then `line`, then `mutantCode`, which makes the order TOTAL: two rows can
 * never compare equal, so `--top 20` on one machine is `--top 20` on every other. A rank that left
 * ties would make the cap's contents depend on the sort implementation.
 */
export function survivorActionabilityRank(s: ExplainSurvivor): number {
  if (s.reach === "reached-unnoticed") return 0;
  if (s.reach === "unreached-and-uncovered") return 4;
  if (s.executionProven) return s.reach === "covered-but-unreached" ? 2 : 1;
  return 3;
}

/** The total order `rankedBy: "actionability"` names. Exported so a consumer, or a test, can
 *  reproduce the selection without re-deriving the tie-breaks. */
export function rankSurvivors(survivors: readonly ExplainSurvivor[]): ExplainSurvivor[] {
  return [...survivors].sort((a, b) => {
    const byRank = survivorActionabilityRank(a) - survivorActionabilityRank(b);
    if (byRank !== 0) return byRank;
    if (a.file !== b.file) return a.file < b.file ? -1 : 1;
    if (a.line !== b.line) return a.line - b.line;
    return a.mutantCode < b.mutantCode ? -1 : a.mutantCode > b.mutantCode ? 1 : 0;
  });
}

/**
 * R443: builds each survivor's ready-to-paste mark from the report's RECORDED numbering facts, or
 * `undefined` when the report has none. `fileSingleton` follows R-443's rule B2: the (file, tuple)
 * is not a recorded twin site, and nothing this run hid from numbering could be its twin (its
 * coarse tuple is not in `carryHidden.tuples`, its file not in `carryHidden.files`).
 */
function markBuilderOf(report: SessionReport): ((m: MutantOutcome) => ExplainMark) | undefined {
  const { numberingDigest, twinSites, carryHidden, buildSymbols } = report;
  if (numberingDigest === undefined || twinSites === undefined || carryHidden === undefined) {
    return undefined;
  }
  const twins = new Set(twinSites);
  const hiddenTuples = new Set(carryHidden.tuples);
  const hiddenFiles = new Set(carryHidden.files.map((f) => f.replaceAll("\\", "/")));
  return (m) => {
    const file = m.file.replaceAll("\\", "/");
    const coarse = coarseIdentityTupleOf({
      astHash: m.astHash,
      operatorName: m.operatorName,
      operatorVersion: `${m.operatorMajor}.0.0`,
    });
    return {
      key: markIdentityOf(m),
      reason: MARK_REASON_PLACEHOLDER,
      file,
      numberingDigest,
      fileSingleton:
        !twins.has(twinSiteOf(file, markTupleOfRow(m))) &&
        !hiddenTuples.has(coarse) &&
        !hiddenFiles.has(file),
      ...(buildSymbols !== undefined && buildSymbols.length > 0
        ? { preprocessorSymbols: [...buildSymbols] }
        : {}),
    };
  };
}

/** What `explain` may be asked to do differently. Absent means the whole projection, in report
 *  order — the behaviour every caller had before R150 added the cap. */
export interface ExplainOptions {
  /**
   * Keep at most this many survivors, chosen by `rankSurvivors`. A positive integer; 0 and negative
   * values are REFUSED rather than clamped, because "show me none" and "show me all" are both
   * plausible readings of `--top 0` and a projection that guesses which one the caller meant would
   * be guessing about completeness. Omit the option to get every survivor.
   */
  readonly topSurvivors?: number;
}

/**
 * Projects a finished `SessionReport`. Validates first (`assertExplainableReport`) even though the
 * parameter is typed: the callers that reach a report off disk get there through a cast, so the
 * type is a promise this function must not take on trust.
 */
export function explain(report: SessionReport, options: ExplainOptions = {}): ExplainOutput {
  const validated = assertExplainableReport(report);
  const { counts, validity } = validated;
  const { topSurvivors } = options;
  if (topSurvivors !== undefined && (!Number.isInteger(topSurvivors) || topSurvivors < 1)) {
    // A caller-contract violation, thrown rather than defaulted: silently treating a bad cap as
    // "no cap" would emit a complete list to a caller who asked for a bounded one, and silently
    // treating it as zero would emit an empty one that reads like a report with no survivors.
    throw new Error(
      `explain: topSurvivors must be a positive integer, got ${JSON.stringify(topSurvivors)}`,
    );
  }
  const markOf = markBuilderOf(validated);
  const allSurvivors = validated.mutants
    .filter((m) => m.verdict === "survived")
    .map((m) => {
      const survivor = survivorOf(m, validated.artifacts, validated.coverageMode);
      const mark = markOf?.(m);
      return mark !== undefined ? { ...survivor, mark } : survivor;
    });
  const survivors =
    topSurvivors === undefined ? allSurvivors : rankSurvivors(allSurvivors).slice(0, topSurvivors);
  // C02-09: from ALL rows, before the cap. `--top` bounds survivors only (Q6).
  const blocks = blocksOf(validated);
  // R265, R325: a report without `identityScheme` was written before the field existed and reads
  // as scheme 1, the same rule `parseEquivalenceMarks` applies to a marks file without one.
  const markIdentityScheme = validated.identityScheme ?? 1;
  return {
    explainSchemaVersion: EXPLAIN_SCHEMA_VERSION,
    derivedFromReportSchemaVersion: validated.schemaVersion,
    contract: EXPLAIN_CONTRACT,
    score: {
      mutationScore: validated.mutationScore,
      reliability: validity.reliability,
      scoreDescribes: validity.scoreDescribes,
      scored: validity.scoredMutants.scored,
      recorded: validity.scoredMutants.recorded,
      excludedFromScore: {
        errors: counts.errors,
        noCoverage: counts.noCoverage,
        knownSurvivors: counts.knownSurvivors,
      },
    },
    caveats: validity.caveats.map((caveat) => ({
      caveat,
      interpretation: keyed(CAVEAT_INTERPRETATIONS, caveat, "caveat"),
    })),
    survivorSelection: {
      total: allSurvivors.length,
      shown: survivors.length,
      omitted: allSurvivors.length - survivors.length,
      rankedBy: topSurvivors === undefined ? "report-order" : "actionability",
    },
    survivors,
    notMeasured: validated.mutants.filter((m) => m.verdict === "error").map(notMeasuredOf),
    toolConditions: toolConditionsOf(validated),
    ...(blocks !== undefined
      ? { gaps: blocks.gaps, noCoverageBlocks: blocks.noCoverageBlocks }
      : {}),
    markIdentityScheme,
    // R325's rule (`applyEquivalenceMarks`): a mark whose scheme is not the run's is stale.
    ...(markIdentityScheme !== IDENTITY_SCHEME
      ? {
          markKeysStale: {
            reportScheme: markIdentityScheme,
            buildScheme: IDENTITY_SCHEME,
            interpretation: MARK_KEYS_STALE_INTERPRETATION,
          },
        }
      : {}),
  };
}
