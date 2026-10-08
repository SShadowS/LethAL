import { describe, expect, it } from "bun:test";
import type { FetchFn } from "../src/activation";
import {
  BcAnswerUnreadError,
  type BcReadFailure,
  bounded,
  readJsonBody,
  withDeadline,
  withFreshConnectionOnHttps,
} from "../src/bc-fetch";
import {
  deafBody,
  deafFetch,
  emptyBody,
  erroringBody,
  notJsonBody,
  stalledBody,
} from "./helpers/lease-wire";

/**
 * R194. The wrapper is the ONLY thing between every BC client's default fetch and Bun's pooled
 * sockets, so each property below is one a hosted run relies on:
 *
 *   - an HTTPS request carries `Connection: close`, whatever headers the caller already set;
 *   - an HTTP request is passed through untouched, so a container gate measures the old transport;
 *   - the caller's other headers and options survive, because the fenced transport's
 *     `authorization` header is what makes the request a request.
 */

interface Seen {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

function capture(): { readonly seen: Seen[]; readonly fetchFn: FetchFn } {
  const seen: Seen[] = [];
  // `as FetchFn`, as the other transport tests do: `typeof fetch` carries Bun's `preconnect`
  // static, which a fake has no reason to implement.
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    seen.push({ url, init });
    return new Response("ok");
  }) as FetchFn;
  return { seen, fetchFn };
}

describe("withFreshConnectionOnHttps (R194)", () => {
  it("adds Connection: close to an HTTPS request and keeps the caller's headers", async () => {
    const { seen, fetchFn } = capture();
    const wrapped = withFreshConnectionOnHttps(fetchFn);
    await wrapped("https://sandbox.example/ODataV4/LethALControl_RunMutant", {
      method: "POST",
      headers: { authorization: "Basic abc", "content-type": "application/json" },
      body: "{}",
    });
    const [call] = seen;
    if (call === undefined) throw new Error("inner fetch was not called");
    const headers = new Headers(call.init?.headers);
    expect(headers.get("connection")).toBe("close");
    expect(headers.get("authorization")).toBe("Basic abc");
    expect(headers.get("content-type")).toBe("application/json");
    expect(call.init?.method).toBe("POST");
    expect(call.init?.body).toBe("{}");
  });

  it("leaves an HTTP request untouched, so a container keeps its pooled connection", async () => {
    const { seen, fetchFn } = capture();
    const wrapped = withFreshConnectionOnHttps(fetchFn);
    const init = { method: "POST", headers: { authorization: "Basic abc" } };
    await wrapped("http://Cronus283:7048/BC/ODataV4/LethALControl_RunMutant", init);
    const [call] = seen;
    if (call === undefined) throw new Error("inner fetch was not called");
    // The very same init object, not a copy with a header added.
    expect(call.init).toBe(init);
    expect(new Headers(call.init?.headers).get("connection")).toBeNull();
  });

  it("reads the URL from a URL object and from a Request as well as from a string", async () => {
    const { seen, fetchFn } = capture();
    const wrapped = withFreshConnectionOnHttps(fetchFn);
    await wrapped(new URL("https://sandbox.example/a"));
    await wrapped(new Request("https://sandbox.example/b"));
    expect(seen).toHaveLength(2);
    for (const call of seen) {
      expect(new Headers(call.init?.headers).get("connection")).toBe("close");
    }
  });

  it("is case-insensitive on the scheme", async () => {
    const { seen, fetchFn } = capture();
    await withFreshConnectionOnHttps(fetchFn)("HTTPS://sandbox.example/a");
    expect(new Headers(seen[0]?.init?.headers).get("connection")).toBe("close");
  });
});

// R506: the shared deadline helpers. No wall-clock asserts: a missing bound goes red by bun's 5 s
// test timeout.
describe("R506: bounded, withDeadline and readJsonBody", () => {
  const never = () => new Promise<never>(() => {});

  /** A factory that records each call and makes a BcAnswerUnreadError. */
  function recording(): {
    readonly fail: (m: string, k: BcReadFailure) => Error;
    readonly calls: { readonly m: string; readonly k: BcReadFailure }[];
  } {
    const calls: { m: string; k: BcReadFailure }[] = [];
    return {
      calls,
      fail: (m, k) => {
        calls.push({ m, k });
        return new BcAnswerUnreadError(m, k);
      },
    };
  }

  /** One JSON read under one deadline, through a given fetch. */
  function readThrough(
    fetchFn: typeof fetch,
    ms: number,
    fail: (m: string, k: BcReadFailure) => Error,
  ) {
    return withDeadline(
      ms,
      "X",
      async (signal) => {
        const res = await fetchFn("http://bc/x", { signal });
        return readJsonBody(res, signal, "X", ms, fail);
      },
      fail,
    );
  }

  it("B1: bounded rejects with the caller's own error instance", async () => {
    const sentinel = new Error("sentinel");
    const err = await bounded(never(), 20, "x", () => sentinel).catch((e: unknown) => e);
    expect(err).toBe(sentinel);
  });

  it("B2: withDeadline passes an imposter error from `call` through untouched", async () => {
    const imposter = new Error("x gave no answer within 20 ms");
    const { fail, calls } = recording();
    const err = await withDeadline(
      20,
      "x",
      async () => {
        throw imposter;
      },
      fail,
    ).catch((e: unknown) => e);
    expect(err).toBe(imposter);
    expect(calls).toHaveLength(0);
  });

  it("B3: bounded's default timeout is a BcAnswerUnreadError of kind timeout", async () => {
    const err = await bounded(never(), 20, "x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BcAnswerUnreadError);
    expect((err as BcAnswerUnreadError).kind).toBe("timeout");
    expect((err as Error).message).toBe("x gave no answer within 20 ms");
  });

  it("B4: a stalled body is aborted: the timer stays armed through the body read", async () => {
    // Relies on equal-delay timers firing in the order they were set: the abort is set before
    // `bounded`'s guard (as R504's L1 does), so either may end the call, and both say "timeout".
    const { fetchFn, aborted } = stalledBody();
    const { fail } = recording();
    const err = await readThrough(fetchFn, 20, fail).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BcAnswerUnreadError);
    expect((err as BcAnswerUnreadError).kind).toBe("timeout");
    expect(aborted()).toBe(true);
  });

  for (const [name, fetchFn] of [
    ["deaf body", deafBody()],
    ["deaf fetch", deafFetch()],
  ] as const) {
    it(`B5: a ${name} is ended by the race`, async () => {
      const { fail } = recording();
      const err = await readThrough(fetchFn, 20, fail).catch((e: unknown) => e);
      expect((err as BcAnswerUnreadError).kind).toBe("timeout");
      expect((err as Error).message).toBe("X gave no answer within 20 ms");
    });
  }

  for (const [name, fetchFn, text] of [
    ["not JSON", notJsonBody(), "SyntaxError"],
    ["empty", emptyBody(), "SyntaxError"],
    ["erroring stream", erroringBody(), "stream broke mid-body"],
  ] as const) {
    it(`B6: a ${name} 2xx body is unreadable, never an empty value`, async () => {
      const { fail } = recording();
      const err = await readThrough(fetchFn, 500, fail).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(BcAnswerUnreadError);
      expect((err as BcAnswerUnreadError).kind).toBe("unreadable");
      expect((err as Error).message).toContain("could not be read or parsed");
      expect((err as Error).message).toContain(text);
    });
  }

  it("B7: a slow but complete body is not cut by the bound", async () => {
    const text = JSON.stringify({ value: "ok" });
    const half = Math.floor(text.length / 2);
    // Errors on the fetch's abort, as Bun's body does, so a cut at the headers would show.
    const fetchFn = (async (_url: unknown, init?: RequestInit) =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            init?.signal?.addEventListener("abort", () =>
              controller.error(new Error("The operation was aborted.")),
            );
            controller.enqueue(new TextEncoder().encode(text.slice(0, half)));
            setTimeout(() => {
              controller.enqueue(new TextEncoder().encode(text.slice(half)));
              controller.close();
            }, 5);
          },
        }),
        { status: 200 },
      )) as unknown as typeof fetch;
    const { fail } = recording();
    expect(await readThrough(fetchFn, 500, fail)).toEqual({ value: "ok" });
  });
});
