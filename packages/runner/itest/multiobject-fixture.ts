/**
 * R383: the `sandbox-multiobject` fixture's pre-committed per-mutant table and the checks every
 * `itest:alrunner` multi-object leg runs against it.
 *
 * Pre-committed in docs/superpowers/specs/2026-10-02-r383-multiobject-precommitment.md before any
 * live run on the fixture. A difference is a finding and a stop: never edit a row to match a run.
 *
 * `MultiPair.Codeunit.al` holds two codeunits, and al-runner reports its lines file-relative, so
 * every covered line of `Multi B` must be resolved to `Multi B` and converted by its base line.
 * `Multi A` and `Multi B.Unreached` are never called: their mutants read `no-coverage`, which
 * before R383 read `survived` because the file turned coverage off. Covering tests and the
 * attribution are pinned too, because the frozen baseline compares neither.
 *
 * Kept out of `al-runner.itest.ts` because that script runs its gate at import (R186).
 */
import { join } from "node:path";

const FIXTURES = join(import.meta.dir, "..", "..", "..", "fixtures");
export const MULTIOBJECT_PROJECT_DIR = join(FIXTURES, "sandbox-multiobject");
export const MULTIOBJECT_TEST_DIR = join(FIXTURES, "sandbox-multiobject-tests");
/** The top of the target's range, 79800-79849, per the `pickSelectorIds` convention. */
export const MULTIOBJECT_SELECTOR_IDS = { selectorId: 79849, controlId: 79848, tableId: 79847 };

const SPEC = "docs/superpowers/specs/2026-10-02-r383-multiobject-precommitment.md";
const PAIR = "src/MultiPair.Codeunit.al";
const CONTROL = "src/MultiControl.Codeunit.al";

export interface MultiObjectRow {
  readonly code: string;
  readonly file: string;
  readonly line: number;
  readonly operatorName: string;
  readonly procedureName: string;
  readonly verdict: "killed" | "survived" | "no-coverage";
  readonly killingTest?: string;
  /** Full qualified names, compared as a complete set. */
  readonly coveringTests: readonly string[];
  readonly coverageAttribution?: "exact";
}

const covered = (test: string) => ({
  coveringTests: [`Multi Tests.${test}`],
  coverageAttribution: "exact" as const,
});
const killedBy = (test: string) => ({
  verdict: "killed" as const,
  killingTest: test,
  ...covered(test),
});
const unreached = { verdict: "no-coverage" as const, coveringTests: [] };

/** The spec's fixed table, every field written out. Sorted by code. */
export const EXPECTED_MULTIOBJECT: readonly MultiObjectRow[] = [
  {
    code: "M0001",
    file: CONTROL,
    line: 4,
    operatorName: "lethal.empty-block",
    procedureName: "Double",
    ...killedBy("ControlDoubles"),
  },
  {
    code: "M0002",
    file: CONTROL,
    line: 5,
    operatorName: "lethal.return-value",
    procedureName: "Double",
    ...killedBy("ControlDoubles"),
  },
  {
    code: "M0003",
    file: PAIR,
    line: 4,
    operatorName: "lethal.empty-block",
    procedureName: "Never",
    ...unreached,
  },
  {
    code: "M0004",
    file: PAIR,
    line: 5,
    operatorName: "lethal.return-value",
    procedureName: "Never",
    ...unreached,
  },
  {
    code: "M0005",
    file: PAIR,
    line: 5,
    operatorName: "lethal.swap-additive",
    procedureName: "Never",
    ...unreached,
  },
  {
    code: "M0006",
    file: PAIR,
    line: 12,
    operatorName: "lethal.empty-block",
    procedureName: "Reached",
    ...killedBy("ReachedBothWays"),
  },
  {
    code: "M0007",
    file: PAIR,
    line: 13,
    operatorName: "lethal.conditional-boundary",
    procedureName: "Reached",
    verdict: "survived",
    ...covered("ReachedBothWays"),
  },
  {
    code: "M0008",
    file: PAIR,
    line: 14,
    operatorName: "lethal.return-value",
    procedureName: "Reached",
    ...killedBy("ReachedBothWays"),
  },
  {
    code: "M0009",
    file: PAIR,
    line: 14,
    operatorName: "lethal.swap-additive",
    procedureName: "Reached",
    ...killedBy("ReachedBothWays"),
  },
  {
    code: "M0010",
    file: PAIR,
    line: 15,
    operatorName: "lethal.return-value",
    procedureName: "Reached",
    ...killedBy("ReachedBothWays"),
  },
  {
    code: "M0011",
    file: PAIR,
    line: 17,
    operatorName: "lethal.empty-block",
    procedureName: "Unreached",
    ...unreached,
  },
  {
    code: "M0012",
    file: PAIR,
    line: 18,
    operatorName: "lethal.return-value",
    procedureName: "Unreached",
    ...unreached,
  },
];

export interface MultiObjectMutant {
  readonly mutantCode: string;
  readonly file: string;
  readonly line: number;
  readonly operatorName: string;
  readonly procedureName: string;
  readonly verdict: string;
  readonly killingTest?: string;
  readonly coveringTests: readonly string[];
  readonly coverageAttribution?: string;
}

/** The slice of a `SessionReport` these checks read. */
export interface MultiObjectReport {
  readonly baselineGreen: boolean;
  readonly batches: number;
  readonly mutants: readonly MultiObjectMutant[];
}

/** Every mutant as a row: forward slashes in `file`, covering tests sorted, absent fields absent. */
export function multiObjectRows(report: MultiObjectReport): MultiObjectRow[] {
  return report.mutants
    .map(
      (m) =>
        ({
          code: m.mutantCode,
          file: m.file.replace(/\\/g, "/"),
          line: m.line,
          operatorName: m.operatorName,
          procedureName: m.procedureName,
          verdict: m.verdict,
          ...(m.killingTest !== undefined ? { killingTest: m.killingTest } : {}),
          coveringTests: [...m.coveringTests].sort(),
          ...(m.coverageAttribution !== undefined
            ? { coverageAttribution: m.coverageAttribution }
            : {}),
        }) as MultiObjectRow,
    )
    .sort((a, b) => a.code.localeCompare(b.code));
}

/** Printed BEFORE any assertion: a failure must show which mutant moved, and the gate is slow. */
export function printMultiObjectTable(report: MultiObjectReport, leg: string): void {
  console.log(
    `  R383 multi-object ${leg}: batches=${report.batches} baselineGreen=${report.baselineGreen}`,
  );
  for (const r of multiObjectRows(report)) {
    console.log(
      `    ${leg} ${r.code} ${r.verdict} ${r.killingTest ?? "-"} [${r.coveringTests.join(", ")}] ${r.coverageAttribution ?? "-"} ${r.file}:${r.line} ${r.operatorName} ${r.procedureName}`,
    );
  }
}

const show = (r: MultiObjectRow | undefined): string =>
  r === undefined ? "(none)" : JSON.stringify({ ...r, coveringTests: [...r.coveringTests].sort() });

/** One line per differing code, missing and extra codes included. Never stops at the first. */
function diffRows(
  expected: readonly MultiObjectRow[],
  actual: readonly MultiObjectRow[],
): string[] {
  const want = new Map(expected.map((r) => [r.code, r]));
  const got = new Map(actual.map((r) => [r.code, r]));
  const codes = [...new Set([...want.keys(), ...got.keys()])].sort();
  const out: string[] = [];
  for (const code of codes) {
    const e = want.get(code);
    const a = got.get(code);
    if (a === undefined) out.push(`${code} missing: expected ${show(e)}`);
    else if (e === undefined) out.push(`${code} unexpected: actual ${show(a)}`);
    else if (show(e) !== show(a)) out.push(`${code}: expected ${show(e)}, actual ${show(a)}`);
  }
  return out;
}

/** One batch, green baseline, then the pre-committed table per mutant. */
export function assertMultiObjectRun(report: MultiObjectReport, leg: string): void {
  const problems: string[] = [];
  if (report.batches !== 1) problems.push(`the run planned ${report.batches} batches, expected 1`);
  if (!report.baselineGreen) problems.push("the baseline must be green");
  problems.push(...diffRows(EXPECTED_MULTIOBJECT, multiObjectRows(report)));
  if (problems.length > 0) {
    throw new Error(
      `R383 multi-object ${leg}: rows differ from the pre-committed table (${SPEC}):\n${problems.map((p) => `  - ${p}`).join("\n")}`,
    );
  }
}

/** Per mutant, every field: `other` must equal the one-shot leg. */
export function assertMultiObjectLegsEqual(
  oneShot: MultiObjectReport,
  other: MultiObjectReport,
  leg: string,
): void {
  const problems = diffRows(multiObjectRows(oneShot), multiObjectRows(other));
  if (problems.length > 0) {
    throw new Error(
      `R383 multi-object ${leg}: differs from the one-shot leg:\n${problems.map((p) => `  - ${p}`).join("\n")}`,
    );
  }
}
