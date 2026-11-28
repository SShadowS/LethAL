import { compareAppVersions } from "./app-version";

/**
 * PR-479 (479a): the experimental `bcdev-client` backend: each test codeunit runs in a `/cs` client
 * session, with coverage off. Round 1 is the plumbing: the kind, its refusals and its caveat. Round 3b runs a
 * session through `runClientCodeunit`; a per-method `run`/`runMany` throws `BcdevClientMethodRunError`.
 * Spec: `docs/superpowers/specs/2026-11-28-pr479a-bcdev-client-driver.md`.
 */

/** A bcdev-client run needs this LethAL Control or newer (headless stays at `MIN_CONTROL_VERSION`). */
export const CLIENT_MIN_CONTROL_VERSION = "1.0.0.31";

/**
 * The short form of the `client-no-coverage` caveat, written beside every survivor of a bcdev-client run
 * (the changed-line list, the Stryker elements page). The full text is `CAVEAT_INTERPRETATIONS`.
 */
export const CLIENT_NO_COVERAGE_TEXT =
  "client-no-coverage: coverage is off on this backend: a survivor may be a mutant no test reached. Do not read these survivors as headless survivors.";

/**
 * Run and runMany of a built bcdev-client backend. Round 3b: a client run goes through `runClientCodeunit` (one
 * codeunit's full declared run per op), never a per-method call, so reaching either is a caller bug.
 */
export class BcdevClientMethodRunError extends Error {
  readonly reason = "bcdev-client-method-run";
  constructor(what: string) {
    super(
      `bcdev-client-method-run: ${what} was called on the bcdev-client backend, which runs whole codeunits only (runClientCodeunit). A client run never sends one method.`,
    );
    this.name = "BcdevClientMethodRunError";
  }
}

/**
 * Round 3b (amendment 1 item 2): a candidate kill's no-mutant confirmation (a) did not pass: a baseline-green method
 * failed with NO mutant active, in a fresh session. The environment moved since the baseline, so the run stops; it is
 * never a kill, and the verdicts so far are not trusted either.
 */
export class ClientConfirmationFailedError extends Error {
  readonly reason = "confirmation-failed";
  constructor(mutantId: string, codeunit: string, failed: readonly string[]) {
    super(
      `confirmation-failed: confirming mutant ${mutantId}'s kill, codeunit ${codeunit} ran with no mutant active in a fresh client session and baseline-green method(s) ${failed.join(", ")} did not pass. The environment changed since the baseline; the run is stopped (PR-479).`,
    );
    this.name = "ClientConfirmationFailedError";
  }
}

/** `--backend bcdev-client` without `--experimental-client-mode`. */
export class BcdevClientExperimentalError extends Error {
  readonly reason = "bcdev-client-experimental";
  constructor() {
    super(
      "bcdev-client-experimental: --backend bcdev-client is experimental (coverage is off: a survivor may be a mutant no test reached) and is refused unless the run also passes --experimental-client-mode (PR-479).",
    );
    this.name = "BcdevClientExperimentalError";
  }
}

/** The `/cs` probe found no client session endpoint (a missing field, a connection failure or a 404). */
export class ClientSessionUnavailableError extends Error {
  readonly reason = "client-session-unavailable";
  constructor(why: string) {
    super(
      `client-session-unavailable: ${why}. A bcdev-client run needs the server's web client /cs endpoint; nothing was published (PR-479).`,
    );
    this.name = "ClientSessionUnavailableError";
  }
}

/** The deployed LethAL Control is older than `CLIENT_MIN_CONTROL_VERSION`. */
export class ClientControlTooOldError extends Error {
  readonly reason = "client-control-too-old";
  constructor(found: string) {
    super(
      `client-control-too-old: the deployed LethAL Control reports ${JSON.stringify(found)}, older than the ${CLIENT_MIN_CONTROL_VERSION} a bcdev-client run requires. Nothing was published. Publish a newer control app, or use --backend bcdev (PR-479).`,
    );
    this.name = "ClientControlTooOldError";
  }
}

/** A bcdev-client run and a headless run (or their stored runs or reports) were mixed. */
export class ClientNeverMixedError extends Error {
  readonly reason = "bcdev-client-never-mixed";
  constructor(what: string, why: string) {
    super(
      `bcdev-client-never-mixed: ${what}: ${why}. A bcdev-client run and a headless run are never mixed, in either direction: coverage is off on one and on the other it is not (PR-479).`,
    );
    this.name = "ClientNeverMixedError";
  }
}

/** A flag that does not apply to a bcdev-client run. */
export class ClientModeRefusedError extends Error {
  readonly reason: string;
  constructor(flag: string, why: string) {
    super(
      `bcdev-client-refused-${flag}: ${flag} is refused on the bcdev-client backend: ${why} (PR-479).`,
    );
    this.reason = `bcdev-client-refused-${flag}`;
    this.name = "ClientModeRefusedError";
  }
}

/** The HTTP status of a GET to `url`; a connection failure throws. Replaceable in tests. */
export type ClientSessionProbe = (url: string) => Promise<number>;

const PROBE_TIMEOUT_MS = 15_000;

export const defaultClientSessionProbe: ClientSessionProbe = async (url) => {
  const res = await fetch(url, { method: "GET", signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
  return res.status;
};

/**
 * Before any publish: `<webClientBaseUrl>/cs` must answer (a GET; bcwin answered 405 with /cs
 * present, which counts as present). A missing field, a connection failure, a 404 or any 5xx refuses.
 */
export async function probeClientSession(
  webClientBaseUrl: string | undefined,
  probe: ClientSessionProbe = defaultClientSessionProbe,
): Promise<void> {
  if (webClientBaseUrl === undefined || webClientBaseUrl === "") {
    throw new ClientSessionUnavailableError(
      'the config\'s "bcdev" section has no "webClientBaseUrl", so /cs cannot be probed',
    );
  }
  const url = `${webClientBaseUrl.replace(/\/+$/, "")}/cs`;
  let status: number;
  try {
    status = await probe(url);
  } catch (err) {
    throw new ClientSessionUnavailableError(
      `${url} could not be reached (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  if (status === 404 || status >= 500) {
    throw new ClientSessionUnavailableError(`${url} answered ${status}`);
  }
}

/** Refuses a control app older than `CLIENT_MIN_CONTROL_VERSION`; an unreadable version refuses too. */
export function assertClientControlVersion(found: string): void {
  let older: boolean;
  try {
    older = compareAppVersions(found, CLIENT_MIN_CONTROL_VERSION) < 0;
  } catch {
    throw new ClientControlTooOldError(found);
  }
  if (older) throw new ClientControlTooOldError(found);
}
