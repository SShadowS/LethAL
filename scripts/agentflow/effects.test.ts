import { describe, expect, test } from "bun:test";
import {
  type Effect,
  EffectRefusedError,
  EffectRunner,
  readEffect,
  writeEffect,
} from "./effects.ts";
import { HaltError } from "./halt.ts";

/** A witness that fails the test if the world was touched. */
function tripwire() {
  const calls: string[] = [];
  return {
    calls,
    read: (name: string) =>
      readEffect("read-only-inspection", name, async () => {
        calls.push(`read:${name}`);
        return "value";
      }),
    write: (name: string, dry?: string) =>
      writeEffect(
        "pr-create",
        name,
        async () => {
          calls.push(`write:${name}`);
          return "done";
        },
        dry !== undefined ? { result: dry } : undefined,
      ),
  };
}

describe("an effect does nothing until a runner performs it", () => {
  test("constructing a write touches nothing", () => {
    const t = tripwire();
    t.write("create the PR", "pr#0");
    t.write("merge it", "sha0");
    expect(t.calls).toEqual([]);
  });
});

describe("a dry run performs no write, and every read", () => {
  test("writes are skipped and reads are performed", async () => {
    const t = tripwire();
    const r = new EffectRunner({ dryRun: true, isHalted: () => false });

    expect(await r.run(t.read("list issues"))).toBe("value");
    expect(await r.run(t.write("create the PR", "pr#0"))).toBe("pr#0");

    // The only line here is the read. If a write had leaked through, it would appear.
    expect(t.calls).toEqual(["read:list issues"]);
    expect(r.plannedWrites.map((w) => w.describe)).toEqual(["create the PR"]);
    expect(r.records.map((x) => x.outcome)).toEqual(["performed", "skipped-dry-run"]);
  });

  test("a write with no declared dry-run result is refused, not invented", async () => {
    // Inventing one is how a dry run starts reporting outcomes it did not produce.
    const t = tripwire();
    const r = new EffectRunner({ dryRun: true, isHalted: () => false });
    await expect(r.run(t.write("merge"))).rejects.toThrow(EffectRefusedError);
    expect(t.calls).toEqual([]);
  });

  test("a whole tick of writes leaves the world untouched", async () => {
    const t = tripwire();
    const r = new EffectRunner({ dryRun: true, isHalted: () => false });
    for (const name of ["claim", "label", "comment", "push", "pr", "merge"]) {
      await r.run(t.write(name, "x"));
    }
    expect(t.calls).toEqual([]);
    expect(r.plannedWrites).toHaveLength(6);
  });
});

describe("a real run performs both", () => {
  test("reads and writes are performed and recorded in order", async () => {
    const t = tripwire();
    const r = new EffectRunner({ dryRun: false, isHalted: () => false });
    await r.run(t.read("status"));
    await r.run(t.write("push", "x"));
    expect(t.calls).toEqual(["read:status", "write:push"]);
    expect(r.records.every((x) => x.outcome === "performed")).toBe(true);
  });
});

describe("HALT is checked at the seam, through the same list as the kill switch", () => {
  test("a refused action throws even though the effect was constructed", async () => {
    const t = tripwire();
    const r = new EffectRunner({ dryRun: false, isHalted: () => true });
    await expect(r.run(t.write("create the PR", "pr#0"))).rejects.toThrow(HaltError);
    expect(t.calls).toEqual([]);
  });

  test("containment is still permitted while halted", async () => {
    const calls: string[] = [];
    const stop: Effect<void> = writeEffect("container-stop", "docker stop", async () => {
      calls.push("stopped");
    });
    const r = new EffectRunner({ dryRun: false, isHalted: () => true });
    await r.run(stop);
    expect(calls).toEqual(["stopped"]);
  });

  test("HALT is checked BEFORE the dry-run branch, so a halted dry run refuses rather than plans", async () => {
    // The plan is what a later non-dry run executes. A halted dry run that happily "plans" a merge
    // has written down the thing the human pressed stop to prevent.
    const t = tripwire();
    const r = new EffectRunner({ dryRun: true, isHalted: () => true });
    await expect(r.run(t.write("merge", "sha"))).rejects.toThrow(HaltError);
    expect(r.plannedWrites).toEqual([]);
  });

  test("HALT is re-read per effect, so dropping it mid-tick stops the next write", async () => {
    // Captured once, the window between a human pressing stop and the next tick is exactly where
    // the writes they meant to stop happen.
    const t = tripwire();
    let halted = false;
    const r = new EffectRunner({ dryRun: false, isHalted: () => halted });

    await r.run(t.write("push", "x"));
    halted = true;
    await expect(r.run(t.write("merge", "y"))).rejects.toThrow(HaltError);

    expect(t.calls).toEqual(["write:push"]);
  });

  test("a read that is not on the allowlist is refused too", async () => {
    // Reads are not automatically safe: `run-live-gate` reads a result, and running a live gate
    // under HALT is exactly what must not happen.
    const gate = readEffect("run-live-gate", "itest:tables", async () => "verdicts");
    const r = new EffectRunner({ dryRun: false, isHalted: () => true });
    await expect(r.run(gate)).rejects.toThrow(HaltError);
  });
});

describe("the record is the ledger's raw material", () => {
  test("it keeps order, kind, action and description", async () => {
    const t = tripwire();
    const r = new EffectRunner({ dryRun: true, isHalted: () => false });
    await r.run(t.read("fetch"));
    await r.run(t.write("claim", "ok"));
    expect(r.records).toEqual([
      {
        kind: "read",
        action: "read-only-inspection",
        describe: "fetch",
        outcome: "performed",
      },
      { kind: "write", action: "pr-create", describe: "claim", outcome: "skipped-dry-run" },
    ]);
  });
});
