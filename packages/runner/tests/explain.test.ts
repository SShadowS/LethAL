import { describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { explainFromCli, helpText, parseCliConfig } from "../src/cli";
import {
  ADMISSIBLE_INTERPRETATIONS,
  EXPLAIN_CONTRACT,
  EXPLAIN_SCHEMA_VERSION,
  MalformedReportError,
  assertExplainableReport,
  explain,
} from "../src/explain";
import type { Interpretation } from "../src/interpretation";
import {
  CAVEAT_INTERPRETATIONS,
  ERROR_CAUSE_INTERPRETATIONS,
  GUARD_EVIDENCE_INTERPRETATIONS,
  QUARANTINE_INTERPRETATION,
  REPORT_SCHEMA_VERSION,
  STRANDED_SKIP_INTERPRETATION,
} from "../src/report";
import type { Caveat, MutantOutcome, SessionReport } from "../src/report";
import { ATTRIBUTION_INTERPRETATIONS } from "../src/selection";
import type { CoverageAttribution } from "../src/selection";
import type { MutantVerdict } from "../src/store";

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
): MutantOutcome {
  return {
    mutantCode: code,
    file: "src/Posting/Foo.Codeunit.al",
    line: 42,
    operatorName: "lethal.negate-conditional",
    verdict: "survived",
    batchIndex: 0,
    durationMs: 120,
    procedureName: "ComputeTotal",
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

function errorMutant(code: string, cause?: "deadline-exceeded" | "unstable"): MutantOutcome {
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
    only: { patterns: ["src/Posting/**"], excludedFileCount: 38 },
    timings: {
      totalMs: 1000,
      generateMutationSetMs: 10,
      deployMs: 500,
      baselineMs: 200,
      mutantsMs: 120,
      perMutant: { count: 1, meanMs: 120, medianMs: 120, p95Ms: 120, maxMs: 120 },
    },
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
  "`entailedNegative`, `note`, `scoreDescribes`, `detail` or `failureNote`; they may be reworded " +
  "at any time without a version bump. That is safe rather than merely asked-for, because every " +
  "machine-usable atom already appears as a structured field beside the prose that explains it " +
  "(`attribution`/`executionProven`/`guardEvidence`/`cause`/`caveat`/`condition`), so there is " +
  "nothing a consumer would need to recover from a sentence. `basis` points at the evidence for " +
  "a claim (a ROADMAP id, or a file) and IS stable enough to key on.";

/**
 * Every string the PROJECTION authors — present in the output but coming from neither the report
 * nor a registry interpretation. Deliberately short: two enum families derived from report values,
 * one field-name literal, and the contract note. Anything else appearing here is a new voice in the
 * output and has to be argued for.
 *
 * The three TOKENS need no equality pin of their own: consumers filter on their exact value, so
 * widening one into a sentence breaks the code that reads it rather than smuggling anything —
 * measured, `"quarantined"` carrying advice (through an `as ToolCondition` cast) fails five tests.
 * `note` is the only entry with room to hide a claim, and it is pinned by `PINNED_CONTRACT_NOTE`.
 *
 * Shares `EXPLAIN_LEAF_PATHS`'s known bypass (R115) — this list is observed, not derived.
 */
const PROJECTION_AUTHORED_STRINGS: readonly string[] = [
  "explainSchemaVersion", // contract.structureStableUnder
  PINNED_CONTRACT_NOTE, // contract.note
  "observed", // GuardEvidence — derived from a boolean, so absent from the report
  "not-observed",
  "not-measured",
  "quarantined", // ToolCondition — a field NAME in the report, never a value
  "stranded-skips",
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
 *   resumedFrom  `carriedMutants: 0` because no outcome here is `carried` (the fold counts it 1:1),
 *                which is a documented, meaningful state: the resume found nothing to carry.
 *                `skippedStranded: 2` is backed by the two `strandedSkipMutant` rows above.
 */
function fullCoverageReport(): SessionReport {
  const base = reportFixture();
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
      survivorMutant("M0001", "exact", true),
      survivorMutant("M0002", "object", false),
      survivorMutant("M0003", "all-green"),
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
    resumedFrom: { runId: 7, carriedMutants: 0, skippedStranded: 2 },
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
  "$.survivors[].interpretation.meaning", // [registry]
  "$.survivors[].interpretation.entailedNegative", // [registry]
  "$.survivors[].interpretation.basis", // [registry]
  "$.survivors[].guardInterpretation.meaning", // [registry]
  "$.survivors[].guardInterpretation.entailedNegative", // [registry]
  "$.survivors[].guardInterpretation.basis", // [registry]
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
    ];
    expect(new Set(rowValues).size).toBe(rowValues.length);
    // ALL NINE per-row [verbatim] fields, projected against source as whole rows rather than
    // field by field. The final review measured what the field-by-field form missed: six survivor
    // fields and three notMeasured fields had no value assertion anywhere, so swapping `file` with
    // `codeunitName` in `survivorOf` was 1444 pass / 0 fail, and reading `notMeasured[].line` off
    // `startIndex` (77 -> 200) was 48 pass / 0 fail. A whole-row `toEqual` cannot be partially
    // written: adding a field to `ExplainSurvivor` without adding it here fails the row compare.
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

  test("the contract note is EXACTLY the pinned text, and is the shared constant", () => {
    // Fix round 2. Equality, not phrasing — see PINNED_CONTRACT_NOTE.
    const out = explain(fullCoverageReport());
    expect(out.contract.note).toBe(PINNED_CONTRACT_NOTE);
    expect(EXPLAIN_CONTRACT.note).toBe(PINNED_CONTRACT_NOTE);
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

  test("executionProven TRUE can sit beside guardEvidence 'not-observed', and is NOT reconciled", () => {
    // Filed by the final review as a roadmap row; this pins the FACT, not a decision.
    //
    // The pair is a genuine contradiction in evidence, not a bug in either field. `exact`
    // attribution is coverage's claim, from the baseline run on the hub, that a test executed this
    // procedure. `guardObserved: false` is the fenced run's own attestation that NO instrumented
    // guard fired at all — which its interpretation calls DECISIVE. Two measurements, two sessions,
    // opposite answers about the same mutant.
    //
    // Zero such survivors exist across all six committed reports and no other fixture builds the
    // pair, so it is LATENT: nothing here would notice if the projection started reconciling them,
    // or stopped. This test states what today's projection does — emits both, side by side,
    // unreconciled — so that whichever way the roadmap row is decided, the change shows up as this
    // test going red rather than as a silent behaviour shift.
    const out = explain(reportFixture({ mutants: [survivorMutant("M0001", "exact", false)] }));
    const [s] = out.survivors;
    expect(s?.executionProven).toBe(true);
    expect(s?.guardEvidence).toBe("not-observed");
    expect(s?.interpretation).toBe(ATTRIBUTION_INTERPRETATIONS.exact);
    expect(s?.guardInterpretation).toBe(GUARD_EVIDENCE_INTERPRETATIONS["not-observed"]);
    // No third field, no note, no flag: the projection does not say the two disagree.
    expect(Object.keys(s ?? {}).sort()).toEqual(
      [
        "attribution",
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
        "procedureName",
      ].sort(),
    );
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
});
