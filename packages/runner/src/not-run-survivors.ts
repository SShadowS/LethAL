// PR-381 (R1197): survivors in an al-runner-v3 run that had tests v3 did not run at baseline.
// Spec: docs/superpowers/specs/2026-11-23-pr381-refused-test-survivors-caveat.md
// A test v3 refused, timed out or stopped at baseline kills nothing, so a survivor only it would kill
// is unknown. No verdict changes: this is the count and the words that go beside every survivor count.
import { V3_REFUSED_NEARBY_TAG } from "./al-runner-v3-backend";
import { SURVIVING_VERDICTS } from "./equivalence-marks";
import type { MutantOutcome, SessionReport } from "./report";

/** The report as this module reads it. A `SessionReport` fits; so does a bare test fixture. */
export interface NotRunView {
  readonly backend?: string;
  /** Written on every al-runner-v3 report (`[]` when none); absent on bcdev and on older reports. */
  readonly v3NotRunAtBaseline?: readonly string[];
  /** A `SessionReport`'s rows. A bare fixture may hold fewer fields; `reaches` still gets the row as given. */
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
 * Does a not-run test reach a mutant? `"unknown"` counts as reaching: an answer may only over-approximate.
 * The injection point for PR-386's static reach; nothing passes one yet.
 */
export type NotRunReach = (
  test: string,
  mutant: Readonly<SessionReport["mutants"][number]>,
) => boolean | "unknown";

/** The default: every not-run test reaches every survivor (the spec's whole-suite trigger). */
export const ALWAYS_REACHES: NotRunReach = () => true;

/**
 * The rule, pure. `undefined` unless the backend is al-runner-v3, `v3NotRunAtBaseline` is non-empty and
 * the report has at least one `survived` or `known-survivor` row that SOME not-run test `reaches`.
 * confirm-merge passes a view holding only the survivors still measured by v3.
 */
export function notRunSurvivors(
  r: NotRunView,
  reaches: NotRunReach = ALWAYS_REACHES,
): NotRunSurvivors | undefined {
  if (r.backend !== "al-runner-v3") return undefined;
  const tests = r.v3NotRunAtBaseline ?? [];
  if (tests.length === 0) return undefined;
  const rows =
    reaches === ALWAYS_REACHES
      ? survivorRows(r)
      : survivorRows(r).filter((m) =>
          // The rows of a real report are whole `MutantOutcome`s.
          tests.some((t) => reaches(t, m as SessionReport["mutants"][number]) !== false),
        );
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
      : `${n.notRunTests} tests`;
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
  const n = notRunSurvivors(r);
  if (n !== undefined) {
    return notRunSentence(n, r.testsOnly !== undefined ? { testsOnly: r.testsOnly } : {});
  }
  return r.backend === "al-runner-v3" &&
    r.v3NotRunAtBaseline === undefined &&
    survivorRows(r).length > 0
    ? NOT_RECORDED_TEXT
    : undefined;
}
