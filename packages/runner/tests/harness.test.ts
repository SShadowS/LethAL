import { describe, expect, spyOn, test } from "bun:test";
import type { ActivationConfig } from "../src/activation";
import {
  CONTROL_APP_ID,
  HarnessVerificationError,
  HarnessVerifier,
  MultiTenantContainerError,
} from "../src/harness";

const CFG: ActivationConfig = {
  baseUrl: "http://bc:7048/BC",
  company: "CRONUS Danmark A/S",
  username: "u",
  password: "p",
  tenant: "default",
};

const SERVER_GENERATION = "b".repeat(32);

/**
 * A protocol-v2 `HarnessInfo` payload, shaped exactly like the deployed `LethAL Control` 1.0.0.2
 * one (`ControlApi.HarnessInfo`): protocolVersion 2, a 32-hex `serverGeneration`, and
 * `tenantCountReachable: false` — AL cannot enumerate tenants from an extension, so the live
 * server never reports a count (design §7).
 */
function info(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    appId: CONTROL_APP_ID,
    semver: "1.0.0.0",
    protocolVersion: 2,
    serverGeneration: SERVER_GENERATION,
    tenantCountReachable: false,
    isolationModes: ["Codeunit"],
    testTypes: ["codeunit"],
    ...over,
  };
}

function okFetch(inner: Record<string, unknown>): typeof fetch {
  return (async (_url: unknown, _init?: RequestInit) =>
    new Response(JSON.stringify({ value: JSON.stringify(inner) }), {
      status: 200,
    })) as typeof fetch;
}

function verifier(fetchFn: typeof fetch): HarnessVerifier {
  return new HarnessVerifier(CFG, fetchFn);
}

/** `verify()` warns (loudly, by design) whenever the tenant gate cannot be enforced — silence
 *  that here so it doesn't drown the suite, and let a test read what was warned. */
async function verifyQuiet(v: HarnessVerifier): Promise<{
  details: Awaited<ReturnType<HarnessVerifier["verify"]>>;
  warnings: string[];
}> {
  const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const details = await v.verify();
    return { details, warnings: warnSpy.mock.calls.map((c) => String(c[0])) };
  } finally {
    warnSpy.mockRestore();
  }
}

describe("HarnessVerifier.verify", () => {
  test("accepts a matching, compatible v2 harness and returns its serverGeneration", async () => {
    const { details } = await verifyQuiet(verifier(okFetch(info())));
    expect(details.protocolVersion).toBe(2);
    expect(details.serverGeneration).toBe(SERVER_GENERATION);
  });

  test("accepts a forward-compatible newer protocol (v3)", async () => {
    const { details } = await verifyQuiet(verifier(okFetch(info({ protocolVersion: 3 }))));
    expect(details.protocolVersion).toBe(3);
  });

  // Layer 5C-B1 (design §7): protocol v2 is incompatible with v1 in BOTH directions. A v1 server
  // (no lease fence at all) must be refused before any publish — the 5C-A "forward-compatible,
  // a v1 server still runs our empty-lease calls" allowance is deliberately gone.
  test("rejects a v1 server outright", async () => {
    await expect(verifier(okFetch(info({ protocolVersion: 1 }))).verify()).rejects.toBeInstanceOf(
      HarnessVerificationError,
    );
  });

  test("sends the required clientProtocol argument (a v1 client's `{}` cannot reach a v2 server)", async () => {
    let seenBody = "";
    const capture = (async (_url: unknown, init?: RequestInit) => {
      seenBody = String(init?.body);
      return new Response(JSON.stringify({ value: JSON.stringify(info()) }), { status: 200 });
    }) as typeof fetch;
    await verifyQuiet(verifier(capture));
    expect(JSON.parse(seenBody)).toEqual({ clientProtocol: 2 });
  });

  test("rejects a v2 payload with no serverGeneration — the lease could not be fenced without it", async () => {
    await expect(verifier(okFetch(info({ serverGeneration: undefined }))).verify()).rejects.toThrow(
      /serverGeneration/,
    );
  });

  test("rejects an EMPTY serverGeneration rather than sending it as expectedGeneration", async () => {
    await expect(verifier(okFetch(info({ serverGeneration: "" }))).verify()).rejects.toThrow(
      /serverGeneration/,
    );
  });

  // design §7's single-tenant gate. The shipped harness reports tenantCountReachable:false, so
  // the gate is UNENFORCED — and must say so out loud rather than emitting a silent pass.
  test("reports the tenant gate as unenforced (and warns) when the count is unreachable", async () => {
    const { details, warnings } = await verifyQuiet(verifier(okFetch(info())));
    expect(details.tenantGate).toBe("unenforced");
    expect(warnings.some((w) => w.includes("NOT ENFORCED"))).toBe(true);
  });

  test("refuses a multi-tenant container when the count IS reachable", async () => {
    await expect(
      verifier(okFetch(info({ tenantCountReachable: true, tenantCount: 2 }))).verify(),
    ).rejects.toBeInstanceOf(MultiTenantContainerError);
  });

  test("reports the tenant gate as enforced for a reachable single-tenant count", async () => {
    const { details, warnings } = await verifyQuiet(
      verifier(okFetch(info({ tenantCountReachable: true, tenantCount: 1 }))),
    );
    expect(details.tenantGate).toBe("enforced");
    expect(warnings).toHaveLength(0);
  });

  test("refuses to gate a publish on an unreadable count that claims to be reachable", async () => {
    await expect(
      verifier(okFetch(info({ tenantCountReachable: true, tenantCount: "lots" }))).verify(),
    ).rejects.toThrow(/tenantCount/);
  });

  test("rejects a payload with no tenantCountReachable at all", async () => {
    await expect(
      verifier(okFetch(info({ tenantCountReachable: undefined }))).verify(),
    ).rejects.toThrow(/tenantCountReachable/);
  });

  test("rejects a wrong control app id", async () => {
    await expect(
      verifier(okFetch(info({ appId: "00000000-0000-0000-0000-000000000000" }))).verify(),
    ).rejects.toBeInstanceOf(HarnessVerificationError);
  });

  test("rejects an older/unknown protocol version", async () => {
    await expect(verifier(okFetch(info({ protocolVersion: 0 }))).verify()).rejects.toBeInstanceOf(
      HarnessVerificationError,
    );
  });

  test("rejects a harness missing Codeunit isolation", async () => {
    await expect(
      verifier(okFetch(info({ isolationModes: ["Function"] }))).verify(),
    ).rejects.toThrow(/isolationModes/);
  });

  test("rejects a harness missing the codeunit test type", async () => {
    await expect(verifier(okFetch(info({ testTypes: [] }))).verify()).rejects.toThrow(/testTypes/);
  });

  test("rejects an unreachable harness (pre-dispatch throw)", async () => {
    const throwing = (async (_url: unknown, _init?: RequestInit) => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    await expect(verifier(throwing).verify()).rejects.toThrow(/unreachable/);
  });

  test("rejects a non-2xx harness response", async () => {
    const five00 = (async (_url: unknown, _init?: RequestInit) =>
      new Response("boom", { status: 500 })) as typeof fetch;
    await expect(verifier(five00).verify()).rejects.toThrow(/HTTP 500/);
  });

  test("POSTs LethALControl_HarnessInfo with company + tenant", async () => {
    let seenUrl = "";
    const capture = (async (url: unknown, _init?: RequestInit) => {
      seenUrl = String(url);
      return new Response(JSON.stringify({ value: JSON.stringify(info()) }), { status: 200 });
    }) as typeof fetch;
    await verifyQuiet(verifier(capture));
    expect(seenUrl).toContain("/ODataV4/LethALControl_HarnessInfo");
    expect(seenUrl).toContain("tenant=default");
    expect(seenUrl).toContain("company=CRONUS");
  });
});
