/**
 * R582: since bcdev re-runs every kill under the mutant (R577's rule), a `timeout-killed` mutant
 * is stopped by BC TWICE: the first run and the re-run, both at the budget the first run was sent.
 * This is the check that both stops happened and both are BC's own: exactly two mutated `timeout`
 * rows for the killing test (`method = killingTest`: at line 145 the replayed prefix rows belong to
 * another method), each carrying BC's stop words and held to the budget. Kept out of
 * `hang.itest.ts`, which runs its gate at import (R186), so each direction is unit-tested offline
 * (`tests/hang-stop-rows.test.ts`).
 */

import { DEFAULT_DEV_PORT } from "./config-path";
import { markedServerFor } from "./out-of-use";

/**
 * GitHub #49 / R833: which answer BC gives the held request after our confirmed stop. BC 28 answers
 * the 408 naming the AL `StopSession` call; BC 29 answers the exact 400 (measured on `bc4`
 * 29.0.54011.57673: 6 of 6 hangs). The gate accepts ONE form per server, so a 400 on BC 28 still
 * fails it, and so does a 408 on BC 29 until someone measures one there.
 */
export type StopForm = "408" | "400";

/** The `stopEvidence` a row must carry for each form. */
export const STOP_EVIDENCE_FOR_FORM: Record<StopForm, "bc-named-stop" | "begin-transaction-world"> =
  { "408": "bc-named-stop", "400": "begin-transaction-world" };

/**
 * The form this run's server gives, read from the config the run names (`lethal.config.bcN.json`).
 * bc1-bc3 are BC 28.4, bc4 is BC 29. Any other name is refused, never guessed: the parked Cronus28
 * default has no measured form here.
 */
export function stopFormFor(
  configName: string,
  bcdev: { readonly server?: string; readonly port?: number },
  env: NodeJS.ProcessEnv = process.env,
): StopForm {
  const m = /^lethal\.config\.bc([1-4])\.json$/.exec(configName);
  const n = m?.[1];
  if (n === undefined) {
    throw new Error(
      `the hang gate cannot tell which stop answer to expect from config ${JSON.stringify(configName)}: use lethal.config.bc1.json to bc4.json (bc1-bc3 are BC 28, bc4 is BC 29)`,
    );
  }
  // The file name is not proof: cross-check it against the server the config really names.
  const u = bcdev.server === undefined ? undefined : new URL(bcdev.server);
  const devPort =
    bcdev.port ?? (u !== undefined && u.port !== "" ? Number(u.port) : DEFAULT_DEV_PORT);
  const marked = u === undefined ? undefined : markedServerFor(u.hostname, devPort, env);
  if (marked !== `bc${n}`) {
    throw new Error(
      `config ${configName} names server ${u?.hostname ?? "(none)"}:${devPort}, which is ${marked ?? "not a known bc1-bc4 server"}, not bc${n}: the hang gate will not guess the stop answer from a file name that disagrees with the server`,
    );
  }
  return n === "4" ? "400" : "408";
}

/**
 * The problem with a `timeout` row's failure message for `form`, or `undefined` when it carries
 * that form's words. 408: BC's "stopped the session" and "StopSession". 400: BC's body text
 * ("begin transaction world not called" and the code `Internal_ServerError`), which the message
 * quotes after "BC's own words" (`scoreStop`, `RunMutantMany`'s timeout). A message in the OTHER
 * form carries none of this form's words, so it fails.
 */
export function stopWordsProblem(form: StopForm, msg: string): string | undefined {
  if (form === "408") {
    return /stopped the session/i.test(msg) && /StopSession/i.test(msg)
      ? undefined
      : `does not carry BC's 408 stop words ("stopped the session" and "StopSession"): ${JSON.stringify(msg.slice(0, 200))}`;
  }
  return msg.includes("begin transaction world not called") && msg.includes("Internal_ServerError")
    ? undefined
    : `does not carry BC 29's 400 body ("begin transaction world not called" and "Internal_ServerError"): ${JSON.stringify(msg.slice(0, 200))}`;
}

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
  m: {
    readonly mutantCode: string;
    readonly killingTest?: string;
    readonly stopEvidence?: string;
  },
  rows: readonly StopRow[],
  budgetMs: number,
  graceMs: number,
  form: StopForm,
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
  const wantEvidence = STOP_EVIDENCE_FOR_FORM[form];
  if (m.stopEvidence !== wantEvidence) {
    out.push(
      `[${label}] GitHub #49: ${m.mutantCode}'s row has stopEvidence ${JSON.stringify(m.stopEvidence)}, expected ${JSON.stringify(wantEvidence)} (the ${form} form)`,
    );
  }
  stops.forEach((r, i) => {
    const which = i === 0 ? "first run" : "re-run";
    const msg = r.failure_message ?? "";
    const problem = stopWordsProblem(form, msg);
    if (problem !== undefined) {
      out.push(`[${label}] R582: ${m.mutantCode}'s ${which} timeout row ${problem}`);
    }
    if (r.duration_ms < budgetMs || r.duration_ms >= budgetMs + graceMs) {
      out.push(
        `[${label}] R582: ${m.mutantCode}'s ${which} timeout row took ${r.duration_ms} ms, outside [${budgetMs}, ${budgetMs + graceMs})`,
      );
    }
  });
  return out;
}
