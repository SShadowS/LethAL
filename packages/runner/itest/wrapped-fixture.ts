/**
 * R-300b: the `sandbox-wrapped` fixture's pre-committed per-mutant table and the checks every
 * `itest:alrunner` wrapped leg runs against it (one-shot, `--server`, resource selector).
 *
 * Pre-committed in docs/superpowers/specs/2026-10-06-r300b-wrapped-leg-precommitment.md before any
 * al-runner session on the fixture; the table is R-343's, pre-committed in
 * docs/superpowers/specs/2026-10-08-r343-wrapped-leg-precommitment.md before the changed code ran.
 * R536 added a wrapped table and a wrapped page with their twins (M0037-M0058), pre-committed in
 * docs/superpowers/specs/2026-10-09-r536-wrapped-table-page-precommitment.md before any live run.
 * R545 added a wrapped page extension and its twin (M0059-M0070), pre-committed in
 * docs/superpowers/specs/2026-10-09-r545-wrapped-pageext-precommitment.md before any live run.
 * R550 added a wrapped report and its twin (M0071-M0098), pre-committed in
 * docs/superpowers/specs/2026-10-09-r550-wrapped-report-precommitment.md before any live run; its
 * kills also pin their failure text (`KILL_TEXTS`), because every one comes from a test's own
 * `Error(...)` and a kill for another reason (a duplicate key, a refused RunModal) would otherwise
 * match the table.
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
// R536: a wrapped table (field trigger + procedure) and a wrapped page, each with an unwrapped twin.
const TRIG = "src/WrappedTrigger.Table.al";
const TRIG_TWIN = "src/WrappedTriggerTwin.Table.al";
const VIEW = "src/WrappedView.Page.al";
const VIEW_TWIN = "src/WrappedViewTwin.Page.al";
// R545: a wrapped page extension (of `Wrapped View`) and its unwrapped twin (of the twin page).
const XTRA = "src/WrappedXtra.PageExt.al";
const XTRA_TWIN = "src/WrappedXtraTwin.PageExt.al";
// R550: a wrapped report (data-item, request-page and report triggers; `Band`, `GetTotal`) and twin.
const BAND = "src/WrappedYBand.Report.al";
const BAND_TWIN = "src/WrappedYBandTwin.Report.al";

/** Admitted wrapped file -> its unwrapped twin. */
export const TWINS: Readonly<Record<string, string>> = {
  [TOP]: TOP_TWIN,
  [PRE]: PRE_TWIN,
  [TRIG]: TRIG_TWIN,
  [VIEW]: VIEW_TWIN,
  [XTRA]: XTRA_TWIN,
  [BAND]: BAND_TWIN,
};
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
  /** R536: the whole covering set, when it is more than the killing (or only) test. Sorted. */
  covering?: readonly string[],
): WrappedRow => ({
  code,
  file,
  line,
  operatorName: `lethal.${operator}`,
  procedureName,
  verdict,
  ...(verdict === "killed" && test !== undefined ? { killingTest: test } : {}),
  coveringTests:
    verdict === "no-coverage" || test === undefined
      ? []
      : (covering ?? [test]).map((t) => `${SUITE}.${t}`),
});

// R536: a trigger mutant has no member name, so every backend places it by its OBJECT (selection's
// fallback 1): the tests that ran anything in that object. The table's trigger mutants are
// therefore covered by both table tests; the page's never-run OnOpenPage by LabelView, which calls
// `Label` and never opens the page, so those mutants survive.
const TRIG_TESTS = ["ClampTrigger", "DoubledTrigger"];
const TRIG_TWIN_TESTS = ["ClampTriggerTwin", "DoubledTriggerTwin"];
// R550: the report's triggers (object-placed) and `Band` (called by both tests) are covered by both.
const BAND_TESTS = ["BandYDirect", "BandYRun"];
const BAND_TWIN_TESTS = ["BandYDirectTwin", "BandYRunTwin"];

/**
 * R550 (plan review I3): the failure text each report-arm kill must carry, by code. Every one is the
 * killing test's own `Error(...)`, worked out from the mutation (replacements read offline): a kill
 * that died for another reason (a duplicate key, a refused RunModal, a permission error) would match
 * the verdict table and is caught here instead.
 */
export const KILL_TEXTS: Readonly<Record<string, string>> = {
  M0071: "band total should be 6, got 0",
  M0072: "band total should be 6, got 0",
  M0078: "band total should be 6, got 7",
  M0079: "Band(3) should be 2, got 0",
  M0080: "Band(2) should be 1, got 2",
  M0081: "Band(3) should be 2, got 0",
  M0082: "Band(2) should be 1, got 0",
  M0083: "band total should be 6, got 0",
  M0084: "band total should be 6, got 0",
  M0085: "band total should be 6, got 0",
  M0086: "band total should be 6, got 0",
  M0092: "band total should be 6, got 7",
  M0093: "Band(3) should be 2, got 0",
  M0094: "Band(2) should be 1, got 2",
  M0095: "Band(3) should be 2, got 0",
  M0096: "Band(2) should be 1, got 0",
  M0097: "band total should be 6, got 0",
  M0098: "band total should be 6, got 0",
};

/** Each code in `KILL_TEXTS` is killed and its `killingTestFailure` contains the pinned text. */
export function killTextDifferences(report: WrappedReport): string[] {
  const out: string[] = [];
  for (const [code, text] of Object.entries(KILL_TEXTS)) {
    const m = report.mutants.find((x) => x.mutantCode === code);
    if (m === undefined) out.push(`${code}: missing (its kill text is pinned)`);
    else if (!(m.killingTestFailure ?? "").includes(text))
      out.push(`${code}: killingTestFailure ${JSON.stringify(m.killingTestFailure)} lacks ${JSON.stringify(text)}`);
  }
  return out;
}

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
  // R536, pre-committed in docs/superpowers/specs/2026-10-09-r536-wrapped-table-page-precommitment.md.
  row("M0037", TRIG, 19, "empty-block", "", "killed", "ClampTrigger", TRIG_TESTS),
  row("M0038", TRIG, 20, "conditional-boundary", "", "survived", "ClampTrigger", TRIG_TESTS),
  row("M0039", TRIG, 21, "remove-assignment", "", "killed", "ClampTrigger", TRIG_TESTS),
  row("M0040", TRIG, 21, "shift-integer", "", "killed", "ClampTrigger", TRIG_TESTS),
  row("M0041", TRIG, 35, "empty-block", "Doubled", "killed", "DoubledTrigger"),
  row("M0042", TRIG, 36, "return-value", "Doubled", "killed", "DoubledTrigger"),
  row("M0043", TRIG_TWIN, 19, "empty-block", "", "killed", "ClampTriggerTwin", TRIG_TWIN_TESTS),
  row(
    "M0044",
    TRIG_TWIN,
    20,
    "conditional-boundary",
    "",
    "survived",
    "ClampTriggerTwin",
    TRIG_TWIN_TESTS,
  ),
  row("M0045", TRIG_TWIN, 21, "remove-assignment", "", "killed", "ClampTriggerTwin", TRIG_TWIN_TESTS),
  row("M0046", TRIG_TWIN, 21, "shift-integer", "", "killed", "ClampTriggerTwin", TRIG_TWIN_TESTS),
  row("M0047", TRIG_TWIN, 35, "empty-block", "Doubled", "killed", "DoubledTriggerTwin"),
  row("M0048", TRIG_TWIN, 36, "return-value", "Doubled", "killed", "DoubledTriggerTwin"),
  row("M0049", VIEW, 27, "empty-block", "", "survived", "LabelView"),
  row("M0050", VIEW, 28, "remove-assignment", "", "survived", "LabelView"),
  row("M0051", VIEW, 28, "flip-boolean-literal", "", "survived", "LabelView"),
  row("M0052", VIEW, 32, "empty-block", "Label", "killed", "LabelView"),
  row("M0053", VIEW, 33, "conditional-boundary", "Label", "survived", "LabelView"),
  row("M0054", VIEW_TWIN, 27, "empty-block", "", "survived", "LabelViewTwin"),
  row("M0055", VIEW_TWIN, 28, "remove-assignment", "", "survived", "LabelViewTwin"),
  row("M0056", VIEW_TWIN, 28, "flip-boolean-literal", "", "survived", "LabelViewTwin"),
  row("M0057", VIEW_TWIN, 32, "empty-block", "Label", "killed", "LabelViewTwin"),
  row("M0058", VIEW_TWIN, 33, "conditional-boundary", "Label", "survived", "LabelViewTwin"),
  // R545, pre-committed in docs/superpowers/specs/2026-10-09-r545-wrapped-pageext-precommitment.md.
  // The extension's never-run OnOpenPage is placed by the EXTENSION object, which only ScaledXtra
  // reaches, so its mutants survive under it.
  row("M0059", XTRA, 14, "empty-block", "", "survived", "ScaledXtra"),
  row("M0060", XTRA, 15, "remove-assignment", "", "survived", "ScaledXtra"),
  row("M0061", XTRA, 15, "flip-boolean-literal", "", "survived", "ScaledXtra"),
  row("M0062", XTRA, 19, "empty-block", "Scaled", "killed", "ScaledXtra"),
  row("M0063", XTRA, 20, "conditional-boundary", "Scaled", "survived", "ScaledXtra"),
  row("M0064", XTRA, 21, "return-value", "Scaled", "killed", "ScaledXtra"),
  row("M0065", XTRA_TWIN, 14, "empty-block", "", "survived", "ScaledXtraTwin"),
  row("M0066", XTRA_TWIN, 15, "remove-assignment", "", "survived", "ScaledXtraTwin"),
  row("M0067", XTRA_TWIN, 15, "flip-boolean-literal", "", "survived", "ScaledXtraTwin"),
  row("M0068", XTRA_TWIN, 19, "empty-block", "Scaled", "killed", "ScaledXtraTwin"),
  row("M0069", XTRA_TWIN, 20, "conditional-boundary", "Scaled", "survived", "ScaledXtraTwin"),
  row("M0070", XTRA_TWIN, 21, "return-value", "Scaled", "killed", "ScaledXtraTwin"),
  // R550, pre-committed in docs/superpowers/specs/2026-10-09-r550-wrapped-report-precommitment.md.
  // Triggers are placed by the REPORT object: every test that ran anything in it (BandYDirect runs
  // `Band` only, BandYRun runs the report). The request page is never shown (survivors), and
  // OnPreReport's two mutants are equivalent (Total starts at 0 on a fresh report variable).
  row("M0071", BAND, 22, "empty-block", "", "killed", "BandYRun", BAND_TESTS),
  row("M0072", BAND, 23, "remove-assignment", "", "killed", "BandYRun", BAND_TESTS),
  row("M0073", BAND, 42, "empty-block", "", "survived", "BandYRun", BAND_TESTS),
  row("M0074", BAND, 43, "remove-assignment", "", "survived", "BandYRun", BAND_TESTS),
  row("M0075", BAND, 43, "flip-boolean-literal", "", "survived", "BandYRun", BAND_TESTS),
  row("M0076", BAND, 52, "empty-block", "", "survived", "BandYRun", BAND_TESTS),
  row("M0077", BAND, 53, "remove-assignment", "", "survived", "BandYRun", BAND_TESTS),
  row("M0078", BAND, 53, "shift-integer", "", "killed", "BandYRun", BAND_TESTS),
  row("M0079", BAND, 57, "empty-block", "Band", "killed", "BandYDirect", BAND_TESTS),
  row("M0080", BAND, 58, "conditional-boundary", "Band", "killed", "BandYDirect", BAND_TESTS),
  row("M0081", BAND, 59, "return-value", "Band", "killed", "BandYDirect", BAND_TESTS),
  row("M0082", BAND, 60, "return-value", "Band", "killed", "BandYDirect", BAND_TESTS),
  row("M0083", BAND, 64, "empty-block", "GetTotal", "killed", "BandYRun"),
  row("M0084", BAND, 65, "return-value", "GetTotal", "killed", "BandYRun"),
  row("M0085", BAND_TWIN, 22, "empty-block", "", "killed", "BandYRunTwin", BAND_TWIN_TESTS),
  row("M0086", BAND_TWIN, 23, "remove-assignment", "", "killed", "BandYRunTwin", BAND_TWIN_TESTS),
  row("M0087", BAND_TWIN, 42, "empty-block", "", "survived", "BandYRunTwin", BAND_TWIN_TESTS),
  row("M0088", BAND_TWIN, 43, "remove-assignment", "", "survived", "BandYRunTwin", BAND_TWIN_TESTS),
  row("M0089", BAND_TWIN, 43, "flip-boolean-literal", "", "survived", "BandYRunTwin", BAND_TWIN_TESTS),
  row("M0090", BAND_TWIN, 52, "empty-block", "", "survived", "BandYRunTwin", BAND_TWIN_TESTS),
  row("M0091", BAND_TWIN, 53, "remove-assignment", "", "survived", "BandYRunTwin", BAND_TWIN_TESTS),
  row("M0092", BAND_TWIN, 53, "shift-integer", "", "killed", "BandYRunTwin", BAND_TWIN_TESTS),
  row("M0093", BAND_TWIN, 57, "empty-block", "Band", "killed", "BandYDirectTwin", BAND_TWIN_TESTS),
  row("M0094", BAND_TWIN, 58, "conditional-boundary", "Band", "killed", "BandYDirectTwin", BAND_TWIN_TESTS),
  row("M0095", BAND_TWIN, 59, "return-value", "Band", "killed", "BandYDirectTwin", BAND_TWIN_TESTS),
  row("M0096", BAND_TWIN, 60, "return-value", "Band", "killed", "BandYDirectTwin", BAND_TWIN_TESTS),
  row("M0097", BAND_TWIN, 64, "empty-block", "GetTotal", "killed", "BandYRunTwin"),
  row("M0098", BAND_TWIN, 65, "return-value", "GetTotal", "killed", "BandYRunTwin"),
];

/**
 * R497: the bcdev table (`itest:bcdev-wrapped`), pre-committed in
 * docs/superpowers/specs/2026-10-08-r497-bcdev-wrapped-precommitment.md. The BC paths admit the
 * two-arm shape, so `WrappedArms` is SCORED there: its three rows replace al-runner's refusals.
 * Every other row is the al-runner table's ("adds": alc compiles the union of the symbols).
 */
export const EXPECTED_WRAPPED_BC: readonly WrappedRow[] = EXPECTED_WRAPPED.map(
  (r) =>
    [
      row("M0001", ARMS, 7, "empty-block", "Pick", "killed", "ArmsPick"),
      row("M0002", ARMS, 8, "conditional-boundary", "Pick", "survived", "ArmsPick"),
      row("M0003", ARMS, 9, "return-value", "Pick", "killed", "ArmsPick"),
    ].find((a) => a.code === r.code) ?? r,
);

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
  /** R550: the killing test's failure text, which `killTextDifferences` reads. */
  readonly killingTestFailure?: string;
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
  problems.push(...killTextDifferences(report));
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

/**
 * R497: one bcdev leg (fenced or hub). One batch, a green baseline, the bcdev table per mutant,
 * strict twin parity, and no coverage refusal naming any of the fixture's objects (codeunits,
 * tables, pages, page extensions and reports 78900-78949, either key case): an admitted file must not be refused, and
 * `WrappedPairB`'s compiled-out key must not refuse `WrappedPairA` (plan r2 A1).
 */
export function assertBcWrappedRun(
  report: WrappedReport,
  leg: string,
  warnings: readonly string[],
): void {
  const problems: string[] = [];
  if (report.batches !== 1) problems.push(`the run planned ${report.batches} batches, not 1`);
  if (!report.baselineGreen) problems.push("the baseline must be green");
  problems.push(...diffRows(EXPECTED_WRAPPED_BC, wrappedRows(report)));
  problems.push(...twinDifferences(report));
  problems.push(...killTextDifferences(report));
  for (const w of warnings)
    if (/coverage refused for (codeunit|table|page|pageextension|report):789\d\d/i.test(w))
      problems.push(`refusal: ${w}`);
  for (const m of report.mutants)
    if (m.failureNote?.includes("coverage refused"))
      problems.push(`${m.mutantCode} carries a refusal: ${m.failureNote}`);
  if (problems.length > 0) {
    throw new Error(
      `R497 bcdev wrapped ${leg}: rows differ from the pre-committed table (${BC_SPEC}):\n${problems.map((p) => `  - ${p}`).join("\n")}`,
    );
  }
}

const BC_SPEC = "docs/superpowers/specs/2026-10-08-r497-bcdev-wrapped-precommitment.md";

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
