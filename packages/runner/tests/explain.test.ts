import { describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tier1Operators } from "@lethal/builtin-tier1";
import { explainFromCli, helpText, parseCliConfig } from "../src/cli";
import {
  ADMISSIBLE_INTERPRETATIONS,
  ARTIFACT_ID_ABSENCES,
  EXPLAIN_CONTRACT,
  EXPLAIN_SCHEMA_VERSION,
  MalformedReportError,
  SURVIVOR_RANKINGS,
  TOOL_CONDITIONS,
  assertExplainableReport,
  explain,
  rankSurvivors,
  survivorActionabilityRank,
} from "../src/explain";
import type { Interpretation } from "../src/interpretation";
import {
  CAVEAT_INTERPRETATIONS,
  ERROR_CAUSE_INTERPRETATIONS,
  GUARD_EVIDENCE_INTERPRETATIONS,
  QUARANTINE_INTERPRETATION,
  REACH_INTERPRETATIONS,
  REPORT_SCHEMA_VERSION,
  STRANDED_SKIP_INTERPRETATION,
} from "../src/report";
import type { Caveat, MutantErrorCause, MutantOutcome, SessionReport } from "../src/report";
import { ATTRIBUTION_INTERPRETATIONS, serializeKey } from "../src/selection";
import type { CoverageAttribution } from "../src/selection";
import type { MutantVerdict } from "../src/store";
import { TypeLeafPathError, typeLeafPaths } from "./helpers/type-leaf-paths";

// ————————————————————————————————————————————————————————————————————————————————————————
// Fixtures. A literal `SessionReport` rather than a run-shaped builder ON PURPOSE: `explain`'s
// real input is a JSON file read off disk (`lethal explain <report.json>`), so the input space it
// must survive is "whatever is in that file", not "whatever a live run can produce". The
// end-to-end fixtures at the bottom of this file are the real committed campaign reports.
// ————————————————————————————————————————————————————————————————————————————————————————

function survivorMutant(
  code: string,
  attribution: CoverageAttribution,
  guardObserved?: boolean,
  batchIndex = 0,
): MutantOutcome {
  return {
    mutantCode: code,
    file: "src/Posting/Foo.Codeunit.al",
    line: 42,
    operatorName: "lethal.negate-conditional",
    verdict: "survived",
    batchIndex,
    durationMs: 120,
    procedureName: "ComputeTotal",
    // C02-01: the enclosing procedure's span, distinct from `line` and `startIndex` so a swap
    // between them is detectable in the verbatim test.
    procedureStartLine: 38,
    procedureEndLine: 51,
    startIndex: 100,
    endIndex: 110,
    originalText: "Qty > 0",
    mutatedText: "Qty <= 0",
    coveringTests: ["Foo Tests.ComputesTotal"],
    coverageAttribution: attribution,
    ...(guardObserved !== undefined ? { guardObserved } : {}),
    runner: "fenced",
    astHash: `hash-${code}`,
    codeunitName: "Foo Mgt.",
    operatorMajor: 1,
  };
}

function errorMutant(code: string, cause?: MutantErrorCause): MutantOutcome {
  return {
    mutantCode: code,
    file: "src/Posting/Foo.Codeunit.al",
    line: 77,
    operatorName: "lethal.void-method-call",
    verdict: "error",
    batchIndex: 0,
    durationMs: 0,
    procedureName: "PostBatch",
    startIndex: 200,
    endIndex: 220,
    originalText: "Rec.SetCurrentKey(No);",
    mutatedText: "",
    coveringTests: [],
    failureNote: "deadline exceeded running Foo Tests.PostsBatch (infrastructure, not a kill)",
    ...(cause !== undefined ? { cause } : {}),
    runner: "fenced",
    astHash: `hash-${code}`,
    codeunitName: "Foo Mgt.",
    operatorMajor: 1,
  };
}

/** An `error` outcome of the shape `--resume` records for a mutant it did NOT re-run, so a fixture
 *  claiming `resumedFrom.skippedStranded: n` has n outcomes actually backing it — the fold counts
 *  that field 1:1 from `mutant-skipped-stranded` (report-fold.ts), it is not free-standing. */
function strandedSkipMutant(code: string): MutantOutcome {
  return {
    ...errorMutant(code),
    failureNote:
      "not re-run on resume: a prior run's execution of this mutant could not be confirmed " +
      "complete and stranded the tier. Pass --retry-stranded to attempt it.",
  };
}

/** A mutant with a verdict the projection neither lists nor interprets — it exists only to make a
 *  fixture's `counts` real rather than asserted into place. */
function plainMutant(code: string, verdict: MutantVerdict): MutantOutcome {
  return {
    mutantCode: code,
    file: "src/Posting/Bar.Codeunit.al",
    line: 12,
    operatorName: "lethal.empty-block",
    verdict,
    batchIndex: 0,
    durationMs: 5,
    procedureName: "Recalc",
    startIndex: 10,
    endIndex: 20,
    originalText: "begin end",
    mutatedText: "",
    coveringTests: [],
    runner: "fenced",
    astHash: `hash-${code}`,
    codeunitName: "Bar Mgt.",
    operatorMajor: 1,
  };
}

function reportFixture(over: Partial<SessionReport> = {}): SessionReport {
  const base: SessionReport = {
    schemaVersion: REPORT_SCHEMA_VERSION,
    validity: {
      reliability: "narrowed",
      caveats: ["narrowed"],
      scoreDescribes: "3 scored mutant(s) in src/Posting/** (2 of 40 .al files)",
      baselineTests: { total: 12, failing: 0 },
      scoredMutants: { scored: 3, recorded: 4 },
      executionContexts: [
        {
          runner: "fenced",
          guiAllowed: false,
          clientType: "ODataV4",
          basis: "test fixture",
          verdictCount: 4,
        },
      ],
    },
    survivorsByProcedure: [],
    testFiles: { "Foo Tests": "test/Foo.Test.al" },
    backend: "bcdev",
    authoritative: true,
    baselineGreen: true,
    batches: 1,
    counts: {
      killed: 1,
      survived: 2,
      noCoverage: 0,
      timeoutKilled: 0,
      knownSurvivors: 0,
      unstable: 0,
      errors: 1,
      deadlineExceeded: 1,
    },
    mutationScore: 1 / 3,
    mutants: [
      survivorMutant("M0001", "exact", true),
      survivorMutant("M0002", "object", true),
      errorMutant("M0003", "deadline-exceeded"),
    ],
    unsupportedTests: [],
    notInstrumented: { totalFiles: 40, fileCount: 0, siteCount: 0, files: [] },
    declarativeSites: { siteCount: 0, fileCount: 0, files: [] },
    only: { patterns: ["src/Posting/**"], excludedFileCount: 38 },
    timings: {
      totalMs: 1000,
      generateMutationSetMs: 10,
      deployMs: 500,
      baselineMs: 200,
      mutantsMs: 120,
      perMutant: { count: 1, meanMs: 120, medianMs: 120, p95Ms: 120, maxMs: 120 },
    },
    preprocessorSymbols: [],
    unplaceableCount: 0,
    unplaceableMutants: [],
    untargetedTriggerCount: 0,
  };
  return { ...base, ...over };
}

function reportWithCaveat(caveat: Caveat): SessionReport {
  const base = reportFixture();
  return { ...base, validity: { ...base.validity, caveats: [caveat] } };
}

/**
 * Every `Interpretation`-shaped object reachable in `value`, with the JSON path it sits at.
 *
 * "Interpretation-shaped" is `meaning: string` + `basis: string` — the two required members of the
 * type. Walks arrays and plain objects; the path is only for the failure message.
 */
function interpretationsIn(
  value: unknown,
  path = "$",
): readonly { readonly path: string; readonly value: Interpretation }[] {
  if (Array.isArray(value)) {
    return value.flatMap((v, i) => interpretationsIn(v, `${path}[${i}]`));
  }
  if (typeof value !== "object" || value === null) return [];
  const record = value as Record<string, unknown>;
  if (typeof record.meaning === "string" && typeof record.basis === "string") {
    return [{ path, value: record as unknown as Interpretation }];
  }
  return Object.entries(record).flatMap(([k, v]) => interpretationsIn(v, `${path}.${k}`));
}

/**
 * Every LEAF path in `value` — an array index collapses to `[]`, so N survivors contribute one path
 * per field rather than N. Deliberately type-blind: a leaf is anything that is not an array or a
 * plain object, so a new `summary: string`, a new `priority: 1` and a new `deserved: true` all show
 * up identically.
 */
function leafPathsIn(value: unknown, path = "$"): readonly string[] {
  if (Array.isArray(value)) return value.flatMap((v) => leafPathsIn(v, `${path}[]`));
  if (typeof value === "object" && value !== null) {
    return Object.entries(value).flatMap(([k, v]) => leafPathsIn(v, `${path}.${k}`));
  }
  return [path];
}

/** Every string VALUE reachable in `value` (keys are not values, so a field NAME never counts). */
function stringsIn(value: unknown): readonly string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringsIn);
  if (typeof value === "object" && value !== null) return Object.values(value).flatMap(stringsIn);
  return [];
}

/**
 * `EXPLAIN_CONTRACT.note`, pinned by EQUALITY as the test's own independent copy.
 *
 * Fix round 2. This is the one string in the output authored in `explain.ts`, and it slipped every
 * other mechanism at once: not `Interpretation`-shaped (identity is blind to it), at a path
 * `EXPLAIN_LEAF_PATHS` already lists (the pin stays green), not copied from the report (the
 * verbatim check does not reach it). Appending *"the survivors with executionProven: true are the
 * weak spots in this suite and deserve attention first; consider covering those lines more
 * tightly"* shipped 43 pass / 0 fail into the real rung1 artifact.
 *
 * Pinned by TEXT rather than screened by phrasing, because the phrase that got through cleared the
 * banned-phrase regex — closing against the regex would close against the wrong thing. Any edit at
 * all reddens this, which is correct for a string describing THIS ARTIFACT'S OWN CONTRACT: changing
 * it changes what the output promises, and that is exactly when `EXPLAIN_SCHEMA_VERSION` deserves a
 * look. See `EXPLAIN_CONTRACT`'s doc comment for why the same pin would be wrong on a registry
 * `meaning`.
 */
const PINNED_CONTRACT_NOTE =
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
  "a claim (a ROADMAP id, or a file) and IS stable enough to key on.";

/**
 * Every string the PROJECTION authors — present in the output but coming from neither the report
 * nor a registry interpretation. Two enum families derived from report values, two `ToolCondition`
 * tokens, and the contract's own text.
 *
 * DERIVED, not listed. R115 gap (3): this used to be a hand-maintained array, and that made it the
 * fourth of four small coordinated edits that shipped a new GLOBAL prose field green — two lines in
 * `explain.ts`, one entry in `EXPLAIN_LEAF_PATHS`, one entry here, measured at 45 pass / 0 fail. The
 * realistic route was never malice: an author whose new field reddens two tests "fixes" them by
 * adding the two entries, and nobody is asked whether the projection should be saying that at all.
 *
 * Building the set from the shipped constants removes the place to add the entry. A new authored
 * string now has exactly two homes, and both are loud:
 *   - `EXPLAIN_CONTRACT` — pinned below as a WHOLE OBJECT, so a new field there reddens the pin
 *     rather than widening this set quietly;
 *   - a new interpretation registry — which is a `Record<Union, Interpretation>` with a resolving
 *     basis, i.e. the admissibility rule being followed rather than dodged.
 *
 * The TOKENS need no equality pin of their own: consumers filter on their exact value, so widening
 * one into a sentence breaks the code that reads it rather than smuggling anything — measured,
 * `"quarantined"` carrying advice (through an `as ToolCondition` cast) fails five tests. `note` is
 * the only entry with room to hide a claim, and it is pinned by `PINNED_CONTRACT_NOTE`.
 */
const PROJECTION_AUTHORED_STRINGS: readonly string[] = [
  // The contract's own text, whatever it currently says. Safe to admit wholesale ONLY because the
  // constant is pinned by equality below; drop that pin and this line becomes the hole.
  ...Object.values(EXPLAIN_CONTRACT).filter((v): v is string => typeof v === "string"),
  // GuardEvidence — derived from a boolean, so absent from the report.
  ...Object.keys(GUARD_EVIDENCE_INTERPRETATIONS),
  // SurvivorReach — R116, derived from a PAIR, so absent from the report.
  ...Object.keys(REACH_INTERPRETATIONS),
  // ToolCondition — a field NAME in the report, never a value.
  ...TOOL_CONDITIONS,
  // SurvivorRanking — R150. Describes how this projection ordered its own output, so it can come
  // from nowhere but here.
  ...SURVIVOR_RANKINGS,
  // ArtifactIdAbsence, C02-01. Authored tokens, like TOOL_CONDITIONS: why a survivor has no
  // artifactId, which the report states only by the absence of a field.
  ...ARTIFACT_ID_ABSENCES,
];

// ————————————————————————————————————————————————————————————————————————————————————————
// The four tests the plan specifies (task-4-brief.md Step 1), verbatim in intent.
// ————————————————————————————————————————————————————————————————————————————————————————

describe("explain — the plan's own four tests", () => {
  test("every survivor carries a machine field beside its prose", () => {
    const out = explain(reportFixture());
    expect(out.survivors.length).toBeGreaterThan(0);
    for (const s of out.survivors) {
      expect(typeof s.executionProven).toBe("boolean");
      expect(s.interpretation.basis.length).toBeGreaterThan(0);
    }
  });

  test("the header records BOTH schema versions", () => {
    const out = explain(reportFixture());
    expect(out.explainSchemaVersion).toBe(EXPLAIN_SCHEMA_VERSION);
    expect(out.derivedFromReportSchemaVersion).toBe(2);
    expect(out.derivedFromReportSchemaVersion).toBe(REPORT_SCHEMA_VERSION);
  });

  test("it states what is proven and what is not — never what test to write", () => {
    const out = explain(reportFixture());
    const text = JSON.stringify(out).toLowerCase();
    expect(text).not.toMatch(/write a test|add an assertion|you should test/);
  });

  test("it does NOT restate a caveat in fresh prose — it emits the shared constant", () => {
    const out = explain(reportWithCaveat("baseline-red"));
    expect(out.caveats[0]?.interpretation).toBe(CAVEAT_INTERPRETATIONS["baseline-red"]);
  });
});

/**
 * A report that reaches every emitting branch of the projection at once.
 *
 * Its counts are PAIRWISE DISTINCT, and that is load-bearing rather than tidy. The final review
 * swapped `scored` with `recorded` and `noCoverage` with `knownSurvivors` and the whole runner suite
 * stayed green at 1441 pass / 0 fail — because the old fixture had `noCoverage` and `knownSurvivors`
 * BOTH 0, so the one assertion covering them held whichever way they were wired. Five distinct
 * values (scored 4, recorded 14, errors 3, noCoverage 2, knownSurvivors 5) make any swap among them
 * detectable; two zeros make it undetectable no matter how many assertions are added.
 *
 * They are also CONSISTENT with what `buildReport` would actually derive, checked field by field
 * against its own producers rather than by eye — because a fixture describing a state the producer
 * cannot produce is the hazard `legacyBuildReport`'s own doc comment warns about, and a fixture is
 * a poor place to learn that lesson twice:
 *
 *   counts       3 survived + 4 error + 2 killed + 1 no-coverage + 6 known-survivor
 *   recorded     16 = outcomes.length
 *   scored        5 = killed + timeoutKilled + survived
 *   mutationScore 0.4 = 2/5
 *   unstable/deadlineExceeded  1 each, matching M0005 and M0004's `cause`
 *   caveats      `resumed` included because `resumedFrom` is set, which `buildReport` pushes
 *                UNCONDITIONALLY — the final review caught this one missing
 *   resumedFrom  `carriedMutants: 1` because exactly one outcome here (M0003) is `carried`; the
 *                fold counts it 1:1.
 *                `skippedStranded: 2` is backed by the two `strandedSkipMutant` rows above.
 */
function fullCoverageReport(): SessionReport {
  const base = reportFixture();
  const m0001 = survivorMutant("M0001", "exact", true, 1);
  // C02-01: the reader's mark, keyed to this row's REAL serialized identity (report.ts's
  // `markIdentityOf`) rather than a placeholder like `K-M0001`. A wrong key would otherwise go
  // undetected.
  const survivorWithMark: MutantOutcome = {
    ...m0001,
    // GH-24: reaches the `reachGrain` and `reachedBy[]` leaves.
    reachGrain: "statement",
    guardReached: true,
    reachedBy: ["Foo Tests.ComputesTotal"],
    readerMark: {
      key: serializeKey({
        astHash: m0001.astHash,
        codeunitName: m0001.codeunitName,
        procedureName: m0001.procedureName,
        operatorName: m0001.operatorName,
        operatorMajor: m0001.operatorMajor,
        ordinal: 0,
      }),
      reason: "reader confirmed this rewrite is never read downstream",
    },
  };
  // C02-01: `lethal.remove-assignment` is the operator whose registry entry declares
  // "value-rewrite" (remove-assignment.ts), the only way `buildReport` can produce that risk.
  const survivorWithRisk: MutantOutcome = {
    ...survivorMutant("M0002", "object", false, 4),
    operatorName: "lethal.remove-assignment",
    equivalenceRisk: "value-rewrite",
  };
  // C02-01: a trigger mutant, so `procedureName` is "" and `triggerName` carries the member name. It
  // reaches the `triggerName` leaf the "no dead entries" test needs.
  // It is also CARRIED, so the `artifactIdAbsent` leaf is reached (as "carried"), while M0001 in
  // batch 1 reaches `artifactId` through `artifacts` below.
  const triggerSurvivor: MutantOutcome = {
    ...survivorMutant("M0003", "all-green", undefined, 6),
    procedureName: "",
    triggerName: "OnValidate",
    carried: true,
  };
  return {
    ...base,
    validity: {
      ...base.validity,
      reliability: "narrowed-degraded",
      caveats: ["baseline-red", "narrowed", "tests-narrowed", "resumed"],
      scoredMutants: { scored: 5, recorded: 16 },
    },
    baselineGreen: false,
    counts: {
      killed: 2,
      survived: 3,
      noCoverage: 1,
      timeoutKilled: 0,
      knownSurvivors: 6,
      unstable: 1,
      errors: 4,
      deadlineExceeded: 1,
    },
    mutationScore: 0.4,
    mutants: [
      survivorWithMark,
      survivorWithRisk,
      triggerSurvivor,
      errorMutant("M0004", "deadline-exceeded"),
      errorMutant("M0005", "unstable"),
      strandedSkipMutant("M0006"),
      strandedSkipMutant("M0007"),
      plainMutant("M0008", "killed"),
      plainMutant("M0009", "killed"),
      plainMutant("M0010", "no-coverage"),
      plainMutant("M0011", "known-survivor"),
      plainMutant("M0012", "known-survivor"),
      plainMutant("M0013", "known-survivor"),
      plainMutant("M0014", "known-survivor"),
      plainMutant("M0015", "known-survivor"),
      plainMutant("M0016", "known-survivor"),
    ],
    testsOnly: ["test/Posting/**"],
    quarantined: { reason: "test in-flight-unknown running Foo Tests.PostsBatch (mutant M0004)" },
    resumedFrom: { runId: 7, carriedMutants: 1, skippedStranded: 2 },
    // C02-01: batch 1 published (M0001's); batch 4 (M0002) did not, and batch 6's survivor is
    // carried, so this run names no artifact for it whatever `artifacts` holds.
    artifacts: [
      {
        batchIndex: 1,
        artifactId: "0123456789abcdef0123456789abcdef",
        sha256: "c".repeat(64),
        appVersion: "1.0.9.9",
      },
    ],
  };
}

/**
 * EVERY leaf path `ExplainOutput` may contain, and nothing else.
 *
 * This is the pin the identity check below cannot be. Identity is SHAPE-SCOPED: it inspects objects
 * carrying `meaning` + `basis` and is blind to everything else, so a top-level `summary: string` or
 * an `advice: string` on every survivor sails past it — measured, three such fields at once, 35
 * pass / 0 fail, with "these deserve attention first" in the shipped artifact. This pin is
 * type-blind and total instead: a new leaf at an unlisted path fails whatever its type or wording,
 * so smuggled advice dies by CONSTRUCTION rather than by phrasing. A numeric `priority` dies here
 * too, which matters — `SessionReport.survivorsByProcedure`'s own doc comment refuses a computed
 * priority score for exactly that reason ("wrong for someone's context and trusted uncritically
 * anyway").
 *
 * The set is also, exactly, the structure `EXPLAIN_SCHEMA_VERSION` versions. So this one test
 * doubles as the schema's own regression gate: no field can be added, renamed or removed without
 * landing here, where the version bump gets decided.
 *
 * KNOWN BYPASS (R115), stated where whoever edits this list will read it: the set is built from
 * OBSERVED data, so adding a path here alongside the field that emits it is enough to ship a new
 * global field green — four small edits, measured at 45 pass / 0 fail. That is a review event, not
 * a mechanical one: an entry appearing here means a field appeared in `ExplainOutput`, and the
 * question to ask is whether the projection should be saying that at all. Same for
 * `PROJECTION_AUTHORED_STRINGS` below. R115 closes it by deriving both from the output TYPE.
 *
 * Each entry is tagged with WHERE its value is allowed to come from. There are only four sources,
 * and "new prose invented by the projection" is not one of them:
 *   [registry] a member of ADMISSIBLE_INTERPRETATIONS, additionally identity-checked below
 *   [verbatim] copied unchanged from the report, additionally equality-checked below
 *   [enum]     a machine value from a closed set the report already carries, or derived from one
 *   [contract] the fixed EXPLAIN_CONTRACT text
 */
/**
 * The same set, DERIVED from `ExplainOutput`'s declaration instead of from observed output.
 *
 * R115 gap (1). See `typeLeafPaths` for the mechanism and why it parses rather than type-checks.
 * The two sets are asserted equal below; that equality is what turns a field no report provokes
 * from invisible into a dead pin entry, which the existing reachability test already fails on.
 *
 * `expectedLeafTypeNames` states every type allowed to become ONE path. All of them are closed
 * unions of string literals the report already carries, `Interpretation` excepted — which is
 * expanded, not listed, because `interpretation.ts` is in `files`.
 */
function derivedExplainLeafPaths(): readonly string[] {
  const src = join(import.meta.dir, "..", "src");
  return typeLeafPaths({
    files: [join(src, "explain.ts"), join(src, "interpretation.ts")],
    root: "ExplainOutput",
    expectedLeafTypeNames: [
      "Caveat",
      "CoverageAttribution",
      "GuardEvidence",
      "SurvivorReach",
      "ReachGrain",
      "SurvivorRanking",
      "MutantErrorCause",
      "ToolCondition",
      "ArtifactIdAbsence",
      'ReportValidity["reliability"]',
    ],
  });
}

const EXPLAIN_LEAF_PATHS: readonly string[] = [
  "$.explainSchemaVersion", // [enum] this build's constant
  "$.derivedFromReportSchemaVersion", // [verbatim] report.schemaVersion
  "$.contract.structureStableUnder", // [contract]
  "$.contract.proseIsContractual", // [contract]
  "$.contract.note", // [contract]
  "$.score.mutationScore", // [verbatim]
  "$.score.reliability", // [verbatim] validity.reliability
  "$.score.scoreDescribes", // [verbatim] validity.scoreDescribes
  "$.score.scored", // [verbatim] validity.scoredMutants.scored
  "$.score.recorded", // [verbatim] validity.scoredMutants.recorded
  "$.score.excludedFromScore.errors", // [verbatim] counts.errors
  "$.score.excludedFromScore.noCoverage", // [verbatim] counts.noCoverage
  "$.score.excludedFromScore.knownSurvivors", // [verbatim] counts.knownSurvivors
  "$.caveats[].caveat", // [enum] Caveat
  "$.caveats[].interpretation.meaning", // [registry]
  "$.caveats[].interpretation.entailedNegative", // [registry]
  "$.caveats[].interpretation.basis", // [registry]
  "$.survivorSelection.total", // [derived] survivors in the report, before any cap — R150
  "$.survivorSelection.shown", // [derived] survivors.length
  "$.survivorSelection.omitted", // [derived] total - shown
  "$.survivorSelection.rankedBy", // [enum] SurvivorRanking
  "$.survivors[].mutantCode", // [verbatim]
  "$.survivors[].file", // [verbatim]
  "$.survivors[].line", // [verbatim]
  "$.survivors[].codeunitName", // [verbatim]
  "$.survivors[].procedureName", // [verbatim]
  "$.survivors[].operatorName", // [verbatim]
  "$.survivors[].originalText", // [verbatim]
  "$.survivors[].mutatedText", // [verbatim]
  "$.survivors[].attribution", // [enum] CoverageAttribution
  "$.survivors[].executionProven", // [enum] derived: attribution === "exact"
  "$.survivors[].coveringTests[]", // [verbatim]
  "$.survivors[].guardEvidence", // [enum] GuardEvidence
  "$.survivors[].reach", // [enum] SurvivorReach, R116 and GH-24: see survivorReachOf
  "$.survivors[].interpretation.meaning", // [registry]
  "$.survivors[].interpretation.entailedNegative", // [registry]
  "$.survivors[].interpretation.basis", // [registry]
  "$.survivors[].guardInterpretation.meaning", // [registry]
  "$.survivors[].guardInterpretation.entailedNegative", // [registry]
  "$.survivors[].guardInterpretation.basis", // [registry]
  "$.survivors[].reachInterpretation.meaning", // [registry]
  "$.survivors[].reachInterpretation.entailedNegative", // [registry]
  "$.survivors[].reachInterpretation.basis", // [registry]
  "$.survivors[].reachGrain", // [enum] ReachGrain, verbatim from the report row (GH-24)
  "$.survivors[].reachedBy[]", // [verbatim] (GH-24)
  "$.survivors[].batchIndex", // [verbatim]
  "$.survivors[].triggerName", // [verbatim]
  "$.survivors[].procedureStartLine", // [verbatim]
  "$.survivors[].procedureEndLine", // [verbatim]
  "$.survivors[].equivalenceRisk", // [verbatim]
  "$.survivors[].readerMark.key", // [verbatim]
  "$.survivors[].readerMark.reason", // [verbatim]
  "$.survivors[].artifactId", // [joined] artifacts[].artifactId whose batchIndex equals the row's
  "$.survivors[].artifactIdAbsent", // [enum] ArtifactIdAbsence
  "$.notMeasured[].mutantCode", // [verbatim]
  "$.notMeasured[].file", // [verbatim]
  "$.notMeasured[].line", // [verbatim]
  "$.notMeasured[].operatorName", // [verbatim]
  "$.notMeasured[].cause", // [enum] MutantErrorCause
  "$.notMeasured[].failureNote", // [verbatim]
  "$.notMeasured[].interpretation.meaning", // [registry]
  "$.notMeasured[].interpretation.entailedNegative", // [registry]
  "$.notMeasured[].interpretation.basis", // [registry]
  "$.toolConditions[].condition", // [enum] ToolCondition
  "$.toolConditions[].count", // [verbatim] resumedFrom.skippedStranded
  "$.toolConditions[].detail", // [verbatim] quarantined.reason
  "$.toolConditions[].interpretation.meaning", // [registry]
  "$.toolConditions[].interpretation.entailedNegative", // [registry]
  "$.toolConditions[].interpretation.basis", // [registry]
];

// ————————————————————————————————————————————————————————————————————————————————————————
// The admissibility mechanism itself. The brief's regex is a lexical spot-check over three
// phrasings; a projection writing "these 19 deserve attention first" sails straight through it,
// which was measured. The two tests below are what decide what ships, and it takes BOTH: identity
// stops an inline Interpretation, the path pin stops a new field of any type at all.
//
// The registry members are, by construction, keyed to a machine value and co-located with it
// (report.ts / selection.ts) and carry a basis that `interpretation.test.ts` resolves against the
// real ROADMAP.md. Identity is what couples those three guarantees to the projection.
// ————————————————————————————————————————————————————————————————————————————————————————

describe("explain — the admissibility rule, made executable", () => {
  const registry = new Set<Interpretation>(ADMISSIBLE_INTERPRETATIONS);

  test("the registry is exactly the co-located constants — nothing invented, nothing missed", () => {
    const expected = new Set<Interpretation>([
      ...Object.values(ATTRIBUTION_INTERPRETATIONS),
      ...Object.values(CAVEAT_INTERPRETATIONS),
      ...Object.values(GUARD_EVIDENCE_INTERPRETATIONS),
      ...Object.values(REACH_INTERPRETATIONS),
      ...Object.values(ERROR_CAUSE_INTERPRETATIONS),
      QUARANTINE_INTERPRETATION,
      STRANDED_SKIP_INTERPRETATION,
    ]);
    expect(registry).toEqual(expected);
  });

  test("every interpretation in the output is a registry member BY IDENTITY", () => {
    const found = interpretationsIn(explain(fullCoverageReport()));
    expect(found.length).toBeGreaterThan(6);
    const foreign = found.filter((f) => !registry.has(f.value)).map((f) => f.path);
    expect(foreign).toEqual([]);
  });

  test("the output carries NO leaf at an unpinned path — whatever its type or wording", () => {
    // The fix-round-1 correction. Identity above is shape-scoped and cannot see a plain
    // `summary`/`advice`/`priority` field; this can, because it knows nothing about shape.
    const unpinned = [...new Set(leafPathsIn(explain(fullCoverageReport())))].filter(
      (p) => !EXPLAIN_LEAF_PATHS.includes(p),
    );
    expect(unpinned).toEqual([]);
  });

  test("fullCoverageReport describes a state `buildReport` could actually produce", () => {
    // Its doc comment claims this; without a check that claim is exactly the kind this session has
    // been correcting — an assertion of coverage that nothing holds. The final review found the
    // `resumed` caveat missing from a fixture whose comment already claimed producibility.
    //
    // Re-derives each field the way buildReport does (report.ts) rather than comparing to a
    // hardcoded expectation, so the fixture cannot be "fixed" by editing the numbers on both sides.
    const r = fullCoverageReport();
    const tally = (v: MutantVerdict) => r.mutants.filter((m) => m.verdict === v).length;
    expect(r.counts).toEqual({
      killed: tally("killed"),
      survived: tally("survived"),
      noCoverage: tally("no-coverage"),
      timeoutKilled: tally("timeout-killed"),
      knownSurvivors: tally("known-survivor"),
      errors: tally("error"),
      unstable: r.mutants.filter((m) => m.cause === "unstable").length,
      deadlineExceeded: r.mutants.filter((m) => m.cause === "deadline-exceeded").length,
    });
    const scored = r.counts.killed + r.counts.timeoutKilled + r.counts.survived;
    expect(r.validity.scoredMutants).toEqual({ scored, recorded: r.mutants.length });
    expect(r.mutationScore).toBe((r.counts.killed + r.counts.timeoutKilled) / scored);
    // `resumed` is pushed unconditionally when `resumedFrom` is set (report.ts); `narrowed` and
    // `tests-narrowed` likewise follow `only`/`testsOnly`, and `baseline-red` follows baselineGreen.
    expect(r.validity.caveats.includes("resumed")).toBe(r.resumedFrom !== undefined);
    expect(r.validity.caveats.includes("baseline-red")).toBe(!r.baselineGreen);
    expect(r.validity.caveats.includes("narrowed")).toBe(r.only !== undefined);
    // Both `resumedFrom` tallies are counted 1:1 from events by the fold, never free-standing.
    expect(r.resumedFrom?.carriedMutants).toBe(r.mutants.filter((m) => m.carried === true).length);
    expect(r.resumedFrom?.skippedStranded).toBe(
      r.mutants.filter((m) => m.failureNote?.startsWith("not re-run on resume:") === true).length,
    );
    // C02-01: `equivalenceRisk` only on a `survived` row, `readerMark` only on `survived` or
    // `known-survivor`, and both keyed to what `buildReport` would actually derive rather than to
    // a value the fixture merely asserts.
    const riskByOperator = new Map(tier1Operators.map((o) => [o.name, o.equivalenceRisk] as const));
    for (const m of r.mutants) {
      if (m.equivalenceRisk !== undefined) {
        expect(m.verdict).toBe("survived");
        const risk = riskByOperator.get(m.operatorName);
        if (risk === undefined) {
          throw new Error(
            `no tier1 operator named ${m.operatorName}, or it declares no equivalenceRisk`,
          );
        }
        expect(m.equivalenceRisk).toBe(risk);
      }
      if (m.readerMark !== undefined) {
        expect(["survived", "known-survivor"]).toContain(m.verdict);
        expect(m.readerMark.key).toBe(
          serializeKey({
            astHash: m.astHash,
            codeunitName: m.codeunitName,
            procedureName: m.procedureName,
            operatorName: m.operatorName,
            operatorMajor: m.operatorMajor,
            ordinal: m.identityOrdinal ?? 0,
          }),
        );
      }
    }
  });

  test("the pin is exactly what `ExplainOutput`'s TYPE can produce — R115 gap (1)", () => {
    // The pin was built from OBSERVED output, so a field emitted only under a condition no report
    // reaches was invisible in both directions: no unpinned leaf, no dead entry. Measured with
    // `...(survivors.length > 200 ? { summary: "…" } : {})` at 43 pass / 0 fail.
    //
    // The declaration has no such blind spot. Comparing the pin against it means such a field must
    // enter the pin, and the reachability test below then fails it for having no producer — which
    // is the assertion that actually catches it. Sorted, because neither set's ORDER is meaningful
    // and a diff on ordering would be noise.
    expect([...derivedExplainLeafPaths()].sort()).toEqual([...EXPLAIN_LEAF_PATHS].sort());
  });

  test("the type walk fails LOUDLY rather than flattening a struct it cannot expand", () => {
    // Guards the guard. If `typeLeafPaths` quietly turned an unresolvable type reference into one
    // leaf, the equality above would stay green while every field inside that type went unpinned —
    // empty-vs-empty, this project's signature bug. Dropping `interpretation.ts` from the file list
    // makes `Interpretation` exactly such a reference.
    const src = join(import.meta.dir, "..", "src");
    expect(() =>
      typeLeafPaths({
        files: [join(src, "explain.ts")],
        root: "ExplainOutput",
        expectedLeafTypeNames: [
          "Caveat",
          "CoverageAttribution",
          "GuardEvidence",
          "SurvivorReach",
          "MutantErrorCause",
          "ToolCondition",
          'ReportValidity["reliability"]',
        ],
      }),
    ).toThrow(TypeLeafPathError);
  });

  test("the pin has no dead entries — every pinned path is reachable", () => {
    // The other direction: a path left behind by a removed field would silently license anything
    // later reintroduced under that name. `fullCoverageReport` exists to reach every branch, so
    // every pinned path must appear in its projection.
    const produced = new Set(leafPathsIn(explain(fullCoverageReport())));
    expect(EXPLAIN_LEAF_PATHS.filter((p) => !produced.has(p))).toEqual([]);
  });

  test("every [verbatim] path really is verbatim — the projection copies, it does not compose", () => {
    // THE ONLY TEST CHECKING VALUES. The other three guards ask "is this string allowed to be
    // here?"; none asks "is this number right?". Final review measured the gap: swapping
    // scored<->recorded and noCoverage<->knownSurvivors left `bun test packages/runner` at 1441
    // pass / 0 fail, reporting a run that scored 160 of 473 as scoring 473 of 160, and 313
    // never-measured mutants relabelled as deliberately-excluded known findings. Every
    // [verbatim]-tagged path in EXPLAIN_LEAF_PATHS must be asserted here, against its source, over
    // a fixture whose values are pairwise distinct — see `fullCoverageReport`.
    const report = fullCoverageReport();
    const out = explain(report);
    expect(out.derivedFromReportSchemaVersion).toBe(report.schemaVersion);
    expect(out.score.scoreDescribes).toBe(report.validity.scoreDescribes);
    expect(out.score.reliability).toBe(report.validity.reliability);
    expect(out.score.mutationScore).toBe(report.mutationScore);
    // The five that were swappable. Asserted as one object so a swap between any pair shows as a
    // diff rather than as five independent equalities anyone could add four of.
    expect({
      ...out.score.excludedFromScore,
      scored: out.score.scored,
      recorded: out.score.recorded,
    }).toEqual({
      scored: report.validity.scoredMutants.scored,
      recorded: report.validity.scoredMutants.recorded,
      errors: report.counts.errors,
      noCoverage: report.counts.noCoverage,
      knownSurvivors: report.counts.knownSurvivors,
    });
    // And the fixture actually distinguishes them — a fixture with a repeat cannot detect a swap,
    // which is exactly how the defect above stayed green.
    const swappable = [
      report.validity.scoredMutants.scored,
      report.validity.scoredMutants.recorded,
      report.counts.errors,
      report.counts.noCoverage,
      report.counts.knownSurvivors,
    ];
    expect(new Set(swappable).size).toBe(swappable.length);
    // The same property for the per-row fields below: a swap is only detectable where the two
    // values differ, so pin that the fixture keeps them distinct rather than trusting it to.
    const [firstSurvivor] = report.mutants.filter((m) => m.verdict === "survived");
    const rowValues = [
      firstSurvivor?.file,
      firstSurvivor?.codeunitName,
      firstSurvivor?.procedureName,
      firstSurvivor?.operatorName,
      firstSurvivor?.originalText,
      firstSurvivor?.mutatedText,
      String(firstSurvivor?.line),
      String(firstSurvivor?.startIndex),
      // C02-01: the new span, and the batch this row was recorded in, distinct from every value
      // above and from each other.
      String(firstSurvivor?.procedureStartLine),
      String(firstSurvivor?.procedureEndLine),
      String(firstSurvivor?.batchIndex),
    ];
    expect(new Set(rowValues).size).toBe(rowValues.length);
    // EVERY per-row [verbatim] field, projected against source as whole rows rather than field by
    // field. The final review measured what the field-by-field form missed: six survivor fields
    // and three notMeasured fields had no value assertion anywhere, so swapping `file` with
    // `codeunitName` in `survivorOf` was 1444 pass / 0 fail, and reading `notMeasured[].line` off
    // `startIndex` (77 -> 200) was 48 pass / 0 fail. A whole-row `toEqual` cannot be partially
    // written: adding a field to `ExplainSurvivor` without adding it here fails the row compare.
    //
    // C02-01's three optional fields (`triggerName`, `equivalenceRisk`, `readerMark`) are compared
    // as present-or-absent KEYS rather than by value: reading `m.triggerName` through a plain
    // property access gives `undefined` whether the key is genuinely missing or present with an
    // `undefined` value, so a value comparison alone cannot catch `survivorOf` writing the key
    // where the source omitted it (`...(v !== undefined ? { k: v } : {})` broken into `k: v`).
    const survivorSources = report.mutants.filter((m) => m.verdict === "survived");
    const survivorVerbatim = (m: {
      mutantCode: string;
      file: string;
      line: number;
      codeunitName: string;
      procedureName: string;
      operatorName: string;
      originalText: string;
      mutatedText: string;
      coveringTests: readonly string[];
      batchIndex?: number;
      procedureStartLine?: number;
      procedureEndLine?: number;
      triggerName?: string;
      equivalenceRisk?: string;
      readerMark?: { readonly key: string; readonly reason: string };
      reachGrain?: string;
      reachedBy?: readonly string[];
    }) => ({
      mutantCode: m.mutantCode,
      file: m.file,
      line: m.line,
      codeunitName: m.codeunitName,
      procedureName: m.procedureName,
      operatorName: m.operatorName,
      originalText: m.originalText,
      mutatedText: m.mutatedText,
      coveringTests: m.coveringTests,
      batchIndex: m.batchIndex,
      procedureStartLine: m.procedureStartLine,
      procedureEndLine: m.procedureEndLine,
      hasTriggerName: "triggerName" in m,
      triggerName: m.triggerName,
      hasEquivalenceRisk: "equivalenceRisk" in m,
      equivalenceRisk: m.equivalenceRisk,
      hasReaderMark: "readerMark" in m,
      readerMark: m.readerMark,
      hasReachGrain: "reachGrain" in m,
      reachGrain: m.reachGrain,
      hasReachedBy: "reachedBy" in m,
      reachedBy: m.reachedBy,
    });
    expect(out.survivors.map(survivorVerbatim)).toEqual(survivorSources.map(survivorVerbatim));
    const errorSources = report.mutants.filter((m) => m.verdict === "error");
    const notMeasuredVerbatim = (m: {
      mutantCode: string;
      file: string;
      line: number;
      operatorName: string;
      failureNote?: string;
    }) => ({
      mutantCode: m.mutantCode,
      file: m.file,
      line: m.line,
      operatorName: m.operatorName,
      failureNote: m.failureNote,
    });
    expect(out.notMeasured.map(notMeasuredVerbatim)).toEqual(errorSources.map(notMeasuredVerbatim));
    expect(out.toolConditions.find((c) => c.condition === "quarantined")?.detail).toBe(
      report.quarantined?.reason,
    );
    expect(out.toolConditions.find((c) => c.condition === "stranded-skips")?.count).toBe(
      report.resumedFrom?.skippedStranded,
    );
  });

  test("an archived report projects the new fields as absent, never defaulted (C02-01)", () => {
    // A pre-C02-01 row: no span, no row-level risk or mark. The RUN-level lists are present and
    // name this row's mutantCode, to prove explain never joins them.
    // Destructured off rather than deleted, so the key is genuinely absent from the start,
    // never present with an `undefined` value.
    const { procedureStartLine, procedureEndLine, ...row } = survivorMutant("M0001", "exact", true);
    const report = reportFixture({
      mutants: [row],
      likelyEquivalentSurvivors: {
        count: 1,
        byRisk: [{ risk: "value-rewrite", mutants: ["M0001"], meaning: "m" }],
      },
      readerMarkedEquivalent: {
        matched: [{ mutantCode: "M0001", key: "K", reason: "R" }],
        stale: [],
        contradicted: [],
      },
    });
    const [s] = explain(report).survivors;
    expect(s?.batchIndex).toBe(row.batchIndex);
    for (const k of [
      "procedureStartLine",
      "procedureEndLine",
      "equivalenceRisk",
      "readerMark",
      "triggerName",
    ]) {
      expect(k in (s ?? {})).toBe(false);
    }
  });

  test("a trigger survivor carries triggerName and its span (C02-01)", () => {
    const row: MutantOutcome = {
      ...survivorMutant("M0001", "exact", true),
      procedureName: "",
      triggerName: "OnInsert",
      procedureStartLine: 11,
      procedureEndLine: 14,
    };
    const [s] = explain(reportFixture({ mutants: [row] })).survivors;
    expect(s?.procedureName).toBe("");
    expect(s?.triggerName).toBe("OnInsert");
    expect(s?.procedureStartLine).toBe(11);
    expect(s?.procedureEndLine).toBe(14);
  });

  test("the contract is EXACTLY the pinned object, field for field, and is the shared constant", () => {
    // Fix round 2. Equality, not phrasing — see PINNED_CONTRACT_NOTE.
    const out = explain(fullCoverageReport());
    expect(out.contract.note).toBe(PINNED_CONTRACT_NOTE);
    // WHOLE-OBJECT, not just `note`, and that is R115 gap (3)'s other half.
    // `PROJECTION_AUTHORED_STRINGS` now admits every string value of `EXPLAIN_CONTRACT`
    // wholesale, so an added contract field would otherwise widen the allowed-string set
    // silently — which is exactly the smuggling route being closed. A `toEqual` on the whole
    // object makes adding one a visible, argued change instead.
    expect(EXPLAIN_CONTRACT).toEqual({
      structureStableUnder: "explainSchemaVersion",
      proseIsContractual: false,
      note: PINNED_CONTRACT_NOTE,
    });
    // Emitted by reference, like the interpretations — never composed fresh per call, which is what
    // would let one caller's contract statement differ from another's.
    expect(out.contract).toBe(EXPLAIN_CONTRACT);
  });

  test("every string in the output comes from the report, the registry, or a pinned literal", () => {
    // The general form of the fix-round-2 finding: identity covers Interpretation-shaped prose and
    // the leaf pin covers new PATHS, but neither covers new TEXT at an existing path. This does.
    const report = fullCoverageReport();
    const allowed = new Set<string>([
      ...stringsIn(report), // [verbatim]
      ...ADMISSIBLE_INTERPRETATIONS.flatMap((i) => [i.meaning, i.basis, i.entailedNegative ?? ""]),
      ...PROJECTION_AUTHORED_STRINGS,
    ]);
    expect(stringsIn(explain(report)).filter((s) => !allowed.has(s))).toEqual([]);
  });

  test("no string the projection SHIPS tells a reader what test to write", () => {
    // Scans the registry AND the projection's own authored strings — `contract.note` used to be
    // outside every scan, which is how the fix-round-2 probe reached the real artifact. Still only
    // a spot-check over known phrasings: see `CAVEAT_INTERPRETATIONS`'s doc comment (report.ts) on
    // what co-location does and does not buy. Target/tool discipline inside an admissible string is
    // a human judgement at review time; no test here decides it.
    //
    // Note this scans the TEST's copy of the contract note, not the source constant, so it cannot
    // see an edit to `explain.ts` on its own. That is the intended two-stage flow: the EQUALITY pin
    // above reddens on any source edit whatever its wording, the author then has to update the pin
    // deliberately, and this fires if what they pasted in carries a known phrasing.
    const banned = /write a test|add an assertion|you should test|strengthen (these|this|the)/i;
    const offenders = [
      ...ADMISSIBLE_INTERPRETATIONS.flatMap((i) => [i.meaning, i.entailedNegative ?? ""]),
      ...PROJECTION_AUTHORED_STRINGS,
    ].filter((s) => banned.test(s));
    expect(offenders).toEqual([]);
  });
});

// ————————————————————————————————————————————————————————————————————————————————————————
// Survivors: the section the subsystem exists for.
// ————————————————————————————————————————————————————————————————————————————————————————

describe("explain — survivors", () => {
  test("executionProven is TRUE only for an exact (member-level) attribution", () => {
    const out = explain(
      reportFixture({
        mutants: [
          survivorMutant("M0001", "exact", true),
          survivorMutant("M0002", "object", true),
          survivorMutant("M0003", "all-green", true),
        ],
      }),
    );
    expect(out.survivors.map((s) => [s.mutantCode, s.executionProven])).toEqual([
      ["M0001", true],
      ["M0002", false],
      ["M0003", false],
    ]);
  });

  test("each survivor's interpretation is the shared attribution constant, by identity", () => {
    const out = explain(
      reportFixture({
        mutants: [survivorMutant("M0001", "exact", true), survivorMutant("M0002", "object", true)],
      }),
    );
    expect(out.survivors[0]?.interpretation).toBe(ATTRIBUTION_INTERPRETATIONS.exact);
    expect(out.survivors[1]?.interpretation).toBe(ATTRIBUTION_INTERPRETATIONS.object);
  });

  test("guardObserved's THREE states stay three — absent is never folded into false", () => {
    const out = explain(
      reportFixture({
        mutants: [
          survivorMutant("M0001", "exact", true),
          survivorMutant("M0002", "exact", false),
          survivorMutant("M0003", "exact"),
        ],
      }),
    );
    expect(out.survivors.map((s) => s.guardEvidence)).toEqual([
      "observed",
      "not-observed",
      "not-measured",
    ]);
    expect(out.survivors[1]?.guardInterpretation).toBe(
      GUARD_EVIDENCE_INTERPRETATIONS["not-observed"],
    );
    expect(out.survivors[2]?.guardInterpretation).toBe(
      GUARD_EVIDENCE_INTERPRETATIONS["not-measured"],
    );
  });

  test("executionProven TRUE beside guardEvidence 'not-observed' is NOT a contradiction — R116", () => {
    // The row this test was filed for is DECIDED, and the decision reversed its original reading.
    // The pair looked like two measurements disagreeing. It is not: `exact` attribution is a
    // MEMBER-level coverage match from the BASELINE run (a test executed the mutated PROCEDURE),
    // while `not-observed` is the MUTANT run's attestation that no guarded STATEMENT ran, because
    // `ObservedAny` is set inside `IsActive` at each mutation SITE. Different granularity,
    // different runs. A test can enter a procedure and never reach one statement inside it.
    //
    // So the pair is MORE actionable than either half — "this test enters the procedure but never
    // reaches this line" — and reconciling it upstream, which the row considered, would have
    // destroyed that. The projection now NAMES the state instead of leaving the reader to spot it.
    const out = explain(reportFixture({ mutants: [survivorMutant("M0001", "exact", false)] }));
    const [s] = out.survivors;
    expect(s?.executionProven).toBe(true);
    expect(s?.guardEvidence).toBe("not-observed");
    expect(s?.reach).toBe("covered-but-unreached");
    expect(s?.interpretation).toBe(ATTRIBUTION_INTERPRETATIONS.exact);
    expect(s?.guardInterpretation).toBe(GUARD_EVIDENCE_INTERPRETATIONS["not-observed"]);
    expect(s?.reachInterpretation).toBe(REACH_INTERPRETATIONS["covered-but-unreached"]);
    expect(Object.keys(s ?? {}).sort()).toEqual(
      [
        // C02-01 Task 4: `reportFixture()` has no `artifacts`, so the row says `not-recorded`.
        "artifactIdAbsent",
        "attribution",
        "batchIndex",
        "codeunitName",
        "coveringTests",
        "executionProven",
        "file",
        "guardEvidence",
        "guardInterpretation",
        "interpretation",
        "line",
        "mutantCode",
        "mutatedText",
        "operatorName",
        "originalText",
        "procedureEndLine",
        "procedureName",
        "procedureStartLine",
        "reach",
        "reachInterpretation",
      ].sort(),
    );
  });

  test("`reach` separates covered-but-unreached from genuinely uncovered", () => {
    // The distinction the shipped `not-observed` prose used to erase by telling every reader to
    // file such a mutant with `no-coverage`. That is right for `object`/`all-green` and WRONG for
    // `exact`, and the two call for different work: a new case covering the branch, versus a test
    // for code nothing exercises at all.
    const out = explain(
      reportFixture({
        mutants: [
          survivorMutant("M0001", "exact", false),
          survivorMutant("M0002", "object", false),
          survivorMutant("M0003", "all-green", false),
        ],
      }),
    );
    expect(out.survivors.map((s) => s.reach)).toEqual([
      "covered-but-unreached",
      "unreached-and-uncovered",
      "unreached-and-uncovered",
    ]);
  });

  test("`reach` is `not-decided` whenever the guard attestation is not decisive", () => {
    // `observed` says only that SOME guarded site fired somewhere in the artifact, and
    // `not-measured` says no attestation exists. Neither can place THIS statement, so the pair
    // must say nothing rather than guess — including for `exact`, the case most tempting to read
    // as proof the line ran.
    const out = explain(
      reportFixture({
        mutants: [
          survivorMutant("M0001", "exact", true),
          survivorMutant("M0002", "exact"),
          survivorMutant("M0003", "object", true),
        ],
      }),
    );
    expect(out.survivors.map((s) => s.reach)).toEqual([
      "not-decided",
      "not-decided",
      "not-decided",
    ]);
  });

  test("only `survived` mutants become survivors", () => {
    const out = explain(
      reportFixture({
        mutants: [survivorMutant("M0001", "exact", true), errorMutant("M0002", "unstable")],
      }),
    );
    expect(out.survivors.map((s) => s.mutantCode)).toEqual(["M0001"]);
  });
});

// GH-24: reach decided PER MUTANT from `guardReached`, the mutant's own statement marker, where
// the report carries it. The batch-wide `guardObserved` decides only an archived row (no grain).

describe("GH-24: reach decided per mutant", () => {
  function reachMutant(
    code: string,
    attribution: CoverageAttribution,
    guardObserved: boolean | undefined,
    extra: Partial<MutantOutcome>,
  ): MutantOutcome {
    return { ...survivorMutant(code, attribution, guardObserved), ...extra };
  }

  test("GH-24: guardReached true reads reached-unnoticed and carries reachedBy", () => {
    const out = explain(
      reportFixture({
        mutants: [
          reachMutant("M0001", "exact", true, {
            reachGrain: "statement",
            guardReached: true,
            reachedBy: ["Foo Tests.ComputesTotal"],
          }),
        ],
      }),
    );
    const s = out.survivors[0];
    expect(s?.reach).toBe("reached-unnoticed");
    expect(s?.reachInterpretation).toBe(REACH_INTERPRETATIONS["reached-unnoticed"]);
    expect(s?.reachedBy).toEqual(["Foo Tests.ComputesTotal"]);
    expect(s?.reachGrain).toBe("statement");
  });

  test("GH-24: guardReached false decides unreached even when guardObserved is true", () => {
    // `guardObserved: true` alone is `not-decided` under R116 (some guard fired SOMEWHERE). The
    // mutant's own marker answering "not reached" in every run is the per-mutant fact that decides.
    const out = explain(
      reportFixture({
        mutants: [
          reachMutant("M0001", "exact", true, {
            reachGrain: "statement",
            guardReached: false,
            reachedBy: [],
          }),
          reachMutant("M0002", "object", true, {
            reachGrain: "statement",
            guardReached: false,
            reachedBy: [],
          }),
        ],
      }),
    );
    expect(out.survivors.map((s) => s.reach)).toEqual([
      "covered-but-unreached",
      "unreached-and-uncovered",
    ]);
    expect(out.survivors[0]?.reachedBy).toEqual([]);
  });

  test("GH-24: absent guardReached falls back to the R116 derivation", () => {
    // Every committed campaign report predates GH-24, so none carries a grain: each survivor must
    // read exactly what R116's pair says, and every report must still project.
    const campaignDir = join(
      import.meta.dir,
      "..",
      "..",
      "..",
      "docs",
      "campaign",
      "2026-08-03-do",
    );
    let checked = 0;
    for (const name of [
      "rung1.report.json",
      "rung1.resumed-run.report.json",
      "rung1.run2-partial.report.json",
      "rung2.report.json",
      "rung3.independent-confirm.report.json",
      "rung3.redcheck.report.json",
    ]) {
      const report = assertExplainableReport(
        JSON.parse(readFileSync(join(campaignDir, name), "utf8")),
      );
      for (const s of explain(report).survivors) {
        const r116 =
          s.guardEvidence === "not-observed"
            ? s.executionProven
              ? "covered-but-unreached"
              : "unreached-and-uncovered"
            : "not-decided";
        expect(`${name} ${s.mutantCode} ${s.reach}`).toBe(`${name} ${s.mutantCode} ${r116}`);
        expect("reachGrain" in s || "reachedBy" in s).toBe(false);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(100);
  });

  test("GH-24: enclosing grain stays not-decided and says so", () => {
    // `guardObserved: FALSE` on purpose: under R116 alone these read covered-but-unreached and
    // unreached-and-uncovered. Only the grain arm keeps them `not-decided`, which is the point.
    const out = explain(
      reportFixture({
        mutants: [
          reachMutant("M0001", "exact", false, { reachGrain: "enclosing" }),
          reachMutant("M0002", "object", false, { reachGrain: "unplaced" }),
        ],
      }),
    );
    expect(out.survivors.map((s) => [s.reach, s.reachGrain])).toEqual([
      ["not-decided", "enclosing"],
      ["not-decided", "unplaced"],
    ]);
    expect(out.survivors.some((s) => "reachedBy" in s)).toBe(false);
    expect(REACH_INTERPRETATIONS["not-decided"].meaning).toContain("reachGrain");
  });

  test("GH-24: a --resume-carried row and a statement run with no answer read not-decided", () => {
    // A carried row keeps its grain but never `guardReached`, and a statement-grain mutant whose
    // runs ended without an answer has none either. Neither may fall through to the batch-wide
    // `guardObserved: false` and read as unreached.
    const out = explain(
      reportFixture({
        mutants: [
          reachMutant("M0001", "exact", false, { reachGrain: "statement", carried: true }),
          reachMutant("M0002", "object", false, { reachGrain: "statement" }),
        ],
      }),
    );
    expect(out.survivors.map((s) => s.reach)).toEqual(["not-decided", "not-decided"]);
  });

  test("GH-24: an archived row with no grain keeps the R116 derivation", () => {
    const out = explain(
      reportFixture({
        mutants: [
          survivorMutant("M0001", "exact", false),
          survivorMutant("M0002", "object", false),
          survivorMutant("M0003", "exact", true),
        ],
      }),
    );
    expect(out.survivors.map((s) => s.reach)).toEqual([
      "covered-but-unreached",
      "unreached-and-uncovered",
      "not-decided",
    ]);
  });

  test("GH-24: contradictory reach fields are refused", () => {
    const bad = (extra: Record<string, unknown>, guardObserved: boolean | undefined = true) =>
      reportFixture({
        mutants: [{ ...survivorMutant("M0001", "exact", guardObserved), ...extra }],
      } as unknown as Partial<SessionReport>);
    const cases: readonly [string, SessionReport][] = [
      // A marker runs only inside a branch whose guard ran, so reached without observed is corrupt.
      [
        "guardObserved",
        bad({ reachGrain: "statement", guardReached: true, reachedBy: ["T.A"] }, false),
      ],
      // Only a statement-grain mutant carries a marker.
      ["reachGrain", bad({ reachGrain: "enclosing", guardReached: false, reachedBy: [] })],
      ["reachGrain", bad({ guardReached: true, reachedBy: ["T.A"] })],
      // The two travel together.
      ["reachedBy", bad({ reachGrain: "statement", reachedBy: ["T.A"] })],
      ["reachedBy", bad({ reachGrain: "statement", guardReached: true })],
      // Types: a coerced value would decide reach.
      ["guardReached", bad({ reachGrain: "statement", guardReached: "true", reachedBy: [] })],
      ["reachedBy", bad({ reachGrain: "statement", guardReached: true, reachedBy: [7] })],
      ["reachGrain", bad({ reachGrain: "expression" })],
      // GH-24b: a marker that fired names at least one covering test; guardReached true with
      // nothing in reachedBy is corrupt the same way as the pairs above.
      ["reachedBy", bad({ reachGrain: "statement", guardReached: true, reachedBy: [] })],
    ];
    for (const [field, report] of cases) {
      expect(() => explain(report)).toThrow(MalformedReportError);
      expect(() => explain(report)).toThrow(new RegExp(field));
    }
  });

  test("GH-24: reached-unnoticed ranks first", () => {
    const reached = reachMutant("M0005", "object", true, {
      reachGrain: "statement",
      guardReached: true,
      reachedBy: ["Foo Tests.ComputesTotal"],
    });
    const out = explain(
      reportFixture({
        mutants: [
          survivorMutant("M0004", "object", false),
          survivorMutant("M0003", "object", true),
          survivorMutant("M0002", "exact", false),
          survivorMutant("M0001", "exact", true),
          reached,
        ],
      }),
      { topSurvivors: 5 },
    );
    expect(out.survivors.map((s) => [s.mutantCode, s.reach] as const)).toEqual([
      ["M0005", "reached-unnoticed"],
      ["M0001", "not-decided"],
      ["M0002", "covered-but-unreached"],
      ["M0003", "not-decided"],
      ["M0004", "unreached-and-uncovered"],
    ]);
    expect(out.survivors.map(survivorActionabilityRank)).toEqual([0, 1, 2, 3, 4]);
  });
});

// ————————————————————————————————————————————————————————————————————————————————————————
// R150 — the bounded projection. `explain` on a real campaign report is 253 KB, 209 KB of it
// survivors, which is a file an agent consumer cannot hold. `topSurvivors` bounds it. Every test
// below is about the same danger: a capped list that reads like a complete one.
// ————————————————————————————————————————————————————————————————————————————————————————

describe("explain — survivorSelection and the cap", () => {
  /** One survivor per used rank tier (4 through 1; tier 0, reached-unnoticed, is not in this
   *  fixture), deliberately in the WORST order, so any test asserting a ranked result would also
   *  pass on an unsorted one only by accident. Rank comes from the pair (attribution,
   *  guardObserved): see `survivorActionabilityRank`. */
  function oneOfEachRank(): MutantOutcome[] {
    return [
      survivorMutant("M0004", "object", false), // rank 4: unreached-and-uncovered
      survivorMutant("M0003", "object", true), // rank 3: not-decided, not execution-proven
      survivorMutant("M0002", "exact", false), // rank 2: covered-but-unreached
      survivorMutant("M0001", "exact", true), // rank 1: the most evidence in this fixture
    ];
  }

  test("with no cap: every survivor, in REPORT order, and the block says so", () => {
    // The uncapped path must not quietly start ranking. Callers that predate the cap read
    // `survivors` positionally against their own report, and `report-order` is the promise that
    // still holds for them.
    const out = explain(reportFixture({ mutants: oneOfEachRank() }));
    expect(out.survivors.map((s) => s.mutantCode)).toEqual(["M0004", "M0003", "M0002", "M0001"]);
    expect(out.survivorSelection).toEqual({
      total: 4,
      shown: 4,
      omitted: 0,
      rankedBy: "report-order",
    });
  });

  test("the count block is emitted even when NOTHING was capped", () => {
    // The whole point of emitting it unconditionally: a consumer reads `total` without first having
    // to decide whether the field's absence means "complete" or "this build is older than the cap".
    const out = explain(reportFixture({ mutants: [survivorMutant("M0001", "exact", true)] }));
    expect(out.survivorSelection.total).toBe(1);
    expect(out.survivorSelection.omitted).toBe(0);
  });

  test("a cap keeps the ranked PREFIX and STATES what it dropped", () => {
    const out = explain(reportFixture({ mutants: oneOfEachRank() }), { topSurvivors: 2 });
    expect(out.survivors.map((s) => s.mutantCode)).toEqual(["M0001", "M0002"]);
    expect(out.survivorSelection).toEqual({
      total: 4,
      shown: 2,
      omitted: 2,
      rankedBy: "actionability",
    });
  });

  test("`shown` and `omitted` describe the array actually emitted, not the request", () => {
    // The failure this catches is a cap that reports what it was ASKED for. `--top 10` against 4
    // survivors must not say `shown: 10`, and `omitted` must never go negative.
    const out = explain(reportFixture({ mutants: oneOfEachRank() }), { topSurvivors: 10 });
    expect(out.survivors).toHaveLength(4);
    expect(out.survivorSelection).toEqual({
      total: 4,
      shown: 4,
      omitted: 0,
      rankedBy: "actionability",
    });
  });

  test("the rank is the documented tier order, and it is over EVIDENCE", () => {
    const out = explain(reportFixture({ mutants: oneOfEachRank() }), { topSurvivors: 4 });
    expect(out.survivors.map((s) => [s.mutantCode, s.executionProven, s.reach] as const)).toEqual([
      ["M0001", true, "not-decided"],
      ["M0002", true, "covered-but-unreached"],
      ["M0003", false, "not-decided"],
      ["M0004", false, "unreached-and-uncovered"],
    ]);
    expect(out.survivors.map(survivorActionabilityRank)).toEqual([1, 2, 3, 4]);
  });

  test("the order is TOTAL — ties break on file, then line, then mutantCode", () => {
    // Without a total order the contents of `--top n` depend on the sort implementation, so the
    // same report and the same cap could disagree between two machines. Every mutant here is rank
    // 1, so ONLY the tie-breaks decide, and they are fed in reverse of the expected result.
    const same = (code: string, file: string, line: number): MutantOutcome => ({
      ...survivorMutant(code, "exact", true),
      file,
      line,
    });
    const out = explain(
      reportFixture({
        mutants: [
          same("M0009", "src/B.al", 10),
          same("M0002", "src/A.al", 99),
          same("M0001", "src/A.al", 99),
          same("M0003", "src/A.al", 7),
        ],
      }),
      { topSurvivors: 4 },
    );
    expect(out.survivors.map((s) => s.mutantCode)).toEqual(["M0003", "M0001", "M0002", "M0009"]);
  });

  test("ranking does not mutate the caller's array", () => {
    const survivors = explain(reportFixture({ mutants: oneOfEachRank() })).survivors;
    const before = survivors.map((s) => s.mutantCode);
    rankSurvivors(survivors);
    expect(survivors.map((s) => s.mutantCode)).toEqual(before);
  });

  test("a cap that is not a positive integer is REFUSED, never clamped", () => {
    // `--top 0` has two plausible readings ("none" / "all") and a projection that picks one is
    // guessing about completeness, which is the one thing this block exists to make impossible.
    const report = reportFixture({ mutants: oneOfEachRank() });
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => explain(report, { topSurvivors: bad })).toThrow(/positive integer/);
    }
  });

  test("the cap bounds survivors ONLY — notMeasured is untouched and still complete", () => {
    // Stated as a test rather than left to the help text: a consumer that caps survivors must not
    // silently receive a shortened error list too, because nothing in the output would say so.
    const out = explain(
      reportFixture({
        mutants: [...oneOfEachRank(), errorMutant("M0010", "unstable"), errorMutant("M0011")],
      }),
      { topSurvivors: 1 },
    );
    expect(out.survivors).toHaveLength(1);
    expect(out.notMeasured.map((n) => n.mutantCode)).toEqual(["M0010", "M0011"]);
  });
});

// ————————————————————————————————————————————————————————————————————————————————————————
// Tool mechanics — the half of the line the projection IS allowed to be prescriptive about.
// ————————————————————————————————————————————————————————————————————————————————————————

describe("explain — tool mechanics", () => {
  test("a deadline-exceeded error is projected as not-a-verdict, with R91's prescription", () => {
    const out = explain(reportFixture({ mutants: [errorMutant("M0003", "deadline-exceeded")] }));
    expect(out.notMeasured.map((n) => n.mutantCode)).toEqual(["M0003"]);
    expect(out.notMeasured[0]?.interpretation).toBe(
      ERROR_CAUSE_INTERPRETATIONS["deadline-exceeded"],
    );
    // The prescription is about LethAL's own machinery, so it names the flag.
    expect(out.notMeasured[0]?.interpretation?.meaning).toContain("--mutant-timeout-ms");
  });

  /**
   * R114's acceptance, stated as the property the projection could not have.
   *
   * A STRANDED mutant — one whose run returned no readable result and whose operation could not be
   * confirmed complete, so the tier was quarantined — reached the report with `cause: undefined`.
   * Measured on real campaign data: all three `error` verdicts in `rung1.run2-partial` carried it.
   * The prose the operator needs was in `failureNote`, which the explain contract explicitly forbids
   * consumers to parse, so R91's prescription was keyed on the right machine value and could NEVER
   * fire for the case R91 measured. Machinery that runs, reports success, and measures nothing.
   *
   * `stranded` is its OWN cause rather than a reuse of `deadline-exceeded`, and the difference is
   * not cosmetic: `deadline-exceeded` means the budget elapsed and a backend told us the mutant is
   * over, so the container is clean. A strand means we do NOT know whether it is over. Both want the
   * same first move — raise the floor and resume — so both carry that; only one of them can also
   * promise the tier is fine.
   */
  test("R114: a STRANDED error carries the stranded cause and emits R91's prescription", () => {
    const strand = {
      ...errorMutant("M0003", "stranded"),
      failureNote:
        "quarantined: Foo Tests.PostsBatch returned no readable result and its operation could " +
        "not be confirmed complete — container may be stranded. Its budget was 180000 ms",
    };
    const out = explain(reportFixture({ mutants: [strand] }));
    expect(out.notMeasured[0]?.cause).toBe("stranded");
    expect(out.notMeasured[0]?.interpretation).toBe(ERROR_CAUSE_INTERPRETATIONS.stranded);
    // R91's prescription, by the flag it names — this is the property the row says it cannot have.
    expect(out.notMeasured[0]?.interpretation?.meaning).toContain("--mutant-timeout-ms");
    expect(out.notMeasured[0]?.interpretation?.meaning).toContain("--resume");
    // And the half `deadline-exceeded` must NOT be allowed to claim for a strand: that the mutant
    // is done. Asserted on the entailed negative rather than by comparing the two registry entries,
    // because two entries could drift into saying the same thing and still differ by identity.
    expect(out.notMeasured[0]?.interpretation?.entailedNegative).toContain("not know");
  });

  /**
   * R122(b). The third `error` shape, and the one that had no machine value at all: the run
   * provably COMPLETED server-side and only its answer could not be read. It is not a deadline (no
   * budget elapsed) and it is not a strand (a strand is precisely the case where nobody knows
   * whether the op finished — this is the case where a reconciling read proved it did).
   *
   * The pair is asserted against each other rather than in isolation, because the whole risk here
   * is the two collapsing into one meaning: reading a result-lost as a strand sends an operator to
   * recycle a healthy container and wait for `--retry-stranded`, when `--resume` alone fixes it.
   */
  test("R122: a result-lost error is distinguishable from a strand, and prescribes --resume", () => {
    const out = explain(reportFixture({ mutants: [errorMutant("M0003", "result-lost")] }));
    expect(out.notMeasured[0]?.cause).toBe("result-lost");
    expect(out.notMeasured[0]?.interpretation).toBe(ERROR_CAUSE_INTERPRETATIONS["result-lost"]);
    expect(out.notMeasured[0]?.interpretation?.meaning).toContain("--resume");
    // The two must not say the same thing. `stranded` cannot promise the container is fine;
    // `result-lost` is the one that can, and that promise is the difference an operator acts on.
    expect(out.notMeasured[0]?.interpretation?.meaning).toContain("container is explicitly fine");
    expect(ERROR_CAUSE_INTERPRETATIONS.stranded.meaning).not.toContain(
      "container is explicitly fine",
    );
  });

  test("an error with NO recorded cause carries no interpretation — and says nothing instead", () => {
    // The honest shape: LethAL records `cause` at only the two call sites that know it, so a
    // stranded operation reaches the report with `cause` absent. Inventing a meaning here would
    // be exactly the free-floating claim the keying rule exists to refuse.
    const out = explain(reportFixture({ mutants: [errorMutant("M0003")] }));
    expect(out.notMeasured[0]?.cause).toBeUndefined();
    expect(out.notMeasured[0]?.interpretation).toBeUndefined();
    expect(out.notMeasured[0]?.failureNote).toContain("deadline exceeded running");
  });

  test("a quarantined session is reported as a tool condition, not as a clean result", () => {
    const out = explain(
      reportFixture({ quarantined: { reason: "test in-flight-unknown running X (mutant M0004)" } }),
    );
    const q = out.toolConditions.find((c) => c.condition === "quarantined");
    expect(q?.interpretation).toBe(QUARANTINE_INTERPRETATION);
    expect(q?.detail).toContain("in-flight-unknown");
    // `count` is 0 BY ARGUMENT, not by accident: the mutants a quarantine cost were never
    // scheduled, so the report structurally cannot count them, and the interpretation says they are
    // absent rather than survived. The field's doc comment argued that and no test held it — a
    // `count: 7` here was 45 pass / 0 fail (final review, Minor 3).
    expect(q?.count).toBe(0);
  });

  test("an EMPTY quarantine reason omits `detail` rather than emitting a blank one", () => {
    // The other half of Minor 3: the `reason !== ""` guard was unasserted, so deleting it was also
    // 45 pass / 0 fail. An empty `detail` would read as "quarantined, and here is why: <nothing>";
    // omitting it says the report carried no reason, which is what happened.
    const out = explain(reportFixture({ quarantined: { reason: "" } }));
    const q = out.toolConditions.find((c) => c.condition === "quarantined");
    expect(q).toBeDefined();
    expect(q?.detail).toBeUndefined();
    expect(q?.interpretation).toBe(QUARANTINE_INTERPRETATION);
  });

  test("stranded skips are reported with their count; zero produces no condition at all", () => {
    const withSkips = explain(
      reportFixture({ resumedFrom: { runId: 7, carriedMutants: 3, skippedStranded: 2 } }),
    );
    const s = withSkips.toolConditions.find((c) => c.condition === "stranded-skips");
    expect(s?.count).toBe(2);
    expect(s?.interpretation).toBe(STRANDED_SKIP_INTERPRETATION);

    const noSkips = explain(
      reportFixture({ resumedFrom: { runId: 7, carriedMutants: 3, skippedStranded: 0 } }),
    );
    expect(noSkips.toolConditions.map((c) => c.condition)).not.toContain("stranded-skips");
  });

  test("a clean run reports no tool conditions", () => {
    expect(explain(reportFixture()).toolConditions).toEqual([]);
  });
});

// ————————————————————————————————————————————————————————————————————————————————————————
// The split contract (brief Step 3), stated in the output itself.
// ————————————————————————————————————————————————————————————————————————————————————————

describe("explain — the split contract", () => {
  test("the output states that structure is versioned and prose is NOT", () => {
    const out = explain(reportFixture());
    expect(out.contract.structureStableUnder).toBe("explainSchemaVersion");
    expect(out.contract.proseIsContractual).toBe(false);
    const note = out.contract.note.toLowerCase();
    expect(note).toContain("do not parse");
    expect(note).toContain("without a version bump");
    // Why parsing prose is unnecessary rather than merely discouraged.
    expect(note).toContain("structured field");
  });

  test("the score arrives with its own qualifications, verbatim from the report", () => {
    const report = reportFixture();
    const out = explain(report);
    expect(out.score.mutationScore).toBe(report.mutationScore);
    expect(out.score.reliability).toBe("narrowed");
    expect(out.score.scoreDescribes).toBe(report.validity.scoreDescribes);
    expect(out.score.excludedFromScore).toEqual({ errors: 1, noCoverage: 0, knownSurvivors: 0 });
  });
});

// ————————————————————————————————————————————————————————————————————————————————————————
// C02-01 Task 4: each survivor names the artifact its batch recorded, or says why not. Fixture ids
// are literals, so the oracle is the fixture, never the lookup.
// ————————————————————————————————————————————————————————————————————————————————————————

describe("explain — artifactId (C02-01)", () => {
  const A1 = "0123456789abcdef0123456789abcdef";
  const A4 = "fedcba9876543210fedcba9876543210";
  const artifacts = [
    { batchIndex: 1, artifactId: A1, sha256: "a".repeat(64), appVersion: "1.0.1.1" },
    { batchIndex: 4, artifactId: A4, sha256: "b".repeat(64), appVersion: "1.0.1.2" },
  ];

  test("each survivor names the artifact its batch recorded", () => {
    // M0001 in batch 1 and M0001 AGAIN in batch 4 (ids restart per batch). Indexes 1 and 4, not 0
    // and 1, so a lookup by array position fails here.
    const out = explain(
      reportFixture({
        artifacts,
        mutants: [
          survivorMutant("M0001", "exact", true, 1),
          survivorMutant("M0001", "exact", true, 4),
        ],
      }),
    );
    const [b1, b4] = out.survivors;
    expect(b1?.batchIndex).toBe(1);
    expect(b1?.artifactId).toBe(A1);
    expect(b4?.batchIndex).toBe(4);
    expect(b4?.artifactId).toBe(A4);
    expect("artifactIdAbsent" in (b1 ?? {})).toBe(false);
    expect("artifactIdAbsent" in (b4 ?? {})).toBe(false);
  });

  test("a carried survivor never borrows its batch's artifactId", () => {
    const out = explain(
      reportFixture({
        artifacts,
        mutants: [{ ...survivorMutant("M0001", "exact", true, 4), carried: true }],
      }),
    );
    const [s] = out.survivors;
    expect(s?.artifactIdAbsent).toBe("carried");
    expect("artifactId" in (s ?? {})).toBe(false);
  });

  test("a batch with no artifact says not-published beside a published one", () => {
    const [first] = artifacts;
    if (first === undefined) throw new Error("fixture has no batch-1 artifact");
    const out = explain(
      reportFixture({
        artifacts: [first],
        mutants: [
          survivorMutant("M0001", "exact", true, 1),
          survivorMutant("M0001", "exact", true, 4),
        ],
      }),
    );
    const [b1, b4] = out.survivors;
    expect(b1?.artifactId).toBe(A1);
    expect(b4?.artifactIdAbsent).toBe("not-published");
    expect("artifactId" in (b4 ?? {})).toBe(false);

    const none = explain(
      reportFixture({
        artifacts: [],
        mutants: [
          survivorMutant("M0001", "exact", true, 1),
          survivorMutant("M0002", "exact", true, 4),
        ],
      }),
    );
    expect(none.survivors.map((s) => s.artifactIdAbsent)).toEqual([
      "not-published",
      "not-published",
    ]);
  });

  test("a report without artifacts says not-recorded", () => {
    const out = explain(reportFixture());
    expect(out.survivors.length).toBeGreaterThan(0);
    for (const s of out.survivors) {
      expect(s.artifactIdAbsent).toBe("not-recorded");
      expect("artifactId" in s).toBe(false);
    }
  });

  test("a malformed artifacts[] is refused", () => {
    const entry = { batchIndex: 1, artifactId: A1, sha256: "a".repeat(64), appVersion: "1.0.1.1" };
    for (const value of [
      "not an array",
      [entry, { ...entry, artifactId: A4 }], // batchIndex 1 twice
      [{ ...entry, batchIndex: "1" }],
      [{ ...entry, batchIndex: -1 }],
      [{ ...entry, batchIndex: 1.5 }],
      [{ ...entry, artifactId: 7 }],
      [null],
    ]) {
      const bad = reportFixture({ artifacts: value } as unknown as Partial<SessionReport>);
      expect(() => explain(bad)).toThrow(MalformedReportError);
      expect(() => explain(bad)).toThrow(/artifacts/);
    }
  });

  test("a malformed survivor batchIndex is refused when the report names artifacts", () => {
    const { batchIndex: _dropped, ...noBatch } = survivorMutant("M0001", "exact", true, 4);
    for (const row of [noBatch, { ...survivorMutant("M0001", "exact", true), batchIndex: "1" }]) {
      const bad = reportFixture({ artifacts, mutants: [row] } as unknown as Partial<SessionReport>);
      expect(() => explain(bad)).toThrow(MalformedReportError);
      expect(() => explain(bad)).toThrow(/batchIndex/);
    }
  });

  // Review finding 1 (C02-01 round 1): `batchIndex` is a REQUIRED report-row field and
  // `survivorOf` copies it, so a bad one is malformed whether or not the report names artifacts.
  test("a malformed survivor batchIndex is refused when the report has NO artifacts", () => {
    const { batchIndex: _dropped, ...noBatch } = survivorMutant("M0007", "exact", true, 4);
    const rows = [noBatch, "1", -1, 1.5, null].map((bi) =>
      bi === noBatch ? noBatch : { ...survivorMutant("M0007", "exact", true), batchIndex: bi },
    );
    for (const row of rows) {
      const bad = reportFixture({ mutants: [row] } as unknown as Partial<SessionReport>);
      expect("artifacts" in bad).toBe(false);
      expect(() => explain(bad)).toThrow(MalformedReportError);
      expect(() => explain(bad)).toThrow(/"M0007".*batchIndex/);
    }
  });

  test("a malformed readerMark is refused rather than projected as an empty mark", () => {
    for (const value of [null, "x", { key: "K" }, { key: "K", reason: 7 }]) {
      const bad = reportFixture({
        mutants: [{ ...survivorMutant("M0001", "exact", true), readerMark: value }],
      } as unknown as Partial<SessionReport>);
      expect(() => explain(bad)).toThrow(MalformedReportError);
      expect(() => explain(bad)).toThrow(/readerMark/);
    }
  });

  test("a non-boolean carried is refused", () => {
    for (const value of ["true", 1, null]) {
      const bad = reportFixture({
        mutants: [{ ...survivorMutant("M0001", "exact", true), carried: value }],
      } as unknown as Partial<SessionReport>);
      expect(() => explain(bad)).toThrow(MalformedReportError);
      expect(() => explain(bad)).toThrow(/carried/);
    }
  });
});

// ————————————————————————————————————————————————————————————————————————————————————————
// R113: `explain` is the first consumer to meet the blind `JSON.parse(...) as SessionReport` cast.
// ————————————————————————————————————————————————————————————————————————————————————————

describe("assertExplainableReport — a foreign report is refused, never silently narrowed", () => {
  test("an unrecognised caveat throws, naming the value and the closed set", () => {
    const base = reportFixture();
    const bad = {
      ...base,
      validity: { ...base.validity, caveats: ["narrowed", "stale-tst-app"] },
    } as unknown as SessionReport;
    expect(() => explain(bad)).toThrow(MalformedReportError);
    expect(() => explain(bad)).toThrow(/stale-tst-app/);
    expect(() => explain(bad)).toThrow(/baseline-red/); // the closed set is named
  });

  test("an unrecognised coverage attribution throws", () => {
    const bad = reportFixture({
      mutants: [{ ...survivorMutant("M0001", "exact", true), coverageAttribution: "member" }],
    } as unknown as Partial<SessionReport>);
    expect(() => explain(bad)).toThrow(MalformedReportError);
    expect(() => explain(bad)).toThrow(/member/);
  });

  test("a survivor with NO attribution throws — executionProven cannot be defaulted", () => {
    const survivor = survivorMutant("M0001", "exact", true);
    const { coverageAttribution: _dropped, ...withoutAttribution } = survivor;
    const bad = reportFixture({ mutants: [withoutAttribution] });
    expect(() => explain(bad)).toThrow(MalformedReportError);
    expect(() => explain(bad)).toThrow(/M0001/);
  });

  test("an unrecognised VERDICT throws — the empty-vs-empty collision, closed", () => {
    // Measured before the fix: corrupting every "survived" to "Survived" in rung1 produced a
    // projection byte-identical to the same report with `mutants: []`. 107 survivors gone, caveats
    // and mutationScore unchanged, nothing said.
    const bad = reportFixture({
      mutants: [{ ...survivorMutant("M0001", "exact", true), verdict: "Survived" }],
    } as unknown as Partial<SessionReport>);
    expect(() => explain(bad)).toThrow(MalformedReportError);
    expect(() => explain(bad)).toThrow(/Survived/);
    expect(() => explain(bad)).toThrow(/timeout-killed/); // the closed set is named
  });

  test("a corrupt verdict does NOT project to the same thing as no mutants at all", () => {
    // The property the throw exists for, stated directly rather than left implied by the throw.
    const corrupt = reportFixture({
      mutants: [{ ...survivorMutant("M0001", "exact", true), verdict: "Survived" }],
    } as unknown as Partial<SessionReport>);
    const emptied = reportFixture({ mutants: [] });
    let corruptOut: string;
    try {
      corruptOut = JSON.stringify(explain(corrupt));
    } catch (err) {
      corruptOut = `THREW: ${err instanceof Error ? err.name : String(err)}`;
    }
    expect(corruptOut).not.toBe(JSON.stringify(explain(emptied)));
    expect(corruptOut).toBe("THREW: MalformedReportError");
  });

  test("a non-boolean guardObserved throws rather than coercing a DECISIVE state", () => {
    // `null` would coerce to `not-observed` — the state meaning the mutated code was never reached,
    // which moves a mutant out of the survivor reading entirely. `"false"` would coerce the other
    // way, to `observed`.
    for (const value of [null, "false", "no", 0, 1]) {
      const bad = reportFixture({
        mutants: [{ ...survivorMutant("M0001", "exact"), guardObserved: value }],
      } as unknown as Partial<SessionReport>);
      expect(() => explain(bad)).toThrow(MalformedReportError);
      expect(() => explain(bad)).toThrow(/guardObserved/);
    }
  });

  test("a malformed `quarantined` throws rather than emitting a condition with a null detail", () => {
    for (const value of [null, "held", {}, { reason: 7 }]) {
      const bad = reportFixture({ quarantined: value } as unknown as Partial<SessionReport>);
      expect(() => explain(bad)).toThrow(MalformedReportError);
    }
  });

  test("a non-integer `resumedFrom.skippedStranded` throws rather than becoming a string count", () => {
    for (const value of ["2", 1.5, -1, null]) {
      const bad = reportFixture({
        resumedFrom: { runId: 7, carriedMutants: 3, skippedStranded: value },
      } as unknown as Partial<SessionReport>);
      expect(() => explain(bad)).toThrow(MalformedReportError);
      expect(() => explain(bad)).toThrow(/skippedStranded/);
    }
  });

  test("an unrecognised RELIABILITY throws — a published enum, even though only copied", () => {
    // Final review, Minor 8. The projection does not branch on `reliability`; the CONSUMER does,
    // because `EXPLAIN_CONTRACT.note` publishes value domains as stable. So the branch rule is
    // widened rather than excepted: closed-set enums are validated even when copied through.
    const base = reportFixture();
    const bad = {
      ...base,
      validity: { ...base.validity, reliability: "partial" },
    } as unknown as SessionReport;
    expect(() => explain(bad)).toThrow(MalformedReportError);
    expect(() => explain(bad)).toThrow(/partial/);
    expect(() => explain(bad)).toThrow(/narrowed-degraded/); // the closed set is named
  });

  test("an unrecognised error cause throws", () => {
    const bad = reportFixture({
      mutants: [{ ...errorMutant("M0003"), cause: "flaky" }],
    } as unknown as Partial<SessionReport>);
    expect(() => explain(bad)).toThrow(MalformedReportError);
    expect(() => explain(bad)).toThrow(/flaky/);
  });

  test("a report from another schema version is refused, naming both versions", () => {
    const bad = reportFixture({ schemaVersion: 1 });
    expect(() => explain(bad)).toThrow(MalformedReportError);
    expect(() => explain(bad)).toThrow(/\b1\b/);
    expect(() => explain(bad)).toThrow(new RegExp(`\\b${REPORT_SCHEMA_VERSION}\\b`));
  });

  test("non-report JSON is refused rather than projected into an empty answer", () => {
    for (const value of [null, 42, "a string", [], { hello: "world" }]) {
      expect(() => assertExplainableReport(value)).toThrow(MalformedReportError);
    }
  });

  test("a well-formed report passes through unchanged", () => {
    const report = reportFixture();
    expect(assertExplainableReport(JSON.parse(JSON.stringify(report)))).toEqual(report);
  });
});

// ————————————————————————————————————————————————————————————————————————————————————————
// End to end, on the REAL committed reports from the campaign this subsystem was measured in.
//
// `rung1.report.json` is the run behind the $18.56 sentence: 107 survivors, of which **88 are
// `object`** (coverage placed them at OBJECT level — some test touched the codeunit, no test is
// measured to have executed the procedure) and **19 are `exact`**. An agent had to derive that
// split by hand from a report that could not state it. This asserts the projection now does.
// ————————————————————————————————————————————————————————————————————————————————————————

describe("explain — the real campaign reports", () => {
  const campaignDir = join(import.meta.dir, "..", "..", "..", "docs", "campaign", "2026-08-03-do");
  const load = (name: string): SessionReport =>
    assertExplainableReport(JSON.parse(readFileSync(join(campaignDir, name), "utf8")));

  test("rung1: the 88/19 split the $18.56 sentence had to be derived by hand", () => {
    const out = explain(load("rung1.report.json"));
    const proven = out.survivors.filter((s) => s.executionProven);
    const unproven = out.survivors.filter((s) => !s.executionProven);
    expect(out.survivors.length).toBe(107);
    expect(unproven.length).toBe(88);
    expect(proven.length).toBe(19);
    // And the 88 carry the entailed negative that stops a reader writing 88 pointless tests.
    for (const s of unproven) {
      expect(s.interpretation).toBe(ATTRIBUTION_INTERPRETATIONS[s.attribution]);
      expect(s.interpretation.entailedNegative).toBeDefined();
    }
  });

  test("every committed campaign report projects without throwing", () => {
    for (const name of [
      "rung1.report.json",
      "rung1.resumed-run.report.json",
      "rung1.run2-partial.report.json",
      "rung2.report.json",
      "rung3.independent-confirm.report.json",
      "rung3.redcheck.report.json",
    ]) {
      const out = explain(load(name));
      expect(out.explainSchemaVersion).toBe(EXPLAIN_SCHEMA_VERSION);
      const foreign = interpretationsIn(out)
        .filter((f) => !new Set<Interpretation>(ADMISSIBLE_INTERPRETATIONS).has(f.value))
        .map((f) => `${name}${f.path}`);
      expect(foreign).toEqual([]);
      // The path pin, against real data too: the synthetic fixture reaches every branch, but only
      // real reports prove no field appears that a hand-built fixture never provoked.
      const unpinned = [...new Set(leafPathsIn(out))]
        .filter((p) => !EXPLAIN_LEAF_PATHS.includes(p))
        .map((p) => `${name}${p}`);
      expect(unpinned).toEqual([]);
      // And the string-provenance check against real data too.
      const report = load(name);
      const allowed = new Set<string>([
        ...stringsIn(report),
        ...ADMISSIBLE_INTERPRETATIONS.flatMap((i) => [
          i.meaning,
          i.basis,
          i.entailedNegative ?? "",
        ]),
        ...PROJECTION_AUTHORED_STRINGS,
      ]);
      expect(
        stringsIn(out)
          .filter((s) => !allowed.has(s))
          .map((s) => `${name}: ${s}`),
      ).toEqual([]);
      // C02-01: every survivor has exactly one of `artifactId` / `artifactIdAbsent`.
      for (const s of out.survivors) {
        expect(`${name}: ${"artifactId" in s} ${"artifactIdAbsent" in s}`).toMatch(
          /: (true false|false true)$/,
        );
      }
    }
  });

  test("rung1.resumed-run: carried survivors say carried, the rest say not-recorded (C02-01)", () => {
    const raw = load("rung1.resumed-run.report.json");
    const out = explain(raw);
    // Keyed by (batchIndex, mutantCode): mutant ids restart per batch.
    const id = (m: { batchIndex?: number; mutantCode: string }) =>
      `${m.batchIndex}/${m.mutantCode}`;
    const carried = new Set(
      raw.mutants.filter((m) => m.verdict === "survived" && m.carried === true).map(id),
    );
    expect(carried.size).toBe(54); // measured 2026-09-25: 108 survivors, 54 carried
    // The OUTPUT count, so the loop below cannot pass on zero projected survivors.
    expect(out.survivors.length).toBe(108);
    for (const s of out.survivors) {
      expect("artifactId" in s).toBe(false);
      expect(s.artifactIdAbsent).toBe(carried.has(id(s)) ? "carried" : "not-recorded");
    }
  });

  test("the quarantined partial run names the quarantine rather than reading as a result", () => {
    const out = explain(load("rung1.run2-partial.report.json"));
    expect(out.toolConditions.map((c) => c.condition)).toContain("quarantined");
  });
});

// ————————————————————————————————————————————————————————————————————————————————————————
// `lethal explain <report.json>` — the wiring.
// ————————————————————————————————————————————————————————————————————————————————————————

describe("lethal explain — CLI", () => {
  test("parses the report path as a positional", () => {
    expect(parseCliConfig(["explain", "out/report.json"])).toEqual({
      mode: "explain",
      reportPath: "out/report.json",
    });
  });

  test("a missing report path is refused by name, not as a bare ENOENT later", () => {
    expect(() => parseCliConfig(["explain"])).toThrow(/<report\.json>/);
    expect(() => parseCliConfig(["explain", ""])).toThrow(/<report\.json>/);
  });

  test("help documents the subcommand and the field that decides what a survivor is worth", () => {
    const text = helpText("0.0.0");
    expect(text).toContain("lethal explain");
    expect(text).toContain("executionProven");
  });

  async function runCli(contents: string): Promise<{ code: number; out: string }> {
    const dir = await mkdtemp(join(tmpdir(), "lethal-explain-cli-"));
    const path = join(dir, "report.json");
    await writeFile(path, contents, "utf8");
    const lines: string[] = [];
    const log = spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      lines.push(a.map(String).join(" "));
    });
    try {
      const code = await explainFromCli({ mode: "explain", reportPath: path });
      return { code, out: lines.join("\n") };
    } finally {
      log.mockRestore();
    }
  }

  test("prints the projection as JSON and exits 0", async () => {
    const { code, out } = await runCli(JSON.stringify(reportFixture()));
    expect(code).toBe(0);
    const printed = JSON.parse(out);
    expect(printed.explainSchemaVersion).toBe(EXPLAIN_SCHEMA_VERSION);
    expect(printed.survivors).toHaveLength(2);
    expect(printed.contract.proseIsContractual).toBe(false);
  });

  test("a corrupt caveat is refused THROUGH the CLI too — not just at the library boundary", async () => {
    const base = reportFixture();
    const corrupted = JSON.stringify({
      ...base,
      validity: { ...base.validity, caveats: ["stale-tst-app"] },
    });
    await expect(runCli(corrupted)).rejects.toThrow(MalformedReportError);
  });

  test("a file that is not JSON is refused naming the file", async () => {
    await expect(runCli("not json at all")).rejects.toThrow(/not valid JSON/);
  });

  test("a missing file is refused naming what to pass instead", async () => {
    await expect(
      explainFromCli({ mode: "explain", reportPath: join(tmpdir(), "lethal-no-such-report.json") }),
    ).rejects.toThrow(/--out/);
  });

  // R150 — the cap, reached the way a user reaches it.

  test("--top parses to a cap, and the printed JSON is the capped projection", async () => {
    const parsed = parseCliConfig(["explain", "report.json", "--top", "1"]);
    expect(parsed).toEqual({ mode: "explain", reportPath: "report.json", topSurvivors: 1 });

    const dir = await mkdtemp(join(tmpdir(), "lethal-explain-top-"));
    const path = join(dir, "report.json");
    await writeFile(path, JSON.stringify(reportFixture()), "utf8");
    const lines: string[] = [];
    const log = spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      lines.push(a.map(String).join(" "));
    });
    try {
      const code = await explainFromCli({ mode: "explain", reportPath: path, topSurvivors: 1 });
      expect(code).toBe(0);
      const printed = JSON.parse(lines.join("\n"));
      // The fixture has two survivors, so this proves BOTH halves: the array was cut, and the
      // output says what was cut. A cap that printed one survivor and no `omitted` would satisfy
      // the first half alone, and that is the failure mode worth a test.
      expect(printed.survivors).toHaveLength(1);
      expect(printed.survivorSelection).toEqual({
        total: 2,
        shown: 1,
        omitted: 1,
        rankedBy: "actionability",
      });
    } finally {
      log.mockRestore();
    }
  });

  test("--top without a cap flag is absent, not zero", () => {
    // `topSurvivors: 0` would be a refusal at the library boundary, so the no-flag path must leave
    // the property off entirely rather than pass a falsy default through.
    expect(parseCliConfig(["explain", "report.json"])).toEqual({
      mode: "explain",
      reportPath: "report.json",
    });
  });

  test("a --top that is not a positive integer is refused at parse time, before the file is read", () => {
    for (const bad of ["0", "1.5", "twenty", ""]) {
      expect(() => parseCliConfig(["explain", "report.json", "--top", bad])).toThrow(
        /--top must be a positive integer/,
      );
    }
    // A leading dash has to be written `--top=-3`: bare `--top -3` never reaches this validation
    // because `parseArgs` refuses it first as an ambiguous argument. Both refuse; only this form
    // exercises OUR message.
    expect(() => parseCliConfig(["explain", "report.json", "--top=-3"])).toThrow(
      /--top must be a positive integer/,
    );
  });

  test("help documents --top and what it states about what it dropped", () => {
    const text = helpText("0.0.0");
    expect(text).toContain("--top <n>");
    expect(text).toContain("survivorSelection");
  });
});
