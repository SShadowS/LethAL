/**
 * R-384: `lethal verify`'s reach filter. Since R-371 a shared-helper edit turns many tests "new",
 * and verify used to add every new test to every survivor's request. Verify's first unmutated run
 * of every requested test already returns that test's coverage (fenced mode), so a new test can be
 * sent only to the survivors its coverage reaches, by the SAME rule the source run used to pick
 * covering tests (`buildCoverageIndex` + `coverageFilter`). Pure: no server, no file.
 *
 * The rule (plan r2): the filter is on only under `fenced` coverage without `--no-reach-filter`.
 * A new test is filterable only when its baseline row is a valid green one (decision 13's
 * `invalidBaselineReason`) AND its coverage has at least one entry; any other new test joins
 * every survivor. A survivor coverage cannot place (R298 refused, R175 unplaceable, no member key)
 * takes every new test. A survivor's source covering tests are never removed.
 */
import type { MutantManifestEntry } from "@lethal/schemata";
import type { CoverageMode, TestMethodRef, TestVerdict } from "./backend";
import { invalidBaselineReason } from "./orchestrator";
import { isHubCoverageMode } from "./runner-disagreement";
import { buildCoverageIndex, coverageFilter, testKeyOf } from "./selection";

/** Whether the filter runs this session, and when it does not, why (rule 1). */
export type ReachState = { readonly on: true } | { readonly on: false; readonly why: string };

/**
 * Rule 1. On only under `fenced` and without `--no-reach-filter`. A hub mode's coverage comes from
 * a `GuiAllowed=Yes` Web session, not the fenced session that decides verdicts (R55), so it can
 * under-report the fenced path; `none` has no coverage. Verify runs on bcdev only, so `al-runner`
 * never reaches here; it is off all the same.
 */
export function reachStateOf(mode: CoverageMode, enabled: boolean): ReachState {
  if (!enabled) return { on: false, why: "--no-reach-filter" };
  if (mode === "fenced") return { on: true };
  if (isHubCoverageMode(mode)) return { on: false, why: `coverage mode "${mode}" is a hub mode` };
  return { on: false, why: `coverage mode "${mode}"` };
}

export interface ReachInput {
  /** The coverage mode the baseline was measured under. */
  readonly mode: CoverageMode;
  /** `false` under `--no-reach-filter`. */
  readonly enabled: boolean;
  /** The running survivors' manifest entries. */
  readonly survivors: readonly MutantManifestEntry[];
  /** Per mutant id: the source run's covering tests that verify runs, in order. Never filtered. */
  readonly coveringKeys: ReadonlyMap<string, readonly TestMethodRef[]>;
  /** The new tests, in plan order. */
  readonly newTests: readonly TestMethodRef[];
  /** The baseline rows `runNamedMutants` just measured. */
  readonly baseline: ReadonlyArray<{ readonly ref: TestMethodRef; readonly verdict: TestVerdict }>;
  /** R298: refused objects of the INSTALLED artifact's sources (`coverageRefusedObjects`). */
  readonly refusedObjects: ReadonlyMap<string, string>;
}

/** Why a survivor takes every new test (rule 4). */
export type FailClosedSurvivorWhy = "refused" | "unplaceable" | "no-member-key";

export interface ReachResult {
  readonly state: ReachState;
  /** Per survivor: its covering tests, then the new tests that reach it, then the fail-closed new
   *  tests (rule 5). With the filter off: its covering tests, then every new test. */
  readonly methods: ReadonlyMap<string, readonly TestMethodRef[]>;
  /** New tests that joined every survivor because their coverage could not be used (rule 2). */
  readonly failClosedTests: ReadonlyArray<{ readonly ref: TestMethodRef; readonly why: string }>;
  /** Survivors that took every new test (rule 4). */
  readonly failClosedSurvivors: ReadonlyArray<{
    readonly mutantId: string;
    readonly why: FailClosedSurvivorWhy;
  }>;
  /** Table-trigger survivors that took fallback 2: every filterable new test. */
  readonly untargeted: readonly string[];
  /** Survivors left with no method at all: nothing is sent for them. */
  readonly unreached: ReadonlySet<string>;
  /** Survivors whose final request holds no new test. A superset of `unreached`. */
  readonly noNewTest: ReadonlySet<string>;
  /** P: summed over survivors, the new tests joined that were not already covering tests. */
  readonly joins: number;
  /** K: how many new tests were filterable (their coverage could be read). */
  readonly filterable: number;
}

/** Rule 4's third case: nothing to look a member up by. */
function hasNoMemberKey(m: MutantManifestEntry): boolean {
  return (
    m.procedureName === "" && m.triggerName === undefined && (m.coverageArmNames ?? []).length === 0
  );
}

/** Why a new test's coverage cannot be used, or `undefined` when it can (rule 2). */
function failClosedWhy(verdict: TestVerdict | undefined): string | undefined {
  const invalid = invalidBaselineReason(verdict);
  if (invalid !== undefined) return invalid;
  if (verdict?.coverage === undefined) return "no coverage was reported";
  if (verdict.coverage.entries.length === 0) return "coverage reported no entries";
  return undefined;
}

export function narrowVerifyRequests(a: ReachInput): ReachResult {
  const state = reachStateOf(a.mode, a.enabled);
  const newKeys = new Set(a.newTests.map(testKeyOf));
  const rowBy = new Map(a.baseline.map((b) => [testKeyOf(b.ref), b.verdict] as const));

  const failClosedTests: Array<{ ref: TestMethodRef; why: string }> = [];
  const filterable: TestMethodRef[] = [];
  if (state.on) {
    for (const ref of a.newTests) {
      const why = failClosedWhy(rowBy.get(testKeyOf(ref)));
      if (why === undefined) filterable.push(ref);
      else failClosedTests.push({ ref, why });
    }
  }

  // Per survivor: the filterable new tests whose coverage reaches it, or "every" when it takes
  // every new test (filter off, or rule 4).
  const reachedBy = new Map<string, ReadonlySet<string> | "every">();
  const failClosedSurvivors: Array<{ mutantId: string; why: FailClosedSurvivorWhy }> = [];
  const untargeted: string[] = [];
  if (!state.on) {
    for (const s of a.survivors) reachedBy.set(s.mutantId, "every");
  } else {
    const index = buildCoverageIndex(
      filterable.map((ref) => {
        const coverage = rowBy.get(testKeyOf(ref))?.coverage;
        return { ref, ...(coverage !== undefined ? { coverage } : {}) };
      }),
    );
    const placeable = a.survivors.filter((s) => !hasNoMemberKey(s));
    // Rule 3: the source run's own call. `nonGreenIndex` is left out on purpose: every non-
    // filterable test joins every survivor anyway, so R140's decline could only take tests away.
    // `warn` is a no-op: two of its lines are false inside verify (rule 7).
    const split = coverageFilter(
      placeable,
      index,
      filterable,
      undefined,
      isHubCoverageMode(a.mode),
      a.refusedObjects,
      () => {},
    );
    for (const s of a.survivors) {
      const id = s.mutantId;
      const why: FailClosedSurvivorWhy | undefined = hasNoMemberKey(s)
        ? "no-member-key"
        : split.refused.has(id)
          ? "refused"
          : split.unplaceable.has(id)
            ? "unplaceable"
            : undefined;
      if (why !== undefined) {
        failClosedSurvivors.push({ mutantId: id, why });
        reachedBy.set(id, "every");
        continue;
      }
      if (split.attribution.get(id) === "all-green") untargeted.push(id);
      reachedBy.set(id, new Set((split.covered.get(id) ?? []).map(testKeyOf)));
    }
  }

  const methods = new Map<string, readonly TestMethodRef[]>();
  const unreached = new Set<string>();
  const noNewTest = new Set<string>();
  let joins = 0;
  for (const s of a.survivors) {
    const id = s.mutantId;
    const covering = a.coveringKeys.get(id) ?? [];
    const coveringKeys = new Set(covering.map(testKeyOf));
    const reached = reachedBy.get(id);
    if (reached === undefined) throw new Error(`verify-reach.ts: survivor ${id} was not decided`);
    const seen = new Set<string>();
    const out: TestMethodRef[] = [];
    const add = (ref: TestMethodRef) => {
      const k = testKeyOf(ref);
      if (seen.has(k)) return;
      seen.add(k);
      out.push(ref);
      if (newKeys.has(k) && !coveringKeys.has(k)) joins += 1;
    };
    // Rule 5: covering tests first and untouched, then the reaching new tests, then the
    // fail-closed ones; each group in plan order. A survivor that takes every new test (filter
    // off, or rule 4) takes them in plan order, exactly as before R-384.
    for (const ref of covering) add(ref);
    if (reached === "every") {
      for (const ref of a.newTests) add(ref);
    } else {
      for (const ref of filterable) if (reached.has(testKeyOf(ref))) add(ref);
      for (const { ref } of failClosedTests) add(ref);
    }
    methods.set(id, out);
    if (out.length === 0) unreached.add(id);
    if (!out.some((r) => newKeys.has(testKeyOf(r)))) noNewTest.add(id);
  }

  return {
    state,
    methods,
    failClosedTests,
    failClosedSurvivors,
    untargeted,
    unreached,
    noNewTest,
    joins,
    filterable: filterable.length,
  };
}
