// scripts/r236-baseline-probe/fetch-trace.test.ts
import { describe, expect, test } from "bun:test";
import type { FetchFn } from "../../packages/runner/src/activation";
import { type CallTrace, traceFetch } from "./fetch-trace";

const URL_ = "http://Cronus28:7048/BC/ODataV4/LethALControl_RunMutantWithCoverage?company=X";
const BODY = JSON.stringify({
  attemptId: "a7",
  opSeq: 12,
  testMethod: "PageActionComputesNonZero",
});
const asFetch = (f: (i: unknown, init?: RequestInit) => Promise<Response>): FetchFn =>
  Object.assign(f, { preconnect: fetch.preconnect }) as FetchFn;

describe("traceFetch", () => {
  test("healthy call: body unchanged, status and headers kept, UTF-8 bytes counted, onBody sees the text", async () => {
    const sink: CallTrace[] = [];
    const bodies: string[] = [];
    const inner = asFetch(
      async () =>
        new Response("é{}", { status: 200, statusText: "OK", headers: { "x-probe": "1" } }),
    );
    const res = await traceFetch(inner, sink, { onBody: (_t, text) => bodies.push(text) })(URL_, {
      method: "POST",
      body: BODY,
    });
    expect(res.status).toBe(200);
    expect(res.statusText).toBe("OK");
    expect(res.headers.get("x-probe")).toBe("1");
    expect(await res.text()).toBe("é{}");
    expect(bodies).toEqual(["é{}"]);
    const [t] = sink;
    expect(t?.action).toBe("LethALControl_RunMutantWithCoverage");
    expect(t?.attemptId).toBe("a7");
    expect(t?.opSeq).toBe(12);
    expect(t?.bytesReceived).toBe(4);
    expect(t?.bodyEndAt).toBeDefined();
    expect(t?.error).toBeUndefined();
  });

  test("body breaks after the first chunk was CONSUMED: the SAME error reaches the caller, 3 bytes recorded, the hook ran first", async () => {
    const sink: CallTrace[] = [];
    const boom = new Error("The socket connection was closed unexpectedly");
    const order: string[] = [];
    let pulls = 0;
    // pull-based: the error is raised only on the SECOND pull, i.e. after the reader has taken
    // the first chunk, so the counting transform provably saw those bytes.
    const inner = asFetch(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(c) {
              pulls++;
              if (pulls === 1) c.enqueue(new Uint8Array([123, 34, 118]));
              else c.error(boom);
            },
          }),
          { status: 200 },
        ),
    );
    const res = await traceFetch(inner, sink, {
      onBrokenCall: async (trace) => {
        order.push(`hook:${trace.errorPhase}:${trace.attemptId}:${trace.bytesReceived}`);
      },
    })(URL_, { method: "POST", body: BODY });
    const caught = await res.text().then(
      () => null,
      (e: unknown) => e,
    );
    order.push("caller");
    expect(caught).toBe(boom);
    expect(order).toEqual(["hook:body:a7:3", "caller"]);
    expect(sink[0]?.errorPhase).toBe("body");
  });

  test("fetch throws before headers: same error rethrown, phase 'fetch', no headersAt", async () => {
    const sink: CallTrace[] = [];
    const boom = new Error("aborted");
    const f = traceFetch(
      asFetch(async () => {
        throw boom;
      }),
      sink,
    );
    const caught = await f(URL_, { method: "POST", body: BODY }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(caught).toBe(boom);
    expect(sink[0]?.errorPhase).toBe("fetch");
    expect(sink[0]?.headersAt).toBeUndefined();
  });

  test("init passes through as the SAME object unless freshConnection is set", async () => {
    const seen: unknown[] = [];
    const inner = asFetch(async (_i, init) => {
      seen.push(init);
      return new Response("{}");
    });
    const init = { method: "POST", body: BODY, headers: { a: "b" } };
    await traceFetch(inner, [])(URL_, init);
    await traceFetch(inner, [], { freshConnection: true })(URL_, init);
    expect(seen[0]).toBe(init);
    expect(new Headers((seen[1] as RequestInit).headers).get("connection")).toBe("close");
    expect(new Headers((seen[1] as RequestInit).headers).get("a")).toBe("b");
  });

  test("a hook that throws never changes what the caller sees", async () => {
    const boom = new Error("x");
    const f = traceFetch(
      asFetch(async () => {
        throw boom;
      }),
      [],
      {
        onBrokenCall: async () => {
          throw new Error("hook failed");
        },
      },
    );
    const caught = await f(URL_, { method: "POST", body: BODY }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(caught).toBe(boom);
  });

  test("review r1: a stalling REAL body still rejects with AbortError through the rebuilt Response; the pre-hook error class is kept", async () => {
    let tick: ReturnType<typeof setInterval> | undefined;
    const server = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(c) {
              c.enqueue(new TextEncoder().encode('{"value":'));
              tick = setInterval(() => {}, 1000); // never closes: the body stalls
            },
          }),
        ),
    });
    try {
      const sink: CallTrace[] = [];
      const seenInHook: string[] = [];
      const ac = new AbortController();
      const f = traceFetch(fetch, sink, {
        onBrokenCall: async (t) => {
          seenInHook.push(`${t.errorName}`);
          await Bun.sleep(300); // a slow marker read
          t.error = "relabelled by a slow hook";
        },
      });
      const res = await f(`http://localhost:${server.port}/BC/ODataV4/LethALControl_RunMutant`, {
        method: "POST",
        body: BODY,
        signal: ac.signal,
      });
      setTimeout(() => ac.abort(), 100);
      const caught = await res.text().then(
        () => null,
        (e: unknown) => e,
      );
      expect((caught as Error | null)?.name).toBe("AbortError");
      expect(seenInHook).toEqual(["AbortError"]);
      expect(sink[0]?.errorName).toBe("AbortError");
      expect(sink[0]?.preHookError).toContain("AbortError");
      expect(sink[0]?.preHookError).not.toContain("relabelled");
      expect(sink[0]?.bytesReceived).toBe(9);
    } finally {
      if (tick !== undefined) clearInterval(tick);
      server.stop(true);
    }
  });
});

describe("byte capture (orchestrator ruling A: the truncation check)", () => {
  const PREFIX = '{"value":"{\\"status\\":\\"ran\\"';
  const capture = (t: CallTrace) => t.testMethod === "PageActionComputesNonZero";

  test("a stalled REAL body: the exact bytes that arrived, offset = bytesReceived, marked partial", async () => {
    let tick: ReturnType<typeof setInterval> | undefined;
    const server = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(c) {
              c.enqueue(new TextEncoder().encode(PREFIX));
              tick = setInterval(() => {}, 1000);
            },
          }),
        ),
    });
    try {
      const sink: CallTrace[] = [];
      const got: Array<{ bytes: Uint8Array; complete: boolean }> = [];
      const ac = new AbortController();
      const body = JSON.stringify({
        attemptId: "a7",
        opSeq: 12,
        testMethod: "PageActionComputesNonZero",
      });
      const f = traceFetch(fetch, sink, {
        captureBytes: capture,
        onBytes: (_t, bytes, complete) => got.push({ bytes, complete }),
      });
      const res = await f(
        `http://localhost:${server.port}/BC/ODataV4/LethALControl_RunMutantWithCoverage`,
        {
          method: "POST",
          body,
          signal: ac.signal,
        },
      );
      setTimeout(() => ac.abort(), 100);
      await res.text().catch(() => null);
      expect(got).toHaveLength(1);
      expect(got[0]?.complete).toBe(false);
      expect(new TextDecoder().decode(got[0]?.bytes)).toBe(PREFIX);
      expect(got[0]?.bytes.byteLength).toBe(sink[0]?.bytesReceived);
    } finally {
      if (tick !== undefined) clearInterval(tick);
      server.stop(true);
    }
  });

  test("a clean REAL body: the full answer bytes, marked complete; other calls are not captured", async () => {
    const full = `${PREFIX}, "sessionId": 5}"}`;
    const server = Bun.serve({ port: 0, fetch: () => new Response(full) });
    try {
      const got: Array<{ bytes: Uint8Array; complete: boolean }> = [];
      const f = traceFetch(fetch, [], {
        captureBytes: capture,
        onBytes: (_t, bytes, complete) => got.push({ bytes, complete }),
      });
      const url = `http://localhost:${server.port}/BC/ODataV4/LethALControl_RunMutantWithCoverage`;
      const mk = (m: string) => ({ method: "POST", body: JSON.stringify({ testMethod: m }) });
      expect(await (await f(url, mk("PageActionComputesNonZero"))).text()).toBe(full);
      await (await f(url, mk("SomeOtherTest"))).text();
      expect(got).toHaveLength(1);
      expect(got[0]?.complete).toBe(true);
      expect(new TextDecoder().decode(got[0]?.bytes)).toBe(full);
    } finally {
      server.stop(true);
    }
  });
});
