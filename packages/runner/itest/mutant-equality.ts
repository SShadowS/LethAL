/**
 * Per-mutant regression-equality gate (Layer 5A, design spec §11): "Per-mutant regression
 * equality — not aggregate counts, which can match while individual verdicts are swapped."
 *
 * Aggregate counts (killed 3 / survived 10 / no-coverage 3) are a smoke test only. Two reports
 * can share every aggregate count while two mutants' verdicts have been silently swapped
 * between them — a regression aggregates cannot see. This module normalizes a `SessionReport`
 * into per-mutant records keyed by SEMANTIC identity (the same astHash/codeunitName/
 * operatorName/operatorMajor tuple `identityKeyOf`/`serializeKey` in `../src/selection.ts`
 * already use for known-survivor persistence — never a mutant CODE or a file:line pair, both of
 * which shift under renumbering or incidental source edits) and diffs two such normalized sets
 * field by field.
 *
 * Deliberately excluded from comparison: `duration`, `runId`, `version` and `artifactId` — all
 * nondeterministic by design (clock-derived versions, random per-artifact ids, wall-clock
 * timings), never part of a mutant's semantic identity or verdict.
 */
import type { MutantOutcome, SessionReport } from "../src/report";

export interface NormalizedMutant {
  readonly key: string; // astHash|codeunitName|operatorName|operatorMajor
  readonly verdict: string;
  readonly killingTest: string | null;
  readonly coverageFiltered: boolean;
  readonly errorClass: string | null;
}

function keyOf(m: MutantOutcome): string {
  return `${m.astHash}|${m.codeunitName}|${m.operatorName}|${m.operatorMajor}`;
}

/**
 * Coarse, deterministic error classification. `cause` is set at only two call sites in
 * `orchestrator.ts` (a client-side deadline, or a test that fails at baseline confirmation);
 * every other "error" verdict (a bisected compile-failure culprit, an unattributable deploy
 * failure, "no green baseline tests", ...) collapses to "other" rather than pattern-matching
 * `failureNote`'s free text, which can legitimately vary between two otherwise-equal runs (it
 * embeds e.g. a bisected culprit's own mutant id/line, which is deterministic PER RUN but not
 * guaranteed byte-identical across two independently generated artifacts). None of the live
 * verdict tables this gate checks (fixtures/README.md) contain any "error" verdict, so this
 * coarseness costs nothing there; a finer taxonomy is future work if error-path regressions
 * ever need it.
 */
function errorClassOf(m: MutantOutcome): string | null {
  if (m.verdict !== "error") return null;
  return m.cause ?? "other";
}

/** Excludes duration, runId, version and artifactId — nondeterministic by design. */
export function normalizeForComparison(report: SessionReport): NormalizedMutant[] {
  return report.mutants.map((m) => ({
    key: keyOf(m),
    verdict: m.verdict,
    killingTest: m.killingTest ?? null,
    coverageFiltered: m.verdict === "no-coverage",
    errorClass: errorClassOf(m),
  }));
}

function fmt(v: string | boolean | null): string {
  return v === null ? "null" : String(v);
}

/**
 * Returns human-readable differences; empty array means equal. One entry PER MUTANT that
 * differs (not one per differing field) — a verdict swapped between two mutants therefore
 * produces exactly two entries, not four, matching how a reviewer would actually read the
 * diff: "these two mutants changed," not four disconnected field deltas.
 *
 * Also flags a semantic identity appearing more than once within a single side (an
 * `identityKeyOf` collision — see selection.ts's own caveat about non-laminar specs) and a
 * mutant present on only one side, both of which are regressions equality-by-index would miss
 * entirely.
 */
export function diffMutants(
  before: readonly NormalizedMutant[],
  after: readonly NormalizedMutant[],
): string[] {
  const diffs: string[] = [];

  const groupByKey = (mutants: readonly NormalizedMutant[]): Map<string, NormalizedMutant[]> => {
    const map = new Map<string, NormalizedMutant[]>();
    for (const m of mutants) {
      const list = map.get(m.key);
      if (list) list.push(m);
      else map.set(m.key, [m]);
    }
    return map;
  };
  const beforeByKey = groupByKey(before);
  const afterByKey = groupByKey(after);

  for (const [key, list] of beforeByKey) {
    if (list.length > 1) {
      diffs.push(
        `mutant ${key}: appears ${list.length} times in "before" (duplicate semantic identity)`,
      );
    }
  }
  for (const [key, list] of afterByKey) {
    if (list.length > 1) {
      diffs.push(
        `mutant ${key}: appears ${list.length} times in "after" (duplicate semantic identity)`,
      );
    }
  }

  const allKeys = new Set([...beforeByKey.keys(), ...afterByKey.keys()]);
  for (const key of allKeys) {
    const b = beforeByKey.get(key)?.[0];
    const a = afterByKey.get(key)?.[0];
    if (b === undefined) {
      diffs.push(`mutant ${key}: present in "after" but missing from "before"`);
      continue;
    }
    if (a === undefined) {
      diffs.push(`mutant ${key}: present in "before" but missing from "after"`);
      continue;
    }
    const fieldDiffs: string[] = [];
    if (b.verdict !== a.verdict) fieldDiffs.push(`verdict ${fmt(b.verdict)} -> ${fmt(a.verdict)}`);
    if (b.killingTest !== a.killingTest) {
      fieldDiffs.push(`killingTest ${fmt(b.killingTest)} -> ${fmt(a.killingTest)}`);
    }
    if (b.coverageFiltered !== a.coverageFiltered) {
      fieldDiffs.push(`coverageFiltered ${fmt(b.coverageFiltered)} -> ${fmt(a.coverageFiltered)}`);
    }
    if (b.errorClass !== a.errorClass) {
      fieldDiffs.push(`errorClass ${fmt(b.errorClass)} -> ${fmt(a.errorClass)}`);
    }
    if (fieldDiffs.length > 0) {
      diffs.push(`mutant ${key}: ${fieldDiffs.join("; ")}`);
    }
  }

  return diffs.sort();
}
