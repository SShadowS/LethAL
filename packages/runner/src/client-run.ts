import {
  ClientDriverCommandError,
  ClientDriverDeadlineError,
  ClientDriverDiedError,
  ClientDriverNotBuiltError,
  ClientDriverProtocolError,
  ClientDriverRefusedError,
  ClientDriverSequenceError,
  ClientDriverSessionError,
} from "./client-driver";
import type { ClientAttestationRow } from "./client-transport";

/**
 * PR-479 (479a) round 3a: what one client codeunit run returns, and every check on its rows.
 * A check that fails throws a named `ClientRunFailure`. It is a failure, never a verdict (the orchestrator, round 3b,
 * decides kills and survivors from a RETURNED result only).
 * Spec: `docs/superpowers/specs/2026-11-28-pr479a-bcdev-client-driver.md`, section 1 item 6 and amendments 1-3.
 */

export type ClientRunFailureReason =
  | "workdate-changed"
  | "client-activation-unknown"
  | "client-activation-refused"
  | "client-deactivate-before-end"
  | "client-final-deactivate"
  | "client-attestation-unreadable"
  | "client-page-result-unreadable"
  | "client-run-empty"
  | "client-incomplete"
  | "client-test-method-runs"
  | "client-row-session"
  | "client-row-generation"
  | "client-row-mutant"
  | "client-row-not-loaded-observed"
  | "client-row-identity-mismatch"
  | "client-row-success"
  /** N2: a row's serverGeneration or databaseId differs from the lease's / HarnessInfo's: another server state. */
  | "client-row-stale-server"
  /** S3: the driver's close after the final Deactivate failed; the session may linger. Stops the run, quarantines. */
  | "client-close-failed"
  /** The driver failed BEFORE Activate (a read-back refusal, a dead driver): no op exists, nothing is wedged. */
  | "client-driver-failed"
  /** Anything that is not a named check, between Activate and the final Deactivate (an overrun, a dead driver, a
   *  lost answer): the op may still be running. */
  | "client-in-flight-unknown";

export class ClientRunFailure extends Error {
  constructor(
    readonly reason: ClientRunFailureReason,
    message: string,
    /**
     * PR-479 round 3b: the op may still be in flight (it was, or may have been, activated and its final Deactivate
     * never answered `deactivated`). Recovered only by an NST restart plus ForceResetLease, so the orchestrator
     * quarantines the lane (base spec item 7, amendment 1 items 1 and 8).
     */
    readonly inFlight = false,
  ) {
    super(`${reason}: ${message}`);
    this.name = "ClientRunFailure";
    this.detail = message;
  }
  /** The message without its reason prefix. */
  readonly detail: string;
}

const DRIVER_ERRORS = [
  ClientDriverRefusedError,
  ClientDriverDeadlineError,
  ClientDriverDiedError,
  ClientDriverSessionError,
  ClientDriverCommandError,
  ClientDriverProtocolError,
  ClientDriverSequenceError,
  ClientDriverNotBuiltError,
] as const;

/**
 * Round 3b: what a client op's failure means for the orchestrator. Inside the in-flight window (`inFlight`), every
 * failure is marked in flight, and one that is not a named check becomes `client-in-flight-unknown`. Outside it, a
 * driver failure is `client-driver-failed` (no op exists). Any other error is returned unchanged: it stops the run.
 */
export function classifyClientFailure(err: unknown, inFlight: boolean): unknown {
  if (err instanceof ClientRunFailure) {
    return inFlight && !err.inFlight ? new ClientRunFailure(err.reason, err.detail, true) : err;
  }
  const text = err instanceof Error ? err.message : String(err);
  if (inFlight) {
    return new ClientRunFailure(
      "client-in-flight-unknown",
      `${text}; the op did not End, and stays in flight until an NST restart plus ForceResetLease`,
      true,
    );
  }
  if (DRIVER_ERRORS.some((c) => err instanceof c)) {
    return new ClientRunFailure("client-driver-failed", `${text} (before Activate: no op exists)`);
  }
  return err;
}

export interface ClientMethodResult {
  readonly method: string;
  readonly outcome: "pass" | "fail";
  readonly failureMessage?: string;
  readonly row: ClientAttestationRow;
}

export interface ClientCodeunitResult {
  readonly codeunitId: number;
  /** One entry per declared method, in declared order. */
  readonly methods: readonly ClientMethodResult[];
  readonly boundSessionId: number;
  /** The generation `ActivateForClient` wrote. */
  readonly generation: number;
  /** The server's start WorkDate before and after the op; equal to the batch baseline's, or the run failed. */
  readonly workDates: { readonly before: string; readonly after: string };
}

export interface PageResult {
  readonly name: string;
  readonly outcome: "pass" | "fail";
  readonly message?: string;
}

/** The codeunit's own `OnRun` is matched by name and left out of the 1..N join (amendment 2, item 5). */
const ON_RUN = "onrun";
const isOnRun = (name: string): boolean => name.toLowerCase() === ON_RUN;

/** The test runner's method `result` values, measured on bcwin (PR-478): 2 is a pass, 1 a failure. */
const RESULT_SUCCESS = 2;
const RESULT_FAILURE = 1;

/**
 * Reads the driver's `ran` detail. `results` is an array of the test runner's `TestResultJson` texts, ONE per codeunit
 * (measured on bcwin, PR-478 `client-op-result.md`):
 * `{"name", "codeUnit": <id>, ..., "result", "testResults": [{"method", "startTime", "finishTime", "result"}, ...]}`.
 * A method's `result` is 2 (success) or 1 (failure); anything else is unreadable. A failing entry's text is its
 * `message` or `errorMessage` string, when it has one. A codeunit other than `codeunitId` is an extra codeunit
 * (`client-incomplete`). Anything else that does not read throws `client-page-result-unreadable`.
 */
export function parsePageResults(
  detail: Record<string, unknown> | undefined,
  codeunitId: number,
): PageResult[] {
  const raw = detail?.results;
  if (!Array.isArray(raw)) {
    throw new ClientRunFailure(
      "client-page-result-unreadable",
      "the driver's ran step has no results array",
    );
  }
  const unreadable = (why: string): never => {
    throw new ClientRunFailure("client-page-result-unreadable", why);
  };
  const asObject = (v: unknown, at: string): Record<string, unknown> =>
    typeof v === "object" && v !== null && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : unreadable(`${at} is not an object`);
  return raw.flatMap((text, i) => {
    let parsed: unknown;
    try {
      parsed = typeof text === "string" ? JSON.parse(text) : text;
    } catch {
      return unreadable(`result ${i} is not JSON`);
    }
    const cu = asObject(parsed, `result ${i}`);
    if (typeof cu.codeUnit !== "number") unreadable(`result ${i} has no numeric codeUnit`);
    if (cu.codeUnit !== codeunitId) {
      throw new ClientRunFailure(
        "client-incomplete",
        `the page ran codeunit ${String(cu.codeUnit)}, not the requested ${codeunitId}`,
      );
    }
    if (!Array.isArray(cu.testResults)) unreadable(`result ${i} has no testResults array`);
    return (cu.testResults as unknown[]).map((entry, j): PageResult => {
      const at = `result ${i} entry ${j}`;
      const { method, result, message, errorMessage } = asObject(entry, at);
      if (typeof method !== "string" || method === "") return unreadable(`${at} has no method`);
      if (result !== RESULT_SUCCESS && result !== RESULT_FAILURE) {
        return unreadable(
          `${at} (${method}) has result ${JSON.stringify(result)}, not ${RESULT_SUCCESS} (success) or ${RESULT_FAILURE} (failure)`,
        );
      }
      const text =
        typeof message === "string" && message !== ""
          ? message
          : typeof errorMessage === "string" && errorMessage !== ""
            ? errorMessage
            : undefined;
      return {
        name: method,
        outcome: result === RESULT_SUCCESS ? "pass" : "fail",
        ...(text !== undefined ? { message: text } : {}),
      };
    });
  });
}

export interface ClientRunCheckInput {
  readonly codeunitId: number;
  /** The manifest's declared method names, in declared order. */
  readonly declared: readonly string[];
  readonly pageResults: readonly PageResult[];
  readonly rows: readonly ClientAttestationRow[];
  readonly attemptId: string;
  readonly opSeq: number;
  /** The id `DeactivateForClient` named before End. */
  readonly boundSessionId: number;
  /** What `ActivateForClient` wrote. */
  readonly generation: number;
  /** The mutant the op activated; "" for a baseline or a no-mutant confirmation. */
  readonly mutantId: string;
  /** The lease's serverGeneration; every row must carry it (N2). */
  readonly serverGeneration: string;
  /** HarnessInfo's databaseId; every row must carry it (N2). */
  readonly databaseId: string;
}

/** Names that appear more than once, and names that are not in `declared`, and declared names that never appear. */
function joinOf(declared: readonly string[], names: readonly string[]) {
  const counts = new Map<string, number>();
  for (const n of names) counts.set(n, (counts.get(n) ?? 0) + 1);
  return {
    missing: declared.filter((d) => !counts.has(d)),
    extra: [...counts.keys()].filter((n) => !declared.includes(n)),
    duplicated: [...counts].filter(([, c]) => c > 1).map(([n]) => n),
  };
}

function assertJoin(side: string, declared: readonly string[], names: readonly string[]): void {
  const { missing, extra, duplicated } = joinOf(declared, names);
  if (missing.length + extra.length + duplicated.length === 0) return;
  throw new ClientRunFailure(
    "client-incomplete",
    `${side} differ from the declared methods: missing [${missing.join(", ")}], extra [${extra.join(", ")}], duplicated [${duplicated.join(", ")}]`,
  );
}

/** Every check of section 1 item 6 and amendments 1-3 on one codeunit's run. Throws `ClientRunFailure`. */
export function checkClientRun(input: ClientRunCheckInput): readonly ClientMethodResult[] {
  const { declared, codeunitId, attemptId, opSeq, boundSessionId, generation, mutantId } = input;
  const page = input.pageResults.filter((r) => !isOnRun(r.name));
  const rows = input.rows.filter((r) => !isOnRun(r.method));
  // Empty-vs-empty must never pass: an empty run, or no rows at all, is a failure before any join.
  if (declared.length === 0 || page.length === 0 || rows.length === 0) {
    throw new ClientRunFailure(
      "client-run-empty",
      `codeunit ${codeunitId}: ${declared.length} declared method(s), ${page.length} page result(s), ${rows.length} row(s)`,
    );
  }
  assertJoin(
    "the page results",
    declared,
    page.map((r) => r.name),
  );
  for (const r of rows) {
    if (r.attemptId !== attemptId || r.opSeq !== opSeq || r.codeunitId !== codeunitId) {
      throw new ClientRunFailure(
        "client-incomplete",
        `a row for ${r.attemptId}/${r.opSeq}/codeunit ${r.codeunitId} method ${r.method} is not of this op (${attemptId}/${opSeq}/codeunit ${codeunitId})`,
      );
    }
  }
  assertJoin(
    "the rows",
    declared,
    rows.map((r) => r.method),
  );
  for (const r of rows) {
    if (r.serverGeneration !== input.serverGeneration || r.databaseId !== input.databaseId) {
      throw new ClientRunFailure(
        "client-row-stale-server",
        `the row for ${r.method} carries serverGeneration ${JSON.stringify(r.serverGeneration)} / databaseId ${JSON.stringify(r.databaseId)}, the lease has ${JSON.stringify(input.serverGeneration)} / ${JSON.stringify(input.databaseId)}`,
      );
    }
  }

  const out: ClientMethodResult[] = [];
  declared.forEach((method, i) => {
    const row = rows.find((r) => r.method === method);
    const result = page.find((r) => r.name === method);
    if (row === undefined || result === undefined) throw new Error("unreachable: joins passed");
    const at = `${method} (declared #${i + 1})`;
    if (row.testMethodRuns !== i + 1) {
      throw new ClientRunFailure(
        "client-test-method-runs",
        `${at}: testMethodRuns is ${row.testMethodRuns}, expected ${i + 1} (1..N in declared order)`,
      );
    }
    if (row.sessionId !== boundSessionId) {
      throw new ClientRunFailure(
        "client-row-session",
        `${at}: row session ${row.sessionId} is not the bound session ${boundSessionId}`,
      );
    }
    if (row.observedIdentityMismatch) {
      throw new ClientRunFailure(
        "client-row-identity-mismatch",
        `${at}: the row observed an identity mismatch`,
      );
    }
    if (row.loaded) {
      if (row.loadedGeneration > generation) {
        throw new ClientRunFailure(
          "client-row-generation",
          `${at}: loaded generation ${row.loadedGeneration} is newer than the activated ${generation}`,
        );
      }
      if (row.loadedGeneration < generation) {
        // A login-time load (amendment 2, item 1): accepted only if nothing was observed. It never supports a kill.
        if (row.observedAny) {
          throw new ClientRunFailure(
            "client-row-generation",
            `${at}: loaded generation ${row.loadedGeneration} is older than the activated ${generation}, and the row observed a guard`,
          );
        }
      } else if (row.loadedMutantId !== mutantId) {
        throw new ClientRunFailure(
          "client-row-mutant",
          `${at}: loaded mutant ${JSON.stringify(row.loadedMutantId)}, expected ${JSON.stringify(mutantId)}`,
        );
      }
    } else if (row.observedAny || row.observedActive) {
      throw new ClientRunFailure(
        "client-row-not-loaded-observed",
        `${at}: the row is not Loaded but observed a guard`,
      );
    }
    if (row.success !== (result.outcome === "pass")) {
      throw new ClientRunFailure(
        "client-row-success",
        `${at}: the row says success=${row.success}, the page says ${result.outcome}`,
      );
    }
    out.push({
      method,
      outcome: result.outcome,
      ...(result.message !== undefined ? { failureMessage: result.message } : {}),
      row,
    });
  });
  return out;
}
