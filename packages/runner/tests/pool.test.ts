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

  test("workers <= 0 clamps to a single shard, never zero shards", () => {
    for (const workers of [0, -1, -5]) {
      const shards = shardEvenly([1, 2, 3], workers);
      expect(shards).toEqual([[1, 2, 3]]);
    }
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

  // M1: permits <= 0 must fail loudly at construction, not deadlock silently
  // — Semaphore(0) previously meant every run() call awaited a `waiting`
  // slot that nothing could ever release (active >= permits is 0 >= 0,
  // always true; nothing decrements `active` to make it fall below 0).
  test("rejects a non-positive permit count instead of deadlocking", () => {
    expect(() => new Semaphore(0)).toThrow(/permits/i);
    expect(() => new Semaphore(-1)).toThrow(/permits/i);
  });

  // M1: a release's wakeup of a waiting caller and a brand-new caller's own
  // admission check must never both succeed against the same freed slot. The
  // original `if (this.active >= this.permits) await ...` checked capacity
  // exactly once per call; a caller resumed by `next()` after a release
  // proceeded straight to `this.active++` without re-validating, so if a
  // fresh caller's own (never-blocked) check landed in the same window — it
  // synchronously sees the post-release, pre-wakeup `active` count and also
  // proceeds — both callers could increment `active` past `permits`. This
  // drives that interleaving for real (every completing task immediately
  // spawns a fresh caller from inside its own body, before its own release
  // runs) across many iterations rather than asserting on a single hand-timed
  // race, since the exact microtask ordering isn't something a test should
  // hardcode.
  test("a fresh caller racing a release's wakeup never pushes active above permits", async () => {
    const sem = new Semaphore(2);
    let peak = 0;
    let launched = 0;
    let completed = 0;
    const target = 500;
    let rejectDone: (e: unknown) => void = () => {};
    const done = new Promise<void>((resolve, reject) => {
      rejectDone = reject;
      const launch = () => {
        if (launched >= target) return;
        launched++;
        sem
          .run(async () => {
            peak = Math.max(peak, sem.inFlight);
            if (peak > 2) rejectDone(new Error(`active exceeded permits: ${peak}`));
            // Fire the next caller synchronously, from inside this task's own
            // body — before `run()`'s `finally` releases this slot — so a
            // fresh admission check and this task's eventual release-wakeup
            // land as close together as the real bug required.
            launch();
          })
          .then(() => {
            completed++;
            if (completed === target) resolve();
          }, reject);
      };
      launch();
      launch();
      launch();
    });
    await done;
    expect(peak).toBeLessThanOrEqual(2);
  });
});
