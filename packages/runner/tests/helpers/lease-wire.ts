/**
 * R504: wire-level fakes for `LeaseClient`, shaped like run-mutant-transport.test.ts's R191
 * `stalledBody`. Each answers on the real HTTP surface, so the client's own timeout and parsing run.
 */

/** The OData action a lease request names, e.g. `RenewLease`. */
export function actionOf(url: unknown): string {
  const m = /LethALControl_(\w+)\?/.exec(String(url));
  if (m?.[1] === undefined)
    throw new Error(`lease-wire: no LethALControl_ action in ${String(url)}`);
  return m[1];
}

/** A 200 whose OData scalar `value` is `inner`, stringified. */
export function okResponse(inner: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ value: JSON.stringify(inner) }), { status: 200 });
}

/**
 * A 200 that sends `{"value":` and never finishes. With `honourAbort` the stream errors when the
 * fetch's signal aborts, as Bun's does; without it the stream ignores the abort entirely.
 */
export function stalledResponse(
  signal: AbortSignal | null | undefined,
  honourAbort: boolean,
  onAbort: () => void = () => {},
): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"value":'));
      if (!honourAbort) return;
      signal?.addEventListener(
        "abort",
        () => {
          onAbort();
          controller.error(new Error("The operation was aborted."));
        },
        { once: true },
      );
    },
  });
  return new Response(stream, { status: 200 });
}

/** A body that stalls after its first bytes and errors on the fetch's abort. */
export function stalledBody(): {
  readonly fetchFn: typeof fetch;
  readonly aborted: () => boolean;
  /** Resolves when the stream sees the abort. */
  readonly abortSeen: Promise<void>;
} {
  let sawAbort = false;
  let seen: () => void = () => {};
  const abortSeen = new Promise<void>((resolve) => {
    seen = resolve;
  });
  const fetchFn = (async (_url: unknown, init?: RequestInit) =>
    stalledResponse(init?.signal, true, () => {
      sawAbort = true;
      seen();
    })) as typeof fetch;
  return { fetchFn, aborted: () => sawAbort, abortSeen };
}

/** The same stalled body, but it ignores the abort: only a race can end the call. */
export function deafBody(): typeof fetch {
  return (async (_url: unknown, init?: RequestInit) =>
    stalledResponse(init?.signal, false)) as typeof fetch;
}

/** A fetch that never resolves and ignores its abort. */
export function deafFetch(): typeof fetch {
  return ((_url: unknown, _init?: RequestInit) => new Promise<Response>(() => {})) as typeof fetch;
}

/** What one routed action answers: an inner result, a stall, or a hand-built response. */
export type WireAnswer = Record<string, unknown> | "stall" | Response;

export const WIRE_LEASE = {
  epoch: 3,
  token: "tok-abc",
  serverGeneration: "a".repeat(32),
  lastCompletedOpSeq: 7,
  expiresAt: "2026-07-24T12:00:00.000Z",
} as const;

export const IDLE_STATUS = {
  opKind: "none",
  opAttemptId: "",
  opSeq: 0,
  lastCompletedOpSeq: 7,
  completed: true,
} as const;

/** A normal answer per action, for a session where nothing goes wrong. */
const DEFAULT_ANSWERS: Record<string, Record<string, unknown>> = {
  AcquireLease: { granted: true, ...WIRE_LEASE },
  RenewLease: { renewed: true, expiresAt: "2026-07-24T12:00:15.000Z" },
  ReleaseLease: { released: true },
  BeginPublish: { begun: true },
  EndPublish: { ended: true },
  GetOperationStatus: IDLE_STATUS,
  RecoverOp: { recovered: true },
  ForceResetLease: { reset: false, reason: "generation-changed" },
};

/**
 * Routes each lease action to `answers[action](n)` (n counts that action's calls from 1), or to
 * the default answer. `"stall"` is a body that errors on the fetch's abort. `calls` counts per action.
 */
export function leaseRouter(
  answers: Partial<
    Record<string, (n: number, body: Record<string, unknown>) => WireAnswer | Promise<WireAnswer>>
  > = {},
): { readonly fetchFn: typeof fetch; readonly calls: Record<string, number> } {
  const calls: Record<string, number> = {};
  const fetchFn = (async (url: unknown, init?: RequestInit) => {
    const action = actionOf(url);
    const n = (calls[action] ?? 0) + 1;
    calls[action] = n;
    const handler = answers[action];
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    const answer: WireAnswer | undefined =
      handler !== undefined ? await handler(n, body) : DEFAULT_ANSWERS[action];
    if (answer === undefined) throw new Error(`lease-wire: no answer for ${action}`);
    if (answer === "stall") return stalledResponse(init?.signal, true);
    if (answer instanceof Response) return answer;
    return okResponse(answer);
  }) as typeof fetch;
  return { fetchFn, calls };
}
