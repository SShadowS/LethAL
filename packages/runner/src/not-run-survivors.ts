// PR-381 (R1197): survivors in an al-runner-v3 run that had tests v3 did not run at baseline.
// Spec: docs/superpowers/specs/2026-11-23-pr381-refused-test-survivors-caveat.md
// A test v3 refused, timed out or stopped at baseline kills nothing, so a survivor only it would kill
// is unknown. No verdict changes: this is the count and the words that go beside every survivor count.
import { isV3RefusalText } from "./al-runner-rows";
import { V3_NOT_RUN_SUFFIX, V3_REFUSED_NEARBY_TAG } from "./al-runner-v3-backend";
import { SURVIVING_VERDICTS } from "./equivalence-marks";
import type { MutantOutcome } from "./report";

/**
 * A baseline row v3 did not run to a verdict: the test never ran, so it would run on BC. Counted:
 * - a refusal (v3's `NotRun: out-of-scope:` text, or the `V3_NOT_RUN_SUFFIX` a verdict carries; `includes`,
 *   because pointers are appended after the suffix);
 * - a timeout (a test LethAL stopped is a `timeout` too) and a `deadline-exceeded` row;
 * - v3's "contract" notRun rows (`v3RowVerdict`), and a baseline transport failure.
 * NOT counted: a test that ran and failed or errored on its own, and the R-236c TestPage-scan skip (PR-387).
 */
export function isNotRunBaselineRow(v: {
  readonly outcome: string;
  readonly failureMessage?: string;
}): boolean {
  const m = v.failureMessage ?? "";
  return (
    v.outcome === "timeout" ||
    v.outcome === "deadline-exceeded" ||
    isV3RefusalText(m) ||
    m.includes(V3_NOT_RUN_SUFFIX) ||
    (m.startsWith("al-runner-v3 contract:") &&
      (m.includes(" is notRun with status ") ||
        m.includes(", but the call was sent --test-timeout-secs "))) ||
    m.startsWith("al-runner-v3 transport failure:")
  );
}

/** The report as this module reads it. A `SessionReport` fits; so does a bare test fixture. */
export interface NotRunView {
  readonly backend: string;
  /** Written on every al-runner-v3 report (`[]` when none); absent on bcdev (until PR-387) and on older reports. */
  readonly notRunAtBaseline?: readonly string[];
  /** The stored result: readers print from it when present. */
  readonly survivorsBesideUnrunTests?: NotRunSurvivors;
  /** A `SessionReport`'s rows. */
  readonly mutants?: readonly Pick<MutantOutcome, "verdict" | "failureNote">[];
  readonly validity?: { readonly caveats: readonly string[] };
  readonly testsOnly?: readonly string[];
}

export interface NotRunSurvivors {
  /** `survived` and `known-survivor` rows. */
  readonly survivors: number;
  /** Tests v3 refused, timed out or stopped at baseline. */
  readonly notRunTests: number;
  /** Survivors carrying `[v3-refused-test-nearby]`. Omitted with coverage off. */
  readonly sharingACodeunit?: number;
}

/** What a reader prints for an al-runner-v3 report written before the field existed. */
export const NOT_RECORDED_TEXT = "tests not run at baseline: not recorded in this report";

const survivorRows = (r: NotRunView) =>
  (r.mutants ?? []).filter((m) => SURVIVING_VERDICTS.has(m.verdict));

/**
 * The rule, pure, on ANY backend: `undefined` unless `notRunAtBaseline` is non-empty and the report has at
 * least one `survived` or `known-survivor` row. (This PR fills the field for al-runner-v3 only; bcdev is
 * PR-387.) confirm-merge passes a view holding only the survivors still measured by v3.
 */
export function notRunSurvivors(r: NotRunView): NotRunSurvivors | undefined {
  const tests = r.notRunAtBaseline ?? [];
  if (tests.length === 0) return undefined;
  const rows = survivorRows(r);
  if (rows.length === 0) return undefined;
  const coverageOff = (r.validity?.caveats ?? []).includes("al-runner-v3-coverage-off");
  return {
    survivors: rows.length,
    notRunTests: tests.length,
    ...(coverageOff
      ? {}
      : {
          sharingACodeunit: rows.filter((m) =>
            (m.failureNote ?? "").includes(V3_REFUSED_NEARBY_TAG),
          ).length,
        }),
  };
}

/**
 * The sentence, raw numbers (no thousands separators). A narrowed or `--tests-only` run counts "of this
 * session's tests".
 */
export function notRunSentence(
  n: NotRunSurvivors,
  scope: { readonly testsOnly?: readonly string[] } = {},
): string {
  const tests =
    scope.testsOnly !== undefined && scope.testsOnly.length > 0
      ? `${n.notRunTests} of this session's tests`
      : `${n.notRunTests} ${n.notRunTests === 1 ? "test" : "tests"}`;
  const hint =
    n.sharingACodeunit === undefined
      ? ""
      : `; ${n.sharingACodeunit} carry the nearby tag (a hint, not a bound)`;
  return `${n.survivors} survivors, all in a run with ${tests} v3 did not run at baseline (refused, timed out or stopped; such a test kills nothing, so a survivor only it would kill is unknown)${hint}`;
}

/**
 * The line a reader prints beside a survivor count: the sentence, the "not recorded" text for an
 * al-runner-v3 report that has survivors and predates the field, or `undefined` when there is nothing
 * to say.
 */
export function notRunLine(r: NotRunView): string | undefined {
  // The stored field is what the run measured; recompute only when it is absent (an older report), or for
  // confirm-merge's subset, which strips it first.
  const n = r.survivorsBesideUnrunTests ?? notRunSurvivors(r);
  if (n !== undefined) {
    return notRunSentence(n, r.testsOnly !== undefined ? { testsOnly: r.testsOnly } : {});
  }
  return r.backend === "al-runner-v3" &&
    r.notRunAtBaseline === undefined &&
    survivorRows(r).length > 0
    ? NOT_RECORDED_TEXT
    : undefined;
}
