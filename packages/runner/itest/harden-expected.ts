import type { MutantOutcome, SessionReport } from "../src/report";
import { assertGateBaseline } from "./baseline-guard";

/**
 * C02-03: the pre-committed per-mutant table for `fixtures/sandbox-harden`, and the three checks
 * the `itest:harden` gate runs against a live report. One module both the offline test and the gate
 * import, so the two cannot drift. Lives outside the itest because that file exits the process at
 * import time when its env gate is unset.
 */

export type Planted = "S1" | "S2" | "S3" | "S4" | "S5";

export interface ExpectedMutant {
  readonly file: string; // project-relative, as MutantOutcome.file spells it
  readonly line: number;
  readonly operator: string;
  readonly scope: string; // procedure, or trigger as the report names it
  readonly verdict: "killed" | "survived";
  readonly killingTest?: string; // required when verdict is "killed"
  readonly planted?: Planted;
}

const L = "src/HardenLogic.Codeunit.al";
const T = "src/HardenEntry.Table.al";

export const EXPECTED: readonly ExpectedMutant[] = [
  {
    file: L,
    line: 5,
    operator: "lethal.empty-block",
    scope: "IsLarge",
    verdict: "killed",
    killingTest: "IsLargeSeparatesSmallFromLarge",
  },
  {
    file: L,
    line: 6,
    operator: "lethal.conditional-boundary",
    scope: "IsLarge",
    verdict: "survived",
    planted: "S1",
  },
  {
    file: L,
    line: 6,
    operator: "lethal.return-value",
    scope: "IsLarge",
    verdict: "killed",
    killingTest: "IsLargeSeparatesSmallFromLarge",
  },
  {
    file: L,
    line: 13,
    operator: "lethal.empty-block",
    scope: "CountInCategory",
    verdict: "killed",
    killingTest: "CountInCategoryCountsRows",
  },
  // Tier-2 remove-setrange displaces void-method-call's identical deletion at this span (section 3.2 dedup).
  {
    file: L,
    line: 14,
    operator: "lethal.remove-setrange",
    scope: "CountInCategory",
    verdict: "survived",
    planted: "S2",
  },
  {
    file: L,
    line: 15,
    operator: "lethal.return-value",
    scope: "CountInCategory",
    verdict: "killed",
    killingTest: "CountInCategoryCountsRows",
  },
  {
    file: L,
    line: 22,
    operator: "lethal.empty-block",
    scope: "FirstAmount",
    verdict: "killed",
    killingTest: "FirstAmountReadsARow",
  },
  {
    file: L,
    line: 23,
    operator: "lethal.negate-guard",
    scope: "FirstAmount",
    verdict: "killed",
    killingTest: "FirstAmountReadsARow",
  },
  {
    file: L,
    line: 23,
    operator: "lethal.swap-find-direction",
    scope: "FirstAmount",
    verdict: "survived",
    planted: "S3",
  },
  {
    file: L,
    line: 24,
    operator: "lethal.return-value",
    scope: "FirstAmount",
    verdict: "killed",
    killingTest: "FirstAmountReadsARow",
  },
  // `exit(0)` on line 25: return-value skips a zero, and shift-integer claims only a literal directly in an assignment or equality comparison.
  {
    file: L,
    line: 30,
    operator: "lethal.empty-block",
    scope: "SetAmount",
    verdict: "killed",
    killingTest: "SetAmountStoresTheAmount",
  },
  // Both kept: dedup keys on replacement text, and validate-to-assign's is never empty.
  {
    file: L,
    line: 31,
    operator: "lethal.void-method-call",
    scope: "SetAmount",
    verdict: "killed",
    killingTest: "SetAmountStoresTheAmount",
  },
  {
    file: L,
    line: 31,
    operator: "lethal.validate-to-assign",
    scope: "SetAmount",
    verdict: "survived",
    planted: "S4",
  },
  {
    file: L,
    line: 39,
    operator: "lethal.empty-block",
    scope: "BonusFor",
    verdict: "killed",
    killingTest: "BonusForPaysOnlyAboveTen",
  },
  {
    file: L,
    line: 40,
    operator: "lethal.remove-assignment",
    scope: "BonusFor",
    verdict: "survived",
    planted: "S5",
  },
  {
    file: L,
    line: 40,
    operator: "lethal.shift-integer",
    scope: "BonusFor",
    verdict: "killed",
    killingTest: "BonusForPaysOnlyAboveTen",
  },
  {
    file: L,
    line: 41,
    operator: "lethal.conditional-boundary",
    scope: "BonusFor",
    verdict: "killed",
    killingTest: "BonusForPaysOnlyAboveTen",
  },
  {
    file: L,
    line: 42,
    operator: "lethal.remove-assignment",
    scope: "BonusFor",
    verdict: "killed",
    killingTest: "BonusForPaysOnlyAboveTen",
  },
  {
    file: L,
    line: 43,
    operator: "lethal.return-value",
    scope: "BonusFor",
    verdict: "killed",
    killingTest: "BonusForPaysOnlyAboveTen",
  },
  // Trigger mutants: covered by SetAmountStoresTheAmount too, which passes on all of them.
  {
    file: T,
    line: 12,
    operator: "lethal.empty-block",
    scope: "OnValidate",
    verdict: "killed",
    killingTest: "AmountValidateDoublesIt",
  },
  {
    file: T,
    line: 13,
    operator: "lethal.remove-assignment",
    scope: "OnValidate",
    verdict: "killed",
    killingTest: "AmountValidateDoublesIt",
  },
];

/** The answer key's killer for each actionable survivor, by method name. */
export const ANSWER_KILLERS: Readonly<Record<Exclude<Planted, "S5">, string>> = {
  S1: "IsLargeAtTheBoundary",
  S2: "CountInCategoryIgnoresOtherCategories",
  S3: "FirstAmountReadsTheFirstRow",
  S4: "SetAmountRunsValidation",
};

export class HardenGateError extends Error {}

/** `file:line:operator`, with the file's separators normalised so a Windows path matches. */
export function siteOf(file: string, line: number, operator: string): string {
  return `${file.replaceAll("\\", "/")}:${line}:${operator}`;
}

export function describeRow(row: ExpectedMutant): string {
  return `${siteOf(row.file, row.line, row.operator)} (${row.scope}${row.planted !== undefined ? `, ${row.planted}` : ""})`;
}

/**
 * The report must be ONE batch, batch 0. The S5 lookup and the marks match by `mutantCode`, which
 * restarts per batch, so on a two-batch report the same code could name two mutants and a check
 * could pass on the wrong one. Every table check runs this first.
 */
export function assertSingleBatch(report: SessionReport): void {
  const other = report.mutants.filter((m) => m.batchIndex !== 0);
  if (report.batches !== 1 || other.length !== 0) {
    const sample = other.slice(0, 5).map((m) => `${m.mutantCode}@${m.batchIndex}`);
    throw new HardenGateError(
      `the report must be exactly one batch (batch 0), got batches=${String(report.batches)} and ${other.length} mutant(s) outside batch 0 [${sample.join(", ")}]: mutant codes restart per batch, so the mark and S5 checks would be ambiguous`,
    );
  }
}

/**
 * Pair every row with exactly one report mutant. Throws on a missing row or a site held twice, so
 * an empty report fails here rather than passing every later check vacuously.
 */
function pairRows(
  report: SessionReport,
  expected: readonly ExpectedMutant[],
): Map<ExpectedMutant, MutantOutcome> {
  if (expected.length === 0) throw new HardenGateError("the expected table is empty");
  assertSingleBatch(report);
  const bySite = new Map<string, MutantOutcome[]>();
  for (const m of report.mutants) {
    const k = siteOf(m.file, m.line, m.operatorName);
    const list = bySite.get(k);
    if (list === undefined) bySite.set(k, [m]);
    else list.push(m);
  }
  const paired = new Map<ExpectedMutant, MutantOutcome>();
  for (const row of expected) {
    const found = bySite.get(siteOf(row.file, row.line, row.operator)) ?? [];
    const [m] = found;
    if (m === undefined || found.length !== 1) {
      throw new HardenGateError(
        `${describeRow(row)}: expected exactly one mutant in the report, found ${found.length}`,
      );
    }
    paired.set(row, m);
  }
  return paired;
}

function plantedRow(expected: readonly ExpectedMutant[], p: Planted): ExpectedMutant {
  const rows = expected.filter((r) => r.planted === p);
  const [row] = rows;
  if (row === undefined || rows.length !== 1) {
    throw new HardenGateError(`the expected table holds ${rows.length} rows planted ${p}, not 1`);
  }
  return row;
}

function mutantFor(paired: Map<ExpectedMutant, MutantOutcome>, row: ExpectedMutant): MutantOutcome {
  const m = paired.get(row);
  if (m === undefined) throw new HardenGateError(`${describeRow(row)}: not paired`);
  return m;
}

/** Leg A: every row's verdict and killer, nothing extra, no no-coverage, and the equivalence list. */
export function assertHardenVerdicts(report: SessionReport, expected = EXPECTED): void {
  const paired = pairRows(report, expected);
  const predicted = new Set(expected.map((r) => siteOf(r.file, r.line, r.operator)));
  for (const m of report.mutants) {
    if (!predicted.has(siteOf(m.file, m.line, m.operatorName))) {
      throw new HardenGateError(
        `${m.mutantCode} ${siteOf(m.file, m.line, m.operatorName)} (${m.verdict}): a mutant the table does not predict`,
      );
    }
  }
  for (const row of expected) {
    const m = mutantFor(paired, row);
    if (m.verdict !== row.verdict) {
      throw new HardenGateError(
        `${describeRow(row)}: verdict ${m.verdict}, expected ${row.verdict}`,
      );
    }
    if (row.verdict === "killed" && m.killingTest !== row.killingTest) {
      throw new HardenGateError(
        `${describeRow(row)}: killed by ${String(m.killingTest)}, expected ${String(row.killingTest)}`,
      );
    }
  }
  if (report.counts.noCoverage !== 0) {
    throw new HardenGateError(`counts.noCoverage is ${report.counts.noCoverage}, expected 0`);
  }
  const plantedCount = expected.filter((r) => r.planted !== undefined).length;
  if (report.counts.survived !== plantedCount) {
    throw new HardenGateError(
      `counts.survived is ${report.counts.survived}, expected ${plantedCount}`,
    );
  }
  const gotOps = [
    ...new Set(report.mutants.filter((m) => m.verdict === "survived").map((m) => m.operatorName)),
  ].sort();
  const wantOps = [
    ...new Set(expected.filter((r) => r.planted !== undefined).map((r) => r.operator)),
  ].sort();
  if (JSON.stringify(gotOps) !== JSON.stringify(wantOps)) {
    throw new HardenGateError(
      `survivors' operators are ${gotOps.join(", ")}, expected ${wantOps.join(", ")}`,
    );
  }
  const s5 = mutantFor(paired, plantedRow(expected, "S5"));
  const les = report.likelyEquivalentSurvivors;
  const [group, ...rest] = les?.byRisk ?? [];
  if (
    les === undefined ||
    les.count !== 1 ||
    group === undefined ||
    rest.length !== 0 ||
    group.risk !== "value-rewrite" ||
    typeof group.meaning !== "string" ||
    JSON.stringify(group.mutants) !== JSON.stringify([s5.mutantCode]) ||
    JSON.stringify(Object.keys(les).sort()) !== JSON.stringify(["byRisk", "count"]) ||
    JSON.stringify(Object.keys(group).sort()) !== JSON.stringify(["meaning", "mutants", "risk"])
  ) {
    throw new HardenGateError(
      `likelyEquivalentSurvivors must list exactly S5 (${s5.mutantCode}) under value-rewrite, got ${JSON.stringify(les ?? null)}`,
    );
  }
}

/** Both legs: the mark matched S5 only; stale and contradicted are empty. */
export function assertHardenMarks(report: SessionReport, expected = EXPECTED): void {
  const paired = pairRows(report, expected);
  const s5 = mutantFor(paired, plantedRow(expected, "S5"));
  const rme = report.readerMarkedEquivalent;
  if (rme === undefined) {
    throw new HardenGateError(
      "readerMarkedEquivalent is absent: the run was not given lethal.equivalent.json",
    );
  }
  const matched = rme.matched.map((m) => m.mutantCode);
  if (JSON.stringify(matched) !== JSON.stringify([s5.mutantCode])) {
    throw new HardenGateError(
      `readerMarkedEquivalent.matched is [${matched.join(", ")}], expected [${s5.mutantCode}] (S5)`,
    );
  }
  if (rme.stale.length !== 0 || rme.contradicted.length !== 0) {
    throw new HardenGateError(
      `readerMarkedEquivalent must have no stale or contradicted mark, got stale ${JSON.stringify(rme.stale)}, contradicted ${JSON.stringify(rme.contradicted)}`,
    );
  }
}

/** Leg B: S1..S4 killed by ANSWER_KILLERS by name, S5 survived. Other rows are not asserted. */
export function assertHardenAnswers(report: SessionReport, expected = EXPECTED): void {
  const paired = pairRows(report, expected);
  for (const p of ["S1", "S2", "S3", "S4"] as const) {
    const row = plantedRow(expected, p);
    const m = mutantFor(paired, row);
    if (m.verdict !== "killed" || m.killingTest !== ANSWER_KILLERS[p]) {
      throw new HardenGateError(
        `${p} ${describeRow(row)}: ${m.verdict} by ${String(m.killingTest)}, expected killed by ${ANSWER_KILLERS[p]}`,
      );
    }
  }
  const s5row = plantedRow(expected, "S5");
  const s5 = mutantFor(paired, s5row);
  if (s5.verdict !== "survived") {
    throw new HardenGateError(`S5 ${describeRow(s5row)}: ${s5.verdict}, expected survived`);
  }
}

/**
 * Compares or records the baseline only after legB() resolved. A leg-B throw propagates and leaves
 * no file behind. R332: recording happens only when `LETHAL_ITEST_RECORD_BASELINE` names the file,
 * and then this throws `BaselineRecordedError`, so a record run never passes.
 */
export async function recordAfterBothLegs(
  reportA: SessionReport,
  legB: () => Promise<void>,
  baselinePath: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  await legB();
  await assertGateBaseline(reportA, baselinePath, "harden itest", env);
}
