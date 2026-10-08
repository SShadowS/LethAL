/**
 * R-300b: the `sandbox-wrapped` fixture's pre-committed per-mutant table and the checks every
 * `itest:alrunner` wrapped leg runs against it (one-shot, `--server`, resource selector).
 *
 * Pre-committed in docs/superpowers/specs/2026-10-06-r300b-wrapped-leg-precommitment.md before any
 * al-runner session on the fixture; the table is R-343's, pre-committed in
 * docs/superpowers/specs/2026-10-08-r343-wrapped-leg-precommitment.md before the changed code ran.
 * A difference is a finding and a stop: never edit a row to match a run.
 *
 * What it pins:
 * - each ADMITTED wrapped file (`WrappedTop`, `WrappedPre`) scores exactly as its unwrapped twin,
 *   per mutant, verdict and covering test (the twin's test is the same name plus `Twin`), in both
 *   directions: no twin-only and no wrapped-only row. Before R343 the twins' `swap-additive` rows
 *   were twin-only, because a `#if`-wrapped object was not indexed and typed operators saw nothing
 *   inside it;
 * - the R353 layout: `Twice`'s lines in the ORIGINAL text lie inside `Grow` in the instrumented
 *   text, so a frame misread moves `Twice`'s mutants to `no-coverage` and `Grow`'s covering set;
 * - the C1 pair: `WrappedPairA` is the arm LethAL reads as compiled (WRAPDEF from the config's
 *   `--define`, WRAPAPP from app.json). Whether al-runner's `--define` ADDS to app.json's symbols
 *   or REPLACES them is unmeasured; under "adds" A's mutants score, under "replaces" al-runner
 *   compiles `WrappedPairB` and A's three mutants read `no-coverage`. Either reading passes, but
 *   all three rows must follow ONE reading, and no row may be another file's coverage;
 * - the two-arm control `WrappedArms`: refused by name, `no-coverage`;
 * - zero R383 "the position wins" warnings and zero R-300b "the line is dropped" warnings.
 *
 * Kept out of `al-runner.itest.ts` because that script runs its gate at import (R186).
 */
import { join } from "node:path";

const FIXTURES = join(import.meta.dir, "..", "..", "..", "fixtures");
export const WRAPPED_PROJECT_DIR = join(FIXTURES, "sandbox-wrapped");
export const WRAPPED_TEST_DIR = join(FIXTURES, "sandbox-wrapped-tests");
/** The top of the target's range, 78900-78949, per the `pickSelectorIds` convention. */
export const WRAPPED_SELECTOR_IDS = { selectorId: 78949, controlId: 78948, tableId: 78947 };
/** The config symbol, sent to al-runner as `--define`. The target's app.json defines WRAPAPP. */
export const WRAPPED_SYMBOLS: readonly string[] = ["WRAPDEF"];

const SPEC = "docs/superpowers/specs/2026-10-08-r343-wrapped-leg-precommitment.md";
const SUITE = "Wrapped Tests";

const TOP = "src/WrappedTop.Codeunit.al";
const TOP_TWIN = "src/WrappedTopTwin.Codeunit.al";
const PRE = "src/WrappedPre.Codeunit.al";
const PRE_TWIN = "src/WrappedPreTwin.Codeunit.al";
const PAIR_A = "src/WrappedPairA.Codeunit.al";
const ARMS = "src/WrappedArms.Codeunit.al";

/** Admitted wrapped file -> its unwrapped twin. */
export const TWINS: Readonly<Record<string, string>> = { [TOP]: TOP_TWIN, [PRE]: PRE_TWIN };
/** The C1 pair's rows, which follow one of two readings. */
export const PAIR_CODES: readonly string[] = ["M0004", "M0005", "M0006"];

export const ARMS_REFUSAL =
  "coverage refused for Codeunit:78906 (src/WrappedArms.Codeunit.al): its file holds a #if object wrapper of a shape not measured on al-runner (R300). Its mutants read no-coverage.";

export interface WrappedRow {
  readonly code: string;
  readonly file: string;
  readonly line: number;
  readonly operatorName: string;
  readonly procedureName: string;
  readonly verdict: "killed" | "survived" | "no-coverage";
  readonly killingTest?: string;
  /** Full qualified names, compared as a complete set. */
  readonly coveringTests: readonly string[];
}

const row = (
  code: string,
  file: string,
  line: number,
  operator: string,
  procedureName: string,
  verdict: WrappedRow["verdict"],
  test?: string,
): WrappedRow => ({
  code,
  file,
  line,
  operatorName: `lethal.${operator}`,
  procedureName,
  verdict,
  ...(verdict === "killed" && test !== undefined ? { killingTest: test } : {}),
  coveringTests: verdict === "no-coverage" || test === undefined ? [] : [`${SUITE}.${test}`],
});

/** The spec's table under the "adds" reading (the reading LethAL's own arm choice assumes). */
export const EXPECTED_WRAPPED: readonly WrappedRow[] = [
  row("M0001", ARMS, 7, "empty-block", "Pick", "no-coverage"),
  row("M0002", ARMS, 8, "conditional-boundary", "Pick", "no-coverage"),
  row("M0003", ARMS, 9, "return-value", "Pick", "no-coverage"),
  row("M0004", PAIR_A, 10, "empty-block", "Pick", "killed", "PairPick"),
  row("M0005", PAIR_A, 11, "conditional-boundary", "Pick", "survived", "PairPick"),
  row("M0006", PAIR_A, 12, "return-value", "Pick", "killed", "PairPick"),
  row("M0007", PRE, 9, "empty-block", "Grow", "killed", "GrowPre"),
  row("M0008", PRE, 10, "conditional-boundary", "Grow", "survived", "GrowPre"),
  row("M0009", PRE, 11, "return-value", "Grow", "killed", "GrowPre"),
  row("M0010", PRE, 11, "swap-additive", "Grow", "killed", "GrowPre"),
  row("M0011", PRE, 12, "return-value", "Grow", "survived", "GrowPre"),
  row("M0012", PRE, 35, "empty-block", "Twice", "killed", "TwicePre"),
  row("M0013", PRE, 36, "return-value", "Twice", "killed", "TwicePre"),
  row("M0014", PRE_TWIN, 9, "empty-block", "Grow", "killed", "GrowPreTwin"),
  row("M0015", PRE_TWIN, 10, "conditional-boundary", "Grow", "survived", "GrowPreTwin"),
  row("M0016", PRE_TWIN, 11, "return-value", "Grow", "killed", "GrowPreTwin"),
  row("M0017", PRE_TWIN, 11, "swap-additive", "Grow", "killed", "GrowPreTwin"),
  row("M0018", PRE_TWIN, 12, "return-value", "Grow", "survived", "GrowPreTwin"),
  row("M0019", PRE_TWIN, 35, "empty-block", "Twice", "killed", "TwicePreTwin"),
  row("M0020", PRE_TWIN, 36, "return-value", "Twice", "killed", "TwicePreTwin"),
  row("M0021", TOP, 7, "empty-block", "Grow", "killed", "GrowTop"),
  row("M0022", TOP, 8, "conditional-boundary", "Grow", "survived", "GrowTop"),
  row("M0023", TOP, 9, "return-value", "Grow", "killed", "GrowTop"),
  row("M0024", TOP, 9, "swap-additive", "Grow", "killed", "GrowTop"),
  row("M0025", TOP, 10, "return-value", "Grow", "survived", "GrowTop"),
  row("M0026", TOP, 32, "empty-block", "Twice", "killed", "TwiceTop"),
  row("M0027", TOP, 34, "remove-assignment", "Twice", "killed", "TwiceTop"),
  row("M0028", TOP, 36, "return-value", "Twice", "killed", "TwiceTop"),
  row("M0029", TOP_TWIN, 7, "empty-block", "Grow", "killed", "GrowTopTwin"),
  row("M0030", TOP_TWIN, 8, "conditional-boundary", "Grow", "survived", "GrowTopTwin"),
  row("M0031", TOP_TWIN, 9, "return-value", "Grow", "killed", "GrowTopTwin"),
  row("M0032", TOP_TWIN, 9, "swap-additive", "Grow", "killed", "GrowTopTwin"),
  row("M0033", TOP_TWIN, 10, "return-value", "Grow", "survived", "GrowTopTwin"),
  row("M0034", TOP_TWIN, 32, "empty-block", "Twice", "killed", "TwiceTopTwin"),
  row("M0035", TOP_TWIN, 34, "remove-assignment", "Twice", "killed", "TwiceTopTwin"),
  row("M0036", TOP_TWIN, 36, "return-value", "Twice", "killed", "TwiceTopTwin"),
];

/** The C1 pair's three rows under the "replaces" reading: al-runner compiled `WrappedPairB`. */
export const PAIR_REPLACES: readonly WrappedRow[] = [
  row("M0004", PAIR_A, 10, "empty-block", "Pick", "no-coverage"),
  row("M0005", PAIR_A, 11, "conditional-boundary", "Pick", "no-coverage"),
  row("M0006", PAIR_A, 12, "return-value", "Pick", "no-coverage"),
];

export interface WrappedMutant {
  readonly mutantCode: string;
  readonly file: string;
  readonly line: number;
  readonly operatorName: string;
  readonly procedureName: string;
  readonly verdict: string;
  readonly killingTest?: string;
  readonly coveringTests: readonly string[];
  readonly failureNote?: string;
}

/** The slice of a `SessionReport` these checks read. */
export interface WrappedReport {
  readonly baselineGreen: boolean;
  readonly batches: number;
  readonly mutants: readonly WrappedMutant[];
}

export function wrappedRows(report: WrappedReport): WrappedRow[] {
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
        }) as WrappedRow,
    )
    .sort((a, b) => a.code.localeCompare(b.code));
}

/** Printed BEFORE any assertion: a failure must show which mutant moved, and the gate is slow. */
export function printWrappedTable(report: WrappedReport, leg: string): void {
  console.log(
    `  R-300b wrapped ${leg}: batches=${report.batches} baselineGreen=${report.baselineGreen}`,
  );
  for (const r of wrappedRows(report)) {
    console.log(
      `    ${leg} ${r.code} ${r.verdict} ${r.killingTest ?? "-"} [${r.coveringTests.join(", ")}] ${r.file}:${r.line} ${r.operatorName} ${r.procedureName}`,
    );
  }
}

const show = (r: WrappedRow | undefined): string =>
  r === undefined ? "(none)" : JSON.stringify(r);

function diffRows(expected: readonly WrappedRow[], actual: readonly WrappedRow[]): string[] {
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

/** Which reading the pair's rows follow, or undefined when they follow neither as a whole. */
export function pairReading(report: WrappedReport): "adds" | "replaces" | undefined {
  const pair = wrappedRows(report).filter((r) => PAIR_CODES.includes(r.code));
  const of = (rows: readonly WrappedRow[]) => rows.filter((r) => PAIR_CODES.includes(r.code));
  if (diffRows(of(EXPECTED_WRAPPED), pair).length === 0) return "adds";
  if (diffRows(PAIR_REPLACES, pair).length === 0) return "replaces";
  return undefined;
}

/**
 * One batch, a green baseline, the table per mutant (the pair under ONE reading), the two-arm
 * refusal by name, every admitted file equal to its twin, and no position-wins or dropped line.
 */
export function assertWrappedRun(
  report: WrappedReport,
  leg: string,
  warnings: readonly string[],
): "adds" | "replaces" {
  const problems: string[] = [];
  if (report.batches !== 1) problems.push(`the run planned ${report.batches} batches, not 1`);
  if (!report.baselineGreen) problems.push("the baseline must be green");
  const reading = pairReading(report);
  if (reading === undefined) {
    problems.push(
      `the C1 pair (${PAIR_CODES.join(", ")}) follows neither reading: not all scored as "adds", not all no-coverage as "replaces"`,
    );
  }
  const expected = EXPECTED_WRAPPED.map((r) =>
    reading === "replaces" && PAIR_CODES.includes(r.code)
      ? (PAIR_REPLACES.find((p) => p.code === r.code) ?? r)
      : r,
  );
  problems.push(...diffRows(expected, wrappedRows(report)));
  for (const m of report.mutants) {
    if (m.file.replace(/\\/g, "/") !== ARMS) continue;
    if (m.failureNote !== ARMS_REFUSAL) {
      problems.push(`${m.mutantCode} (two-arm control) is not refused by name: ${m.failureNote}`);
    }
  }
  problems.push(...twinDifferences(report));
  const positionWins = warnings.filter((w) => w.includes("the position wins (R383)"));
  const dropped = warnings.filter((w) => w.includes("the line is dropped (R300)"));
  if (positionWins.length > 0)
    problems.push(`R383 position-wins warnings: ${positionWins.join(" | ")}`);
  if (dropped.length > 0) problems.push(`R-300b dropped lines: ${dropped.join(" | ")}`);
  if (problems.length > 0 || reading === undefined) {
    throw new Error(
      `R-300b wrapped ${leg}: rows differ from the pre-committed table (${SPEC}):\n${problems.map((p) => `  - ${p}`).join("\n")}`,
    );
  }
  return reading;
}

/**
 * Each admitted wrapped file against its twin, per mutant (same procedure, line, operator): the
 * verdict, the killing test and the covering tests, the twin's names being the wrapped ones plus
 * `Twin`. Strict both ways (R343): a wrapped mutant with no twin and a twin mutant with no wrapped
 * partner are each a difference.
 */
export function twinDifferences(report: WrappedReport): string[] {
  const rows = wrappedRows(report);
  const twinName = (t: string) => `${t}Twin`;
  const out: string[] = [];
  for (const [wrapped, twin] of Object.entries(TWINS)) {
    const site = (r: WrappedRow) => `${r.procedureName}|${r.line}|${r.operatorName}`;
    const twins = new Map(rows.filter((r) => r.file === twin).map((r) => [site(r), r]));
    const matched = new Set<string>();
    for (const w of rows.filter((r) => r.file === wrapped)) {
      const t = twins.get(site(w));
      if (t === undefined) {
        out.push(`${w.code} (${wrapped}) has no twin mutant at ${site(w)}`);
        continue;
      }
      matched.add(t.code);
      const want = {
        verdict: w.verdict,
        killingTest: w.killingTest === undefined ? undefined : twinName(w.killingTest),
        coveringTests: w.coveringTests.map(twinName),
      };
      const got = {
        verdict: t.verdict,
        killingTest: t.killingTest,
        coveringTests: t.coveringTests,
      };
      if (JSON.stringify(want) !== JSON.stringify(got)) {
        out.push(
          `${w.code} vs twin ${t.code}: wrapped ${JSON.stringify(want)}, twin ${JSON.stringify(got)}`,
        );
      }
    }
    for (const t of twins.values()) {
      if (!matched.has(t.code)) out.push(`${t.code} (${twin}) has no wrapped partner`);
    }
  }
  return out;
}

/** Per code, every field: `other` must equal the one-shot leg. */
export function assertWrappedLegsEqual(
  oneShot: WrappedReport,
  other: WrappedReport,
  leg: string,
): void {
  const problems = diffRows(wrappedRows(oneShot), wrappedRows(other));
  if (problems.length > 0) {
    throw new Error(
      `R-300b wrapped ${leg}: differs from the one-shot leg:\n${problems.map((p) => `  - ${p}`).join("\n")}`,
    );
  }
}
