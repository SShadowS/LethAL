/**
 * R353: the `sandbox-layout` fixture's pre-committed per-mutant table and the checks every
 * `itest:alrunner` layout leg runs against it.
 *
 * Pre-committed in docs/superpowers/specs/2026-09-30-r353-stale-layout-precommitment.md before
 * any al-runner session on the fixture. A difference is a finding and a stop: never edit a row to
 * match a run.
 *
 * At `maxGuardsPerBatch` 7 the fixture splits into two batches, and batch 1 instruments the file
 * batch 0 copied verbatim. With R349's per-deploy reset removed, the one-shot leg reads batch 1's
 * coverage through batch 0's layout and 1/M0006 and 1/M0007 go from killed to survived with
 * `GrowAboveTen` as their covering test. The verdict alone would catch that, but the covering
 * tests and the attribution are pinned too, because the frozen baseline compares neither.
 *
 * Mutant codes restart per batch, so rows are keyed by `<batch>/<code>` (`mutantRef`), never by
 * code alone. Kept out of `al-runner.itest.ts` because that script runs its gate at import (R186).
 */
import { join } from "node:path";

const FIXTURES = join(import.meta.dir, "..", "..", "..", "fixtures");
export const LAYOUT_PROJECT_DIR = join(FIXTURES, "sandbox-layout");
export const LAYOUT_TEST_DIR = join(FIXTURES, "sandbox-layout-tests");
/** The top of the target's range, 79700-79749, per the `pickSelectorIds` convention. */
export const LAYOUT_SELECTOR_IDS = { selectorId: 79749, controlId: 79748, tableId: 79747 };
/** Alpha has 3 raw specs and Beta 7, so first fit at 7 gives exactly two batches. */
export const LAYOUT_MAX_GUARDS = 7;

const SPEC = "docs/superpowers/specs/2026-09-30-r353-stale-layout-precommitment.md";
const ALPHA = "src/LayoutAlpha.Codeunit.al";
const BETA = "src/LayoutBeta.Codeunit.al";
/** Batch 0 instruments Alpha only, batch 1 Beta only. */
const BATCH_FILES: readonly string[] = [ALPHA, BETA];

export interface LayoutRow {
  readonly ref: string;
  readonly file: string;
  readonly line: number;
  readonly operatorName: string;
  readonly procedureName: string;
  readonly verdict: "killed" | "survived";
  readonly killingTest?: string;
  /** Full qualified names, compared as a complete set. */
  readonly coveringTests: readonly string[];
  readonly coverageAttribution: "exact" | "object" | "all-green";
}

/** The spec's fixed table, every field written out. Sorted by batch, then code. */
export const EXPECTED_LAYOUT: readonly LayoutRow[] = [
  {
    ref: "0/M0001",
    file: ALPHA,
    line: 4,
    operatorName: "lethal.empty-block",
    procedureName: "IsBig",
    verdict: "killed",
    killingTest: "AlphaIsBig",
    coveringTests: ["Layout Tests.AlphaIsBig"],
    coverageAttribution: "exact",
  },
  {
    ref: "0/M0002",
    file: ALPHA,
    line: 5,
    operatorName: "lethal.return-value",
    procedureName: "IsBig",
    verdict: "killed",
    killingTest: "AlphaIsBig",
    coveringTests: ["Layout Tests.AlphaIsBig"],
    coverageAttribution: "exact",
  },
  {
    ref: "0/M0003",
    file: ALPHA,
    line: 5,
    operatorName: "lethal.conditional-boundary",
    procedureName: "IsBig",
    verdict: "survived",
    coveringTests: ["Layout Tests.AlphaIsBig"],
    coverageAttribution: "exact",
  },
  {
    ref: "1/M0001",
    file: BETA,
    line: 4,
    operatorName: "lethal.empty-block",
    procedureName: "Grow",
    verdict: "killed",
    killingTest: "GrowAboveTen",
    coveringTests: ["Layout Tests.GrowAboveTen"],
    coverageAttribution: "exact",
  },
  {
    ref: "1/M0002",
    file: BETA,
    line: 5,
    operatorName: "lethal.conditional-boundary",
    procedureName: "Grow",
    verdict: "survived",
    coveringTests: ["Layout Tests.GrowAboveTen"],
    coverageAttribution: "exact",
  },
  {
    ref: "1/M0003",
    file: BETA,
    line: 6,
    operatorName: "lethal.return-value",
    procedureName: "Grow",
    verdict: "killed",
    killingTest: "GrowAboveTen",
    coveringTests: ["Layout Tests.GrowAboveTen"],
    coverageAttribution: "exact",
  },
  {
    ref: "1/M0004",
    file: BETA,
    line: 6,
    operatorName: "lethal.swap-additive",
    procedureName: "Grow",
    verdict: "killed",
    killingTest: "GrowAboveTen",
    coveringTests: ["Layout Tests.GrowAboveTen"],
    coverageAttribution: "exact",
  },
  {
    ref: "1/M0005",
    file: BETA,
    line: 7,
    operatorName: "lethal.return-value",
    procedureName: "Grow",
    verdict: "survived",
    coveringTests: ["Layout Tests.GrowAboveTen"],
    coverageAttribution: "exact",
  },
  {
    ref: "1/M0006",
    file: BETA,
    line: 37,
    operatorName: "lethal.empty-block",
    procedureName: "Twice",
    verdict: "killed",
    killingTest: "TwiceOfThree",
    coveringTests: ["Layout Tests.TwiceOfThree"],
    coverageAttribution: "exact",
  },
  {
    ref: "1/M0007",
    file: BETA,
    line: 38,
    operatorName: "lethal.return-value",
    procedureName: "Twice",
    verdict: "killed",
    killingTest: "TwiceOfThree",
    coveringTests: ["Layout Tests.TwiceOfThree"],
    coverageAttribution: "exact",
  },
];

export interface LayoutMutant {
  readonly batchIndex: number;
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
export interface LayoutReport {
  readonly baselineGreen: boolean;
  readonly batches: number;
  readonly mutants: readonly LayoutMutant[];
}

const refOf = (m: LayoutMutant): string => `${m.batchIndex}/${m.mutantCode}`;

/** Every mutant as a row: forward slashes in `file`, covering tests sorted. */
export function layoutRows(report: LayoutReport): LayoutRow[] {
  return report.mutants
    .map(
      (m) =>
        ({
          ref: refOf(m),
          file: m.file.replace(/\\/g, "/"),
          line: m.line,
          operatorName: m.operatorName,
          procedureName: m.procedureName,
          verdict: m.verdict,
          ...(m.killingTest !== undefined ? { killingTest: m.killingTest } : {}),
          coveringTests: [...m.coveringTests].sort(),
          coverageAttribution: m.coverageAttribution,
        }) as LayoutRow,
    )
    .sort((a, b) => a.ref.localeCompare(b.ref));
}

/** Printed BEFORE any assertion: a failure must show which mutant moved, and the gate is slow. */
export function printLayoutTable(report: LayoutReport, leg: string): void {
  console.log(
    `  R353 layout ${leg}: batches=${report.batches} baselineGreen=${report.baselineGreen}`,
  );
  for (const r of layoutRows(report)) {
    console.log(
      `    ${leg} ${r.ref} ${r.verdict} ${r.killingTest ?? "-"} [${r.coveringTests.join(", ")}] ${r.coverageAttribution} ${r.file}:${r.line} ${r.operatorName} ${r.procedureName}`,
    );
  }
}

const show = (r: LayoutRow | undefined): string =>
  r === undefined ? "(none)" : JSON.stringify({ ...r, coveringTests: [...r.coveringTests].sort() });

/** One line per differing ref, missing and extra refs included. Never stops at the first. */
function diffRows(expected: readonly LayoutRow[], actual: readonly LayoutRow[]): string[] {
  const want = new Map(expected.map((r) => [r.ref, r]));
  const got = new Map(actual.map((r) => [r.ref, r]));
  const refs = [...new Set([...want.keys(), ...got.keys()])].sort();
  const out: string[] = [];
  for (const ref of refs) {
    const e = want.get(ref);
    const a = got.get(ref);
    if (a === undefined) out.push(`${ref} missing: expected ${show(e)}`);
    else if (e === undefined) out.push(`${ref} unexpected: actual ${show(a)}`);
    else if (show(e) !== show(a)) out.push(`${ref}: expected ${show(e)}, actual ${show(a)}`);
  }
  return out;
}

/** Batch count, file partition, green baseline, then the pre-committed table per ref. */
export function assertLayoutRun(report: LayoutReport, leg: string): void {
  const problems: string[] = [];
  if (report.batches !== 2) {
    problems.push(`the run planned ${report.batches} batch(es), the fixture must run as 2 batches`);
  }
  if (!report.baselineGreen) problems.push("the baseline must be green in both batches");
  for (const m of report.mutants) {
    const want = BATCH_FILES[m.batchIndex];
    if (want === undefined || m.file.replace(/\\/g, "/") !== want) {
      problems.push(`${refOf(m)} is in ${m.file}, batch ${m.batchIndex} holds only ${want}`);
    }
  }
  problems.push(...diffRows(EXPECTED_LAYOUT, layoutRows(report)));
  if (problems.length > 0) {
    throw new Error(
      `R353 layout ${leg}: rows differ from the pre-committed table (${SPEC}):\n${problems.map((p) => `  - ${p}`).join("\n")}`,
    );
  }
}

/** Per `<batch>/<code>`, every field: `other` must equal the one-shot leg. */
export function assertLayoutLegsEqual(
  oneShot: LayoutReport,
  other: LayoutReport,
  leg: string,
): void {
  const problems = diffRows(layoutRows(oneShot), layoutRows(other));
  if (problems.length > 0) {
    throw new Error(
      `R353 layout ${leg}: differs from the one-shot leg:\n${problems.map((p) => `  - ${p}`).join("\n")}`,
    );
  }
}
