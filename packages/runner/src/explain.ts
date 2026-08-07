import type { Interpretation } from "./interpretation";
import {
  CAVEAT_INTERPRETATIONS,
  ERROR_CAUSE_INTERPRETATIONS,
  GUARD_EVIDENCE_INTERPRETATIONS,
  QUARANTINE_INTERPRETATION,
  REPORT_SCHEMA_VERSION,
  STRANDED_SKIP_INTERPRETATION,
  guardEvidenceOf,
} from "./report";
import type {
  Caveat,
  GuardEvidence,
  MutantErrorCause,
  MutantOutcome,
  ReportValidity,
  SessionReport,
} from "./report";
import { ATTRIBUTION_INTERPRETATIONS } from "./selection";
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
 *     registry interpretation, or from a short pinned list of strings this projection authors.
 *     Closes new text at an existing path in general.
 *   - An EQUALITY PIN on `EXPLAIN_CONTRACT.note`, the one string authored here. Appending
 *     target-prescriptive advice to it slipped all three checks above at once and shipped into the
 *     real rung1 artifact (fix round 2); the pin reddens on any edit at all, whatever its wording.
 *
 * The pinned path set is also, exactly, the structure `EXPLAIN_SCHEMA_VERSION` versions: the test
 * that stops smuggled advice is the same test that stops an unversioned schema change.
 *
 * THE BYPASS ALL FOUR SHARE, disclosed because the list above would be dishonest without it. Both
 * pins are built from OBSERVED data — `EXPLAIN_LEAF_PATHS` and `PROJECTION_AUTHORED_STRINGS` are
 * hand-maintained lists checked against what the fixture and the six committed reports actually
 * produce — so a new field ships green if its path and its string are added alongside it. For a
 * GLOBAL, report-content-independent field that is four small coordinated edits (two in this file,
 * one in each list) and an unremarkable-looking diff: measured at 45 pass / 0 fail. For a PER-ITEM
 * field it is impractical, because the six-real-report test forces every distinct real value into
 * `PROJECTION_AUTHORED_STRINGS` and that enumeration is itself the tell. What closes the global case
 * is deriving the pinned set from the output TYPE rather than from observed data — filed as R115.
 * Until then, a diff that adds a field to `ExplainOutput` is a review event, not a mechanical one.
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
 */
export const EXPLAIN_SCHEMA_VERSION = 2;

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
  ...Object.values(ERROR_CAUSE_INTERPRETATIONS),
  QUARANTINE_INTERPRETATION,
  STRANDED_SKIP_INTERPRETATION,
];

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
  readonly attribution: CoverageAttribution;
  readonly executionProven: boolean;
  readonly coveringTests: readonly string[];
  readonly guardEvidence: GuardEvidence;
  /** `ATTRIBUTION_INTERPRETATIONS[attribution]`, by reference. */
  readonly interpretation: Interpretation;
  /** `GUARD_EVIDENCE_INTERPRETATIONS[guardEvidence]`, by reference. */
  readonly guardInterpretation: Interpretation;
}

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
 */
export type ToolCondition = "quarantined" | "stranded-skips";

export interface ExplainToolCondition {
  readonly condition: ToolCondition;
  /** How many mutants the condition accounts for. 0 for `quarantined`, which is not a tally: the
   *  mutants it cost were never scheduled, so the report cannot count them. */
  readonly count: number;
  /** Verbatim from the report (`quarantined.reason`). Absent when the field carries no text. */
  readonly detail?: string;
  readonly interpretation: Interpretation;
}

export interface ExplainOutput {
  readonly explainSchemaVersion: number;
  /** The `REPORT_SCHEMA_VERSION` the input declared — always equal to this build's, because
   *  `assertExplainableReport` refuses anything else. Recorded so the output is self-describing
   *  once it has been written to a file and outlived the binary that made it. */
  readonly derivedFromReportSchemaVersion: number;
  readonly contract: ExplainContract;
  readonly score: ExplainScore;
  readonly caveats: readonly ExplainCaveat[];
  readonly survivors: readonly ExplainSurvivor[];
  readonly notMeasured: readonly ExplainNotMeasured[];
  readonly toolConditions: readonly ExplainToolCondition[];
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
    "`entailedNegative`, `note`, `scoreDescribes`, `detail` or `failureNote`; they may be reworded " +
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
const KNOWN_ERROR_CAUSES: ReadonlySet<string> = new Set(Object.keys(ERROR_CAUSE_INTERPRETATIONS));
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
 *   - every mutant's `guardObserved`       — a tri-state, one of whose states (`not-observed`) moves
 *                                            a mutant out of the survivor reading entirely
 *   - every mutant's `cause`               — selects an `ERROR_CAUSE_INTERPRETATIONS` entry
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
  if (record.schemaVersion !== REPORT_SCHEMA_VERSION) {
    const why =
      "A REPORT_SCHEMA_VERSION bump means a field was renamed, removed, or changed meaning (v1 -> " +
      "v2 renamed `executionContext` and changed its cardinality), so projecting a report of " +
      "another version would attach this build's meanings to another build's fields — the one " +
      "error a projection must not make.";
    throw new MalformedReportError(
      `lethal explain: report schemaVersion is ${JSON.stringify(record.schemaVersion)}, but this build explains ${REPORT_SCHEMA_VERSION}. ${why}`,
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
    if (mutant.verdict === "survived" && attribution === undefined) {
      refuse(
        `${where} is \`survived\` with no coverageAttribution, so whether any test is measured to have executed it cannot be decided`,
        mutant.coverageAttribution,
        KNOWN_ATTRIBUTIONS,
      );
    }
    const cause = mutant.cause;
    if (cause !== undefined && (typeof cause !== "string" || !KNOWN_ERROR_CAUSES.has(cause))) {
      refuse(`${where} has an error cause this build cannot interpret`, cause, KNOWN_ERROR_CAUSES);
    }
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

function survivorOf(m: MutantOutcome): ExplainSurvivor {
  const attribution = m.coverageAttribution;
  if (attribution === undefined) {
    // Unreachable via `explain` (validated above); kept because this function is where the claim
    // `executionProven` makes would otherwise be fabricated.
    refuse(`survivor ${JSON.stringify(m.mutantCode)} has no coverageAttribution`, undefined);
  }
  const guardEvidence = guardEvidenceOf(m.guardObserved);
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
    interpretation: keyed(ATTRIBUTION_INTERPRETATIONS, attribution, "coverageAttribution"),
    guardInterpretation: keyed(GUARD_EVIDENCE_INTERPRETATIONS, guardEvidence, "guardObserved"),
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
 * Projects a finished `SessionReport`. Validates first (`assertExplainableReport`) even though the
 * parameter is typed: the callers that reach a report off disk get there through a cast, so the
 * type is a promise this function must not take on trust.
 */
export function explain(report: SessionReport): ExplainOutput {
  const validated = assertExplainableReport(report);
  const { counts, validity } = validated;
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
    survivors: validated.mutants.filter((m) => m.verdict === "survived").map(survivorOf),
    notMeasured: validated.mutants.filter((m) => m.verdict === "error").map(notMeasuredOf),
    toolConditions: toolConditionsOf(validated),
  };
}
