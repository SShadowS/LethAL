import { describe, expect, test } from "bun:test";
import { canonicalContainerKey, serializePublish } from "../src/publish-serializer";

// `serializePublish`'s lock is module-level (process-global), not scoped to this test file or
// any single `describe` block — every test below mints its own unique key (`uniqueKey()`) so
// concurrently-run tests, and later tests in this same file, can never share a queue by
// accident and produce a false pass/fail.
let keyCounter = 0;
function uniqueKey(label: string): string {
  keyCounter++;
  return `test-${label}-${keyCounter}-${Math.random().toString(36).slice(2)}`;
}

/** Increments `counter.current` on entry, records the max seen across every call sharing this
 * counter object, then decrements on exit — the shared in-flight counter the task brief requires
 * ("never wall-clock timing"). `delayMs` yields the event loop via a real timer so a broken
 * (non-serializing) implementation gets a genuine window to run two of these concurrently; it is
 * NOT used to assert timing, only to give concurrency a chance to manifest if the lock is absent. */
function trackedFn(counter: { current: number; max: number }, delayMs: number) {
  return async (): Promise<number> => {
    counter.current++;
    counter.max = Math.max(counter.max, counter.current);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    counter.current--;
    return counter.max;
  };
}

describe("serializePublish", () => {
  test("same key: shared in-flight counter never exceeds 1", async () => {
    const key = uniqueKey("same");
    const counter = { current: 0, max: 0 };
    const calls = Array.from({ length: 5 }, () => serializePublish(key, trackedFn(counter, 15)));
    await Promise.all(calls);
    expect(counter.max).toBe(1);
  });

  test("different keys: shared in-flight counter reaches >= 2 (no cross-key serialization)", async () => {
    const counter = { current: 0, max: 0 };
    const calls = Array.from({ length: 5 }, (_, i) =>
      serializePublish(uniqueKey(`diff-${i}`), trackedFn(counter, 15)),
    );
    await Promise.all(calls);
    expect(counter.max).toBeGreaterThanOrEqual(2);
  });

  test("a throwing fn releases the lock: a later same-key call still runs, not deadlocked", async () => {
    const key = uniqueKey("throw");
    let secondRan = false;
    // Dispatched back-to-back, without awaiting the first — this is the actual no-deadlock
    // claim: the second call is already queued before the first has settled.
    const first = serializePublish(key, async () => {
      throw new Error("boom");
    });
    const second = serializePublish(key, async () => {
      secondRan = true;
      return "ok";
    });
    await expect(first).rejects.toThrow("boom");
    await expect(second).resolves.toBe("ok");
    expect(secondRan).toBe(true);
  });

  test("results/errors of individual calls are preserved, not swallowed by the queue", async () => {
    const key = uniqueKey("results");
    const a = await serializePublish(key, async () => 1);
    const b = await serializePublish(key, async () => 2);
    expect(a).toBe(1);
    expect(b).toBe(2);
  });
});

describe("canonicalContainerKey", () => {
  test("collapses trailing slash + case on server, and default/omitted tenant", () => {
    const withSlashAndTenant = canonicalContainerKey({
      server: "http://Cronus281/",
      serverInstance: "BC",
      tenant: "default",
    });
    const lowerNoSlashNoTenant = canonicalContainerKey({
      server: "http://cronus281",
      serverInstance: "BC",
    });
    expect(withSlashAndTenant).toBe(lowerNoSlashNoTenant);
  });

  test("different serverInstance or tenant produce different keys", () => {
    const base = canonicalContainerKey({ server: "http://cronus281", serverInstance: "BC" });
    const otherInstance = canonicalContainerKey({
      server: "http://cronus281",
      serverInstance: "BC2",
    });
    const otherTenant = canonicalContainerKey({
      server: "http://cronus281",
      serverInstance: "BC",
      tenant: "other",
    });
    expect(otherInstance).not.toBe(base);
    expect(otherTenant).not.toBe(base);
  });
});
