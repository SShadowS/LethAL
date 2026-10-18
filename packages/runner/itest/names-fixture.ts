/**
 * R557: the `sandbox-names` fixture's pre-committed per-mutant table and the checks every names leg
 * runs against it: `itest:alrunner`'s four (one-shot and `--server`, coverage `al-runner` and
 * `none`) and `itest:bcdev-names`' one (fenced).
 *
 * Pre-committed in docs/superpowers/specs/2026-10-09-r557-names-precommitment.md (table A) before any
 * LethAL session on the fixture and before any fix code existed. A difference is a finding and a
 * stop: never edit a row to match a run.
 *
 * Twelve procedures, each `exit(x + 1)`, each reached and killed by exactly ONE test. Ten of those
 * tests have an AL name al-runner renames (BC's C# identifier rule, `alRunnerMethodName`): a space,
 * `-`, `()`, `.`, `/`, `&`, a leading digit, the unquoted keyword `Default`, Danish letters. Two are
 * unrenamed controls. Before R557 the ten were never run on al-runner and their 30 mutants read
 * survived (coverage none) or no-coverage (coverage al-runner): pre-commitment section B.
 *
 * Kept out of `al-runner.itest.ts` because that script runs its gate at import (R186).
 */
import { join } from "node:path";
import type { SessionReport } from "../src/report";

const FIXTURES = join(import.meta.dir, "..", "..", "..", "fixtures");
export const NAMES_PROJECT_DIR = join(FIXTURES, "sandbox-names");
export const NAMES_TEST_DIR = join(FIXTURES, "sandbox-names-tests");
/** The top of the target's range, 78800-78849, per the `pickSelectorIds` convention. */
export const NAMES_SELECTOR_IDS = { selectorId: 78849, controlId: 78848, tableId: 78847 };
export const NAMES_TESTS_CODEUNIT_ID = 78850;

export const NAMES_SPEC = "docs/superpowers/specs/2026-10-09-r557-names-precommitment.md";
const SUITE = "Names Tests";
const FILE = "src/NamesCalc.Codeunit.al";
const OPERATORS = ["lethal.empty-block", "lethal.return-value", "lethal.swap-additive"] as const;

/** Table A, one row per procedure, in source order. `row` is al-runner's name (the rule's). */
export const NAMES_TABLE: ReadonlyArray<{
  readonly procedure: string;
  /** The only killer's AL name, as `killingTest` shows it after the suite name. */
  readonly killer: string;
  readonly row: string;
  readonly killText: string;
}> = [
  { procedure: "SpaceStep", killer: "Space Step", row: "Codeunit78850.Space_Step" },
  { procedure: "DashStep", killer: "Dash-Step", row: "Codeunit78850.Dasha45Step" },
  { procedure: "ParenStep", killer: "Paren(Step)", row: "Codeunit78850.Parena40Stepa41" },
  { procedure: "DotStep", killer: "Dot.Step", row: "Codeunit78850.Dota46Step" },
  { procedure: "SlashStep", killer: "Slash/Step", row: "Codeunit78850.Slasha47Step" },
  { procedure: "AmpStep", killer: "Amp&Step", row: "Codeunit78850.Ampa38Step" },
  { procedure: "DigitStep", killer: "7Digit Step", row: "Codeunit78850._7Digit_Step" },
  { procedure: "KeywordStep", killer: "Default", row: "Codeunit78850._Default" },
  {
    procedure: "DanishStep",
    killer: "Blåbær Step",
    row: "Codeunit78850.Blåbær_Step",
  },
  { procedure: "TwinStep", killer: "Twin Pair", row: "Codeunit78850.Twin_Pair" },
  { procedure: "TwinLongStep", killer: "Twin_PairLong", row: "Codeunit78850.Twin_PairLong" },
  { procedure: "PlainStep", killer: "PlainControl", row: "Codeunit78850.PlainControl" },
].map((r) => ({ ...r, killText: `${r.procedure}(5) must be 6` }));

/** Every test of the suite, qualified, sorted: a coverage-`none` leg's covering set. */
export const NAMES_ALL_TESTS: readonly string[] = NAMES_TABLE.map(
  (r) => `${SUITE}.${r.killer}`,
).sort();

export interface NamesRow {
  readonly code: string;
  readonly file: string;
  readonly procedureName: string;
  readonly operatorName: string;
  readonly verdict: string;
  readonly killingTest?: string;
  readonly coveringTests: readonly string[];
}

/** The 36 expected rows. `coverage` decides the covering set: one test, or all twelve. */
export function expectedNamesRows(coverage: "exact" | "all"): NamesRow[] {
  return NAMES_TABLE.flatMap((r, k) =>
    OPERATORS.map((operatorName, j) => ({
      code: `M${String(3 * k + j + 1).padStart(4, "0")}`,
      file: FILE,
      procedureName: r.procedure,
      operatorName,
      verdict: "killed",
      killingTest: `${SUITE}.${r.killer}`,
      coveringTests: coverage === "exact" ? [`${SUITE}.${r.killer}`] : NAMES_ALL_TESTS,
    })),
  );
}

export function namesRows(report: SessionReport): NamesRow[] {
  return report.mutants
    .map((m) => ({
      code: m.mutantCode,
      file: m.file.replace(/\\/g, "/"),
      procedureName: m.procedureName,
      operatorName: m.operatorName,
      verdict: m.verdict,
      ...(m.killingTest !== undefined ? { killingTest: m.killingTest } : {}),
      coveringTests: [...m.coveringTests].sort(),
    }))
    .sort((a, b) => a.code.localeCompare(b.code));
}

/** Printed BEFORE any assertion: a failure must show which mutant moved, and the gate is slow. */
export function printNamesTable(report: SessionReport, leg: string): void {
  console.log(
    `  R557 names ${leg}: batches=${report.batches} baselineGreen=${report.baselineGreen} killed=${report.counts.killed} survived=${report.counts.survived} noCoverage=${report.counts.noCoverage}`,
  );
  for (const r of namesRows(report)) {
    console.log(
      `    ${leg} ${r.code} ${r.verdict} ${r.killingTest ?? "-"} [${r.coveringTests.join(", ")}] ${r.procedureName} ${r.operatorName}`,
    );
  }
}

const show = (r: unknown): string => (r === undefined ? "(none)" : JSON.stringify(r));

function diffRows(expected: readonly NamesRow[], actual: readonly NamesRow[]): string[] {
  const want = new Map(expected.map((r) => [r.code, r]));
  const got = new Map(actual.map((r) => [r.code, r]));
  const out: string[] = [];
  for (const code of [...new Set([...want.keys(), ...got.keys()])].sort()) {
    const e = want.get(code);
    const a = got.get(code);
    if (a === undefined) out.push(`${code} missing: expected ${show(e)}`);
    else if (e === undefined) out.push(`${code} unexpected: actual ${show(a)}`);
    else if (show(e) !== show(a)) out.push(`${code}: expected ${show(e)}, actual ${show(a)}`);
  }
  return out;
}

/** Each kill's text carries its row's `<Proc>(5) must be 6`. */
export function namesKillTextDifferences(report: SessionReport): string[] {
  const out: string[] = [];
  NAMES_TABLE.forEach((r, k) => {
    for (let j = 0; j < 3; j++) {
      const code = `M${String(3 * k + j + 1).padStart(4, "0")}`;
      const m = report.mutants.find((x) => x.mutantCode === code);
      if (m === undefined) out.push(`${code}: missing (its kill text is pinned)`);
      else if (!(m.killingTestFailure ?? "").includes(r.killText))
        out.push(
          `${code}: killingTestFailure ${JSON.stringify(m.killingTestFailure)} lacks ${JSON.stringify(r.killText)}`,
        );
    }
  });
  return out;
}

export interface NamesLegObservations {
  /** Every warning code the session emitted. */
  readonly warningCodes: readonly string[];
  /** The R123 contract lines (`al-runner-contract-pinned`) the session emitted. */
  readonly contractLines: readonly string[];
  /** The `test-name-mangling` fact's verdict, when a contract probe ran. */
  readonly nameFact?: string;
}

/**
 * One batch, a green baseline with no `baseline-red` caveat, the table per mutant (verdict, killing
 * test, kill text, and the covering set the leg's coverage gives), no R557 undecided warning, and
 * M1's contract rule: on a one-shot leg the `test-name-mangling` fact is present and matches; on a
 * `--server` leg no contract line is present.
 */
export function assertNamesRun(
  report: SessionReport,
  leg: string,
  o: {
    readonly coverage: "al-runner" | "none" | "fenced";
    readonly transport: "one-shot" | "server" | "bcdev";
    readonly seen?: NamesLegObservations;
  },
): void {
  const problems: string[] = [];
  if (report.batches !== 1) problems.push(`the run planned ${report.batches} batches, not 1`);
  if (!report.baselineGreen) problems.push("the baseline must be green (12 of 12)");
  if (report.validity.caveats.includes("baseline-red"))
    problems.push("the report carries the baseline-red caveat");
  // B1 (bcdev, fenced) pins verdict, killing test and kill text, not the covering set.
  const unpinned = (rows: NamesRow[]) =>
    o.coverage === "fenced" ? rows.map((r) => ({ ...r, coveringTests: [] })) : rows;
  problems.push(
    ...diffRows(
      unpinned(expectedNamesRows(o.coverage === "none" ? "all" : "exact")),
      unpinned(namesRows(report)),
    ),
  );
  problems.push(...namesKillTextDifferences(report));
  const seen = o.seen;
  if (seen !== undefined) {
    if (seen.warningCodes.includes("al-runner-undecided-test-missing"))
      problems.push("an al-runner-undecided-test-missing warning was emitted");
    if (o.transport === "one-shot" && seen.nameFact !== "matches")
      problems.push(
        `the R123 test-name-mangling fact is ${seen.nameFact ?? "absent"}, not matches`,
      );
    if (
      o.transport === "one-shot" &&
      !seen.contractLines.some((l) => l.includes("test-name-mangling=matches"))
    )
      problems.push(
        `no contract line with test-name-mangling=matches: ${JSON.stringify(seen.contractLines)}`,
      );
    if (o.transport === "server" && seen.contractLines.length > 0)
      problems.push(
        `a --server leg printed a contract line: ${JSON.stringify(seen.contractLines)}`,
      );
  }
  if (problems.length > 0) {
    throw new Error(
      `R557 names ${leg}: rows differ from the pre-committed table (${NAMES_SPEC}):\n${problems.map((p) => `  - ${p}`).join("\n")}`,
    );
  }
}

/** Per mutant: verdict, killing test and kill text, plus the covering set when `withCovering`. */
export function assertNamesLegsEqual(
  reference: SessionReport,
  other: SessionReport,
  leg: string,
  withCovering: boolean,
): void {
  const strip = (rows: NamesRow[]) =>
    rows.map((r) => (withCovering ? r : { ...r, coveringTests: [] as readonly string[] }));
  const problems = diffRows(strip(namesRows(reference)), strip(namesRows(other)));
  for (const m of reference.mutants) {
    const t = other.mutants.find((x) => x.mutantCode === m.mutantCode);
    const text = NAMES_TABLE.find((r) => m.killingTest === `${SUITE}.${r.killer}`)?.killText;
    if (t !== undefined && text !== undefined && !(t.killingTestFailure ?? "").includes(text))
      problems.push(
        `${m.mutantCode}: kill text ${JSON.stringify(t.killingTestFailure)} lacks ${text}`,
      );
  }
  if (problems.length > 0) {
    throw new Error(
      `R557 names ${leg}: differs from the reference leg:\n${problems.map((p) => `  - ${p}`).join("\n")}`,
    );
  }
}
