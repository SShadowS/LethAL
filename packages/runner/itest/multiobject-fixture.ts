/**
 * R383: the `sandbox-multiobject` fixture's pre-committed per-mutant table and the checks every
 * `itest:alrunner` multi-object leg runs against it.
 *
 * Pre-committed in docs/superpowers/specs/2026-10-02-r383-multiobject-refusal-precommitment.md
 * before the refusal was restored. A difference is a finding and a stop: never edit a row to match
 * a run.
 *
 * `MultiPair.Codeunit.al` holds two codeunits. al-runner v2.12.0-main.c39ad5de reports every
 * object after a file's first in a frame LethAL cannot undo, so the CLI guard turns the requested
 * coverage off for the whole run, and every mutant runs both green tests. `Multi A` and
 * `Multi B.Unreached` are never called, so their mutants read `survived` (bcdev, and the future
 * al-runner admission, read them `no-coverage`: 2026-10-02-r383-multiobject-precommitment.md).
 * Covering tests and the absent attribution are pinned too, because the frozen baseline compares
 * neither.
 *
 * Kept out of `al-runner.itest.ts` because that script runs its gate at import (R186).
 */
import { join } from "node:path";

const FIXTURES = join(import.meta.dir, "..", "..", "..", "fixtures");
export const MULTIOBJECT_PROJECT_DIR = join(FIXTURES, "sandbox-multiobject");
export const MULTIOBJECT_TEST_DIR = join(FIXTURES, "sandbox-multiobject-tests");
/** The top of the target's range, 79800-79849, per the `pickSelectorIds` convention. */
export const MULTIOBJECT_SELECTOR_IDS = { selectorId: 79849, controlId: 79848, tableId: 79847 };

const SPEC = "docs/superpowers/specs/2026-10-02-r383-multiobject-refusal-precommitment.md";
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
  readonly coverageAttribution?: string;
}

/** Coverage "none": every mutant runs every green test, and no row carries an attribution. */
const BOTH = ["Multi Tests.ControlDoubles", "Multi Tests.ReachedBothWays"];
const killedBy = (test: string) => ({
  verdict: "killed" as const,
  killingTest: test,
  coveringTests: BOTH,
});
const survives = { verdict: "survived" as const, coveringTests: BOTH };

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
    ...survives,
  },
  {
    code: "M0004",
    file: PAIR,
    line: 5,
    operatorName: "lethal.return-value",
    procedureName: "Never",
    ...survives,
  },
  {
    code: "M0005",
    file: PAIR,
    line: 5,
    operatorName: "lethal.swap-additive",
    procedureName: "Never",
    ...survives,
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
    ...survives,
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
    ...survives,
  },
  {
    code: "M0012",
    file: PAIR,
    line: 18,
    operatorName: "lethal.return-value",
    procedureName: "Unreached",
    ...survives,
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
  readonly coverageMode?: string;
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
  const out: string[] = [];
  // Before any Map: a Map keeps one row per code, so a duplicated row would otherwise pass.
  if (actual.length !== expected.length) {
    out.push(`${actual.length} rows, expected ${expected.length}`);
  }
  for (const [side, rows] of [
    ["expected", expected],
    ["actual", actual],
  ] as const) {
    const dup = rows.map((r) => r.code).filter((c, i, all) => all.indexOf(c) !== i);
    if (dup.length > 0) out.push(`${side} repeats code(s) ${[...new Set(dup)].join(", ")}`);
  }
  const want = new Map(expected.map((r) => [r.code, r]));
  const got = new Map(actual.map((r) => [r.code, r]));
  const codes = [...new Set([...want.keys(), ...got.keys()])].sort();
  for (const code of codes) {
    const e = want.get(code);
    const a = got.get(code);
    if (a === undefined) out.push(`${code} missing: expected ${show(e)}`);
    else if (e === undefined) out.push(`${code} unexpected: actual ${show(a)}`);
    else if (show(e) !== show(a)) out.push(`${code}: expected ${show(e)}, actual ${show(a)}`);
  }
  return out;
}

/**
 * The refusal itself, before any live run: the CLI guard was asked for `coverage: "al-runner"`
 * and must hand back `"none"` with exactly one `al-runner-coverage-unsupported` warning naming the
 * pair and not the single-object control file.
 */
export function assertMultiObjectRefusal(
  coverage: string | undefined,
  warnings: readonly string[],
): void {
  const problems: string[] = [];
  if (coverage !== "none") problems.push(`the guard returned coverage ${coverage}, expected none`);
  const guard = warnings.filter((w) => w.includes("al-runner-coverage-unsupported"));
  if (guard.length !== 1) {
    problems.push(`expected ONE al-runner-coverage-unsupported warning, got ${guard.length}`);
  }
  const [line = ""] = guard;
  if (!line.includes(`${PAIR} (more than one object)`)) {
    problems.push(`the warning does not name ${PAIR} (more than one object): ${line}`);
  }
  if (line.includes(CONTROL)) problems.push(`the warning names ${CONTROL}: ${line}`);
  if (problems.length > 0) {
    throw new Error(
      `R383 multi-object refusal (${SPEC}):\n${problems.map((p) => `  - ${p}`).join("\n")}`,
    );
  }
}

/** One batch, green baseline, coverage "none", then the pre-committed table per mutant. */
export function assertMultiObjectRun(report: MultiObjectReport, leg: string): void {
  const problems: string[] = [];
  if (report.coverageMode !== "none") {
    problems.push(`the report's coverageMode is ${report.coverageMode}, expected none`);
  }
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
