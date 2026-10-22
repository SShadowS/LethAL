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

/**
 * R618 `itest:lend`: the 19 `sandbox-app` mutants by IDENTITY KEY (plan r2 I1), with the frozen
 * verdict and killer of `bcdev.baseline.json` (`lend-seed.test.ts` pins the two equal). Codes are
 * labels only: no comparison goes by code or by mutated-text hash.
 */
export const LEND_MUTANTS = {
  M0001: {
    key: "5c9b5c3e0234666484725bd281b0610957f03a54fadff8a87364e8cf29fd8222|Sandbox Logic|IsOverBudget|lethal.empty-block|1",
    verdict: "killed",
    killingTest: "OverBudgetDetected",
  },
  M0002: {
    key: "4004a181f8c0dc8bbe0c7c3051d719211b1ca22dadad08ae600b2df9f72fbe82|Sandbox Logic|IsOverBudget|lethal.return-value|1",
    verdict: "killed",
    killingTest: "OverBudgetDetected",
  },
  M0003: {
    key: "82a8a37831dd57841652a34ad1f5567a0c073ca19774f619b2022729a64fb9dc|Sandbox Logic|IsOverBudget|lethal.conditional-boundary|1",
    verdict: "killed",
    killingTest: "OverBudgetDetected",
  },
  M0004: {
    key: "b03dba085d6a4498f41e5e223ecb64c66e6eee1d2d2ef7ab55f84fa7c63835d7|Sandbox Logic|ClampPercent|lethal.empty-block|1",
    verdict: "survived",
    killingTest: null,
  },
  M0005: {
    key: "241fff269e9c9b9a336099e4588ad85b0198a155d98dccc6e48adf1e551f6341|Sandbox Logic|ClampPercent|lethal.negate-conditional|1",
    verdict: "survived",
    killingTest: null,
  },
  M0006: {
    key: "fc15ec3036dca5e21a2e79675b48f28e5815811f32dff4eb3426e0ff803575bb|Sandbox Logic|ClampPercent|lethal.conditional-boundary|1",
    verdict: "survived",
    killingTest: null,
  },
  M0007: {
    key: "58ade303c82ea175e1cabd4e46b8cd818e3a59a66b60578ef4d85077548d40e9|Sandbox Logic|ClampPercent|lethal.conditional-boundary|1",
    verdict: "survived",
    killingTest: null,
  },
  M0008: {
    key: "40277aa121cd95030531672f906db4dc1f238ef3179b8c58d7815e6a8fe957f5|Sandbox Logic|ClampPercent|lethal.return-value|1",
    verdict: "survived",
    killingTest: null,
  },
  M0009: {
    key: "2b34811c1b253fde93b24824f30d18d933316b7f64723b67d413a3b0d16956a6|Sandbox Logic|ApplyAudit|lethal.empty-block|1",
    verdict: "survived",
    killingTest: null,
  },
  M0010: {
    key: "9b4f290c51c1ef232af4a294bb9a0a4c404064f20bac6e893fab28b45cdf7785|Sandbox Logic|ApplyAudit|lethal.void-method-call|1",
    verdict: "survived",
    killingTest: null,
  },
  M0011: {
    key: "63c4f230d49983a82f9a54edf57f787ba2196df2de23c5374a9921c523fc408f|Sandbox Logic|LogAudit|lethal.empty-block|1",
    verdict: "survived",
    killingTest: null,
  },
  M0012: {
    key: "5cba655a6ac203ce40d31b0b4974a7b2f308cfec342a35d8e1a4f8d8c09c5c03|Sandbox Logic|LogAudit|lethal.negate-conditional|1",
    verdict: "survived",
    killingTest: null,
  },
  M0013: {
    key: "63b9fa65d3452236af3d725f80a805268813f9012185c0296fe552908eae1d6d|Sandbox Logic|LogAudit|lethal.shift-integer|1",
    verdict: "survived",
    killingTest: null,
  },
  M0014: {
    key: "77ee7e3d0adfcd76e1ae34e9067dcebc5c466f1172a857c730b0d43f7085d15c|Sandbox Logic|LogAudit|lethal.empty-block|1",
    verdict: "survived",
    killingTest: null,
  },
  M0015: {
    key: "d8f839f87361f4d85b7ccd435b318285a82e1e3610237d66488e17b8bdd61de3|Sandbox Logic|LogAudit|lethal.remove-assignment|1",
    verdict: "survived",
    killingTest: null,
  },
  M0016: {
    key: "e7216a276891ae7f02f66d83d4fad98fdc3ca56552d617d1f70fa371f7cfc667|Sandbox Pricing|DiscountedPrice|lethal.empty-block|1",
    verdict: "no-coverage",
    killingTest: null,
  },
  M0017: {
    key: "4b61c09033d7c8404656624ea1865b451a890db32d8212d97f8a77e9a5c2634a|Sandbox Pricing|DiscountedPrice|lethal.conditional-boundary|1",
    verdict: "no-coverage",
    killingTest: null,
  },
  M0018: {
    key: "98656555452a91ccc91c88a8a0bc3f58192db5f5153792b959447d06cff62cf1|Sandbox Pricing|DiscountedPrice|lethal.return-value|1",
    verdict: "no-coverage",
    killingTest: null,
  },
  M0019: {
    key: "d7143458adf859fcca3a104795916421514185dbe83b5e6366d0f68f86e9389d|Sandbox Pricing|DiscountedPrice|lethal.swap-additive|1",
    verdict: "no-coverage",
    killingTest: null,
  },
} as const;
export type LendCode = keyof typeof LEND_MUTANTS;

/**
 * R618 `itest:lend`: the pre-committed figures of each leg (plan r2 §6). Per-mutant expectations
 * are `LEND_MUTANTS` plus the role sets below; these are the counts and call totals.
 */
export const LEND_FIGURES = {
  totalMutantSites: 19,
  /** L0 (fill), N1, N5: nothing lent, the frozen table. */
  fresh: { killed: 3, survived: 12, noCoverage: 4, groupedCalls: 15 },
  /** L1 and N0: the 12 survivors carried as known survivors; 3 kills scored. */
  history: { killed: 3, survived: 0, noCoverage: 4, knownSurvivors: 12, groupedCalls: 3 },
  /** R1: `--resume-run` of an unfinished full clone; the one batch is carried whole. */
  resumeWhole: { carryable: 19, carried: 19, groupedCalls: 0 },
  /** R2: `--resume` of K (KEPT carried, M0003's error row and the rest re-run), snapshot reused. */
  resumeSnapshot: { carryable: 9, carried: 9, nonCarryableRows: 1, groupedCalls: 8 },
  /** R3: K2 (all but M0019); the v3 snapshot refused, the baseline re-run. */
  resumeRefusedSnapshot: { carryable: 18, carried: 18, groupedCalls: 0 },
  /** I2: the KEPT row in K whose `durationMs` R2 must read back from `mutant-carried`. */
  sentinel: { code: "M0004", durationMs: 987654 },
  /** K's rows: 2 killed, 5 survived, 2 no-coverage, carried by key. */
  kept: ["M0001", "M0002", "M0004", "M0005", "M0006", "M0007", "M0008", "M0016", "M0017"],
  /** K's error row (Q3): non-carryable, so re-executed. */
  keptAsError: ["M0003"],
  /** K2 leaves out only this one. */
  r3Rerun: ["M0019"],
} as const;
