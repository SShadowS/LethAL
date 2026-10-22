/**
 * R582: since bcdev re-runs every kill under the mutant (R577's rule), a `timeout-killed` mutant
 * is stopped by BC TWICE: the first run and the re-run, both at the budget the first run was sent.
 * This is the check that both stops happened and both are BC's own: exactly two mutated `timeout`
 * rows for the killing test (`method = killingTest`: at line 145 the replayed prefix rows belong to
 * another method), each carrying BC's stop words and held to the budget. Kept out of
 * `hang.itest.ts`, which runs its gate at import (R186), so each direction is unit-tested offline
 * (`tests/hang-stop-rows.test.ts`).
 */

export interface StopRow {
  readonly mutant_code: string | null;
  readonly method: string;
  readonly outcome: string;
  readonly duration_ms: number;
  readonly failure_message: string | null;
}

/** The failures for one `timeout-killed` mutant, `[]` when both stops hold. */
export function stopRowFailures(
  label: string,
  m: { readonly mutantCode: string; readonly killingTest?: string },
  rows: readonly StopRow[],
  budgetMs: number,
  graceMs: number,
): string[] {
  const stops = rows.filter(
    (r) => r.mutant_code === m.mutantCode && r.outcome === "timeout" && r.method === m.killingTest,
  );
  if (stops.length !== 2) {
    return [
      `[${label}] R582: ${m.mutantCode} must have exactly 2 mutated timeout rows for ${m.killingTest ?? "its killing test"} (the first run and the re-run), got ${stops.length}`,
    ];
  }
  const out: string[] = [];
  stops.forEach((r, i) => {
    const which = i === 0 ? "first run" : "re-run";
    const msg = r.failure_message ?? "";
    if (!/stopped the session/i.test(msg) || !/StopSession/i.test(msg)) {
      out.push(
        `[${label}] R582: ${m.mutantCode}'s ${which} timeout row does not carry BC's stop words ("stopped the session" and "StopSession"): ${JSON.stringify(msg.slice(0, 200))}`,
      );
    }
    if (r.duration_ms < budgetMs || r.duration_ms >= budgetMs + graceMs) {
      out.push(
        `[${label}] R582: ${m.mutantCode}'s ${which} timeout row took ${r.duration_ms} ms, outside [${budgetMs}, ${budgetMs + graceMs})`,
      );
    }
  });
  return out;
}
