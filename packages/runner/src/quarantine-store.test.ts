import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QuarantineStore } from "./quarantine-store";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "lethal-quarantine-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("QuarantineStore write/read", () => {
  test("read of an unquarantined tier is null", async () => {
    const store = new QuarantineStore(dir);
    expect(await store.read("http://a|BC")).toBeNull();
  });

  test("record then read round-trips and stamps generation 1", async () => {
    const store = new QuarantineStore(dir);
    const rec = await store.record({
      resourceKey: "http://a|BC",
      opKind: "test-run",
      detail: "deadline exceeded on M0007",
      recordedAtIso: "2026-07-20T10:00:00.000Z",
    });
    expect(rec.generation).toBe(1);
    const read = await store.read("http://a|BC");
    expect(read).toEqual(rec);
  });

  test("a second record increments generation and persists across store instances", async () => {
    const s1 = new QuarantineStore(dir);
    await s1.record({
      resourceKey: "http://a|BC",
      opKind: "test-run",
      detail: "x",
      recordedAtIso: "2026-07-20T10:00:00.000Z",
    });
    const second = await s1.record({
      resourceKey: "http://a|BC",
      opKind: "activation",
      detail: "y",
      recordedAtIso: "2026-07-20T10:05:00.000Z",
    });
    expect(second.generation).toBe(2);
    const s2 = new QuarantineStore(dir); // fresh instance = "next session"
    expect(await s2.read("http://a|BC")).toEqual(second);
  });

  test("concurrent record() writes for one key never corrupt the file", async () => {
    const store = new QuarantineStore(dir);
    await Promise.all([
      store.record({
        resourceKey: "http://a|BC",
        opKind: "test-run",
        detail: "x",
        recordedAtIso: "2026-07-20T10:00:00.000Z",
      }),
      store.record({
        resourceKey: "http://a|BC",
        opKind: "activation",
        detail: "y",
        recordedAtIso: "2026-07-20T10:00:01.000Z",
      }),
    ]);
    const read = await store.read("http://a|BC"); // must not throw (no corrupt/partial JSON)
    expect(read).not.toBeNull();
    expect(typeof read?.generation).toBe("number");
    expect((read?.generation ?? 0) >= 1).toBe(true);
  });
});

describe("QuarantineStore clear (generation-checked)", () => {
  test("clear with the current generation removes the record", async () => {
    const store = new QuarantineStore(dir);
    const rec = await store.record({
      resourceKey: "http://a|BC",
      opKind: "test-run",
      detail: "x",
      recordedAtIso: "2026-07-20T10:00:00.000Z",
    });
    expect(await store.clear("http://a|BC", rec.generation)).toBe("cleared");
    expect(await store.read("http://a|BC")).toBeNull();
  });

  test("a stale clear (older generation) does NOT erase a newer record", async () => {
    const store = new QuarantineStore(dir);
    const first = await store.record({
      resourceKey: "http://a|BC",
      opKind: "test-run",
      detail: "x",
      recordedAtIso: "2026-07-20T10:00:00.000Z",
    });
    await store.record({
      resourceKey: "http://a|BC",
      opKind: "activation",
      detail: "y",
      recordedAtIso: "2026-07-20T10:05:00.000Z",
    }); // gen 2
    expect(await store.clear("http://a|BC", first.generation)).toBe("stale"); // holding gen 1
    expect(await store.read("http://a|BC")).not.toBeNull(); // gen 2 survives
  });

  test("clear of an already-absent record is 'cleared' (idempotent)", async () => {
    const store = new QuarantineStore(dir);
    expect(await store.clear("http://a|BC", 1)).toBe("cleared");
  });
});
