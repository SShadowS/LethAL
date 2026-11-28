import type { ReachGrain } from "@lethal/schemata";
import type { TestMethodRef } from "./backend";
import type { ClientCodeunitResult, ClientMethodResult } from "./client-run";

/**
 * PR-479 (479a) round 3b: the pure rules a bcdev-client run decides a verdict by, from RETURNED client op results only
 * (every row check already passed, `checkClientRun`). The orchestrator runs the ops; this file only reads them.
 * Spec: `docs/superpowers/specs/2026-11-28-pr479a-bcdev-client-driver.md`, section 1 item 6, amendment 1 items 2, 3,
 * 6 and 9, amendment 2 items 3, 4 and 6.
 */

/** One test codeunit of the run, its methods in declared (discovery) order. */
export interface ClientCodeunit {
  readonly codeunitId: number;
  readonly codeunitName: string;
  readonly refs: readonly TestMethodRef[];
}

/** The run's test codeunits, in the fixed order of their first method in `tests`, each in declared method order. */
export function clientCodeunitsOf(tests: readonly TestMethodRef[]): ClientCodeunit[] {
  const out = new Map<
    number,
    { codeunitId: number; codeunitName: string; refs: TestMethodRef[] }
  >();
  for (const t of tests) {
    const cu = out.get(t.codeunitId);
    if (cu === undefined)
      out.set(t.codeunitId, { codeunitId: t.codeunitId, codeunitName: t.codeunitName, refs: [t] });
    else cu.refs.push(t);
  }
  return [...out.values()];
}

/** One codeunit's baseline, as scoring reads it. */
export interface ClientCodeunitBaseline {
  readonly declared: readonly string[];
  /** Baseline-green and not a TestPage method: the only methods that can kill. */
  readonly scored: ReadonlySet<string>;
  /** Baseline-red (and not a TestPage method): still run under every mutant, never a killer. */
  readonly red: ReadonlySet<string>;
}

/** The killer: the FIRST failing scored method by `testMethodRuns` (declared order), never by row order. */
export function firstScoredFailure(
  result: ClientCodeunitResult,
  scored: ReadonlySet<string>,
): ClientMethodResult | undefined {
  return [...result.methods]
    .sort((a, b) => a.row.testMethodRuns - b.row.testMethodRuns)
    .find((m) => m.outcome === "fail" && scored.has(m.method));
}

/** Enclosing and unplaced grain have no reach marker: their kill reach is any observed guard of the mutant. */
export function reachesByAny(grain: ReachGrain | undefined): boolean {
  return grain === "enclosing" || grain === "unplaced";
}

/**
 * The reach rule for a kill (amendment 1 item 3, as amended by amendment 2 item 3): some row at or before the killer,
 * in declared order, has Loaded, `loadedMutantId` = the mutant, Activate's generation, and `observedActive`
 * (statement grain, and any grain the manifest does not name) or `observedAny` (enclosing and unplaced grain:
 * `"by-any"`). `undefined`: unreached, so never a kill.
 */
export function killReach(
  result: ClientCodeunitResult,
  killer: ClientMethodResult,
  mutantId: string,
  grain: ReachGrain | undefined,
): "active" | "by-any" | undefined {
  const byAny = reachesByAny(grain);
  const reached = result.methods.some(
    ({ row }) =>
      row.testMethodRuns <= killer.row.testMethodRuns &&
      row.loaded &&
      row.loadedMutantId === mutantId &&
      row.loadedGeneration === result.generation &&
      (byAny ? row.observedAny : row.observedActive),
  );
  return reached ? (byAny ? "by-any" : "active") : undefined;
}

/** The no-mutant confirmation (a): every scored (baseline-green) method must pass. Returns the ones that did not. */
export function confirmationFailures(
  result: ClientCodeunitResult,
  scored: ReadonlySet<string>,
): string[] {
  return result.methods
    .filter((m) => scored.has(m.method) && m.outcome !== "pass")
    .map((m) => m.method);
}

/** Baseline-red methods declared BEFORE the killer (amendment 1 item 9's `kill-after-red-method`). */
export function redBefore(baseline: ClientCodeunitBaseline, killer: string): string[] {
  const at = baseline.declared.indexOf(killer);
  return baseline.declared.slice(0, Math.max(0, at)).filter((m) => baseline.red.has(m));
}

/**
 * GH-24's reach for a client mutant, from the rows of its runs (amendment 1 item 12, amendment 2 item 3): statement
 * grain only, `guardReached` from `observedActive` on a row that loaded this mutant at its op's generation. Any other
 * grain: `undefined` (the field stays ABSENT, never false).
 */
export function clientReach(
  results: readonly { readonly cu: ClientCodeunit; readonly result: ClientCodeunitResult }[],
  mutantId: string,
  grain: ReachGrain | undefined,
): { readonly guardReached: boolean; readonly reachedBy: readonly string[] } | undefined {
  if (grain !== "statement") return undefined;
  const reachedBy = results.flatMap(({ cu, result }) =>
    result.methods
      .filter(
        ({ row }) =>
          row.loaded &&
          row.loadedMutantId === mutantId &&
          row.loadedGeneration === result.generation &&
          row.observedActive,
      )
      .map((m) => `${cu.codeunitName}.${m.method}`),
  );
  return { guardReached: reachedBy.length > 0, reachedBy };
}
