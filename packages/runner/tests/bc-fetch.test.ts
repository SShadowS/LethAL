import { describe, expect, it } from "bun:test";
import type { FetchFn } from "../src/activation";
import { withFreshConnectionOnHttps } from "../src/bc-fetch";

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
