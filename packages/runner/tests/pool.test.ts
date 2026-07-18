import { describe, expect, test } from "bun:test";
import { Semaphore, shardEvenly } from "../src/pool";

describe("shardEvenly", () => {
  test("splits round-robin so shard sizes differ by at most one", () => {
    const shards = shardEvenly([1, 2, 3, 4, 5, 6, 7], 3);
    expect(shards).toHaveLength(3);
    expect(shards.flat().sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    const sizes = shards.map((s) => s.length).sort((a, b) => a - b);
    const minSize = sizes[0];
    const maxSize = sizes[sizes.length - 1];
    if (minSize !== undefined && maxSize !== undefined) {
      expect(maxSize - minSize).toBeLessThanOrEqual(1);
    }
  });

  test("one worker gets everything, in order", () => {
    expect(shardEvenly([1, 2, 3], 1)).toEqual([[1, 2, 3]]);
  });

  test("more workers than items yields empty shards, never undefined", () => {
    const shards = shardEvenly([1], 3);
    expect(shards).toHaveLength(3);
    expect(shards.flat()).toEqual([1]);
    for (const s of shards) expect(Array.isArray(s)).toBe(true);
  });

  test("is deterministic — same input, same shards", () => {
    expect(shardEvenly([1, 2, 3, 4, 5], 2)).toEqual(shardEvenly([1, 2, 3, 4, 5], 2));
  });
});

describe("Semaphore", () => {
  test("never exceeds its permit count", async () => {
    const sem = new Semaphore(2);
    let peak = 0;
    await Promise.all(
      Array.from({ length: 8 }, () =>
        sem.run(async () => {
          peak = Math.max(peak, sem.inFlight);
          await new Promise((r) => setTimeout(r, 5));
        }),
      ),
    );
    expect(peak).toBeLessThanOrEqual(2);
  });

  test("a throwing task releases its permit", async () => {
    const sem = new Semaphore(1);
    await expect(
      sem.run(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await sem.run(async () => "recovered")).toBe("recovered");
    expect(sem.inFlight).toBe(0);
  });
});
