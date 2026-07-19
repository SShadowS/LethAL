import { describe, expect, it } from "bun:test";
import type { CompiledArtifact } from "../src/artifact";
import { DeploymentVerifier, decidePublishOutcome } from "../src/deployment-verifier";

describe("decidePublishOutcome", () => {
  it("accepts only when the publish succeeded AND identity matches", () => {
    expect(decidePublishOutcome(true, { status: "accepted" })).toBe("accepted");
  });

  it("treats a successful publish with mismatched identity as indeterminate", () => {
    expect(decidePublishOutcome(true, { status: "mismatch", reported: "other" })).toBe(
      "indeterminate",
    );
  });

  it("treats a successful publish with unavailable identity as indeterminate", () => {
    expect(decidePublishOutcome(true, { status: "unavailable", detail: "404" })).toBe(
      "indeterminate",
    );
  });

  it("treats a FAILED publish whose identity matches as anomalous, never as success", () => {
    expect(decidePublishOutcome(false, { status: "accepted" })).toBe("anomalous");
  });

  it("treats a failed publish with mismatched identity as a publication failure", () => {
    expect(decidePublishOutcome(false, { status: "mismatch", reported: "other" })).toBe("failed");
  });
});

const CFG = {
  baseUrl: "http://bc:7048/BC",
  company: "CRONUS",
  username: "u",
  password: "p",
};

const VALID_ID = "0123456789abcdef0123456789abcdef";
const OTHER_VALID_ID = "fedcba9876543210fedcba9876543210";

function fakeArtifact(overrides: Partial<CompiledArtifact> = {}): CompiledArtifact {
  return {
    artifactId: VALID_ID,
    appId: "df1aa9ff-6539-4c86-a9d0-ad702b61ac9a",
    appVersion: "1.0.1.1",
    appPath: "C:/out/deadbeefdeadbeef-0123456789abcdef0123456789abcdef.app",
    sha256: Bun.SHA256.hash(new Uint8Array([1, 2, 3]), "hex"),
    mutantManifest: {
      selectorIds: { selectorId: 1, controlId: 2, tableId: 3 },
      artifactId: VALID_ID,
      mutants: [],
    },
    appManifest: {},
    ...overrides,
  };
}

function fakeFetch(status: number, body: unknown) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchFn = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  return { calls, fetchFn };
}

function throwingFetch(err: Error) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchFn = (async (url: unknown, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(url), init: init ?? {} });
    throw err;
  }) as typeof fetch;
  return { calls, fetchFn };
}

describe("DeploymentVerifier.verify", () => {
  it("POSTs to MutationControl_Identity with the same request shape as MutationControlClient", async () => {
    const { calls, fetchFn } = fakeFetch(200, { value: VALID_ID });
    await new DeploymentVerifier(CFG, fetchFn).verify(fakeArtifact());
    const call = calls[0];
    expect(call?.url).toBe("http://bc:7048/BC/ODataV4/MutationControl_Identity?company=CRONUS");
    expect(call?.init.method).toBe("POST");
    expect(new Headers(call?.init.headers).get("authorization")).toBe(`Basic ${btoa("u:p")}`);
  });

  it("returns accepted when the reported id matches the expected artifact id", async () => {
    const { fetchFn } = fakeFetch(200, { value: VALID_ID });
    const result = await new DeploymentVerifier(CFG, fetchFn).verify(fakeArtifact());
    expect(result).toEqual({ status: "accepted" });
  });

  it("returns mismatch, carrying the reported id, when it differs from the expected id", async () => {
    const { fetchFn } = fakeFetch(200, { value: OTHER_VALID_ID });
    const result = await new DeploymentVerifier(CFG, fetchFn).verify(fakeArtifact());
    expect(result).toEqual({ status: "mismatch", reported: OTHER_VALID_ID });
  });

  it("treats a malformed reported id as unavailable instead of comparing it", async () => {
    const { fetchFn } = fakeFetch(200, { value: "not-a-valid-artifact-id!!" });
    const result = await new DeploymentVerifier(CFG, fetchFn).verify(fakeArtifact());
    expect(result.status).toBe("unavailable");
    expect((result as { detail: string }).detail).toContain("not-a-valid-artifact-id!!");
  });

  it("never treats an empty reported id as a match, even against a valid expected id", async () => {
    const { fetchFn } = fakeFetch(200, { value: "" });
    const result = await new DeploymentVerifier(CFG, fetchFn).verify(fakeArtifact());
    expect(result.status).not.toBe("accepted");
    expect(result.status).toBe("unavailable");
  });

  it("treats a missing `value` field as unavailable, not a mismatch", async () => {
    const { fetchFn } = fakeFetch(200, {});
    const result = await new DeploymentVerifier(CFG, fetchFn).verify(fakeArtifact());
    expect(result).toEqual({
      status: "unavailable",
      detail: "server did not report an artifact id (missing or non-string `value`)",
    });
  });

  it("truncates a huge/hostile reported value in the unavailable detail rather than logging it whole", async () => {
    const hostileValue = "x".repeat(10_000);
    const { fetchFn } = fakeFetch(200, { value: hostileValue });
    const result = await new DeploymentVerifier(CFG, fetchFn).verify(fakeArtifact());
    expect(result.status).toBe("unavailable");
    const detail = (result as { detail: string }).detail;
    expect(detail.length).toBeLessThan(hostileValue.length);
    expect(detail).toContain("truncated");
  });

  it("returns unavailable with the status on an HTTP error", async () => {
    const { fetchFn } = fakeFetch(500, {});
    const result = await new DeploymentVerifier(CFG, fetchFn).verify(fakeArtifact());
    expect(result.status).toBe("unavailable");
    expect((result as { detail: string }).detail).toContain("500");
  });

  it("returns unavailable on a transport failure", async () => {
    const { fetchFn } = throwingFetch(new Error("ECONNREFUSED"));
    const result = await new DeploymentVerifier(CFG, fetchFn).verify(fakeArtifact());
    expect(result.status).toBe("unavailable");
    expect((result as { detail: string }).detail).toContain("ECONNREFUSED");
  });

  it("rejects loudly, without ever calling fetch, when the EXPECTED artifact id is malformed", async () => {
    const { calls, fetchFn } = fakeFetch(200, { value: VALID_ID });
    const verifier = new DeploymentVerifier(CFG, fetchFn);
    await expect(
      verifier.verify(fakeArtifact({ artifactId: "pending-task6-1-0" })),
    ).rejects.toThrow();
    expect(calls.length).toBe(0);
  });

  it("rejects loudly when the expected artifact id is empty, rather than risking an empty/empty match", async () => {
    const { calls, fetchFn } = fakeFetch(200, { value: "" });
    const verifier = new DeploymentVerifier(CFG, fetchFn);
    await expect(verifier.verify(fakeArtifact({ artifactId: "" }))).rejects.toThrow();
    expect(calls.length).toBe(0);
  });

  it("includes ?tenant= when configured", async () => {
    const { calls, fetchFn } = fakeFetch(200, { value: VALID_ID });
    await new DeploymentVerifier({ ...CFG, tenant: "default" }, fetchFn).verify(fakeArtifact());
    expect(calls[0]?.url).toBe(
      "http://bc:7048/BC/ODataV4/MutationControl_Identity?company=CRONUS&tenant=default",
    );
  });
});
