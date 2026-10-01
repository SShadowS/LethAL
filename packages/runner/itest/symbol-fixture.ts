/**
 * R321: the `sandbox-symbols` fixture's pre-committed per-mutant verdicts, one table per build,
 * and the assertion every `itest:alrunner` symbol leg runs against them.
 *
 * Pre-committed in docs/superpowers/specs/2026-09-29-r321-symbol-fixture-precommitment.md before
 * any al-runner session on the fixture. A difference is a finding and a stop: never edit a row to
 * match a run.
 *
 * Since R214 each build has 9 mutants, 5 killed / 4 survived: the seven outside the arms plus its
 * own arm's two. Two builds share seven rows and differ on 4 of their verdicts, and each has two
 * rows the others lack, so a transport that compiled the wrong build fails on the rows AND on the
 * count. Pre-committed in docs/superpowers/specs/2026-09-29-r214-precommitment.md.
 *
 * Kept out of `al-runner.itest.ts` because that script runs its gate at import (R186).
 */
import assert from "node:assert/strict";

/** The gate's sets. Each fixture's symbol-sets.json is `[[], ...SYMBOL_SETS]` (pinned by test). */
export const SYMBOL_SETS: readonly (readonly string[])[] = [["LETHALA"], ["LETHALB"]];

export function symbolSetLabel(symbols: readonly string[]): string {
  return `[${symbols.join(",")}]`;
}

export interface SymbolRow {
  readonly line: number;
  readonly operatorName: string;
  readonly verdict: "killed" | "survived";
  readonly killingTest?: string;
}

const k = (line: number, operatorName: string): SymbolRow => ({
  line,
  operatorName,
  verdict: "killed",
  killingTest: "RateSmall",
});
const s = (line: number, operatorName: string): SymbolRow => ({
  line,
  operatorName,
  verdict: "survived",
});

const EB = "lethal.empty-block";
const RA = "lethal.remove-assignment";
const SI = "lethal.shift-integer";
const RV = "lethal.return-value";
const SA = "lethal.swap-additive";

/** Sorted by line, then operator name, the order `assertSymbolBuild` compares in. */
export const EXPECTED_BY_SET: Readonly<Record<string, readonly SymbolRow[]>> = {
  "[LETHALA]": [
    k(8, EB),
    k(9, RA),
    k(9, SI),
    s(10, RA),
    s(10, SI),
    s(11, RA),
    s(11, SI),
    k(13, RV),
    k(13, SA),
  ],
  "[LETHALB]": [
    k(8, EB),
    s(9, RA),
    s(9, SI),
    k(10, RA),
    k(10, SI),
    s(11, RA),
    s(11, SI),
    k(15, RV),
    k(15, SA),
  ],
};

/**
 * The `#else` build: what a transport that lost its defines measures. No gate leg runs it; the
 * red-checks print it, and the non-vacuity test pins that it differs from both sets' tables.
 */
export const EXPECTED_NO_DEFINE: readonly SymbolRow[] = [
  k(8, EB),
  s(9, RA),
  s(9, SI),
  s(10, RA),
  s(10, SI),
  k(11, RA),
  k(11, SI),
  k(17, RV),
  k(17, SA),
];

export const SYMBOL_FILE = "SymbolLogic.Codeunit.al";

export interface ScoredMutant {
  readonly mutantCode: string;
  readonly file: string;
  readonly line: number;
  readonly operatorName: string;
  readonly verdict: string;
  readonly killingTest?: string;
}

/** The slice of a `SessionReport` this check reads. */
export interface SymbolReport {
  readonly baselineGreen: boolean;
  readonly preprocessorSymbols: readonly string[];
  readonly mutants: readonly ScoredMutant[];
}

/** Printed BEFORE any assertion: a failure must show which mutant moved, and the gate is slow. */
export function printSymbolTable(
  report: SymbolReport,
  symbols: readonly string[],
  leg: string,
): void {
  const label = symbolSetLabel(symbols);
  for (const m of report.mutants) {
    console.log(
      `    ${leg} ${label} ${m.mutantCode} ${m.verdict} ${m.killingTest ?? "-"} ${m.file}:${m.line} ${m.operatorName}`,
    );
  }
}

const byLineThenOperator = (a: SymbolRow, b: SymbolRow): number =>
  a.line - b.line || a.operatorName.localeCompare(b.operatorName);

/**
 * `preprocessorSymbols` is checked but proves nothing about what was compiled: it comes from
 * `RunSessionConfig`, which compiles nothing. The per-mutant comparison is the evidence.
 */
export function assertSymbolBuild(
  report: SymbolReport,
  symbols: readonly string[],
  leg: string,
): void {
  const label = symbolSetLabel(symbols);
  const expected = EXPECTED_BY_SET[label];
  if (expected === undefined) {
    throw new Error(`R321: no pre-committed table for symbol set ${label}`);
  }
  assert.equal(report.baselineGreen, true, `R321 ${leg} ${label}: the baseline must be green`);
  assert.deepEqual(
    [...report.preprocessorSymbols],
    [...symbols],
    `R321 ${leg} ${label}: the report must record the symbols this leg was configured with`,
  );
  const actual = report.mutants.map((m): SymbolRow => {
    assert.ok(
      m.file.endsWith(SYMBOL_FILE),
      `R321 ${leg} ${label}: ${m.mutantCode} is in ${m.file}, every mutant must be in ${SYMBOL_FILE}`,
    );
    return {
      line: m.line,
      operatorName: m.operatorName,
      verdict: m.verdict as SymbolRow["verdict"],
      ...(m.killingTest !== undefined ? { killingTest: m.killingTest } : {}),
    };
  });
  assert.deepEqual(
    actual.sort(byLineThenOperator),
    [...expected].sort(byLineThenOperator),
    `R321 ${leg} ${label}: per-mutant verdicts differ from the pre-committed table (docs/superpowers/specs/2026-09-29-r214-precommitment.md, "R321, new tables"; before R214: docs/superpowers/specs/2026-09-29-r321-symbol-fixture-precommitment.md)`,
  );
}
