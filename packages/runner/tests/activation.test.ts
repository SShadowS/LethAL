import { describe, expect, test } from "bun:test";
import { MutationControlClient } from "../src/activation";

const cfg = {
  baseUrl: "http://bc:7048/BC",
  company: "CRONUS",
  username: "u",
  password: "p",
};

function fakeFetch(status: number, body: unknown) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchFn = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  return { calls, fetchFn };
}

describe("MutationControlClient.setActive", () => {
  test("POSTs to the unbound action with basic auth and verifies the echo", async () => {
    const { calls, fetchFn } = fakeFetch(200, { value: "M0007" });
    await new MutationControlClient(cfg, fetchFn).setActive("M0007");
    const call = calls[0];
    expect(call?.url).toBe("http://bc:7048/BC/ODataV4/MutationControl_SetActive?company=CRONUS");
    expect(call?.init.method).toBe("POST");
    expect(new Headers(call?.init.headers).get("authorization")).toBe(`Basic ${btoa("u:p")}`);
    expect(call?.init.body).toBe(JSON.stringify({ mutantId: "M0007" }));
  });

  // Verified against a real BC server (2026-07-18): OData calls without a `tenant` query
  // param fail authentication entirely (401), even with a correct username/password — see
  // ActivationConfig.tenant's doc comment.
  test("includes ?tenant= when configured", async () => {
    const { calls, fetchFn } = fakeFetch(200, { value: "M0007" });
    await new MutationControlClient({ ...cfg, tenant: "default" }, fetchFn).setActive("M0007");
    expect(calls[0]?.url).toBe(
      "http://bc:7048/BC/ODataV4/MutationControl_SetActive?company=CRONUS&tenant=default",
    );
  });

  test("omits tenant from the URL when not configured", async () => {
    const { calls, fetchFn } = fakeFetch(200, { value: "M0007" });
    await new MutationControlClient(cfg, fetchFn).setActive("M0007");
    expect(calls[0]?.url).not.toContain("tenant");
  });

  test("echo mismatch throws", async () => {
    const { fetchFn } = fakeFetch(200, { value: "M0001" });
    await expect(new MutationControlClient(cfg, fetchFn).setActive("M0007")).rejects.toThrow(
      "activation echo mismatch",
    );
  });

  test("HTTP failure throws with status", async () => {
    const { fetchFn } = fakeFetch(401, {});
    await expect(new MutationControlClient(cfg, fetchFn).setActive("M0007")).rejects.toThrow("401");
  });

  // Observed directly against a real BC server (2026-07-18): the OData pipeline can wedge and
  // never answer at all — fetch() has no default timeout, so without one this hangs forever.
  test("a hung request eventually rejects instead of hanging forever", async () => {
    const neverResolvingFetch = ((_url: unknown, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        const onAbort = () => reject(new Error("The operation was aborted"));
        if (signal?.aborted) onAbort();
        else signal?.addEventListener("abort", onAbort);
      });
    }) as typeof fetch;
    const client = new MutationControlClient({ ...cfg, timeoutMs: 10 }, neverResolvingFetch);
    await expect(client.setActive("M0007")).rejects.toThrow();
  });
});

describe("MutationControlClient.clearActive", () => {
  test("POSTs ClearActive", async () => {
    const { calls, fetchFn } = fakeFetch(200, {});
    await new MutationControlClient(cfg, fetchFn).clearActive();
    expect(calls[0]?.url).toContain("MutationControl_ClearActive");
  });
});
