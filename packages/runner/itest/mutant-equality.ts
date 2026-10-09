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
import { createHash } from "node:crypto";
import { REDACTION_MARKER } from "../src/explain";
import type { MutantOutcome, SessionReport } from "../src/report";

export interface NormalizedMutant {
  readonly key: string; // astHash|codeunitName|procedureName|operatorName|operatorMajor[|ordinal]
  readonly verdict: string;
  readonly killingTest: string | null;
  readonly coverageFiltered: boolean;
  readonly errorClass: string | null;
  /**
   * R556: sha256 (hex) of `mutatedText`, "\r\n" read as "\n". `keyOf` hashes the ORIGINAL node, so a
   * mutant whose replacement changed keeps its key; this says whether the key still names the same
   * mutant. A hash, never the text, so a committed baseline publishes no source. Absent on rows
   * recorded before R556 and where the report has no text (a redacted report).
   */
  readonly mutatedTextSha256?: string;
}

/** The suffix `clipMutationText` (@lethal/schemata) appends to a clipped text. */
const CLIPPED = /… \[truncated \d+ chars\]$/;

/** R556: the hash `normalizeForComparison` records. None for a non-string, the redaction marker
 *  (not the mutant's text: hashing it would make every redacted row "match" every other), or a
 *  clipped text: the clip point counts "\r", so the same mutant clips at a different place in a
 *  CRLF checkout and its hash would differ for no reason. */
export function mutatedTextSha256(text: unknown): string | undefined {
  if (typeof text !== "string" || text === REDACTION_MARKER || CLIPPED.test(text)) {
    return undefined;
  }
  return createHash("sha256").update(text.replaceAll("\r\n", "\n"), "utf8").digest("hex");
}

export function keyOf(m: MutantOutcome): string {
  // `procedureName` joined the identity in R166; R193 added `identityOrdinal`, this mutant's
  // position among byte-identical twins in SOURCE order (not report order, which is what R166
  // rightly refused to key on). Appended only when non-zero, so every key without a twin is
  // unchanged and a baseline with no collisions is byte-identical across the change.
  const scope = m.procedureName || m.triggerName || "";
  const tuple = `${m.astHash}|${m.codeunitName}|${scope}|${m.operatorName}|${m.operatorMajor}`;
  const ordinal = m.identityOrdinal ?? 0;
  return ordinal > 0 ? `${tuple}|${ordinal}` : tuple;
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
  return report.mutants.map((m) => {
    const hash = mutatedTextSha256(m.mutatedText);
    return {
      key: keyOf(m),
      verdict: m.verdict,
      killingTest: m.killingTest ?? null,
      coverageFiltered: m.verdict === "no-coverage",
      errorClass: errorClassOf(m),
      ...(hash !== undefined ? { mutatedTextSha256: hash } : {}),
    };
  });
}

function fmt(v: string | boolean | null): string {
  return v === null ? "null" : String(v);
}

/** Total order over the compared fields — the tie-break that makes a group's order canonical. */
function recordOrder(a: NormalizedMutant, b: NormalizedMutant): number {
  return canonical(a).localeCompare(canonical(b));
}

/** Every compared field, in a single string, the R556 hash last. Used ONLY for ordering, never for
 *  reporting. */
export function canonical(m: NormalizedMutant): string {
  return `${m.verdict}|${fmt(m.killingTest)}|${fmt(m.coverageFiltered)}|${fmt(m.errorClass)}|${m.mutatedTextSha256 ?? ""}`;
}

/** The key without a trailing `|<ordinal>`: the group R193's twins share. `keyOf`'s tuple has five
 *  fields and the ordinal is a sixth (operatorMajor is also digits, so a suffix regex cannot tell).
 *  ponytail: a `|` inside a quoted AL name would split wrong; the cost is a twin read UNVERIFIED or
 *  a lone row compared as a twin, never a false difference under the same scheme. */
function tupleOf(key: string): string {
  const parts = key.split("|");
  return parts.length > 5 ? parts.slice(0, -1).join("|") : key;
}

/** Hashes that occur more than once within one tuple group: twins' shared text. */
function sharedHashes(mutants: readonly NormalizedMutant[]): Set<string> {
  const seen = new Set<string>();
  const shared = new Set<string>();
  for (const m of mutants) {
    if (m.mutatedTextSha256 === undefined) continue;
    const id = `${tupleOf(m.key)}\u0000${m.mutatedTextSha256}`;
    if (seen.has(id)) shared.add(id);
    else seen.add(id);
  }
  return shared;
}

/** R556: what `compareMutants` found, and how many paired rows it could check the text of. */
export interface MutantComparison {
  readonly differences: string[];
  /** Paired rows whose mutated-text hash was compared (and, when equal, verified). */
  readonly textVerified: number;
  /** Paired rows whose text could not be checked: a hash missing on either side, or a twin's hash
   *  shared within its tuple group when the two sides' identity schemes differ or are unknown. */
  readonly textUnverified: number;
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
  return compareMutants(before, after, { sameScheme: true }).differences;
}

/**
 * `diffMutants` plus the R556 text check. A paired row's `mutatedTextSha256` is compared only when
 * BOTH sides carry one; a mismatch is a difference ("mutated text differs under an unchanged key").
 * `sameScheme` is true only when both sides record the same identity scheme. Otherwise keys may
 * have been reassigned, and byte-identical twins share one hash while their ordinals move, so a row
 * is checked only when its hash is unique within its tuple group on both sides; the rest are
 * counted `textUnverified`, never a difference.
 */
export function compareMutants(
  before: readonly NormalizedMutant[],
  after: readonly NormalizedMutant[],
  opts: { readonly sameScheme: boolean },
): MutantComparison {
  const diffs: string[] = [];
  let textVerified = 0;
  let textUnverified = 0;
  const sharedBefore = opts.sameScheme ? new Set<string>() : sharedHashes(before);
  const sharedAfter = opts.sameScheme ? new Set<string>() : sharedHashes(after);
  const checkable = (
    m: NormalizedMutant,
    shared: Set<string>,
  ): m is NormalizedMutant & {
    mutatedTextSha256: string;
  } =>
    m.mutatedTextSha256 !== undefined &&
    !shared.has(`${tupleOf(m.key)}\u0000${m.mutatedTextSha256}`);
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
      if (checkable(bi, sharedBefore) && checkable(ai, sharedAfter)) {
        textVerified++;
        if (bi.mutatedTextSha256 !== ai.mutatedTextSha256) {
          fieldDiffs.push("mutated text differs under an unchanged key");
        }
      } else {
        textUnverified++;
      }
      if (fieldDiffs.length > 0) {
        const where = b.length > 1 ? ` [occurrence ${i + 1} of ${b.length}]` : "";
        diffs.push(`mutant ${key}${where}: ${fieldDiffs.join("; ")}`);
      }
    }
  }

  return { differences: diffs.sort(), textVerified, textUnverified };
}
