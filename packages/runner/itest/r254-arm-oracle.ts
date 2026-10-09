import type { MutantOutcome } from "../src/report";

/**
 * R254's pre-committed oracle for the `reportextension` arm of `fixtures/sandbox-data`
 * (docs/superpowers/specs/2026-10-05-r254-reportextension-arm-precommitment.md). Keyed by
 * file + line + operator, NOT by mutant code, so a renumbering cannot hide a moved verdict.
 * `itest:tables` checks every run against it BEFORE `assertGateBaseline`, so a record run that
 * disagrees never writes `tables.baseline.json`.
 */
export const R254_ARM_FILE = "src/DataBandExt.ReportExt.al";

export interface ArmOracleRow {
  readonly line: number;
  readonly operator: string;
  readonly verdict: "killed" | "survived" | "no-coverage";
  readonly killingTest?: string;
  readonly killPosition?: number;
  /** A substring of `killingTestFailure`. */
  readonly failure?: string;
}

const SUM0 = "band total should be 6, got 0";
const kill = (
  line: number,
  operator: string,
  killingTest: string,
  killPosition: number,
  failure: string,
): ArmOracleRow => ({ line, operator, verdict: "killed", killingTest, killPosition, failure });

export const R254_ARM_ORACLE: readonly ArmOracleRow[] = [
  kill(12, "empty-block", "BandReportSumsBands", 2, SUM0),
  kill(13, "remove-assignment", "BandReportSumsBands", 1, SUM0),
  { line: 19, operator: "empty-block", verdict: "survived" },
  { line: 20, operator: "remove-assignment", verdict: "survived" },
  kill(20, "shift-integer", "BandReportSumsBands", 2, "band total should be 6, got 7"),
  kill(24, "empty-block", "BandClassifiesDirectly", 1, "Band(3) should be 2, got 0"),
  kill(25, "conditional-boundary", "BandClassifiesDirectly", 1, "Band(3) should be 2, got 1"),
  kill(26, "return-value", "BandClassifiesDirectly", 1, "Band(3) should be 2, got 0"),
  kill(27, "return-value", "BandClassifiesDirectly", 1, "Band(2) should be 1, got 0"),
  kill(31, "empty-block", "BandReportSumsBands", 1, SUM0),
  kill(32, "return-value", "BandReportSumsBands", 1, SUM0),
  { line: 36, operator: "empty-block", verdict: "no-coverage" },
  { line: 37, operator: "conditional-boundary", verdict: "no-coverage" },
  { line: 38, operator: "return-value", verdict: "no-coverage" },
  { line: 38, operator: "swap-additive", verdict: "no-coverage" },
  // R-463 (docs/superpowers/specs/2026-10-09-r463-reportext-precommitment.md): `CountBand`, a typed
  // record in the extension. The two `remove-setrange` rows are `void-method-call` under master's code,
  // so a reverted R-463 fails here as two rows "not in the oracle". Line 47's count is not pinned:
  // any `Data Related` row in [3, 99] other than BAND 3 and 4 adds to it.
  kill(46, "empty-block", "BandCountsFromLow", 1, "CountBand(3) should be 2, got 0"),
  kill(47, "remove-setrange", "BandCountsFromLow", 1, "CountBand(3) should be 2, got"),
  kill(48, "remove-setrange", "BandCountsFromLow", 1, "CountBand(3) should be 2, got 4"),
  kill(49, "return-value", "BandCountsFromLow", 1, "CountBand(3) should be 2, got 0"),
];

/** The fields of a report mutant the oracle reads. */
export type ArmMutant = Pick<
  MutantOutcome,
  | "mutantCode"
  | "file"
  | "line"
  | "operatorName"
  | "verdict"
  | "killingTest"
  | "killPosition"
  | "killingTestFailure"
>;

const bare = (operator: string): string => operator.replace(/^lethal\./, "");
const rowKey = (line: number, operator: string): string => `${line} ${bare(operator)}`;

/**
 * Every difference between `mutants` and the oracle, as a sentence; `[]` when they agree. Every row
 * must appear exactly once with its verdict, killer, kill position and failure text, and the arm's
 * file must hold no other mutant.
 */
export function armOracleDiffs(
  mutants: readonly ArmMutant[],
  oracle: readonly ArmOracleRow[] = R254_ARM_ORACLE,
): string[] {
  const diffs: string[] = [];
  const inArm = mutants.filter((m) => m.file.replaceAll("\\", "/") === R254_ARM_FILE);
  const byKey = new Map<string, ArmMutant[]>();
  for (const m of inArm) {
    const k = rowKey(m.line, m.operatorName);
    byKey.set(k, [...(byKey.get(k) ?? []), m]);
  }
  const expected = new Set(oracle.map((r) => rowKey(r.line, r.operator)));
  for (const [k, ms] of byKey) {
    if (!expected.has(k)) {
      diffs.push(
        `${R254_ARM_FILE} line ${k}: ${ms.map((m) => m.mutantCode).join(", ")} is not in the oracle`,
      );
    }
  }
  for (const row of oracle) {
    const where = `${R254_ARM_FILE} line ${row.line} ${row.operator}`;
    const ms = byKey.get(rowKey(row.line, row.operator)) ?? [];
    const [m] = ms;
    if (m === undefined || ms.length !== 1) {
      diffs.push(`${where}: expected exactly one mutant, found ${ms.length}`);
      continue;
    }
    const got = `${m.mutantCode} ${where}`;
    if (m.verdict !== row.verdict)
      diffs.push(`${got}: verdict ${m.verdict}, expected ${row.verdict}`);
    if (m.killingTest !== row.killingTest) {
      diffs.push(`${got}: killingTest ${m.killingTest}, expected ${row.killingTest}`);
    }
    if (m.killPosition !== row.killPosition) {
      diffs.push(`${got}: killPosition ${m.killPosition}, expected ${row.killPosition}`);
    }
    if (row.failure !== undefined && !(m.killingTestFailure ?? "").includes(row.failure)) {
      diffs.push(
        `${got}: killingTestFailure ${JSON.stringify(m.killingTestFailure)} lacks ${JSON.stringify(row.failure)}`,
      );
    }
  }
  return diffs;
}
