import { describe, expect, test } from "bun:test";
import { canonicalContainerKey } from "./publish-serializer";
import { quarantineResourceKey } from "./resource-key";

describe("quarantineResourceKey", () => {
  test("two tenants on the same tier collapse to ONE quarantine key", () => {
    const a = quarantineResourceKey({ server: "http://Cronus281", serverInstance: "BC" });
    // tenant is not even part of the input — the same tier is the same key
    const b = quarantineResourceKey({ server: "http://cronus281/", serverInstance: "BC" });
    expect(a).toBe(b);
  });

  test("differs by server and by instance", () => {
    expect(quarantineResourceKey({ server: "http://a", serverInstance: "BC" })).not.toBe(
      quarantineResourceKey({ server: "http://b", serverInstance: "BC" }),
    );
    expect(quarantineResourceKey({ server: "http://a", serverInstance: "BC" })).not.toBe(
      quarantineResourceKey({ server: "http://a", serverInstance: "BC2" }),
    );
  });

  test("is a DIFFERENT domain from canonicalContainerKey (which keeps tenant)", () => {
    // Same tier, two tenants: quarantine key identical, container key distinct.
    const qk = quarantineResourceKey({ server: "http://a", serverInstance: "BC" });
    const ck1 = canonicalContainerKey({ server: "http://a", serverInstance: "BC", tenant: "t1" });
    const ck2 = canonicalContainerKey({ server: "http://a", serverInstance: "BC", tenant: "t2" });
    expect(ck1).not.toBe(ck2);
    expect(qk).not.toBe(ck1);
  });
});
