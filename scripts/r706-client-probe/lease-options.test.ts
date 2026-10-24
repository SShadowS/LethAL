import { describe, expect, test } from "bun:test";
import { MAX_TTL_SECONDS } from "../../packages/runner/src/lease";
import { leaseOptions } from "./lease-options";

describe("leaseOptions", () => {
  test("default is the runner's bound, with a ttl/3 heartbeat", () =>
    expect(leaseOptions()).toEqual({ ttlSeconds: MAX_TTL_SECONDS, heartbeatMs: 5000 }));
  test("the old 120 s ttl is refused", () =>
    expect(() => leaseOptions(120)).toThrow(/at most|must be/));
  test("a non-positive ttl is refused", () => expect(() => leaseOptions(0)).toThrow());
  test("the bound itself is allowed", () =>
    expect(leaseOptions(MAX_TTL_SECONDS).ttlSeconds).toBe(MAX_TTL_SECONDS));
});
