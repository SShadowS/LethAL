/**
 * R194: every request LethAL sends to a BC endpoint over HTTPS goes on a FRESH connection.
 *
 * Bun's `fetch` pools keep-alive sockets. A hosted sandbox sits behind a gateway that closes an
 * idle one between requests, and the next write on it fails with "The socket connection was closed
 * unexpectedly" AFTER dispatch, which the fenced transport can only call `in-flight-unknown`: a
 * quarantine, a `force-reset-lease`, and a full redeploy-and-baseline on `--resume` (R192), for a
 * request the server never saw. Measured 2026-09-02 on `demoportaldev.continiaonline.com`: the
 * operator put a one-connection-per-request proxy in front of LethAL and the drops stopped for the
 * rest of the session. A survivor's covering tests take about 24 s, which is longer than the
 * gateway keeps an idle socket, so the pooled connection is stale exactly when it is next needed.
 *
 * `Connection: close` is the portable way to say it. Measured on this machine's Bun: three
 * requests reuse ONE socket by default and open THREE with the header, whether it is given as a
 * plain object or a `Headers` instance. One extra TLS handshake per request is nothing against a
 * 24 s survivor and a nine-minute resume.
 *
 * HTTP targets are left alone. A container on this machine has no gateway to drop the socket, and
 * every live gate is measured there; changing their transport for a hazard they cannot have would
 * be a change no gate can distinguish from noise.
 */
import type { FetchFn } from "./activation";
// A cycle (harness imports `bcFetch`), safe because each side uses the other only at call time.
import { refuseUnfilteredExtensionsQuery } from "./harness";

function urlOf(input: Parameters<FetchFn>[0]): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/** Wraps a fetch so that HTTPS requests carry `Connection: close`; HTTP requests pass through. */
export function withFreshConnectionOnHttps(inner: FetchFn): FetchFn {
  const request = (input: Parameters<FetchFn>[0], init?: Parameters<FetchFn>[1]) => {
    if (!/^https:/i.test(urlOf(input))) return inner(input, init);
    const headers = new Headers(init?.headers);
    headers.set("connection", "close");
    return inner(input, { ...init, headers });
  };
  // `typeof fetch` also carries Bun's `preconnect` static; keep the inner one so the wrapper IS a
  // fetch rather than merely being cast to one.
  return Object.assign(request, { preconnect: inner.preconnect });
}

/**
 * R-496: wraps a fetch so that it NEVER follows a redirect. Every request is sent with
 * `redirect: "manual"`, and a 3xx answer throws instead of being returned: a followed redirect
 * sends a request no caller's guard ever saw, and a 302/303 to BC's unfiltered `extensions` list
 * is the request that hung BC 28.4 (R433). When the Location (resolved against the request URL)
 * is one R433's guard refuses, the guard's own `UnfilteredExtensionsQueryError` is thrown; any
 * other redirect throws `BcRedirectRefusedError` naming the status and the Location. Both mean
 * the request was dispatched and answered. LethAL expects no
 * redirect from BC, so neither is followed.
 */
export function refuseRedirects(inner: FetchFn): FetchFn {
  const request = async (input: Parameters<FetchFn>[0], init?: Parameters<FetchFn>[1]) => {
    const res = await inner(input, { ...init, redirect: "manual" });
    if (res.type !== "opaqueredirect" && (res.status < 300 || res.status >= 400)) return res;
    const url = urlOf(input);
    const location = res.headers.get("location");
    if (location !== null) {
      const dest = new URL(location, url);
      const tenant = new URL(url).searchParams.get("tenant") ?? undefined;
      refuseUnfilteredExtensionsQuery(dest.pathname, [...dest.searchParams], tenant);
    }
    throw new BcRedirectRefusedError(
      `BC answered ${url} with HTTP ${res.status} redirect to ${JSON.stringify(location)}; LethAL never follows a redirect from BC (R-496)`,
    );
  };
  return Object.assign(request, { preconnect: inner.preconnect });
}

/**
 * R-496: BC answered with a redirect, and `refuseRedirects` did not follow it. The request WAS
 * dispatched and answered, so this is never a pre-dispatch failure and never retry-safe.
 */
export class BcRedirectRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BcRedirectRefusedError";
  }
}

/**
 * R506: a BC call whose answer was not read: no complete answer within the bound ("timeout"), or
 * a 2xx body that could not be read or parsed ("unreadable"). Extends Error directly, so a catch
 * that reads `HarnessVerificationError` as "the control app is missing" never sees it.
 */
export class BcAnswerUnreadError extends Error {
  constructor(
    message: string,
    readonly kind: BcReadFailure,
  ) {
    super(message);
    this.name = "BcAnswerUnreadError";
  }
}

export type BcReadFailure = "timeout" | "unreadable";

/** R506: how a site turns a read failure into ITS OWN typed error. */
export type BcFailFactory = (message: string, kind: BcReadFailure) => Error;

/**
 * R-204b: `p`, or a rejection once `ms` has passed, for a fetch that ignores its abort signal.
 * R506: the rejection is `onTimeout(message)`, the caller's own error instance, so a timeout is
 * told apart by identity, never by its text.
 */
export function bounded<T>(
  p: Promise<T>,
  ms: number,
  what: string,
  onTimeout: (message: string) => Error = (m) => new BcAnswerUnreadError(m, "timeout"),
): Promise<T> {
  let guard: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p,
    new Promise<never>((_resolve, reject) => {
      guard = setTimeout(() => reject(onTimeout(`${what} gave no answer within ${ms} ms`)), ms);
    }),
  ]).finally(() => {
    if (guard !== undefined) clearTimeout(guard);
  });
}

/**
 * R506: ONE deadline over fetch + body read + parse. The abort timer is armed BEFORE `bounded`'s
 * guard (R-503 order) and stays armed until `call` settles, so it covers the body; the race holds
 * the bound for a fetch or a body that ignores its abort. Errors from `call` pass through
 * untouched: the only error made here is `bounded`'s, through `fail`.
 */
export async function withDeadline<T>(
  ms: number,
  what: string,
  call: (signal: AbortSignal) => Promise<T>,
  fail: BcFailFactory,
): Promise<T> {
  // AbortSignal.timeout() is unreliable in this Bun/Windows env: a manual controller instead.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  const p = (async () => {
    try {
      return await call(controller.signal);
    } finally {
      clearTimeout(timer);
    }
  })();
  return bounded(p, ms, what, (m) => fail(m, "timeout"));
}

/** R506: the 2xx body as JSON. Never an empty value: an unread body THROWS. */
export async function readJsonBody(
  res: Response,
  signal: AbortSignal,
  what: string,
  ms: number,
  fail: BcFailFactory,
): Promise<unknown> {
  try {
    return await res.json();
  } catch (err) {
    if (signal.aborted) throw fail(`${what} body not read within ${ms} ms`, "timeout");
    throw fail(`${what} 2xx body could not be read or parsed: ${String(err)}`, "unreadable");
  }
}

/** The `fetch` every BC-facing client defaults to. Tests inject their own and never see this. */
export const bcFetch: FetchFn = withFreshConnectionOnHttps(refuseRedirects(fetch));
