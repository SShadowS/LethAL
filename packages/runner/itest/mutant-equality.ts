/**
 * Per-mutant HEALTHY-PATH regression guard (Layer 5A, design spec §11; renamed and scoped by the
 * Layer 5B fold-in, design spec §13 item 1): "Per-mutant regression equality — not aggregate
 * counts, which can match while individual verdicts are swapped."
 *
 * ROLE, PRECISELY: this proves the *healthy* path's per-mutant verdicts are unchanged across two
 * runs — it is NOT "the oracle every task checks." It gives ZERO evidence for failure-path logic
 * (cancellation, quarantine, retry classification, ...), which never fires on a healthy run by
 * construction. Each failure seam needs its own fault-injection oracle instead (design spec §14).
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

/** Total order over the compared fields — the tie-break that makes a group's order canonical. */
function recordOrder(a: NormalizedMutant, b: NormalizedMutant): number {
  return canonical(a).localeCompare(canonical(b));
}

/** Every compared field, in a single string. Used ONLY for ordering, never for reporting. */
export function canonical(m: NormalizedMutant): string {
  return `${m.verdict}|${fmt(m.killingTest)}|${fmt(m.coverageFiltered)}|${fmt(m.errorClass)}`;
}

function times(n: number): string {
  return n === 1 ? "1 time" : `${n} times`;
}

function groupByKey(mutants: readonly NormalizedMutant[]): Map<string, NormalizedMutant[]> {
  const map = new Map<string, NormalizedMutant[]>();
  for (const m of mutants) {
    const list = map.get(m.key);
    if (list) list.push(m);
    else map.set(m.key, [m]);
  }
  return map;
}

/**
 * Returns human-readable differences; empty array means equal. One entry PER MUTANT that
 * differs (not one per differing field) — a verdict swapped between two mutants therefore
 * produces exactly two entries, not four, matching how a reviewer would actually read the
 * diff: "these two mutants changed," not four disconnected field deltas.
 *
 * COMPARISON IS PER-KEY MULTISET, not per-key single record. A semantic identity legitimately
 * repeats within one report: `identityKeyOf` is (astHash, codeunitName, operatorName,
 * operatorMajor), and two textually identical statements in the same object hash identically —
 * `tables.baseline.json`'s `Data Ops` holds one such group SIX deep. Treating a repeat as a
 * defect in its own right made `diffMutants(baseline, baseline)` non-empty, i.e. the committed
 * baseline could never pass, and the failure was self-reinforcing: the guard's own advice
 * ("delete, re-run, re-record") regenerated a byte-identical file. Comparing `[0]` of each group
 * instead would have been worse than useless — the six-deep group carries MIXED verdicts (one
 * survived, five killed, three distinct killing tests), so which record `[0]` names depends on
 * report order, exactly the fragility semantic-identity keying exists to remove.
 *
 * So: group both sides by key, sort each group by `canonical` (a total order over the compared
 * fields alone), and compare element-wise. That pins every record rather than one per key, and
 * it is order-insensitive by construction — reordering a group's members is not a difference,
 * because within one key the members ARE indistinguishable except by the fields being compared.
 *
 * Adding a within-key ordinal to `keyOf` would achieve the same count and reintroduce exactly the
 * report-order sensitivity this avoids; it is deliberately not done.
 *
 * Still flagged, each as its own diff: a key whose group SIZE differs between the sides (a
 * mutant gained or lost at that identity), and a key present on only one side.
 */
export function diffMutants(
  before: readonly NormalizedMutant[],
  after: readonly NormalizedMutant[],
): string[] {
  const diffs: string[] = [];
  const beforeByKey = groupByKey(before);
  const afterByKey = groupByKey(after);

  const allKeys = new Set([...beforeByKey.keys(), ...afterByKey.keys()]);
  for (const key of allKeys) {
    const b = [...(beforeByKey.get(key) ?? [])].sort(recordOrder);
    const a = [...(afterByKey.get(key) ?? [])].sort(recordOrder);
    if (b.length === 0) {
      const n = a.length > 1 ? ` (${times(a.length)})` : "";
      diffs.push(`mutant ${key}: present in "after" but missing from "before"${n}`);
      continue;
    }
    if (a.length === 0) {
      const n = b.length > 1 ? ` (${times(b.length)})` : "";
      diffs.push(`mutant ${key}: present in "before" but missing from "after"${n}`);
      continue;
    }
    if (b.length !== a.length) {
      diffs.push(
        `mutant ${key}: appears ${times(b.length)} in "before" but ${times(a.length)} in "after" (semantic-identity group size changed)`,
      );
      continue;
    }
    // Element-wise over the two canonically ordered groups. `where` is empty for the ordinary
    // one-record group so those messages stay exactly as they were.
    for (let i = 0; i < b.length; i++) {
      const bi = b[i];
      const ai = a[i];
      if (bi === undefined || ai === undefined) continue; // unreachable: lengths are equal
      const fieldDiffs: string[] = [];
      if (bi.verdict !== ai.verdict) {
        fieldDiffs.push(`verdict ${fmt(bi.verdict)} -> ${fmt(ai.verdict)}`);
      }
      if (bi.killingTest !== ai.killingTest) {
        fieldDiffs.push(`killingTest ${fmt(bi.killingTest)} -> ${fmt(ai.killingTest)}`);
      }
      if (bi.coverageFiltered !== ai.coverageFiltered) {
        fieldDiffs.push(
          `coverageFiltered ${fmt(bi.coverageFiltered)} -> ${fmt(ai.coverageFiltered)}`,
        );
      }
      if (bi.errorClass !== ai.errorClass) {
        fieldDiffs.push(`errorClass ${fmt(bi.errorClass)} -> ${fmt(ai.errorClass)}`);
      }
      if (fieldDiffs.length > 0) {
        const where = b.length > 1 ? ` [occurrence ${i + 1} of ${b.length}]` : "";
        diffs.push(`mutant ${key}${where}: ${fieldDiffs.join("; ")}`);
      }
    }
  }

  return diffs.sort();
}
