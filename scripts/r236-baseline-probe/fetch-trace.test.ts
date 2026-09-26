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
});
