/**
 * R-592: the frozen figures of the live gates, in one module with no side effects, so the offline
 * pin test (`tests/gate-pages.test.ts`) can import them. An `*.itest.ts` runs its gate at import
 * (R186) and so cannot be imported. Each itest reads its figures from here; the reasons behind each
 * number stay as comments in the itest, next to where it is asserted. `docs/gates/<gate>.md` states
 * the same figures in its `json gate-figures` block, and the pin test fails when the two differ.
 *
 * Change a figure here only together with its gate's pre-commitment and page.
 */

export const BCDEV_FIGURES = {
  totalMutantSites: 19,
  killed: 3,
  survived: 12,
  noCoverage: 4,
  groupedCalls: 15,
  warmKills: 0,
  assertionScreenDiscrimination: "vacuous",
} as const;

export const ENVTOOL_FIGURES = {
  totalMutantSites: 19,
  killed: 3,
  survived: 12,
  noCoverage: 4,
} as const;

export const ALRUNNER_FIGURES = {
  totalMutantSites: 19,
  killed: 3,
  survived: 12,
  noCoverage: 4,
  noCoverageFile: "SandboxPricing.Codeunit.al",
} as const;

export const TABLES_FIGURES = {
  totalMutantSites: 428,
  killed: 314,
  survived: 70,
  noCoverage: 22,
  platformArtifactKills: 4,
  assertionScreenDiscrimination: "partial",
  untargetedTriggerCount: 0,
  /** 314 killed + 70 survived scored, plus 15 warm-kill replays. */
  groupedCalls: 384 + 15,
  warmKills: 15,
  killPositions: [
    { mutantCode: "M0179", killingTest: "ProcessedRequiresCategory", killPosition: 5 },
    { mutantCode: "M0183", killingTest: "FlaggedFiresModifyTrigger", killPosition: 4 },
    { mutantCode: "M0175", killingTest: "CategoryGuardNeedsCalcFields", killPosition: 2 },
    { mutantCode: "M0005", killingTest: "BandReportSumsBands", killPosition: 3 },
    { mutantCode: "M0009", killingTest: "BandReportSumsBands", killPosition: 3 },
  ],
  /** The one test the fenced session refuses (it opens a TestPage), asserted by name. */
  testPageRefused: ["Data Tests.PageActionComputesNonZero"],
  notInstrumented: {
    fileCount: 1,
    siteCount: 5,
    files: ["src/DataScopeQuery.Query.al"],
  },
  declarativeSites: {
    siteCount: 1,
    fileCount: 1,
    file: "src/DataMainList.Page.al",
    kinds: "page_declaration",
  },
} as const;

/** `itest:chunked`: the unbounded control leg (MEASURED 2026-09-04) and the chunked leg (DERIVED). */
export const CHUNKED_FIGURES = {
  control: {
    killed: 17,
    survived: 7,
    noCoverage: 2,
    warmKills: 9,
    groupedCalls: 33,
    /** killPosition histogram over the 17 kills. */
    positions: { 1: 8, 2: 3, 3: 3, 4: 2, 5: 1 } as Record<number, number>,
  },
  chunked: {
    warmKills: 5,
    groupedCalls: 57,
  },
} as const;

export const HANG_FIGURES = {
  /** The per-mutant budget: far above a terminating mutant's 66-141 ms, far below a real hang. */
  budgetMs: 20_000,
  /** R206: the ON leg's warm kills, all in the `SpinUntil` arm. */
  warmKills: 4,
  /** R516: cold confirms of the position-1 timeouts. */
  coldConfirmsOn: 4,
  coldConfirmsSingle: 5,
} as const;
