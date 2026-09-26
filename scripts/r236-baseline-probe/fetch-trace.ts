// scripts/r236-baseline-probe/fetch-trace.ts
/**
 * R236 probe: a fetch wrapper that records each BC call's timeline and counts body bytes as they
 * arrive, so a broken body still says how much came. Errors are rethrown as the SAME object; the
 * hook runs first, must be fast, and can never change what the caller sees.
 */
import type { FetchFn } from "../../packages/runner/src/activation";

export interface CallTrace {
  readonly action: string;
  readonly attemptId?: string;
  readonly opSeq?: number;
  readonly testMethod?: string;
  readonly dispatchedAt: number;
  headersAt?: number;
  status?: number;
  contentLength?: string | null;
  transferEncoding?: string | null;
  connection?: string | null;
  bytesReceived?: number;
  bodyEndAt?: number;
  errorPhase?: "fetch" | "body";
  errorAt?: number;
  error?: string;
  /** Review r1: the error class and text as the transport saw them, captured BEFORE the hook runs, so a
   * slow or misbehaving marker read cannot relabel the failure. */
  errorName?: string;
  preHookError?: string;
}

export interface TraceHooks {
  readonly onBrokenCall?: (trace: CallTrace, requestBody: Record<string, unknown>) => Promise<void>;
  readonly onBody?: (trace: CallTrace, text: string) => void;
  /**
   * Orchestrator ruling A (the truncation check): for calls this returns true, the raw body bytes are
   * kept as they stream and handed to `onBytes` once: `complete: false` with exactly the bytes that
   * arrived before the body broke (called BEFORE the broken-call hook), or `complete: true` with the
   * whole answer. Neither hook can change what the caller sees.
   */
  readonly captureBytes?: (trace: CallTrace) => boolean;
  readonly onBytes?: (trace: CallTrace, bytes: Uint8Array, complete: boolean) => void;
  readonly freshConnection?: boolean;
}

function urlOf(input: Parameters<FetchFn>[0]): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

async function runHook(hooks: TraceHooks, trace: CallTrace, body: Record<string, unknown>) {
  try {
    await hooks.onBrokenCall?.(trace, body);
  } catch {
    // Diagnostics only: a failed hook must never replace the transport's own error.
  }
}

export function traceFetch(inner: FetchFn, sink: CallTrace[], hooks: TraceHooks = {}): FetchFn {
  const request = async (input: Parameters<FetchFn>[0], init?: Parameters<FetchFn>[1]) => {
    const url = urlOf(input);
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<
        string,
        unknown
      >;
    } catch {
      body = {};
    }
    const trace: CallTrace = {
      action: /ODataV4\/([^?]+)/.exec(url)?.[1] ?? url,
      dispatchedAt: Date.now(),
      ...(typeof body.attemptId === "string" ? { attemptId: body.attemptId } : {}),
      ...(typeof body.opSeq === "number" ? { opSeq: body.opSeq } : {}),
      ...(typeof body.testMethod === "string" ? { testMethod: body.testMethod } : {}),
    };
    sink.push(trace);
    let sendInit = init;
    if (hooks.freshConnection === true) {
      const headers = new Headers(init?.headers);
      headers.set("connection", "close");
      sendInit = { ...init, headers };
    }
    let res: Response;
    try {
      res = await inner(input, sendInit);
    } catch (err) {
      trace.errorPhase = "fetch";
      trace.errorAt = Date.now();
      trace.error = String(err);
      trace.errorName = err instanceof Error ? err.name : typeof err;
      trace.preHookError = `${trace.errorName}: ${String(err)}`;
      await runHook(hooks, trace, body);
      throw err;
    }
    trace.headersAt = Date.now();
    trace.status = res.status;
    trace.contentLength = res.headers.get("content-length");
    trace.transferEncoding = res.headers.get("transfer-encoding");
    trace.connection = res.headers.get("connection");
    trace.bytesReceived = 0;
    if (res.body === null) return res;
    const kept: Uint8Array[] | null = hooks.captureBytes?.(trace) === true ? [] : null;
    const handBytes = (complete: boolean) => {
      if (kept === null) return;
      try {
        hooks.onBytes?.(trace, Buffer.concat(kept), complete);
      } catch {
        // diagnostics only
      }
    };
    const counter = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, c) {
        trace.bytesReceived = (trace.bytesReceived ?? 0) + chunk.byteLength;
        kept?.push(chunk.slice());
        c.enqueue(chunk);
      },
      flush() {
        trace.bodyEndAt = Date.now();
      },
    });
    const counted = new Response(res.body.pipeThrough(counter), {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    });
    const text = counted.text.bind(counted);
    Object.defineProperty(counted, "text", {
      value: async () => {
        let t: string;
        try {
          t = await text();
        } catch (err) {
          trace.errorPhase = "body";
          trace.errorAt = Date.now();
          trace.error = String(err);
          trace.errorName = err instanceof Error ? err.name : typeof err;
          trace.preHookError = `${trace.errorName}: ${String(err)}`;
          handBytes(false);
          await runHook(hooks, trace, body);
          throw err;
        }
        handBytes(true);
        try {
          hooks.onBody?.(trace, t);
        } catch {
          // diagnostics only
        }
        return t;
      },
    });
    return counted;
  };
  return Object.assign(request, { preconnect: inner.preconnect });
}
