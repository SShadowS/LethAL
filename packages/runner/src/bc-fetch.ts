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

/** The `fetch` every BC-facing client defaults to. Tests inject their own and never see this. */
export const bcFetch: FetchFn = withFreshConnectionOnHttps(fetch);
