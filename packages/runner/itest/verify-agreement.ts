/**
 * C02-08: joins `lethal verify`'s result rows to a FRESH full run, per mutant.
 *
 * Verify names each row by the SOURCE run's `<batchIndex>/<mutantCode>`. Mutant codes restart per
 * run, so they are never compared across runs: a row finds its one source mutant by code, then its
 * one full-run mutant by the R166 identity key (`keyOf`, the key `campaign compare` and every frozen
 * baseline use). The comparison is per mutant; an aggregate count is never the agreement.
 */
import type { MutantOutcome, SessionReport } from "../src/report";
import type { VerifyOutput, VerifyResult } from "../src/verify";
import { keyOf } from "./mutant-equality";

export interface AgreementRow {
  /** Verify's `<batchIndex>/<mutantCode>`, scoped to the source run. */
  readonly id: string;
  /** `keyOf(source mutant)`. */
  readonly key: string;
  readonly verify: string;
  /** The full run's verdict, or `missing` / `ambiguous(<n>)` / `join-mismatch`. */
  readonly full: string;
  readonly agree: boolean;
}

export class AgreementJoinError extends Error {}

function agreeWith(r: VerifyResult, f: MutantOutcome, full: SessionReport): boolean {
  switch (r.verdict) {
    case "killed":
      return (
        f.verdict === "killed" &&
        r.killingTest !== undefined &&
        f.killingTest === r.killingTest.method
      );
    case "survived":
      return f.verdict === "survived";
    case "skipped": {
      // Skipped is not survived: the full run must confirm the SAME mark matched this survivor.
      const key = r.skipped?.mark.key;
      return (
        key !== undefined &&
        f.verdict === "survived" &&
        f.readerMark?.key === key &&
        (full.readerMarkedEquivalent?.matched ?? []).some(
          (m) => m.mutantCode === f.mutantCode && m.key === key,
        )
      );
    }
    default:
      return false; // "error" measured nothing, so it agrees with nothing.
  }
}

/**
 * Throws AgreementJoinError on an empty result list or a verify id not exactly once in `source`.
 * Returns every row, and one human-readable difference per disagreeing mutant.
 */
export function compareVerifyToFullRun(
  out: Pick<VerifyOutput, "results">,
  source: SessionReport,
  full: SessionReport,
): { readonly rows: readonly AgreementRow[]; readonly diffs: readonly string[] } {
  if (out.results.length === 0) {
    throw new AgreementJoinError("verify returned no rows; nothing to compare");
  }
  const rows: AgreementRow[] = [];
  const diffs: string[] = [];
  for (const r of out.results) {
    const src = source.mutants.filter(
      (m) => m.batchIndex === r.batchIndex && m.mutantCode === r.mutantCode,
    );
    const [s] = src;
    if (s === undefined || src.length !== 1) {
      throw new AgreementJoinError(`${r.id}: ${src.length} source mutants, not 1`);
    }
    const key = keyOf(s);
    // Part of `agree`, not a side note: a wrong join must never print as an agreeing row. Both
    // sides carry the manifest's raw `procedureName` ("" on a trigger row), so they compare as-is.
    if (
      s.file !== r.file ||
      s.line !== r.line ||
      s.operatorName !== r.operatorName ||
      s.procedureName !== r.procedureName
    ) {
      rows.push({ id: r.id, key, verify: r.verdict, full: "join-mismatch", agree: false });
      diffs.push(
        `${r.id} (${key}): verify row names ${r.file}:${r.line} ${r.operatorName} ${r.procedureName}, the source mutant ${s.file}:${s.line} ${s.operatorName} ${s.procedureName}`,
      );
      continue;
    }
    const hits = full.mutants.filter((m) => keyOf(m) === key);
    const [f] = hits;
    if (f === undefined || hits.length !== 1) {
      const fullVerdict = hits.length === 0 ? "missing" : `ambiguous(${hits.length})`;
      rows.push({ id: r.id, key, verify: r.verdict, full: fullVerdict, agree: false });
      diffs.push(`${r.id} (${key}): verify ${r.verdict}, full run ${fullVerdict}`);
      continue;
    }
    const agree = agreeWith(r, f, full);
    rows.push({ id: r.id, key, verify: r.verdict, full: f.verdict, agree });
    if (!agree) {
      const vBy = r.killingTest !== undefined ? ` by ${r.killingTest.method}` : "";
      const fBy = f.killingTest !== undefined ? ` by ${f.killingTest}` : "";
      const marked = f.readerMark !== undefined ? " (marked)" : "";
      diffs.push(
        `${r.id} (${key}): verify ${r.verdict}${vBy}, full run ${f.verdict}${fBy}${marked}`,
      );
    }
  }
  return { rows, diffs };
}

/**
 * Throws AgreementJoinError when `full` shows ANY sign of --resume: a "resumed" entry in
 * `validity.caveats`, a `resumedFrom`, or a mutant with carried === true. Each is checked on its
 * own, so a resumed run that carried zero mutants is still refused (R247).
 */
export function assertFreshFullRun(full: SessionReport): void {
  if (full.validity.caveats.includes("resumed")) {
    throw new AgreementJoinError("the full run's validity.caveats says resumed (R247)");
  }
  if (full.resumedFrom !== undefined) {
    throw new AgreementJoinError(`the full run resumed from run ${full.resumedFrom.runId} (R247)`);
  }
  const carried = full.mutants.filter((m) => m.carried === true).map((m) => m.mutantCode);
  if (carried.length > 0) {
    throw new AgreementJoinError(`the full run carried ${carried.join(", ")} by --resume (R247)`);
  }
}
