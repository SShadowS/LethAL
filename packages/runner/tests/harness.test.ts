import { describe, expect, test } from "bun:test";
import type { ActivationConfig } from "../src/activation";
import { CONTROL_APP_ID, HarnessVerificationError, HarnessVerifier } from "../src/harness";

const CFG: ActivationConfig = {
  baseUrl: "http://bc:7048/BC",
  company: "CRONUS Danmark A/S",
  username: "u",
  password: "p",
  tenant: "default",
};

function info(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    appId: CONTROL_APP_ID,
    semver: "1.0.0.0",
    protocolVersion: 1,
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

describe("HarnessVerifier.verify", () => {
  test("accepts a matching, compatible harness", async () => {
    await verifier(okFetch(info())).verify();
  });

  test("accepts a forward-compatible newer protocol (5C-B v2)", async () => {
    await verifier(okFetch(info({ protocolVersion: 2 }))).verify();
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
    await verifier(capture).verify();
    expect(seenUrl).toContain("/ODataV4/LethALControl_HarnessInfo");
    expect(seenUrl).toContain("tenant=default");
    expect(seenUrl).toContain("company=CRONUS");
  });
});
